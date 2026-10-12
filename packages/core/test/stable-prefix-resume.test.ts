/**
 * stable-prefix-resume.test.ts (2.3, F22) — the stable prefix across the legs of
 * one run: what a break leaves in the checkpoint, what the resume settle answers
 * and against which tools, the `onInput` guardrail on a resumed leg, and the
 * memory recall rule across legs. Scripted Claude endpoint, offline; not
 * live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateText } from '../src/index';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
} from '../src/durable';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import type { CommonCallOptions } from '../src/types/config';
import type { JSONSchema } from '../src/types/schema';
import {
  claudeTurn,
  prefixBreaks,
  scriptedClaude,
  thinkThenAnswer,
  thinkThenCall,
  type ClaudeRequest,
} from './helpers/stable-prefix';

const OBJ: JSONSchema = { type: 'object', properties: {} };
const clock = { now: () => 1_700_000_000_000, setTimeout: () => () => {} };
const LOOPS = ['buffered', 'streaming'] as const;

/** Resume a suspended durable run through either loop. */
async function resume(
  loop: (typeof LOOPS)[number],
  store: ReturnType<typeof createInMemorySessionStore>,
  runId: string,
  options: Omit<CommonCallOptions, 'messages'>,
): Promise<void> {
  if (loop === 'buffered') {
    await resumeFromCheckpoint(store, runId, options);
    return;
  }
  const result = resumeStreamFromCheckpoint(store, runId, options);
  for await (const part of result.fullStream) if (part.type === 'error') throw part.error;
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
