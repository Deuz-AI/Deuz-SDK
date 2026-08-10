import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAgent } from '../src/agent';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
} from '../src/durable';
import { createInMemoryMemoryStore, type MemoryRecord, type MemorySeams } from '../src/memory';
import {
  handoff,
  readHandoffTarget,
  handoffToolName,
  HANDOFF_TARGET,
  type HandoffAgentDef,
} from '../src/inference/handoff';
import type { LanguageModel } from '../src/types/model';
import type { Logger } from '../src/types/deps';
import type { Message } from '../src/types/message';
import type { JSONSchema } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import type { Tool, ToolExecuteContext } from '../src/types/tool';

// ===================================================================
// Harness
// ===================================================================

interface WireBody {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: { type: string; function: { name: string; description?: string } }[];
}

/**
 * A shared recorder over several {@link createMockModel} instances: each agent
 * gets its OWN model id and its own script, and every wire call is appended to
 * one ordered log. That log is what proves a handoff actually swapped the model —
 * the loop reports no model per step, so the request itself is the evidence.
 */
function recorder(): {
  calls: { model: string; body: WireBody }[];
  models: () => string[];
  model: (modelId: string, responses: MockResponse[]) => LanguageModel;
} {
  const calls: { model: string; body: WireBody }[] = [];
  return {
    calls,
    models: () => calls.map((c) => c.model),
    model(modelId, responses) {
      const base = createMockModel({ responses });
      const config = readConfig(base)!;
      const inner = config.fetch!;
      const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ model: modelId, body: JSON.parse(String(init!.body)) as WireBody });
        return inner(input, init);
      }) as typeof fetch;
      return attachConfig(
        { provider: 'mock', modelId, surface: 'chat_completions' },
        { ...config, fetch: fetchImpl },
      );
    },
  };
}

/** The leading system turn of a recorded request (empty when there is none). */
function systemOf(body: WireBody): string {
  const first = body.messages[0];
  if (!first || (first.role !== 'system' && first.role !== 'developer')) return '';
  return String(first.content);
}

/** The tool names a recorded request carried, sorted for order-independent asserts. */
function toolNamesOf(body: WireBody): string[] {
  return (body.tools ?? []).map((t) => t.function.name).sort();
}

const NOTE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { note: { type: 'string' } },
  additionalProperties: false,
};

function noteTool(execute: Tool['execute']): Tool {
  return { description: 'Take a note.', parameters: NOTE_SCHEMA, execute };
}

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** Read `providerMetadata.deuz` off either a result or a `finish` part. */
const deuz = (meta: Record<string, unknown> | undefined): Record<string, unknown> =>
  (meta?.deuz ?? {}) as Record<string, unknown>;

/** Every `tool_result` id in a message array — the Anthropic 400 guard, asserted. */
function answeredIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) if (p.type === 'tool_result') ids.push(p.toolUseId);
  }
  return ids;
}

/** Every `tool_use` id in a message array. */
function calledIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) if (p.type === 'tool_use') ids.push(p.id);
  }
  return ids;
}

function toolResultText(messages: Message[], toolUseId: string): string {
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type === 'tool_result' && p.toolUseId === toolUseId) return String(p.result);
    }
  }
  return '';
}

function spyLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

// ===================================================================
// handoff() — tool construction
// ===================================================================

describe('handoff(): tool construction', () => {
  it('mints one transfer_to_<name> tool per agent, carrying a hidden target marker', () => {
    const billingModel = createMockModel({ responses: [] });
    const tools = handoff({
      billing: { model: billingModel, instructions: 'You settle invoices.' },
    });

    expect(Object.keys(tools)).toEqual(['transfer_to_billing']);
    const transfer = tools.transfer_to_billing!;
    expect(transfer.description).toBe(
      "Transfer the conversation to the 'billing' agent. You settle invoices.",
    );
    expect(transfer.parameters).toEqual({
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why this agent should take over, in one sentence.',
        },
      },
      additionalProperties: false,
    });
    // `reason` is deliberately NOT required: a transfer without a stated reason
    // must still validate, or a routing decision would become an error turn.
    expect((transfer.parameters as { required?: string[] }).required).toBeUndefined();

    const meta = readHandoffTarget(transfer)!;
    expect(meta.name).toBe('billing');
    expect(meta.def.model).toBe(billingModel);
    expect(meta.def.instructions).toBe('You settle invoices.');

    // The marker is hidden: no enumerable key, nothing in JSON, nothing a
    // `{ ...tool }` spread or a `toEqual` would ever show.
    expect(Object.keys(transfer)).toEqual(['description', 'parameters', 'execute']);
    expect(JSON.stringify(transfer)).not.toContain('handoffTarget');
    expect(readHandoffTarget(noteTool(() => 'x'))).toBeUndefined();
    expect(handoffToolName('billing')).toBe('transfer_to_billing');
    expect(typeof HANDOFF_TARGET).toBe('symbol');
  });

  it('HAS an execute (never a client tool) that throws if it is ever reached', async () => {
    const tools = handoff({ billing: { model: createMockModel({ responses: [] }) } });
    const transfer = tools.transfer_to_billing!;
    // No `execute` would classify it as a CLIENT tool and break the loop with a
    // round-trip the caller cannot answer.
    expect(typeof transfer.execute).toBe('function');
    // A synchronous throw is what `executeTools` self-heals into an `is_error`
    // tool_result, so an older loop degrades loudly instead of silently.
    expect(() => transfer.execute!({}, {} as ToolExecuteContext)).toThrow(
      /intercepted by the agentic loop/,
    );
  });

  it('accepts a createAgent() value and honours describe()', () => {
    const model = createMockModel({ responses: [] });
    const support = createAgent({
      name: 'support-agent',
      model,
      instructions: 'Be kind.',
      tools: { note: noteTool(() => 'ok') },
      maxSteps: 4,
    });
    const tools = handoff({ support }, { describe: (name) => `Specialist for ${name} matters.` });

    const meta = readHandoffTarget(tools.transfer_to_support!)!;
    expect(meta.name).toBe('support'); // the RECORD KEY names the transfer
    expect(meta.def.model).toBe(model);
    expect(meta.def.instructions).toBe('Be kind.');
    expect(meta.def.tools).toEqual(support.def.tools);
    // Only the four transferable fields cross over — never the whole AgentDef.
    expect(Object.keys(meta.def).sort()).toEqual(['instructions', 'model', 'name', 'tools']);
    expect(tools.transfer_to_support!.description).toBe(
      "Transfer the conversation to the 'support' agent. Specialist for support matters.",
    );
  });
});

// ===================================================================
// The buffered loop
// ===================================================================

describe('handoff × generateText', () => {
  it('swaps the system prompt, the model and the tool set for the rest of the run', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_billing', args: { reason: 'wants a refund' } }] },
    ]);
    const billingModel = rec.model('billing-model', [{ text: 'Refund issued.' }]);
    const supportModel = rec.model('support-model', [{ text: 'unused' }]);
    const seen: unknown[] = [];

    const agents = handoff(
      {
        billing: {
          model: billingModel,
          instructions: 'You are the billing agent.',
          tools: { refund: noteTool(() => 'refunded') },
        },
        support: { model: supportModel, instructions: 'You are support.' },
      },
      { onHandoff: (info) => seen.push(info) },
    );

    const res = await generateText({
      model: triage,
      instructions: 'Route the user to a specialist.',
      messages: [{ role: 'user', content: 'refund please' }],
      tools: { ...agents, search: noteTool(() => 'nothing') },
      maxSteps: 5,
    });

    expect(rec.models()).toEqual(['triage-model', 'billing-model']);
    expect(res.text).toBe('Refund issued.');

    // Step 1 — the ROOT agent: its own instructions, its own tools, every transfer.
    const first = rec.calls[0]!.body;
    expect(systemOf(first)).toBe('Route the user to a specialist.');
    expect(toolNamesOf(first)).toEqual(['search', 'transfer_to_billing', 'transfer_to_support']);

    // Step 2 — BILLING drives: its instructions REPLACED the root's (not appended
    // to), its own tools are on the wire, the root's `search` is gone, and it
    // cannot transfer to itself while it still can transfer onward.
    const second = rec.calls[1]!.body;
    expect(second.model).toBe('billing-model');
    expect(systemOf(second)).toBe('You are the billing agent.');
    expect(toolNamesOf(second)).toEqual(['refund', 'transfer_to_support']);

    // Every tool_use is answered — including the transfer itself.
    const history = res.response.messages;
    expect(answeredIds(history)).toEqual(calledIds(history));
    const transferId = calledIds(history)[0]!;
    expect(toolResultText(history, transferId)).toBe("Transferred to 'billing'. wants a refund");

    // The system REWRITE never enters the caller's response delta.
    expect(history.some((m) => m.role === 'system')).toBe(false);

    expect(deuz(res.providerMetadata).handoffs).toEqual([
      { to: 'billing', toolCallId: transferId, reason: 'wants a refund', stepIndex: 0 },
    ]);
    // No `from` on the first transfer out of the root agent.
    expect(seen).toEqual([{ to: 'billing', reason: 'wants a refund' }]);
  });

  it('honours a normal tool and a transfer issued in the SAME batch', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      {
        toolCalls: [
          { toolName: 'search', args: { note: 'invoices' } },
          { toolName: 'transfer_to_billing', args: {} },
        ],
      },
    ]);
    const billingModel = rec.model('billing-model', [{ text: 'Done.' }]);
    const search = vi.fn(() => 'found 3 invoices');

    const res = await generateText({
      model: triage,
      messages: [{ role: 'user', content: 'invoices?' }],
      tools: {
        ...handoff({ billing: { model: billingModel, instructions: 'Billing here.' } }),
        search: noteTool(search),
      },
      maxSteps: 5,
    });

    // The normal tool RAN, and the transfer still happened.
    expect(search).toHaveBeenCalledTimes(1);
    expect(rec.models()).toEqual(['triage-model', 'billing-model']);
    const history = res.response.messages;
    const ids = calledIds(history);
    expect(answeredIds(history)).toEqual(ids); // model order preserved
    expect(toolResultText(history, ids[0]!)).toBe('found 3 invoices');
    expect(toolResultText(history, ids[1]!)).toBe("Transferred to 'billing'.");
    expect(res.steps![0]!.toolCalls.map((c) => c.toolName)).toEqual([
      'search',
      'transfer_to_billing',
    ]);
  });

  it('applies only the FIRST of two transfers in one batch and answers the sibling', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      {
        toolCalls: [
          { toolName: 'transfer_to_billing', args: { reason: 'refund' } },
          { toolName: 'transfer_to_support', args: { reason: 'or maybe support' } },
        ],
      },
    ]);
    const billingModel = rec.model('billing-model', [{ text: 'Billing took it.' }]);
    const supportModel = rec.model('support-model', [{ text: 'never' }]);

    const res = await generateText({
      model: triage,
      messages: [{ role: 'user', content: 'help' }],
      tools: handoff({
        billing: { model: billingModel, instructions: 'Billing.' },
        support: { model: supportModel, instructions: 'Support.' },
      }),
      maxSteps: 5,
    });

    expect(rec.models()).toEqual(['triage-model', 'billing-model']);
    const history = res.response.messages;
    const ids = calledIds(history);
    expect(answeredIds(history)).toEqual(ids); // BOTH ids answered
    expect(toolResultText(history, ids[0]!)).toBe("Transferred to 'billing'. refund");
    expect(toolResultText(history, ids[1]!)).toBe(
      "Ignored: already transferred to 'billing' this step.",
    );
    expect(deuz(res.providerMetadata).handoffs).toHaveLength(1);
  });

  it('self-heals past maxHandoffs instead of transferring (and keeps running)', async () => {
    const rec = recorder();
    // Explicit ids: every mock model numbers its own calls from `call_1`, and
    // this run has two DIFFERENT models issuing a transfer.
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_alpha', args: {}, id: 'h1' }] },
    ]);
    const alphaModel = rec.model('alpha-model', [
      { toolCalls: [{ toolName: 'transfer_to_beta', args: {}, id: 'h2' }] },
      { text: 'Fine, I will handle it.' },
    ]);
    const betaModel = rec.model('beta-model', [{ text: 'never reached' }]);

    const res = await generateText({
      model: triage,
      messages: [{ role: 'user', content: 'go' }],
      tools: handoff(
        {
          alpha: { model: alphaModel, instructions: 'Alpha.' },
          beta: { model: betaModel, instructions: 'Beta.' },
        },
        { maxHandoffs: 1 },
      ),
      maxSteps: 5,
    });

    // The SECOND transfer never happened — alpha kept the run.
    expect(rec.models()).toEqual(['triage-model', 'alpha-model', 'alpha-model']);
    expect(res.text).toBe('Fine, I will handle it.');
    expect(systemOf(rec.calls[2]!.body)).toBe('Alpha.');
    const history = res.response.messages;
    expect(calledIds(history)).toEqual(['h1', 'h2']);
    expect(answeredIds(history)).toEqual(['h1', 'h2']);
    expect(toolResultText(history, 'h1')).toBe("Transferred to 'alpha'.");
    expect(toolResultText(history, 'h2')).toBe('Handoff limit (1) reached; continue yourself.');
    expect(deuz(res.providerMetadata).handoffs).toEqual([
      { to: 'alpha', toolCallId: 'h1', stepIndex: 0 },
    ]);
  });

  it('lets a transferred-to agent hand BACK (the transfer catalog is root-sourced)', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_alpha', args: {} }] },
    ]);
    const alphaModel = rec.model('alpha-model', [
      { toolCalls: [{ toolName: 'transfer_to_beta', args: {} }] },
      { text: 'Alpha again, finishing.' },
    ]);
    const betaModel = rec.model('beta-model', [
      { toolCalls: [{ toolName: 'transfer_to_alpha', args: { reason: 'back to you' } }] },
    ]);

    const res = await generateText({
      model: triage,
      messages: [{ role: 'user', content: 'go' }],
      tools: handoff({
        alpha: { model: alphaModel, instructions: 'Alpha.' },
        beta: { model: betaModel, instructions: 'Beta.' },
      }),
      maxSteps: 6,
    });

    expect(rec.models()).toEqual(['triage-model', 'alpha-model', 'beta-model', 'alpha-model']);
    // Beta could still see `transfer_to_alpha` — it was never dropped from the
    // catalog, only from ALPHA's own set.
    expect(toolNamesOf(rec.calls[2]!.body)).toEqual(['transfer_to_alpha']);
    expect(toolNamesOf(rec.calls[3]!.body)).toEqual(['transfer_to_beta']);
    expect(systemOf(rec.calls[3]!.body)).toBe('Alpha.');
    expect(res.text).toBe('Alpha again, finishing.');
    const log = deuz(res.providerMetadata).handoffs as { from?: string; to: string }[];
    expect(log.map((h) => [h.from, h.to])).toEqual([
      [undefined, 'alpha'],
      ['alpha', 'beta'],
      ['beta', 'alpha'],
    ]);
  });

  it('leaves prepareStep the LAST word on the model after a transfer', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_alpha', args: {} }] },
    ]);
    const alphaModel = rec.model('alpha-model', [{ text: 'never used' }]);
    const overrideModel = rec.model('override-model', [{ text: 'from the override' }]);
    const seenModels: string[] = [];

    const res = await generateText({
      model: triage,
      messages: [{ role: 'user', content: 'go' }],
      tools: handoff({ alpha: { model: alphaModel, instructions: 'Alpha.' } }),
      maxSteps: 4,
      prepareStep: ({ stepIndex }) => {
        seenModels.push(String(stepIndex));
        return stepIndex === 1 ? { model: overrideModel } : undefined;
      },
    });

    expect(rec.models()).toEqual(['triage-model', 'override-model']);
    expect(res.text).toBe('from the override');
    // The SYSTEM swap still applied — only the model was overridden.
    expect(systemOf(rec.calls[1]!.body)).toBe('Alpha.');
    expect(seenModels).toEqual(['0', '1']);
  });

  it('removes the system turn when the target declares no instructions', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_plain', args: {} }] },
    ]);
    const plainModel = rec.model('plain-model', [{ text: 'ok' }]);

    await generateText({
      model: triage,
      instructions: 'Root rules.',
      messages: [{ role: 'user', content: 'go' }],
      tools: handoff({ plain: { model: plainModel } }),
      maxSteps: 4,
    });

    expect(systemOf(rec.calls[0]!.body)).toBe('Root rules.');
    expect(systemOf(rec.calls[1]!.body)).toBe(''); // gone, not inherited
  });
});

// ===================================================================
// The streaming loop
// ===================================================================

describe('handoff × streamChat', () => {
  it('emits a handoff part before the next step-start and reports it on finish', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_billing', args: { reason: 'refund' } }] },
    ]);
    const billingModel = rec.model('billing-model', [{ text: 'Refunded.' }]);
    const seen: unknown[] = [];

    const result = streamChat({
      model: triage,
      instructions: 'Route.',
      messages: [{ role: 'user', content: 'refund' }],
      tools: handoff(
        {
          billing: {
            model: billingModel,
            instructions: 'Billing agent.',
            tools: { refund: noteTool(() => 'ok') },
          },
        },
        { onHandoff: (info) => seen.push(info) },
      ),
      maxSteps: 5,
    });
    const parts = await collect(result.fullStream);

    const types = parts.map((p) => p.type);
    const handoffAt = types.indexOf('handoff');
    expect(handoffAt).toBeGreaterThan(-1);
    // It precedes the NEXT step-start (and follows the transfer's tool-result).
    expect(types.lastIndexOf('step-start')).toBeGreaterThan(handoffAt);
    expect(types.lastIndexOf('tool-result')).toBeLessThan(handoffAt);

    const part = parts[handoffAt] as Extract<StreamPart, { type: 'handoff' }>;
    expect(part).toEqual({
      type: 'handoff',
      to: 'billing',
      toolCallId: 'call_1',
      reason: 'refund',
      stepIndex: 0,
    });

    // The transfer is an ordinary completed call for a UI.
    const state = parts.filter(
      (p): p is Extract<StreamPart, { type: 'tool-state' }> => p.type === 'tool-state',
    );
    expect(state.map((s) => s.state)).toEqual(['input-streaming', 'input-complete', 'complete']);

    const finish = parts.find(
      (p): p is Extract<StreamPart, { type: 'finish' }> => p.type === 'finish',
    )!;
    expect(deuz(finish.providerMetadata).handoffs).toEqual([
      { to: 'billing', toolCallId: 'call_1', reason: 'refund', stepIndex: 0 },
    ]);
    expect(seen).toEqual([{ to: 'billing', reason: 'refund' }]);

    // Same swap the buffered loop performs (the loop-symmetry invariant).
    expect(rec.models()).toEqual(['triage-model', 'billing-model']);
    expect(systemOf(rec.calls[1]!.body)).toBe('Billing agent.');
    expect(toolNamesOf(rec.calls[1]!.body)).toEqual(['refund']);
  });

  it('never executes the transfer tool, and still runs the batch mates', async () => {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      {
        toolCalls: [
          { toolName: 'transfer_to_alpha', args: {} },
          { toolName: 'search', args: { note: 'x' } },
        ],
      },
    ]);
    const alphaModel = rec.model('alpha-model', [{ text: 'alpha done' }]);
    const search = vi.fn(() => 'hit');

    const result = streamChat({
      model: triage,
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        ...handoff({ alpha: { model: alphaModel, instructions: 'Alpha.' } }),
        search: noteTool(search),
      },
      maxSteps: 5,
    });
    const parts = await collect(result.fullStream);

    expect(search).toHaveBeenCalledTimes(1);
    const results = parts.filter(
      (p): p is Extract<StreamPart, { type: 'tool-result' }> => p.type === 'tool-result',
    );
    // Model order preserved: the transfer was issued first.
    expect(results.map((r) => [r.toolName, r.output])).toEqual([
      ['transfer_to_alpha', "Transferred to 'alpha'."],
      ['search', 'hit'],
    ]);
    // No 'executing' state for the transfer — it is intercepted, never run.
    const executing = parts.filter(
      (p) => p.type === 'tool-state' && p.state === 'executing',
    ) as Extract<StreamPart, { type: 'tool-state' }>[];
    expect(executing.map((p) => p.toolName)).toEqual(['search']);
    expect(await result.finishReason).toBe('stop');
  });
});

// ===================================================================
// Durable resume
// ===================================================================

describe('handoff × durable resume', () => {
  /** Leg 1: transfer to alpha, then suspend on a client-mode approval. */
  async function suspendInsideAlpha(): Promise<{
    store: ReturnType<typeof createInMemorySessionStore>;
    runId: string;
    approvalId: string;
  }> {
    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_alpha', args: {} }] },
    ]);
    const alphaModel = rec.model('alpha-model', [
      { toolCalls: [{ toolName: 'wire', args: { note: '1000' } }] },
    ]);
    const store = createInMemorySessionStore();
    const res = await generateText({
      model: triage,
      instructions: 'Root.',
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        ...handoff({
          alpha: {
            model: alphaModel,
            instructions: 'Alpha rules.',
            tools: {
              wire: { ...noteTool(() => 'sent'), needsApproval: true },
            },
          },
        }),
      },
      maxSteps: 5,
      session: { store },
    });
    expect(res.pendingApprovals).toHaveLength(1);
    return { store, runId: res.runId!, approvalId: res.pendingApprovals![0]!.approvalId };
  }

  it('checkpoints the active agent and re-applies the overlay on resume', async () => {
    const { store, runId, approvalId } = await suspendInsideAlpha();

    const checkpoint = (await store.load(runId))!;
    expect(checkpoint.status).toBe('suspended');
    expect(checkpoint.handoff).toEqual({ to: 'alpha', count: 1 });
    // The target's system prompt lives in the checkpointed history — that is why
    // the resume overlay only has to restore the model and the tools.
    expect(checkpoint.messages[0]).toEqual({ role: 'system', content: 'Alpha rules.' });

    const rec = recorder();
    const rootModel = rec.model('triage-model-2', [{ text: 'root should not answer' }]);
    const alphaModel = rec.model('alpha-model-2', [{ text: 'Wired, all done.' }]);
    const wire = vi.fn(() => 'sent 1000');

    const resumed = await resumeFromCheckpoint(store, runId, {
      model: rootModel,
      tools: handoff({
        alpha: {
          model: alphaModel,
          instructions: 'Alpha rules.',
          tools: { wire: { ...noteTool(wire), needsApproval: true } },
        },
      }),
      maxSteps: 5,
      approvalResponses: [{ approvalId, approved: true }],
    });

    expect(wire).toHaveBeenCalledTimes(1);
    // The leg continued AS ALPHA: alpha's model, alpha's tools, alpha's system.
    expect(rec.models()).toEqual(['alpha-model-2']);
    expect(systemOf(rec.calls[0]!.body)).toBe('Alpha rules.');
    expect(toolNamesOf(rec.calls[0]!.body)).toEqual(['wire']);
    expect(resumed.text).toBe('Wired, all done.');
    // The budget survives the leg boundary.
    expect((await store.load(runId))!.handoff).toEqual({ to: 'alpha', count: 1 });
  });

  it('re-applies the overlay on a STREAMING resume too (the deferred load path)', async () => {
    const { store, runId, approvalId } = await suspendInsideAlpha();
    const rec = recorder();
    const rootModel = rec.model('triage-model-3', [{ text: 'root should not answer' }]);
    const alphaModel = rec.model('alpha-model-3', [{ text: 'Streamed to the end.' }]);

    const result = resumeStreamFromCheckpoint(store, runId, {
      model: rootModel,
      tools: handoff({
        alpha: {
          model: alphaModel,
          instructions: 'Alpha rules.',
          tools: { wire: { ...noteTool(() => 'sent 1000'), needsApproval: true } },
        },
      }),
      maxSteps: 5,
      approvalResponses: [{ approvalId, approved: true }],
    });
    const parts = await collect(result.fullStream);

    expect(rec.models()).toEqual(['alpha-model-3']);
    expect(systemOf(rec.calls[0]!.body)).toBe('Alpha rules.');
    expect(toolNamesOf(rec.calls[0]!.body)).toEqual(['wire']);
    expect(
      parts
        .filter((p) => p.type === 'text-delta')
        .map((p) => p.text)
        .join(''),
    ).toBe('Streamed to the end.');
    // A resumed leg re-applies an EXISTING transfer; it does not perform a new
    // one, so nothing new is announced.
    expect(parts.some((p) => p.type === 'handoff')).toBe(false);
  });

  it('warns and continues with the root agent when the transfer tool is gone', async () => {
    const { store, runId, approvalId } = await suspendInsideAlpha();
    const rec = recorder();
    const rootModel = rec.model('root-model-2', [{ text: 'root carried on' }]);
    const logger = spyLogger();

    const resumed = await resumeFromCheckpoint(store, runId, {
      model: rootModel,
      // No handoff() this time — the call site changed shape between legs.
      tools: { wire: { ...noteTool(() => 'sent'), needsApproval: true } },
      maxSteps: 5,
      approvalResponses: [{ approvalId, approved: true }],
      deps: { logger },
    });

    expect(logger.warnings.some((w) => w.includes("handed off to 'alpha'"))).toBe(true);
    expect(rec.models()).toEqual(['root-model-2']);
    expect(resumed.text).toBe('root carried on');
    // Degraded but honest: the run still remembers WHO it was and what it spent.
    expect((await store.load(runId))!.handoff).toEqual({ to: 'alpha', count: 1 });
  });
});

// ===================================================================
// Composition risk flagged by the plan: handoff × memory recall
// ===================================================================

describe('handoff × memory recall', () => {
  it('splices the recall block into the TARGET agent system turn', async () => {
    const now = 1_700_000_000_000;
    const store = createInMemoryMemoryStore();
    const record: MemoryRecord = {
      id: 'm1',
      text: 'User prefers dark roast coffee',
      hash: 'h:m1',
      kind: 'semantic',
      scope: { userId: 'u1' },
      createdAt: now,
      updatedAt: now,
      validAt: now,
    };
    await store.upsert([record]);
    const seams: MemorySeams = {
      store,
      // `extract: false` below, so the pipeline LLM is never reached — the seam
      // is required by the type, not by this test.
      llm: async () => '{"facts": []}',
      clock: { now: () => now, setTimeout: (fn) => (setTimeout(fn, 0), () => {}) },
      generateId: () => 'mem-0',
      hashFn: async (t: string) => `h:${t}`,
    };

    const rec = recorder();
    const triage = rec.model('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_barista', args: {} }] },
    ]);
    const baristaModel = rec.model('barista-model', [{ text: 'One dark roast.' }]);

    const res = await generateText({
      model: triage,
      instructions: 'Route the order.',
      messages: [{ role: 'user', content: 'coffee please' }],
      tools: handoff({
        barista: { model: baristaModel, instructions: 'You are the barista.' },
      }),
      memory: { seams, scope: { userId: 'u1' }, extract: false },
      maxSteps: 4,
    });

    expect(res.text).toBe('One dark roast.');
    // Before the transfer: the root instructions PLUS the recall block.
    const first = systemOf(rec.calls[0]!.body);
    expect(first).toContain('Route the order.');
    expect(first).toContain('dark roast');
    // After it: the TARGET's instructions plus the SAME recall block — the root
    // system prompt is gone, and the memory context did not evaporate with it.
    const second = systemOf(rec.calls[1]!.body);
    expect(second.startsWith('You are the barista.')).toBe(true);
    expect(second).toContain('dark roast');
    expect(second).not.toContain('Route the order.');
    // The recall block is still call-site-only: it never entered the history.
    const history = res.response.messages;
    expect(history.some((m) => m.role === 'system')).toBe(false);
    expect(JSON.stringify(history)).not.toContain('User prefers dark roast coffee');
  });
});

/** A tiny type-level guard: the def shape stays assignable both ways. */
const _def: HandoffAgentDef = { model: createMockModel({ responses: [] }) };
void _def;
