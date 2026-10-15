/**
 * native-v3-working-memory.test.ts (2.4, spec §2.5) — working memory in the
 * native loop of a V3 run: the snapshot (with the task list and the active
 * task) lives in the V3 state, the model's tools are offered when configured,
 * a model's patch becomes durable in the same native checkpoint as its tool
 * receipt (never before it, never after), a call replayed after a crash
 * applies once, the working memory is placed as the request tail even
 * without a configured compiler, and a resume keeps the stored snapshot.
 */
import { describe, expect, it } from 'vitest';
import { resumeAgent, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createWorkingMemory } from '../src/context/working-memory';
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import { recordingStoreV3, scriptedModel, wireText, type ScriptedCall } from './fixtures/native-v3';

const parameters = { type: 'object', properties: {} };
const tasks = {
  list: {
    goal: 'Ship the service',
    tasks: [
      { id: 't1', title: 'Build', status: 'done' as const },
      { id: 't2', title: 'Deploy', status: 'in_progress' as const },
    ],
  },
  activeTaskId: 't2',
};

function wmRun(script: ScriptedCall[], extra: Partial<AgentRunOptionsV3> = {}) {
  const scripted = scriptedModel(script);
  const options = (store: AgentRunStoreV3): AgentRunOptionsV3 => ({
    model: scripted.model,
    prompt: 'Deploy it',
    checkpointVersion: 3,
    session: { store, runId: 'run-wm', scope: 'tenant' },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    workingMemory: {
      create: { scope: 'tenant', goal: 'Ship the service', tasks, now: 1 },
      tools: true,
    },
    ...extra,
  });
  return { ...scripted, options };
}

const observe = (id: string, text: string): ScriptedCall => ({
  toolCalls: [
    {
      toolName: 'working_memory_add',
      id,
      args: { items: [{ kind: 'observation', text }] },
    },
  ],
});

describe('working memory in the V3 loop', () => {
  it('keeps the snapshot and its task list in the V3 state and offers the tools', async () => {
    const store = recordingStoreV3();
    const run = wmRun([observe('w1', 'CI is green'), { text: 'done' }]);
    const result = await runAgent(run.options(store));
    expect(result.status).toBe('completed');
    const tools = run.requests()[0]!.tools!.map((tool) => tool.function.name);
    expect(tools).toEqual(['working_memory_read', 'working_memory_add', 'working_memory_update']);
    const stored = (await store.load('run-wm'))!;
    expect(stored.workingMemory).toMatchObject({
      revision: 1,
      goal: { text: 'Ship the service', writer: 'host' },
      tasks: { activeTaskId: 't2', list: tasks.list },
      observations: [{ text: 'CI is green', writer: 'model' }],
    });
    // The second request's tail is the current working memory, with the observation.
    const tail = run.requests()[1]!.messages.at(-1)!;
    expect(wireText(tail)).toMatch(/^<deuz_working_memory /);
    expect(wireText(tail)).toContain('CI is green');
    expect(wireText(tail)).toContain('Deploy');
  });

  it("persists a model's patch in the same save as its tool receipt", async () => {
    const store = recordingStoreV3();
    const run = wmRun([observe('w1', 'CI is green'), { text: 'done' }]);
    await runAgent(run.options(store));
    const receipt = (save: (typeof store.saves)[number]) =>
      Object.values(save.toolResults ?? {}).find((entry) => entry.toolCallId === 'w1');
    const first = store.saves.findIndex((save) => save.workingMemory?.revision === 1);
    expect(first).toBeGreaterThan(0);
    // The save that makes the patch durable carries the call's outcome too…
    expect(receipt(store.saves[first]!)?.stage).toBe('executed');
    // …and the save before it recorded the call as executing, without the patch.
    expect(store.saves[first - 1]!.workingMemory?.revision).toBe(0);
    expect(receipt(store.saves[first - 1]!)?.stage).toBe('executing');
  });

  it('applies a patch once when the call is replayed after a crash', async () => {
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const run = wmRun([observe('w1', 'CI is green'), { text: 'done' }]);
    // The process dies right after the call was recorded as executing.
    first.failAfter((envelope) =>
      Object.values(envelope.toolResults ?? {}).some(
        (entry) => entry.toolCallId === 'w1' && entry.stage === 'executing',
      ),
    );
    expect((await runAgent(run.options(first))).status).toBe('failed');
    const second = recordingStoreV3(inner);
    const resumed = await resumeAgent(run.options(second));
    expect(resumed.status).toBe('completed');
    const stored = (await second.load('run-wm'))!;
    expect(stored.workingMemory?.revision).toBe(1);
    expect(stored.workingMemory?.observations.map((item) => item.text)).toEqual(['CI is green']);
  });

  it('places the working memory tail without a configured compiler', async () => {
    const store = recordingStoreV3();
    const run = wmRun([{ text: 'done' }], {
      workingMemory: { create: { scope: 'tenant', goal: 'Ship the service', tasks, now: 1 } },
    });
    await runAgent(run.options(store));
    const sent = run.requests()[0]!;
    expect(wireText(sent.messages.at(-1)!)).toContain('Ship the service');
    expect(sent.tools).toBeUndefined();
    const stored = (await store.load('run-wm'))!;
    expect(stored.context?.steps).toHaveLength(1);
    expect(stored.context?.steps[0]!.manifest.placement).toEqual({ append: false, tail: true });
  });

  it('keeps the stored snapshot on resume; the active task survives', async () => {
    const store = recordingStoreV3();
    const run = wmRun(
      [
        observe('w1', 'CI is green'),
        { toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] },
        { text: 'done' },
      ],
      { tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } } },
    );
    const first = await runAgent(run.options(store));
    expect(first.status).toBe('suspended');
    if (first.status !== 'suspended') return;
    const resumed = await resumeAgent({
      ...run.options(store),
      // A resume's create is not applied over the stored working memory.
      workingMemory: { create: { scope: 'tenant', goal: 'Something else', now: 2 }, tools: true },
      approvalResponses: [{ approvalId: first.pendingApprovals[0]!.approvalId, approved: true }],
    });
    expect(resumed.status).toBe('completed');
    const stored = (await store.load('run-wm'))!;
    expect(stored.workingMemory).toMatchObject({
      goal: { text: 'Ship the service' },
      tasks: { activeTaskId: 't2' },
      observations: [{ text: 'CI is green' }],
    });
    expect(wireText(run.requests().at(-1)!.messages.at(-1)!)).toContain('Ship the service');
  });

  it('refuses a host tool named like a working memory tool', async () => {
    const store = recordingStoreV3();
    const run = wmRun([{ text: 'never' }], {
      tools: { working_memory_read: { parameters, execute: () => 'mine' } },
    });
    const result = await runAgent(run.options(store));
    expect(result).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(run.fetch).not.toHaveBeenCalled();
  });
});

describe('the working memory scope of a V3 run', () => {
  it("refuses a snapshot or a creation for another scope than the run's", async () => {
    for (const workingMemory of [
      { create: { scope: 'other-tenant', goal: 'Ship', now: 1 } },
      { snapshot: createWorkingMemory({ scope: 'other-tenant', goal: 'Ship', now: 1 }) },
    ]) {
      const store = recordingStoreV3();
      const run = wmRun([{ text: 'never' }], { workingMemory });
      const result = await runAgent(run.options(store));
      expect(result).toMatchObject({
        status: 'failed',
        error: { name: 'TypeError', message: expect.stringMatching(/scope/) },
      });
      expect(run.fetch).not.toHaveBeenCalled();
      expect(store.saves).toEqual([]);
    }
  });
});
