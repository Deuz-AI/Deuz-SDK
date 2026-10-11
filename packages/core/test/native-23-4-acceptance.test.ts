/**
 * native-23-4-acceptance.test.ts (2.3, roadmap section 6) — the scenarios that
 * span chat, memory and fail-over together: a run that uses all three across a
 * process restart, and the preserved-thinking prefix check on a Claude 5.x run
 * with memory (system, tools and every earlier message byte-identical from one
 * request to the next, across a resume). Wire shapes are scripted; not
 * live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import { createInMemoryChatStore } from '../src/chat';
import { createInMemoryMemoryStore, type MemorySeams } from '../src/memory';
import type { AgentRunOptions, AgentRunSession } from '../src/types/agent-run';
import {
  claudeTurn,
  openaiTurn,
  overloaded,
  scriptedFetch,
  type ScriptStep,
} from './fixtures/wire-turns';

const parameters = { type: 'object', properties: {} };

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}

function memory() {
  const store = createInMemoryMemoryStore();
  void store.upsert([
    {
      id: 'seed',
      text: 'works on the billing service',
      hash: 'h:seed',
      kind: 'semantic',
      scope: { userId: 'ada' },
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  const search = vi.spyOn(store, 'search');
  const llm = vi.fn<MemorySeams['llm']>(async ({ system }) =>
    system.includes('extract')
      ? '{"facts":["deploys on fridays"]}'
      : '{"memory":[{"event":"ADD","text":"deploys on fridays"}]}',
  );
  let n = 0;
  const seams: MemorySeams = {
    store,
    llm,
    clock: { now: () => 7, setTimeout: (fn: () => void) => (fn(), () => {}) },
    generateId: () => `m${n++}`,
    hashFn: async (text) => `h:${text}`,
  };
  return { seams, store, search, llm };
}

function claude(id: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createAnthropic({ apiKey: 'a', fetch: wire.fetch })(id), wire };
}

describe('23.4 acceptance', () => {
  it('a run with chat, memory and fail-over survives a restart without repeating anything', async () => {
    const mem = memory();
    const chatStore = createInMemoryChatStore();
    const runs = createInMemoryAgentRunStore();
    const primary = claude('claude-opus-5-5', [
      claudeTurn([{ type: 'tool_use', id: 'toolu_1', name: 'deploy', json: '{}' }], 'tool_use'),
      overloaded,
    ]);
    const fallbackWire = scriptedFetch([
      openaiTurn({ toolCalls: [{ id: 'call_2', name: 'notify', json: '{}' }] }),
      openaiTurn({ text: 'Deployed and notified.' }),
    ]);
    const deploy = vi.fn(() => 'deployed');
    const notify = vi.fn(() => 'sent');
    // Each "process" builds its own options from the same stores.
    const options = (): AgentRunOptions & { session: AgentRunSession } => ({
      model: primary.model,
      fallbackModels: [createOpenAI({ apiKey: 'b', fetch: fallbackWire.fetch })('gpt-5.2')],
      maxRetries: 0,
      prompt: 'deploy the billing service, then tell the team',
      memory: { seams: mem.seams, scope: { userId: 'ada' } },
      chat: { store: chatStore, chatId: 'ops', scope: { userId: 'ada' } },
      session: { store: runs, runId: 'deploy-run', scope: 'tenant' },
      tools: {
        deploy: { parameters, execute: deploy },
        notify: { parameters, needsApproval: true, execute: notify },
      },
    });

    const first = await runAgent(options());
    if (first.status !== 'suspended') throw new Error(`expected suspension, got ${first.status}`);
    // Restart: a new executor resumes from the stores alone.
    const resumed = await resumeAgent({
      ...options(),
      approvalResponses: [{ approvalId: first.pendingApprovals[0]!.approvalId, approved: true }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'Deployed and notified.' });

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(primary.wire.calls()).toBe(2);
    expect(fallbackWire.calls()).toBe(2);
    // One recall, one extraction.
    const recalls = mem.search.mock.calls.filter(([query]) => query.text?.includes('deploy the'));
    expect(recalls).toHaveLength(1);
    expect(mem.llm).toHaveBeenCalledTimes(2);
    // The chat holds each turn once, recall included (it is part of the prefix).
    const record = (await chatStore.loadChat('ops'))!;
    expect(record.messages.map((message) => message.role)).toEqual([
      'user',
      'system',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(new Set(record.messageIds).size).toBe(record.messages.length);
    const envelope = (await runs.load('deploy-run'))!;
    expect(envelope.models?.attempts).toHaveLength(1);
    expect(envelope.memory?.extraction?.status).toBe('completed');
    expect(envelope.chat).toMatchObject({ status: 'saved', cursor: 7 });
  });

  it.skipIf(!DatabaseSync)(
    'a durable store keeps a version 2 envelope as it is, with no migration',
    async () => {
      const ops = createSqliteOpsStore({ path: ':memory:' });
      try {
        const mem = memory();
        const chats = createInMemoryChatStore();
        const opus = claude('claude-opus-5-5', [
          claudeTurn([{ type: 'tool_use', id: 'toolu_1', name: 'gate', json: '{}' }], 'tool_use'),
          claudeTurn([{ type: 'text', text: 'Done.' }]),
        ]);
        const options = (): AgentRunOptions & { session: AgentRunSession } => ({
          model: opus.model,
          prompt: 'gate it',
          memory: { seams: mem.seams, scope: { userId: 'ada' }, extract: false },
          chat: { store: chats, chatId: 'sqlite', scope: { userId: 'ada' } },
          session: { store: ops.agentRuns, runId: 'sqlite-run', scope: 'tenant' },
          tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
        });
        const first = await runAgent(options());
        if (first.status !== 'suspended')
          throw new Error(`expected suspension, got ${first.status}`);
        const stored = (await ops.agentRuns.load('sqlite-run'))!;
        expect(stored.version).toBe(2);
        expect(stored.memory?.recall.status).toBe('recalled');
        expect(stored.transcript?.messages).toHaveLength(3);
        const resumed = await resumeAgent({
          ...options(),
          approvalResponses: [
            { approvalId: first.pendingApprovals[0]!.approvalId, approved: true },
          ],
        });
        expect(resumed.status).toBe('completed');
        expect((await chats.loadChat('sqlite'))!.messages).toHaveLength(5);
        expect(mem.search).toHaveBeenCalledTimes(1);
      } finally {
        await ops.close();
      }
    },
  );

  it('preserved thinking: memory keeps the request prefix byte-identical across steps and a resume', async () => {
    const mem = memory();
    const opus = claude('claude-opus-5-5', [
      claudeTurn(
        [
          { type: 'thinking', signature: 'SIG-A' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{}' },
        ],
        'tool_use',
      ),
      claudeTurn(
        [
          { type: 'thinking', text: 'gate next', signature: 'SIG-B' },
          { type: 'tool_use', id: 'toolu_2', name: 'gate', json: '{}' },
        ],
        'tool_use',
      ),
      claudeTurn([{ type: 'text', text: 'Done.' }]),
    ]);
    const options: AgentRunOptions & { session: AgentRunSession } = {
      model: opus.model,
      prompt: 'which service do I work on?',
      memory: { seams: mem.seams, scope: { userId: 'ada' }, extract: false },
      session: { store: createInMemoryAgentRunStore(), runId: 'prefix', scope: 'tenant' },
      tools: {
        lookup: { parameters, execute: () => 'billing' },
        gate: { parameters, needsApproval: true, execute: () => 'ok' },
      },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') throw new Error(`expected suspension, got ${first.status}`);
    await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: first.pendingApprovals[0]!.approvalId, approved: true }],
    });
    const bodies = opus.wire.bodies as {
      system?: unknown;
      tools?: unknown;
      messages: unknown[];
    }[];
    expect(bodies).toHaveLength(3);
    for (let index = 1; index < bodies.length; index++) {
      const previous = bodies[index - 1]!;
      const next = bodies[index]!;
      expect(JSON.stringify(next.system)).toBe(JSON.stringify(previous.system));
      expect(JSON.stringify(next.tools)).toBe(JSON.stringify(previous.tools));
      expect(JSON.stringify(next.messages.slice(0, previous.messages.length))).toBe(
        JSON.stringify(previous.messages),
      );
    }
    // The recall rides the first request, and each thinking block comes back unchanged.
    expect(JSON.stringify(bodies[0])).toContain('works on the billing service');
    const last = JSON.stringify(bodies[2]!.messages);
    expect(last).toContain('"signature":"SIG-A"');
    expect(last).toContain('"thinking":"gate next","signature":"SIG-B"');
    expect(mem.search).toHaveBeenCalledTimes(1);
  });
});
