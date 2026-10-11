/**
 * native-fallback.test.ts (2.3, 23.4) — `fallbackModels` inside a native run:
 * one failed model call is repeated on the next candidate, inside the same
 * run, budget and checkpoint; completed tool effects never run again; the
 * checkpoint records every fail-over; refusals, policy, budget and validation
 * rejections and errors after content never fail over. Provider behaviour is
 * scripted from the wire shapes; not live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent, streamAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import { createExecutionContext } from '../src/execution-policy';
import type {
  AgentEvent,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
} from '../src/types/agent-run';
import {
  badRequest,
  claudeTurn,
  openaiTurn,
  overloaded,
  scriptedFetch,
  serverError,
  type ScriptStep,
} from './fixtures/wire-turns';
import { sseEvents } from './fixtures/sse';

const parameters = { type: 'object', properties: {} };
type Resumable = AgentRunOptions & { session: AgentRunSession };

function claude(id: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createAnthropic({ apiKey: 'a', fetch: wire.fetch })(id), wire };
}
function gpt(id: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createOpenAI({ apiKey: 'b', fetch: wire.fetch })(id), wire };
}

const lookupTurn = claudeTurn(
  [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{}' }],
  'tool_use',
);
const ref = (provider: string, protocol: string, modelId: string) => ({
  provider,
  protocol,
  modelId,
});

async function events(options: AgentRunOptions) {
  const stream = streamAgent(options);
  const seen: AgentEvent[] = [];
  for await (const event of stream.events) seen.push(event as AgentEvent);
  return { seen, result: await stream.result };
}

describe('native fail-over: one call, same run', () => {
  it('a model error after a tool effect repeats the call on the fallback, never the effect', async () => {
    const primary = claude('claude-opus-5-5', [lookupTurn, overloaded]);
    const fallback = gpt('gpt-5.2', [openaiTurn({ text: 'answer from B' })]);
    const execute = vi.fn(() => 'the value');
    const store = createInMemoryAgentRunStore();
    const { seen, result } = await events({
      model: primary.model,
      fallbackModels: [fallback.model],
      maxRetries: 0,
      prompt: 'look it up',
      session: { store, runId: 'hop', scope: 'tenant' },
      tools: { lookup: { parameters, execute } },
    });
    expect(result).toMatchObject({ status: 'completed', runId: 'hop', output: 'answer from B' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(primary.wire.calls()).toBe(2);
    expect(fallback.wire.calls()).toBe(1);
    // The fallback continued the same history: the tool result is in it.
    expect(JSON.stringify(fallback.wire.bodies[0]!.messages)).toContain('the value');
    // The failed call never reached the stream as an error; a warning says what happened.
    expect(seen.some((event) => event.type === 'part' && event.part.type === 'error')).toBe(false);
    expect(
      seen.find(
        (event) =>
          event.type === 'part' &&
          event.part.type === 'warning' &&
          event.part.warning.setting === 'fallbackModels',
      ),
    ).toBeDefined();
    const envelope = (await store.load('hop'))!;
    expect(envelope.version).toBe(2);
    expect(envelope.models).toEqual({
      policy: 1,
      selected: ref('openai', 'chat_completions', 'gpt-5.2'),
      attempts: [
        {
          attempt: 1,
          model: ref('anthropic', 'anthropic', 'claude-opus-5-5'),
          next: ref('openai', 'chat_completions', 'gpt-5.2'),
          modelStep: 2,
          phase: 'running',
          error: expect.objectContaining({ code: 'overloaded' }),
        },
      ],
    });
  });

  it('the failed model stays skipped for later steps and after a resume', async () => {
    const primary = claude('claude-opus-5-5', [lookupTurn, overloaded]);
    const fallback = gpt('gpt-5.2', [
      openaiTurn({ toolCalls: [{ id: 'call_g', name: 'gate', json: '{}' }] }),
      openaiTurn({ text: 'done' }),
    ]);
    const options: Resumable = {
      model: primary.model,
      fallbackModels: [fallback.model],
      maxRetries: 0,
      prompt: 'work',
      session: { store: createInMemoryAgentRunStore(), runId: 'sticky', scope: 'tenant' },
      tools: {
        lookup: { parameters, execute: () => 'v' },
        gate: { parameters, needsApproval: true, execute: () => 'ok' },
      },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') throw new Error(`expected suspension, got ${first.status}`);
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: first.pendingApprovals[0]!.approvalId, approved: true }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(primary.wire.calls()).toBe(2);
    expect(fallback.wire.calls()).toBe(2);
  });

  it('every candidate failing ends the run with the last error', async () => {
    const primary = claude('claude-opus-5-5', [overloaded]);
    const second = gpt('gpt-5.2', [serverError]);
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: primary.model,
      fallbackModels: [second.model],
      maxRetries: 0,
      prompt: 'x',
      session: { store, runId: 'exhausted', scope: 'tenant' },
    });
    // The fallback's own 500, not the primary's 529.
    expect(result).toMatchObject({ status: 'failed', error: { code: 'api_call_error' } });
    expect((await store.load('exhausted'))!.models?.attempts).toHaveLength(1);
  });
});

describe('native fail-over: what never fails over', () => {
  it('a refusal, a validation rejection and an error after content stay final', async () => {
    const midStream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Half' },
        },
      },
      { event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'died' } } },
    ]);
    const cases: [ScriptStep, Record<string, unknown>][] = [
      [
        claudeTurn([{ type: 'text', text: 'I can’t.' }], 'refusal'),
        { status: 'stopped', reason: 'refusal' },
      ],
      [badRequest, { status: 'failed' }],
      [midStream, { status: 'failed' }],
    ];
    for (const [step, outcome] of cases) {
      const primary = claude('claude-opus-5-5', [step]);
      const fallback = gpt('gpt-5.2', [openaiTurn({ text: 'never' })]);
      const result = await runAgent({
        model: primary.model,
        fallbackModels: [fallback.model],
        maxRetries: 0,
        prompt: 'x',
      });
      expect(result).toMatchObject(outcome);
      expect(fallback.wire.calls()).toBe(0);
    }
  });
});

describe('native fail-over: model change rules', () => {
  const thinkingTurn = claudeTurn(
    [
      { type: 'thinking', signature: 'SIG-0' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{}' },
    ],
    'tool_use',
  );

  it('forwards Claude thinking blocks unchanged to another Claude model', async () => {
    const primary = claude('claude-opus-5-5', [thinkingTurn, overloaded]);
    const sibling = claude('claude-sonnet-5-5', [claudeTurn([{ type: 'text', text: 'ok' }])]);
    await runAgent({
      model: primary.model,
      fallbackModels: [sibling.model],
      maxRetries: 0,
      prompt: 'q',
      tools: { lookup: { parameters, execute: () => 'v' } },
    });
    const sent = sibling.wire.bodies[0]!.messages as { role: string; content: unknown }[];
    expect(sent[1]!.content).toEqual(
      (primary.wire.bodies[1]!.messages as { content: unknown }[])[1]!.content,
    );
    expect(JSON.stringify(sent[1]!.content)).toContain('SIG-0');
  });

  it('never replays Claude reasoning to another provider', async () => {
    const primary = claude('claude-opus-5-5', [thinkingTurn, overloaded]);
    const other = gpt('gpt-5.2', [openaiTurn({ text: 'ok' })]);
    await runAgent({
      model: primary.model,
      fallbackModels: [other.model],
      maxRetries: 0,
      prompt: 'q',
      tools: { lookup: { parameters, execute: () => 'v' } },
    });
    expect(JSON.stringify(other.wire.bodies[0])).not.toContain('SIG-0');
    expect(JSON.stringify(other.wire.bodies[0])).toContain('Checking.');
  });

  it('carries the capabilities override and builds the request for the new model', async () => {
    const primary = gpt('gpt-4.1', [serverError]);
    const unknownClaude = claude('claude-custom-b', [claudeTurn([{ type: 'text', text: 'ok' }])]);
    await runAgent({
      model: primary.model,
      fallbackModels: [unknownClaude.model],
      capabilities: { maxOutput: 32_000 },
      maxRetries: 0,
      prompt: 'q',
    });
    expect(unknownClaude.wire.bodies[0]!.max_tokens).toBe(32_000);
    // Claude 5.x rejects sampling: the fallback's own profile drops what the primary took.
    const sampled = gpt('gpt-4.1', [serverError]);
    const opus = claude('claude-opus-5-5', [claudeTurn([{ type: 'text', text: 'ok' }])]);
    await runAgent({
      model: sampled.model,
      fallbackModels: [opus.model],
      temperature: 0.3,
      maxRetries: 0,
      prompt: 'q',
    });
    expect(sampled.wire.bodies[0]!.temperature).toBe(0.3);
    expect(opus.wire.bodies[0]!.temperature).toBeUndefined();
  });

  it('finalization fails over and keeps its F15 shape on the new model', async () => {
    const primary = claude('claude-opus-5-5', [
      lookupTurn,
      claudeTurn([{ type: 'text', text: 'draft' }]),
      overloaded,
    ]);
    const sibling = claude('claude-sonnet-5-5', [
      claudeTurn([{ type: 'text', text: '{"answer":1}' }]),
    ]);
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: primary.model,
      fallbackModels: [sibling.model],
      maxRetries: 0,
      maxOutputAttempts: 1,
      prompt: 'q',
      session: { store, runId: 'final-hop', scope: 'tenant' },
      tools: { lookup: { parameters, execute: () => 'v' } },
      output: {
        schema: { type: 'object', properties: { answer: { type: 'number' } } },
        mode: 'json',
        validate: (value) => value as { answer: number },
      },
    });
    expect(result).toMatchObject({ status: 'completed', output: { answer: 1 } });
    const body = sibling.wire.bodies[0]! as {
      messages: { role: string }[];
      tools?: unknown[];
      tool_choice?: unknown;
    };
    expect(body.messages.at(-1)!.role).toBe('user');
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect((await store.load('final-hop'))!.models!.attempts[0]).toMatchObject({
      phase: 'finalizing',
      model: { modelId: 'claude-opus-5-5' },
      next: { modelId: 'claude-sonnet-5-5' },
    });
  });
});

describe('native fail-over: budget, policy and binding', () => {
  it('counts the failed attempt in the shared budget and never exceeds it', async () => {
    const primary = claude('claude-opus-5-5', [overloaded]);
    const fallback = gpt('gpt-5.2', [openaiTurn({ text: 'never' })]);
    const result = await runAgent({
      model: primary.model,
      fallbackModels: [fallback.model],
      maxRetries: 0,
      prompt: 'x',
      budget: { tokens: 20 },
      executionEstimate: { tokens: 15 },
    });
    // The failed call's hold is kept, so the fallback's call no longer fits.
    expect(result.status).toBe('failed');
    expect(result.accounting?.committed.tokens).toBe(15);
    expect(fallback.wire.calls()).toBe(0);
  });

  it('a child run spends its failed attempt in the parent ledger and obeys the parent policy', async () => {
    const root = createExecutionContext({
      policy: { allowedModels: ['claude-opus-5-5', 'gpt-5.2'] },
    });
    const primary = claude('claude-opus-5-5', [overloaded]);
    const allowed = gpt('gpt-5.2', [openaiTurn({ text: 'child done' })]);
    const child = await runAgent({
      model: primary.model,
      fallbackModels: [allowed.model],
      maxRetries: 0,
      prompt: 'child',
      execution: root.child({ scopeId: 'child' }),
      executionEstimate: { tokens: 10 },
    });
    expect(child).toMatchObject({ status: 'completed', output: 'child done' });
    // Both attempts reserved against the parent's ledger: nothing was dropped.
    const reservations = root.ledger.snapshot().reservations;
    expect(reservations.map((item) => item.modelId).sort()).toEqual(['claude-opus-5-5', 'gpt-5.2']);

    const refused = claude('claude-opus-5-5', [overloaded]);
    const forbidden = gpt('gpt-4.1', [openaiTurn({ text: 'never' })]);
    const second = await runAgent({
      model: refused.model,
      fallbackModels: [forbidden.model],
      maxRetries: 0,
      prompt: 'child',
      execution: root.child({ scopeId: 'second' }),
    });
    expect(second.status).toBe('failed');
    expect(forbidden.wire.calls()).toBe(0);
  });

  it('refuses a resume whose fallback models changed', async () => {
    const primary = claude('claude-opus-5-5', [lookupTurn]);
    const options: Resumable = {
      model: primary.model,
      fallbackModels: [gpt('gpt-5.2', []).model],
      prompt: 'x',
      session: { store: createInMemoryAgentRunStore(), runId: 'bound', scope: 'tenant' },
      tools: { lookup: { parameters, needsApproval: true, execute: () => 'v' } },
    };
    expect((await runAgent(options)).status).toBe('suspended');
    for (const fallbackModels of [[gpt('gpt-5.1', []).model], [], undefined])
      expect(await resumeAgent({ ...options, fallbackModels })).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('binding changed') },
      });
  });

  it('records nothing and stays version 1 while no call failed', async () => {
    const store: AgentRunStore = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: claude('claude-opus-5-5', [claudeTurn([{ type: 'text', text: 'ok' }])]).model,
      fallbackModels: [gpt('gpt-5.2', []).model],
      prompt: 'x',
      session: { store, runId: 'calm', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    const envelope = (await store.load('calm'))!;
    expect(envelope.models).toBeUndefined();
    expect(envelope.version).toBe(1);
  });
});
