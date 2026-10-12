/**
 * stable-prefix-resume.test.ts (2.3, F22) — the stable prefix across the legs of
 * one run: what a break leaves in the checkpoint, what the resume settle answers
 * and against which tools, the `onInput` guardrail on a resumed leg, and the
 * memory recall rule across legs. Scripted Claude endpoint, offline; not
 * live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/index';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
} from '../src/durable';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import { PROMPT_INJECTION_POLICY, promptInjectionGuardrail } from '../src/guardrails';
import { createInMemoryMemoryStore, type MemorySeams } from '../src/memory';
import type { CommonCallOptions } from '../src/types/config';
import type { LanguageModel } from '../src/types/model';
import type { JSONSchema } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import {
  claudeTurn,
  prefixBreak,
  prefixBreaks,
  scriptedClaude,
  thinkThenAnswer,
  thinkThenCall,
  type ClaudeRequest,
} from './helpers/stable-prefix';

const OBJ: JSONSchema = { type: 'object', properties: {} };
const clock = { now: () => 1_700_000_000_000, setTimeout: () => () => {} };
const LOOPS = ['buffered', 'streaming'] as const;

/**
 * Resume a suspended durable run through either loop. Reports the guardrail
 * verdicts the leg reported, and every part of a streamed leg.
 */
async function resume(
  loop: (typeof LOOPS)[number],
  store: ReturnType<typeof createInMemorySessionStore>,
  runId: string,
  options: Omit<CommonCallOptions, 'messages'>,
): Promise<{ guardrails: number; parts: StreamPart[] }> {
  if (loop === 'buffered') {
    const result = await resumeFromCheckpoint(store, runId, options);
    const deuz = result.providerMetadata?.deuz as { guardrails?: unknown[] } | undefined;
    return { guardrails: deuz?.guardrails?.length ?? 0, parts: [] };
  }
  const result = resumeStreamFromCheckpoint(store, runId, options);
  const parts: StreamPart[] = [];
  for await (const part of result.fullStream) {
    if (part.type === 'error') throw part.error;
    parts.push(part);
  }
  return { guardrails: parts.filter((p) => p.type === 'guardrail').length, parts };
}

/** Every `tool_use_id` a request answers. */
function answeredIds(request: ClaudeRequest): string[] {
  const ids: string[] = [];
  for (const m of request.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string; tool_use_id?: string }>)
      if (b.type === 'tool_result') ids.push(b.tool_use_id!);
  }
  return ids;
}

/** The content of each `tool_result` a request carries, by `tool_use_id`. */
function toolResults(request: ClaudeRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of request.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>)
      if (b.type === 'tool_result') out[b.tool_use_id!] = b.content;
  }
  return out;
}

// --- a break that commits a handoff ------------------------------------------

describe.each(['claude-opus-5-5', 'claude-opus-4-8'])(
  'a transfer and a gated call in one step (%s)',
  (id) => {
    describe.each(LOOPS)('%s loop', (loop) => {
      it('the resume settles the approved call before the target’s instructions', async () => {
        let ran = 0;
        const claude = scriptedClaude(
          [
            claudeTurn([
              { type: 'thinking', signature: 'S0' },
              { type: 'tool_use', id: 'tu_a', name: 'refund' },
              { type: 'tool_use', id: 'tu_t', name: 'transfer_to_billing' },
            ]),
            thinkThenAnswer('S1', 'Refund issued.'),
          ],
          id,
        );
        const billing = { model: claude.model, instructions: 'You handle billing.' };
        const tools = {
          ...handoff({ billing }),
          refund: {
            parameters: OBJ,
            execute: async () => {
              ran++;
              return 'refunded';
            },
            needsApproval: true,
          },
        };
        const store = createInMemorySessionStore();
        const first = await generateText({
          model: claude.model,
          messages: [
            { role: 'system', content: 'You route customers.' },
            { role: 'user', content: 'I want a refund.' },
          ],
          tools,
          maxSteps: 4,
          session: { store, runId: 'run-1' },
          deps: { clock },
        });
        expect(first.pendingApprovals).toHaveLength(1);
        await resume(loop, store, 'run-1', {
          model: claude.model,
          tools,
          maxSteps: 4,
          approvalResponses: [
            { approvalId: first.pendingApprovals![0]!.approvalId, approved: true },
          ],
          deps: { clock },
        });

        expect(ran).toBe(1);
        const second = claude.requests[1]!;
        expect(answeredIds(second).sort()).toEqual(['tu_a', 'tu_t']);
        if (id === 'claude-opus-5-5') {
          // The answers sit right after the turn that asked; the target's
          // instructions, never sent before, follow them.
          const firstAnswer = second.messages.findIndex((m) =>
            JSON.stringify(m).includes('"tool_result"'),
          );
          expect(second.messages[firstAnswer - 1]!.role).toBe('assistant');
          const instructions = second.messages.findIndex((m) =>
            JSON.stringify(m).includes('You handle billing.'),
          );
          expect(instructions).toBeGreaterThan(firstAnswer);
          expect(
            second.messages
              .slice(firstAnswer, instructions)
              .every((m) => JSON.stringify(m).includes('"tool_result"')),
          ).toBe(true);
          expect(second.system).toBe('You route customers.');
          expect(prefixBreaks(claude.requests)).toEqual([]);
        } else {
          expect(second.system).toBe('You handle billing.');
        }
      });
    });
  },
);

describe.each(LOOPS)(
  'a transfer next to a suspending sub-agent on Claude 5.x (%s loop)',
  (loop) => {
    it('the resume re-runs the sub-agent call and answers it before the instructions', async () => {
      let dangerous = 0;
      const parent = scriptedClaude([
        claudeTurn([
          { type: 'thinking', signature: 'S0' },
          { type: 'tool_use', id: 'tu_r', name: 'researcher', input: { prompt: 'Look it up.' } },
          { type: 'tool_use', id: 'tu_t', name: 'transfer_to_billing' },
        ]),
        thinkThenAnswer('S1', 'Refund issued.'),
      ]);
      const child = scriptedClaude([
        thinkThenCall('C0', 'tu_d', 'dangerous'),
        thinkThenAnswer('C1', 'Order 42.'),
      ]);
      const tools = {
        ...handoff({ billing: { model: parent.model, instructions: 'You handle billing.' } }),
        researcher: agentTool({
          name: 'researcher',
          description: 'Research',
          model: child.model,
          tools: {
            dangerous: {
              parameters: OBJ,
              needsApproval: true,
              execute: async () => {
                dangerous++;
                return 'looked';
              },
            },
          },
        }),
      };
      const store = createInMemorySessionStore();
      const first = await generateText({
        model: parent.model,
        messages: [
          { role: 'system', content: 'You route customers.' },
          { role: 'user', content: 'I want a refund.' },
        ],
        tools,
        maxSteps: 4,
        session: { store, runId: 'run-1' },
        deps: { clock },
      });
      expect(first.pendingApprovals).toHaveLength(1);
      expect((await store.load('run-1'))!.messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'system',
      ]);
      await resume(loop, store, 'run-1', {
        model: parent.model,
        tools,
        maxSteps: 4,
        approvalResponses: [{ approvalId: first.pendingApprovals![0]!.approvalId, approved: true }],
        deps: { clock },
      });

      expect(dangerous).toBe(1);
      expect(parent.requests).toHaveLength(2);
      const second = parent.requests[1]!;
      expect(answeredIds(second).sort()).toEqual(['tu_r', 'tu_t']);
      expect(JSON.stringify(second.messages)).toContain('Order 42.');
      expect(prefixBreaks(parent.requests)).toEqual([]);
    });
  },
);

describe('a native run: a transfer and a gated call in one step on Claude 5.x', () => {
  it('resumeAgent settles the approved call', async () => {
    let ran = 0;
    const claude = scriptedClaude([
      claudeTurn([
        { type: 'thinking', signature: 'S0' },
        { type: 'tool_use', id: 'tu_a', name: 'refund' },
        { type: 'tool_use', id: 'tu_t', name: 'transfer_to_billing' },
      ]),
      thinkThenAnswer('S1', 'Refund issued.'),
    ]);
    const options = {
      model: claude.model,
      prompt: 'I want a refund.',
      session: { store: createInMemoryAgentRunStore(), runId: 'native-1', scope: 'tenant' },
      tools: {
        ...handoff({ billing: { model: claude.model, instructions: 'You handle billing.' } }),
        refund: {
          parameters: OBJ,
          needsApproval: true,
          execute: () => {
            ran++;
            return 'refunded';
          },
        },
      },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [
        {
          approvalId: first.status === 'suspended' ? first.pendingApprovals[0]!.approvalId : '',
          approved: true,
        },
      ],
    });
    expect(resumed.status).toBe('completed');
    expect(ran).toBe(1);
    expect(answeredIds(claude.requests[1]!).sort()).toEqual(['tu_a', 'tu_t']);
    expect(prefixBreaks(claude.requests)).toEqual([]);
  });
});

// --- the tools a pending call resolves against ---------------------------------

describe('a tool the step withdrew, called next to a gated one (Claude 5.x)', () => {
  const MODES = ['durable buffered', 'durable streaming', 'non-durable'] as const;

  function setup() {
    const ran: string[] = [];
    const claude = scriptedClaude([
      claudeTurn([
        { type: 'thinking', signature: 'S0' },
        { type: 'tool_use', id: 'tu_a', name: 'approveMe' },
        { type: 'tool_use', id: 'tu_w', name: 'wipe' },
      ]),
      thinkThenAnswer('S1', 'Done.'),
    ]);
    const tool = (name: string, needsApproval = false) => ({
      parameters: OBJ,
      needsApproval,
      execute: async () => {
        ran.push(name);
        return `${name} ran`;
      },
    });
    const common = {
      model: claude.model,
      tools: { approveMe: tool('approveMe', true), wipe: tool('wipe') },
      maxSteps: 4,
      // Step 0 withdraws `wipe`: on Claude 5.x the array still declares it.
      prepareStep: ({ stepIndex }: { stepIndex: number }) =>
        stepIndex === 0 ? { activeTools: ['approveMe'] } : {},
      deps: { clock },
    };
    return { ran, claude, common };
  }

  it.each(MODES)('%s: the settle answers it like an unknown tool', async (mode) => {
    const { ran, claude, common } = setup();
    const input = [{ role: 'user' as const, content: 'Go.' }];
    const store = createInMemorySessionStore();
    const first = await generateText({
      ...common,
      messages: input,
      ...(mode === 'non-durable' ? {} : { session: { store, runId: 'run-1' } }),
    });
    expect(first.pendingApprovals).toHaveLength(1);
    const approvalResponses = [
      { approvalId: first.pendingApprovals![0]!.approvalId, approved: true },
    ];
    let parts: StreamPart[] = [];
    if (mode === 'non-durable') {
      await generateText({
        ...common,
        messages: [...input, ...first.response.messages],
        approvalResponses,
      });
    } else {
      ({ parts } = await resume(
        mode === 'durable buffered' ? 'buffered' : 'streaming',
        store,
        'run-1',
        { ...common, approvalResponses },
      ));
    }

    expect(ran).toEqual(['approveMe']);
    expect(toolResults(claude.requests[1]!)).toEqual({
      tu_a: 'approveMe ran',
      tu_w: 'No such tool: "wipe". Available tools: approveMe.',
    });
    expect(prefixBreaks(claude.requests)).toEqual([]);
    // Nothing reports it as running either.
    const states = parts.flatMap((p) =>
      p.type === 'tool-state' && p.toolCallId === 'tu_w' ? [p.state] : [],
    );
    expect(states).toEqual(mode === 'durable streaming' ? ['error'] : []);
  });

  it('a native resumeAgent leg never runs it', async () => {
    const { ran, claude, common } = setup();
    const options = {
      ...common,
      prompt: 'Go.',
      session: { store: createInMemoryAgentRunStore(), runId: 'native-1', scope: 'tenant' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [
        {
          approvalId: first.status === 'suspended' ? first.pendingApprovals[0]!.approvalId : '',
          approved: true,
        },
      ],
    });
    expect(resumed.status).toBe('completed');
    expect(ran).toEqual(['approveMe']);
    expect(toolResults(claude.requests[1]!).tu_w).toBe(
      'No such tool: "wipe". Available tools: approveMe.',
    );
  });

  it.each(LOOPS)('%s loop: a transfer the step withdrew is not decided either', async (loop) => {
    const transfers: string[] = [];
    const claude = scriptedClaude([
      claudeTurn([
        { type: 'thinking', signature: 'S0' },
        { type: 'tool_use', id: 'tu_a', name: 'approveMe' },
        { type: 'tool_use', id: 'tu_t', name: 'transfer_to_billing' },
      ]),
      thinkThenAnswer('S1', 'Done.'),
    ]);
    const billing = { model: claude.model, instructions: 'You handle billing.' };
    const common = {
      model: claude.model,
      tools: {
        ...handoff({ billing }, { onHandoff: ({ to }) => transfers.push(to) }),
        approveMe: { parameters: OBJ, execute: async () => 'approved', needsApproval: true },
      },
      maxSteps: 4,
      prepareStep: ({ stepIndex }: { stepIndex: number }) =>
        stepIndex === 0 ? { activeTools: ['approveMe'] } : {},
      deps: { clock },
    };
    const store = createInMemorySessionStore();
    const first = await generateText({
      ...common,
      messages: [{ role: 'user', content: 'Go.' }],
      session: { store, runId: 'run-1' },
    });
    expect(first.pendingApprovals).toHaveLength(1);
    await resume(loop, store, 'run-1', {
      ...common,
      approvalResponses: [{ approvalId: first.pendingApprovals![0]!.approvalId, approved: true }],
    });

    expect(transfers).toEqual([]);
    expect(toolResults(claude.requests[1]!)).toEqual({
      tu_a: 'approved',
      tu_t: 'No such tool: "transfer_to_billing". Available tools: approveMe.',
    });
    expect(JSON.stringify(claude.requests[1]!.messages)).not.toContain('You handle billing.');
  });
});

describe.each(LOOPS)(
  'a handoff target’s own gated tool on its resumed leg (Claude 5.x, %s loop)',
  (loop) => {
    it('settles against the set the target was offered', async () => {
      const ran: string[] = [];
      const claude = scriptedClaude([
        thinkThenCall('S0', 'tu_0', 'transfer_to_billing'),
        thinkThenCall('S1', 'tu_1', 'refund'),
        thinkThenAnswer('S2', 'Refunded.'),
      ]);
      const billing = {
        model: claude.model,
        instructions: 'You handle billing.',
        tools: {
          refund: {
            parameters: OBJ,
            needsApproval: true,
            execute: async () => {
              ran.push('refund');
              return 'refunded';
            },
          },
        },
      };
      const common = {
        model: claude.model,
        tools: {
          ...handoff({ billing }),
          search: { parameters: OBJ, execute: async () => 'found' },
        },
        maxSteps: 4,
        deps: { clock },
      };
      const store = createInMemorySessionStore();
      const first = await generateText({
        ...common,
        messages: [{ role: 'user', content: 'Refund my order.' }],
        session: { store, runId: 'run-1' },
      });
      expect(first.pendingApprovals).toHaveLength(1);
      await resume(loop, store, 'run-1', {
        ...common,
        approvalResponses: [{ approvalId: first.pendingApprovals![0]!.approvalId, approved: true }],
      });

      // `refund` is no root tool: the tool-set change before the target's turn offered it.
      expect(ran).toEqual(['refund']);
      expect(toolResults(claude.requests[2]!).tu_1).toBe('refunded');
      expect(prefixBreaks(claude.requests)).toEqual([]);
    });
  },
);

// --- the onInput guardrail on a resumed leg ------------------------------------

describe('promptInjectionGuardrail on a resumed leg (Claude 5.x)', () => {
  const brew = { parameters: OBJ, execute: async () => 'brewed', needsApproval: true };
  const SYSTEM = `${PROMPT_INJECTION_POLICY}\n\nYou brew.`;

  it.each(LOOPS)('%s loop: the policy the checkpoint holds rides once', async (loop) => {
    const claude = scriptedClaude([
      thinkThenCall('S0', 'tu_0', 'brew'),
      thinkThenAnswer('S1', 'Brewed.'),
    ]);
    const store = createInMemorySessionStore();
    const common = {
      model: claude.model,
      instructions: 'You brew.',
      tools: { brew },
      maxSteps: 3,
      guardrails: { onInput: promptInjectionGuardrail() },
      deps: { clock },
    };
    const first = await generateText({
      ...common,
      messages: [{ role: 'user', content: 'Brew me a coffee.' }],
      session: { store, runId: 'run-1' },
    });
    expect(first.pendingApprovals).toHaveLength(1);
    const leg = await resume(loop, store, 'run-1', {
      ...common,
      approvalResponses: [{ approvalId: first.pendingApprovals![0]!.approvalId, approved: true }],
    });

    expect(claude.requests).toHaveLength(2);
    expect(claude.requests.map((r) => r.system)).toEqual([SYSTEM, SYSTEM]);
    expect(prefixBreaks(claude.requests)).toEqual([]);
    // Nothing to add, nothing to report: the first leg reported the rewrite.
    expect(leg.guardrails).toBe(0);
  });

  it('a native resumeAgent leg keeps one copy', async () => {
    const claude = scriptedClaude([
      thinkThenCall('S0', 'tu_0', 'brew'),
      thinkThenAnswer('S1', 'Brewed.'),
    ]);
    const options = {
      model: claude.model,
      instructions: 'You brew.',
      prompt: 'Brew me a coffee.',
      tools: { brew },
      guardrails: { onInput: promptInjectionGuardrail() },
      session: { store: createInMemoryAgentRunStore(), runId: 'native-1', scope: 'tenant' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [
        {
          approvalId: first.status === 'suspended' ? first.pendingApprovals[0]!.approvalId : '',
          approved: true,
        },
      ],
    });
    expect(resumed.status).toBe('completed');
    expect(claude.requests.map((r) => r.system)).toEqual([SYSTEM, SYSTEM]);
    expect(prefixBreaks(claude.requests)).toEqual([]);
  });
});

// --- memory recall across legs -------------------------------------------------

/** A memory store holding one fact, its `search` spied on. */
async function seededSeams(): Promise<MemorySeams & { search: ReturnType<typeof vi.fn> }> {
  const store = createInMemoryMemoryStore();
  const search = vi.fn(store.search.bind(store));
  let id = 0;
  const seams = {
    store: { ...store, search },
    // Extraction is off in these runs; recall never calls the LLM.
    llm: async () => '{"facts": []}',
    clock,
    generateId: () => `mem-${id++}`,
    hashFn: async (t: string) => `h:${t}`,
    search,
  };
  await seams.store.upsert([
    {
      id: 'm-0',
      text: 'User prefers dark roast coffee',
      hash: 'h:coffee',
      kind: 'semantic',
      scope: { userId: 'u1' },
      createdAt: 1,
      updatedAt: 1,
      validAt: 1,
    },
  ]);
  return seams;
}

const MEMORY = 'User prefers dark roast coffee';

/** How often `text` occurs in `value`, serialized. */
function occurrences(value: unknown, text: string): number {
  return JSON.stringify(value ?? null).split(text).length - 1;
}

describe.each(LOOPS)(
  'memory recall follows the run’s first model on every leg (%s loop)',
  (loop) => {
    /** Transfer, then a gated refund in the target, resumed with the approval. */
    async function transferAndResume(
      root: LanguageModel,
      target: LanguageModel,
      seams: MemorySeams,
    ): Promise<void> {
      const billing = {
        model: target,
        tools: {
          refund: { parameters: OBJ, execute: async () => 'refunded', needsApproval: true },
        },
      };
      const store = createInMemorySessionStore();
      const common = {
        model: root,
        tools: handoff({ billing }),
        maxSteps: 4,
        memory: { seams, scope: { userId: 'u1' }, extract: false as const },
        deps: { clock },
      };
      const first = await generateText({
        ...common,
        messages: [
          { role: 'system', content: 'You route.' },
          { role: 'user', content: 'Refund my coffee order.' },
        ],
        session: { store, runId: 'run-1' },
      });
      expect(first.pendingApprovals).toHaveLength(1);
      await resume(loop, store, 'run-1', {
        ...common,
        approvalResponses: [{ approvalId: first.pendingApprovals![0]!.approvalId, approved: true }],
      });
    }

    const turns = () => [
      thinkThenCall('S0', 'tu_0', 'transfer_to_billing'),
      thinkThenCall('S1', 'tu_1', 'refund'),
      thinkThenAnswer('S2', 'Refunded.'),
    ];

    it('a run that starts on another model splices the block on a Claude 5.x target’s resumed leg too', async () => {
      const seams = await seededSeams();
      const claude = scriptedClaude(turns());
      await transferAndResume(claude.model2('claude-opus-4-8'), claude.model, seams);

      expect(claude.requests).toHaveLength(3);
      const [, targetLeg1, targetLeg2] = claude.requests;
      // The target's system reads the block on both legs, so its thinking holds.
      expect(occurrences(targetLeg1!.system, MEMORY)).toBe(1);
      expect(targetLeg2!.system).toEqual(targetLeg1!.system);
      expect(prefixBreak(targetLeg1!, targetLeg2!)).toBeUndefined();
      // The splice keeps the transcript recall-free; each leg recalls, as in 2.2.
      expect(occurrences(targetLeg2!.messages, MEMORY)).toBe(0);
      expect(seams.search).toHaveBeenCalledTimes(2);
    });

    it('a Claude 5.x run keeps its one recall message when an older-model target resumes', async () => {
      const seams = await seededSeams();
      const claude = scriptedClaude(turns());
      await transferAndResume(claude.model, claude.model2('claude-opus-4-8'), seams);

      expect(claude.requests).toHaveLength(3);
      const [, targetLeg1, targetLeg2] = claude.requests;
      // Folded into the older model's system on both legs, and only once.
      expect(occurrences(targetLeg2!.system, MEMORY)).toBe(1);
      expect(targetLeg2!.system).toEqual(targetLeg1!.system);
      expect(seams.search).toHaveBeenCalledTimes(1);
    });
  },
);
