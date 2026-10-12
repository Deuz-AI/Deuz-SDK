/**
 * native-memory.test.ts (2.3, 23.4) — built-in memory inside a native run:
 * one recall per run, kept in the checkpoint as an appended `role: 'system'`
 * message (the D1 shape); extraction only for a completed run, under an
 * operation id recorded as pending with the terminal commit and settled in a
 * later save; never again on a terminal resume; scopes that never widen.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  resumeAgent,
  runAgent,
} from '../src/agent-run';
import { createInMemoryMemoryStore, type MemoryRecord, type MemorySeams } from '../src/memory';
import { createExecutionContext } from '../src/execution-policy';
import { createMockModel, type MockResponse } from '../src/testing';
import { readConfig } from '../src/internal/config-symbol';
import type {
  AgentRunEnvelope,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
} from '../src/types/agent-run';
import type { Message } from '../src/types/message';

const parameters = { type: 'object', properties: {} };
type Resumable = AgentRunOptions & { session: AgentRunSession };
const clock = { now: () => 5_000, setTimeout: (fn: () => void) => (fn(), () => {}) };

function mocked(responses: MockResponse[]) {
  const model = createMockModel({ responses });
  const config = readConfig(model)!;
  const fetch = vi.fn(config.fetch!);
  config.fetch = fetch;
  const requests = () =>
    fetch.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { messages: Record<string, unknown>[] },
    );
  return { model, fetch, requests };
}

let ids = 0;
function record(text: string, scope: MemoryRecord['scope'], extra: Partial<MemoryRecord> = {}) {
  return {
    id: `seed-${ids++}`,
    text,
    hash: `h:${text}`,
    kind: 'semantic' as const,
    scope,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

/** Memory seams whose LLM extracts one fact and adds it. */
function memorySeams(seed: MemoryRecord[] = []) {
  const store = createInMemoryMemoryStore();
  void store.upsert(seed);
  const search = vi.spyOn(store, 'search');
  const llm = vi.fn<MemorySeams['llm']>(async ({ system }) =>
    system.includes('extract')
      ? '{"facts":["prefers tea"]}'
      : '{"memory":[{"event":"ADD","text":"prefers tea"}]}',
  );
  let n = 0;
  const seams: MemorySeams = {
    store,
    llm,
    clock,
    generateId: () => `mem-${n++}`,
    hashFn: async (text) => `h:${text}`,
  };
  return { seams, store, search, llm };
}

/** A store that records every saved envelope. */
function recordingStore() {
  const inner = createInMemoryAgentRunStore();
  const saves: AgentRunEnvelope[] = [];
  const store: AgentRunStore = {
    load: inner.load,
    save: async (envelope) => {
      await inner.save(envelope);
      saves.push(structuredClone(envelope));
    },
  };
  return { store, saves, inner };
}

const isRecall = (message: Message | Record<string, unknown>) =>
  (message as Message).role === 'system' &&
  (message as Message).providerMetadata?.deuz !== undefined &&
  ((message as Message).providerMetadata!.deuz as { memoryRecall?: boolean }).memoryRecall === true;

async function rewrite(
  store: AgentRunStore,
  runId: string,
  edit: (envelope: AgentRunEnvelope) => void,
): Promise<void> {
  const envelope = (await store.load(runId))!;
  edit(envelope);
  envelope.revision = (envelope.revision ?? 0) + 1;
  await store.save(envelope);
}

describe('native memory: recall', () => {
  it('recalls once into an appended system message that every step and the resume replay', async () => {
    const memory = memorySeams([record('likes green tea', { userId: 'ada' })]);
    const { model, fetch, requests } = mocked([
      { toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] },
      { text: 'done' },
    ]);
    const { store } = recordingStore();
    const options: Resumable = {
      model,
      prompt: 'what do I drink?',
      memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false },
      session: { store, runId: 'recall-once', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const saved = (await store.load('recall-once'))!;
    expect(saved.version).toBe(2);
    expect(saved.memory?.recall).toEqual({ status: 'recalled', index: 1, count: 1 });
    expect(saved.messages[1]).toEqual({
      role: 'system',
      content: 'Relevant memories:\n- likes green tea',
      providerMetadata: { deuz: { memoryRecall: true } },
    });
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
    expect(memory.search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The recall sits at the same place in both requests: the prefix never moves.
    const [one, two] = requests();
    expect(two!.messages.slice(0, one!.messages.length)).toEqual(one!.messages);
    expect(two!.messages.filter((message) => message.role === 'system')).toHaveLength(1);
  });

  it('recall: false and a recall already answering the last user turn add none', async () => {
    const memory = memorySeams([record('likes green tea', { userId: 'ada' })]);
    const off = await runAgent({
      model: mocked([{ text: 'hi' }]).model,
      prompt: 'hello',
      memory: { seams: memory.seams, scope: { userId: 'ada' }, recall: false, extract: false },
    });
    expect(off.messages.some(isRecall)).toBe(false);
    const replayed = await runAgent({
      model: mocked([{ text: 'hi' }]).model,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'system',
          content: 'Relevant memories:\n- x',
          providerMetadata: { deuz: { memoryRecall: true } },
        },
      ],
      memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false },
    });
    expect(replayed.messages.filter(isRecall)).toHaveLength(1);
    expect(memory.search).not.toHaveBeenCalled();
  });

  it('a failing store is best-effort: the run goes on without memories', async () => {
    const memory = memorySeams();
    memory.search.mockRejectedValueOnce(new Error('vector db down'));
    const { store } = recordingStore();
    const result = await runAgent({
      model: mocked([{ text: 'hi' }]).model,
      prompt: 'hello',
      memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false },
      session: { store, runId: 'recall-fails', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    expect((await store.load('recall-fails'))?.memory?.recall).toEqual({ status: 'failed' });
  });

  it('recalls only the run’s own scope', async () => {
    const memory = memorySeams([
      record('ada drinks tea', { userId: 'ada' }),
      record('bob drinks coffee', { userId: 'bob' }),
    ]);
    const result = await runAgent({
      model: mocked([{ text: 'hi' }]).model,
      prompt: 'what do I drink?',
      memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false },
    });
    const recalled = result.messages.find(isRecall);
    expect(recalled?.content).toContain('ada drinks tea');
    expect(recalled?.content).not.toContain('bob');
  });
});

describe('native memory: extraction', () => {
  it('records the extraction as pending with the terminal commit, then settles it', async () => {
    const memory = memorySeams([record('likes green tea', { userId: 'ada' })]);
    const { store: inner, saves } = recordingStore();
    // How many memories exist when each envelope is saved.
    const sizes: number[] = [];
    const store: AgentRunStore = {
      load: inner.load,
      save: async (envelope) => {
        await inner.save(envelope);
        sizes.push((await memory.store.list({ userId: 'ada' })).length);
      },
    };
    const result = await runAgent({
      model: mocked([{ text: 'noted, tea it is' }]).model,
      prompt: 'I prefer tea',
      memory: { seams: memory.seams, scope: { userId: 'ada' } },
      session: { store, runId: 'extract', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    const terminal = saves.findIndex((envelope) => envelope.phase === 'terminal');
    const pending = saves[terminal]!.memory!.extraction!;
    expect(saves[terminal]!.result?.status).toBe('completed');
    expect(pending).toMatchObject({ status: 'pending', infer: true });
    // Nothing was written to memory before the run's outcome was durable.
    expect(sizes[terminal]).toBe(1);
    const settled = saves.at(-1)!.memory!.extraction!;
    expect(settled).toEqual({ ...pending, status: 'completed', mutations: 1 });
    expect(sizes.at(-1)).toBe(2);
    const written = (await memory.store.list({ userId: 'ada' })).find(
      (memoryRecord) => memoryRecord.text === 'prefers tea',
    );
    expect(written).toMatchObject({
      text: 'prefers tea',
      scope: { userId: 'ada' },
      metadata: { deuz: { runId: 'extract', operationId: pending.operationId } },
    });
    // The extraction reads the user turn and the answer, never the recall message.
    const prompt = memory.llm.mock.calls[0]![0].user;
    expect(prompt).toContain('I prefer tea');
    expect(prompt).toContain('noted, tea it is');
    expect(prompt).not.toContain('likes green tea');
  });

  it('never extracts for a stopped, failed or suspended run', async () => {
    const memory = memorySeams();
    const opts = { seams: memory.seams, scope: { userId: 'ada' } };
    const stopped = await runAgent({
      model: mocked([{ toolCalls: [{ toolName: 'work', args: {} }] }]).model,
      prompt: 'loop',
      maxSteps: 1,
      memory: opts,
      tools: { work: { parameters, execute: () => 'ok' } },
    });
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'max-steps' });
    const failing = mocked([{ text: 'x' }]);
    readConfig(failing.model)!.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 });
    const failed = await runAgent({ model: failing.model, prompt: 'x', memory: opts });
    expect(failed.status).toBe('failed');
    const suspended = await runAgent({
      model: mocked([{ toolCalls: [{ toolName: 'gate', args: {} }] }]).model,
      prompt: 'gate',
      memory: opts,
      session: { store: createInMemoryAgentRunStore(), runId: 's', scope: 't' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    });
    expect(suspended.status).toBe('suspended');
    expect(memory.llm).not.toHaveBeenCalled();
    expect(await memory.store.list({ userId: 'ada' })).toEqual([]);
  });

  it('extract: false and writePolicy manual / session-end write nothing', async () => {
    for (const memoryOptions of [
      { extract: false as const },
      { writePolicy: 'manual' as const },
      { writePolicy: 'session-end' as const },
    ]) {
      const memory = memorySeams();
      const { store } = recordingStore();
      const result = await runAgent({
        model: mocked([{ text: 'ok' }]).model,
        prompt: 'I prefer tea',
        memory: { seams: memory.seams, scope: { userId: 'ada' }, ...memoryOptions },
        session: { store, runId: 'policy', scope: 'tenant' },
      });
      expect(result.status).toBe('completed');
      expect(memory.llm).not.toHaveBeenCalled();
      expect((await store.load('policy'))?.memory?.extraction).toBeUndefined();
    }
  });

  it('sweep: on-extract drops expired records after the extraction', async () => {
    const memory = memorySeams([record('stale', { userId: 'ada' }, { expiresAt: 10 })]);
    await runAgent({
      model: mocked([{ text: 'ok' }]).model,
      prompt: 'I prefer tea',
      memory: { seams: memory.seams, scope: { userId: 'ada' }, recall: false, sweep: 'on-extract' },
    });
    const texts = (await memory.store.list({ userId: 'ada' })).map((r) => r.text);
    expect(texts).toEqual(['prefers tea']);
  });

  it('a terminal resume neither extracts again nor calls a model', async () => {
    const memory = memorySeams();
    const { model, fetch } = mocked([{ text: 'ok' }]);
    const options: Resumable = {
      model,
      prompt: 'I prefer tea',
      memory: { seams: memory.seams, scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'terminal', scope: 'tenant' },
    };
    const first = await runAgent(options);
    const calls = memory.llm.mock.calls.length;
    const searches = memory.search.mock.calls.length;
    const again = await resumeAgent(options);
    expect(again).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(memory.llm).toHaveBeenCalledTimes(calls);
    expect(memory.search).toHaveBeenCalledTimes(searches);
  });
});

describe('native memory: a checkpoint failure after the memory write', () => {
  it('keeps the run completed, never extracts twice, and reconciles without the LLM', async () => {
    const memory = memorySeams();
    const inner = createInMemoryAgentRunStore();
    let failSettle = true;
    const store: AgentRunStore = {
      load: inner.load,
      save: (envelope) => {
        if (failSettle && envelope.memory?.extraction?.status === 'completed')
          throw new Error('disk full');
        return inner.save(envelope);
      },
    };
    const { model, fetch } = mocked([{ text: 'ok' }]);
    const options: Resumable = {
      model,
      prompt: 'I prefer tea',
      memory: { seams: memory.seams, scope: { userId: 'ada' } },
      session: { store, runId: 'settle-fails', scope: 'tenant' },
    };
    const result = await runAgent(options);
    expect(result.status).toBe('completed');
    const stored = (await inner.load('settle-fails'))!;
    expect(stored.result?.status).toBe('completed');
    expect(stored.memory?.extraction?.status).toBe('pending');
    expect(await memory.store.list({ userId: 'ada' })).toHaveLength(1);
    const llmCalls = memory.llm.mock.calls.length;

    // A terminal resume leaves the pending record alone: no model, no extraction.
    expect((await resumeAgent(options)).status).toBe('completed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(memory.llm).toHaveBeenCalledTimes(llmCalls);

    // The explicit reconciliation finds the operation's records and settles it.
    failSettle = false;
    const reconciled = await reconcileAgentRun({
      session: options.session,
      memory: options.memory,
    });
    expect(reconciled).toEqual({ runId: 'settle-fails', memory: 'completed' });
    expect(memory.llm).toHaveBeenCalledTimes(llmCalls);
    expect(await memory.store.list({ userId: 'ada' })).toHaveLength(1);
    expect((await inner.load('settle-fails'))?.memory?.extraction).toMatchObject({
      status: 'completed',
    });
  });

  it('reconciles a pending extraction that never wrote by running it once', async () => {
    const memory = memorySeams();
    const store = createInMemoryAgentRunStore();
    const options: Resumable = {
      model: mocked([{ text: 'ok' }]).model,
      prompt: 'I prefer tea',
      memory: { seams: memory.seams, scope: { userId: 'ada' } },
      session: { store, runId: 'interrupted', scope: 'tenant' },
    };
    await runAgent(options);
    // As if the process died after the terminal commit, before the extraction.
    await rewrite(store, 'interrupted', (envelope) => {
      envelope.memory!.extraction = { ...envelope.memory!.extraction!, status: 'pending' };
      delete envelope.memory!.extraction!.mutations;
    });
    await memory.store.delete((await memory.store.list({ userId: 'ada' })).map((r) => r.id));
    const before = memory.llm.mock.calls.length;
    const reconciled = await reconcileAgentRun({
      session: options.session,
      memory: options.memory,
    });
    expect(reconciled.memory).toBe('completed');
    expect(memory.llm.mock.calls.length).toBe(before + 2);
    expect(await memory.store.list({ userId: 'ada' })).toHaveLength(1);
    // Settled: a second call does nothing.
    await reconcileAgentRun({ session: options.session, memory: options.memory });
    expect(memory.llm.mock.calls.length).toBe(before + 2);
  });
});

describe('native memory: scopes and binding', () => {
  it('fails the run before any call on an empty scope', async () => {
    const memory = memorySeams();
    const { model, fetch } = mocked([{ text: 'x' }]);
    const result = await runAgent({
      model,
      prompt: 'x',
      memory: { seams: memory.seams, scope: {} },
    });
    expect(result.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a resume whose memory scope changed, appeared or disappeared', async () => {
    const memory = memorySeams();
    const store = createInMemoryAgentRunStore();
    const options: Resumable = {
      model: mocked([{ toolCalls: [{ toolName: 'gate', args: {} }] }]).model,
      prompt: 'x',
      memory: { seams: memory.seams, scope: { userId: 'ada' } },
      session: { store, runId: 'bound', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    expect((await runAgent(options)).status).toBe('suspended');
    for (const changed of [
      { ...options, memory: { seams: memory.seams, scope: { userId: 'bob' } } },
      { ...options, memory: undefined },
    ]) {
      expect(await resumeAgent(changed)).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('binding changed') },
      });
    }
    // The same scope in another key order is the same binding.
    const same = await resumeAgent({
      ...options,
      memory: { seams: memory.seams, scope: { agentId: undefined, userId: 'ada' } },
    });
    expect(same.status).toBe('suspended');
  });

  it('a child run under a parent run’s execution may narrow its memory scope, never widen it', async () => {
    const memory = memorySeams();
    const root = createExecutionContext();
    const child = (scope: MemoryRecord['scope']) =>
      ({
        parameters,
        execute: async (_args: unknown, ctx: { execution?: typeof root }) => {
          const run = await runAgent({
            model: mocked([{ text: 'child done' }]).model,
            prompt: 'child',
            execution: ctx.execution!.child({ scopeId: JSON.stringify(scope) }),
            memory: { seams: memory.seams, scope, recall: false, extract: false },
          });
          return run.status === 'failed' ? `failed: ${run.error.message}` : run.status;
        },
      }) as const;
    const parent = mocked([
      {
        toolCalls: [
          { toolName: 'narrow', id: 'n', args: {} },
          { toolName: 'wide', id: 'w', args: {} },
          { toolName: 'other', id: 'o', args: {} },
        ],
      },
      { text: 'parent done' },
    ]);
    const result = await runAgent({
      model: parent.model,
      prompt: 'delegate',
      execution: root,
      memory: { seams: memory.seams, scope: { userId: 'ada', agentId: 'planner' }, extract: false },
      tools: {
        narrow: child({ userId: 'ada', agentId: 'planner', chatId: 'c1' }),
        wide: child({ userId: 'ada' }),
        other: child({ userId: 'bob', agentId: 'planner' }),
      },
    });
    expect(result.status).toBe('completed');
    const outputs = result.messages
      .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
      .filter((part) => part.type === 'tool_result')
      .map((part) => (part as { result: unknown }).result);
    expect(outputs[0]).toBe('completed');
    expect(String(outputs[1])).toMatch(/failed: .*memory scope/);
    expect(String(outputs[2])).toMatch(/failed: .*memory scope/);
  });

  describe('a nested run on the parent run’s own execution context', () => {
    type Execution = ReturnType<typeof createExecutionContext>;
    const nested = (
      memory: ReturnType<typeof memorySeams>,
      scope: MemoryRecord['scope'],
      pick: (execution: Execution) => Execution,
    ) =>
      ({
        parameters,
        execute: async (_args: unknown, ctx: { execution?: Execution }) => {
          const run = await runAgent({
            model: mocked([{ text: 'child done' }]).model,
            prompt: 'child',
            execution: pick(ctx.execution!),
            memory: { seams: memory.seams, scope, recall: false, extract: false },
          });
          return run.status === 'failed' ? `failed: ${run.error.message}` : run.status;
        },
      }) as const;
    const outputs = (messages: Message[]) =>
      messages
        .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
        .filter((part) => part.type === 'tool_result')
        .map((part) => String((part as { result: unknown }).result));

    it('may not step into another user', async () => {
      const memory = memorySeams();
      const result = await runAgent({
        model: mocked([
          { toolCalls: [{ toolName: 'other', id: 'o', args: {} }] },
          { text: 'parent done' },
        ]).model,
        prompt: 'delegate',
        execution: createExecutionContext(),
        memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false, recall: false },
        tools: { other: nested(memory, { userId: 'bob' }, (execution) => execution) },
      });
      expect(result.status).toBe('completed');
      expect(outputs(result.messages)[0]).toMatch(/failed: .*memory scope/);
    });

    it('does not drop the parent’s registration when it ends', async () => {
      const memory = memorySeams();
      const result = await runAgent({
        model: mocked([
          { toolCalls: [{ toolName: 'same', id: 's', args: {} }] },
          { toolCalls: [{ toolName: 'wide', id: 'w', args: {} }] },
          { text: 'parent done' },
        ]).model,
        prompt: 'delegate',
        execution: createExecutionContext(),
        memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false, recall: false },
        tools: {
          same: nested(memory, { userId: 'ada' }, (execution) => execution),
          wide: nested(memory, { userId: 'bob' }, (execution) =>
            execution.child({ scopeId: 'kid' }),
          ),
        },
      });
      expect(result.status).toBe('completed');
      const [same, wide] = outputs(result.messages);
      expect(same).toBe('completed');
      expect(wide).toMatch(/failed: .*memory scope/);
    });
  });
});

describe('native memory: envelope versions', () => {
  it('writes version 2 only with 2.3 state and keeps resuming version 1', async () => {
    const store = createInMemoryAgentRunStore();
    const plain: Resumable = {
      model: mocked([{ toolCalls: [{ toolName: 'gate', args: {} }] }, { text: 'ok' }]).model,
      prompt: 'x',
      session: { store, runId: 'plain', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    const first = await runAgent(plain);
    expect((await store.load('plain'))?.version).toBe(1);
    const resumed = await resumeAgent({
      ...plain,
      approvalResponses: [
        {
          approvalId: first.status === 'suspended' ? first.pendingApprovals[0]!.approvalId : '',
          approved: true,
        },
      ],
    });
    expect(resumed.status).toBe('completed');
    expect((await store.load('plain'))?.version).toBe(1);
  });

  it('refuses an envelope version it does not know', async () => {
    const store = createInMemoryAgentRunStore();
    const options: Resumable = {
      model: mocked([{ toolCalls: [{ toolName: 'gate', args: {} }] }]).model,
      prompt: 'x',
      session: { store, runId: 'future', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    await runAgent(options);
    await rewrite(store, 'future', (envelope) => {
      (envelope as unknown as { version: number }).version = 3;
    });
    expect(await resumeAgent(options)).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('version') },
    });
  });
});
