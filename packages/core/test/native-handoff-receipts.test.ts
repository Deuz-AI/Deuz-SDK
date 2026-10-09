/**
 * native-handoff-receipts.test.ts (2.3) — two native-dispatch defects that let a
 * call escape, or wrongly block, the effect-receipt boundary:
 *
 * - `prepareAgentTools` rebuilt every tool with an object spread, which drops the
 *   NON-ENUMERABLE `HANDOFF_TARGET` marker. A native run therefore never saw a
 *   transfer tool: the model's `transfer_to_*` call ran the deliberately throwing
 *   body instead of handing the run over.
 * - A tool whose `execute` threw left its receipt at `executing`, the stage that
 *   means "the outcome is unknown". The loop had already self-healed the error
 *   into an `is_error` result, yet a later resume stopped with
 *   `tool-reconciliation-required`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, streamAgent } from '../src/agent-run';
import { handoff, readHandoffTarget, HANDOFF_TARGET } from '../src/inference/handoff';
import { prepareAgentTools } from '../src/inference/agent-tools';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { ExecutionPersistenceError } from '../src/internal/execution-error';
import { resolveDependencies } from '../src/internal/resolve-deps';
import type { AgentEvent, AgentToolReceipt } from '../src/types/agent-run';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';

const parameters = { type: 'object' as const, properties: {} };

function counted(modelId: string, responses: MockResponse[]) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  const model: LanguageModel = attachConfig(
    { provider: 'mock', modelId, surface: 'chat_completions' },
    { ...config, fetch },
  );
  return { model, fetch };
}

function toolResults(messages: Message[]): { id: string; result: unknown; isError?: boolean }[] {
  const out: { id: string; result: unknown; isError?: boolean }[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content)
      if (p.type === 'tool_result')
        out.push({ id: p.toolUseId, result: p.result, ...(p.isError ? { isError: true } : {}) });
  }
  return out;
}

describe('native handoff', () => {
  it('keeps the transfer marker through native preparation and wraps target tools', async () => {
    const refund = vi.fn(() => 'refunded');
    const billing = counted('billing-model', [
      { toolCalls: [{ toolName: 'refund', id: 'refund-1', args: {} }] },
      { text: 'Refund issued.' },
    ]);
    const prepared = await prepareAgentTools(
      handoff({
        billing: { model: billing.model, tools: { refund: { parameters, execute: refund } } },
      }),
    );
    const meta = readHandoffTarget(prepared.transfer_to_billing!);
    expect(meta?.name).toBe('billing');
    // The marker stays invisible to keys/JSON, exactly like the original tool's.
    expect(Object.keys(prepared.transfer_to_billing!)).not.toContain(String(HANDOFF_TARGET));
    // The target's own tools enter the same native executor as root tools.
    expect(meta?.def.tools?.refund?.execute).not.toBe(refund);
  });

  it('transfers a native run instead of running the throwing transfer body', async () => {
    const refund = vi.fn(() => 'refunded');
    const triage = counted('triage-model', [
      { toolCalls: [{ toolName: 'transfer_to_billing', id: 'handoff-1', args: {} }] },
    ]);
    const billing = counted('billing-model', [
      { toolCalls: [{ toolName: 'refund', id: 'refund-1', args: {} }] },
      { text: 'Refund issued.' },
    ]);
    const store = createInMemoryAgentRunStore();
    const stream = streamAgent({
      model: triage.model,
      prompt: 'I want my money back.',
      session: { store, runId: 'native-handoff', scope: 'tenant' },
      tools: handoff({
        billing: {
          model: billing.model,
          instructions: 'You handle refunds.',
          tools: { refund: { parameters, execute: refund } },
        },
      }),
    });
    const events: AgentEvent[] = [];
    for await (const event of stream.events) events.push(event);
    const result = await stream.result;

    expect(result).toMatchObject({ status: 'completed', output: 'Refund issued.' });
    expect(triage.fetch).toHaveBeenCalledTimes(1);
    expect(billing.fetch).toHaveBeenCalledTimes(2);
    expect(refund).toHaveBeenCalledTimes(1);
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []));
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'handoff', to: 'billing', toolCallId: 'handoff-1' }),
    );
    const transfer = toolResults(result.messages).find((r) => r.id === 'handoff-1');
    expect(transfer).toEqual({ id: 'handoff-1', result: "Transferred to 'billing'." });
    expect(JSON.stringify(result.messages)).not.toContain('must never execute');
    // The target's tool left a receipt and a native tool-output event.
    const receipts = Object.values((await store.load('native-handoff'))!.toolResults ?? {});
    expect(receipts.map((r) => `${r.toolName}:${r.stage}`)).toEqual(['refund:completed']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-output', toolName: 'refund', rawResult: 'refunded' }),
    );
  });
});

describe('failed receipt stage', () => {
  const context = { toolCallId: 'c1', messages: [], deps: resolveDependencies() };

  it('records a thrown execute as failed and replays the recorded error', async () => {
    const execute = vi.fn(() => {
      throw new Error('upstream said no');
    });
    const saved = new Map<string, AgentToolReceipt>();
    const tools = await prepareAgentTools({ one: { parameters, execute } }, {}, undefined, {
      load: (id) => saved.get(id),
      save: async (receipt) => {
        saved.set(receipt.toolCallId, structuredClone(receipt));
      },
    });
    await expect(tools.one!.execute!({}, context)).rejects.toThrow('upstream said no');
    expect(saved.get('c1')).toMatchObject({ stage: 'failed', error: 'upstream said no' });
    // A replay of the same call reports the same failure without a second effect.
    const replay = tools.one!.execute!({}, context);
    await expect(replay).rejects.toThrow('upstream said no');
    await expect(replay).rejects.not.toMatchObject({ fatalExecution: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps executing for a fatal infrastructure error, whose effect is unknown', async () => {
    const saved = new Map<string, AgentToolReceipt>();
    const tools = await prepareAgentTools(
      {
        one: {
          parameters,
          execute: () => {
            throw new ExecutionPersistenceError('child checkpoint lost');
          },
        },
      },
      {},
      undefined,
      {
        load: (id) => saved.get(id),
        save: async (receipt) => {
          saved.set(receipt.toolCallId, structuredClone(receipt));
        },
      },
    );
    await expect(tools.one!.execute!({}, context)).rejects.toThrow('child checkpoint lost');
    expect(saved.get('c1')?.stage).toBe('executing');
  });

  it('lets a run resume past a tool that already failed and self-healed', async () => {
    const flaky = vi.fn(() => {
      throw new Error('quota exceeded');
    });
    const publish = vi.fn(() => 'published');
    const { model, fetch } = counted('mock-model', [
      { toolCalls: [{ toolName: 'flaky', id: 'flaky-1', args: {} }] },
      { toolCalls: [{ toolName: 'publish', id: 'publish-1', args: {} }] },
      { text: 'done' },
    ]);
    const store = createInMemoryAgentRunStore();
    const options = {
      model,
      prompt: 'work',
      session: { store, runId: 'failed-then-approval', scope: 'tenant' },
      tools: {
        flaky: { parameters, execute: flaky },
        publish: { parameters, execute: publish, needsApproval: true },
      },
    };
    const first = await streamAgent(options).result;
    expect(first.status).toBe('suspended');
    const stored = (await store.load('failed-then-approval'))!;
    expect(Object.values(stored.toolResults ?? {}).map((r) => `${r.toolName}:${r.stage}`)).toEqual([
      'flaky:failed',
    ]);
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: 'publish-1', approved: true }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(flaky).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(toolResults(resumed.messages).find((r) => r.id === 'flaky-1')).toMatchObject({
      isError: true,
    });
  });
});
