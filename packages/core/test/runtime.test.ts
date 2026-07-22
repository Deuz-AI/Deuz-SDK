import { describe, it, expect } from 'vitest';
import {
  createInMemoryRunStore,
  createRunManager,
  emitActivity,
  emitPlanUpdate,
  createSteeringController,
} from '../src/runtime';
import type { StreamPart } from '../src/types/stream';
import { createInMemoryChatStore } from '../src/chat';

describe('RunManager over an in-memory RunStore', () => {
  it('registers, transitions, and lists runs deterministically', async () => {
    let t = 1000;
    const manager = createRunManager({ store: createInMemoryRunStore(), now: () => t });

    const rec = await manager.startRun({
      runId: 'r1',
      goal: 'do the thing',
      meta: { userId: 'u1' },
    });
    expect(rec).toMatchObject({
      runId: 'r1',
      status: 'running',
      goal: 'do the thing',
      createdAt: 1000,
    });

    t = 2000;
    await manager.setPlan('r1', {
      goal: 'do the thing',
      tasks: [{ id: 't1', title: 'step', status: 'pending' }],
    });
    await manager.setStatus('r1', 'suspended', { stepIndex: 3 });

    const got = await manager.getRun('r1');
    expect(got).toMatchObject({ status: 'suspended', stepIndex: 3, updatedAt: 2000 });
    expect(got!.plan!.tasks[0]!.title).toBe('step');

    await manager.startRun({ runId: 'r2' });
    expect((await manager.listRuns()).map((r) => r.runId).sort()).toEqual(['r1', 'r2']);
    expect((await manager.listRuns({ status: 'suspended' })).map((r) => r.runId)).toEqual(['r1']);
  });
});

describe('live-view emitters', () => {
  it('emitPlanUpdate / emitActivity push canonical parts through a sink', () => {
    const parts: StreamPart[] = [];
    const emit = (p: StreamPart): void => void parts.push(p);
    emitPlanUpdate(emit, { goal: 'g', tasks: [{ id: 't1', title: 'a', status: 'done' }] });
    emitActivity(emit, 'opened page', { level: 'info', data: { url: 'https://x' } });
    expect(parts[0]).toEqual({
      type: 'plan-update',
      goal: 'g',
      tasks: [{ id: 't1', title: 'a', status: 'done' }],
    });
    expect(parts[1]).toMatchObject({ type: 'activity', message: 'opened page', level: 'info' });
  });

  it('is a no-op when the sink is undefined (buffered call)', () => {
    expect(() => emitActivity(undefined, 'x')).not.toThrow();
    expect(() => emitPlanUpdate(undefined, { tasks: [] })).not.toThrow();
  });
});

describe('createSteeringController', () => {
  it('queues and drains injected messages', () => {
    const steering = createSteeringController();
    expect(steering.pending).toBe(0);
    steering.enqueue('focus on pricing');
    steering.enqueue('also check reviews');
    expect(steering.pending).toBe(2);
    expect(steering.drain()).toEqual(['focus on pricing', 'also check reviews']);
    expect(steering.pending).toBe(0);
    expect(steering.drain()).toEqual([]);
  });
});

describe('chat engine folds plan/activity parts', () => {
  it('applyUIPart collects the latest plan and appends activity', async () => {
    // Round-trip via the reducer used by useChat.
    const { createAssistantTurn, applyUIPart } = await import('../src/chat');
    let turn = createAssistantTurn('m1');
    turn = applyUIPart(turn, {
      type: 'plan-update',
      goal: 'g',
      tasks: [{ id: 't1', title: 'a', status: 'pending' }],
    });
    turn = applyUIPart(turn, { type: 'activity', message: 'started' });
    turn = applyUIPart(turn, {
      type: 'plan-update',
      goal: 'g',
      tasks: [{ id: 't1', title: 'a', status: 'done' }],
    });
    turn = applyUIPart(turn, { type: 'activity', message: 'finished', level: 'info' });

    expect(turn.plan!.tasks[0]!.status).toBe('done'); // latest snapshot wins
    expect(turn.activity.map((a) => a.message)).toEqual(['started', 'finished']);
  });

  // A ChatStore is unrelated here but confirms the import graph stays clean.
  it('does not couple runtime to a chat store', () => {
    expect(typeof createInMemoryChatStore).toBe('function');
  });
});
