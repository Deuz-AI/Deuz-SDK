/**
 * The model's working memory tools (2.4, spec §2.5): every write is a patch
 * with writer `'model'` and an operation id from the model step and tool
 * call id, so a replayed call is a duplicate; a refusal reaches the model as
 * a tool error; the tools persist nothing; and a sub-agent handed the tools
 * gets no write access to its parent's working memory.
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import {
  applyWorkingMemoryPatch,
  createWorkingMemory,
  workingMemoryTools,
  type WorkingMemoryHandle,
  type WorkingMemoryPatch,
  type WorkingMemoryPatchResult,
  type WorkingMemorySnapshot,
} from '../src/context/working-memory';
import { canonicalJson, sha256Digest } from '../src/internal/digest';
import { createMockModel } from '../src/testing';
import type { AgentTool, AgentToolContext } from '../src/types/agent-run';
import type { Message } from '../src/types/message';

const start = (): WorkingMemorySnapshot =>
  createWorkingMemory({
    scope: 'tenant',
    goal: 'Ship 2.4',
    constraints: ['No force pushes'],
    tasks: {
      list: { goal: 'Ship 2.4', tasks: [{ id: 't1', title: 'Build', status: 'pending' }] },
      activeTaskId: 't1',
    },
    now: 1_000,
  });

/** A run's working memory: applies patches at a fixed time and records them. */
function memoryHandle(snapshot = start()) {
  let current = snapshot;
  const patches: WorkingMemoryPatch[] = [];
  const handle: WorkingMemoryHandle = {
    current: () => current,
    apply(patch) {
      patches.push(patch);
      const result = applyWorkingMemoryPatch(current, patch, { now: 9_000 });
      current = result.snapshot;
      return result;
    },
  };
  return { handle, patches, snapshot: () => current };
}

const context = (toolCallId: string, extra: Partial<AgentToolContext> = {}): AgentToolContext => ({
  toolCallId,
  modelStep: 1,
  messages: [],
  agentPath: [],
  ...extra,
});

const call = async (tool: AgentTool | undefined, args: unknown, ctx: AgentToolContext) =>
  tool!.execute!(args, ctx);

describe('workingMemoryTools', () => {
  it('offers read, add and update tools under a prefix, each safe to replay', () => {
    const { handle } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    expect(Object.keys(tools)).toEqual([
      'working_memory_read',
      'working_memory_add',
      'working_memory_update',
    ]);
    for (const tool of Object.values(tools)) {
      expect(tool.replay).toBe('idempotent');
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
    expect(Object.keys(workingMemoryTools({ memory: handle, prefix: 'wm' }))).toEqual([
      'wm_read',
      'wm_add',
      'wm_update',
    ]);
  });

  it('reads the snapshot without its internal bookkeeping', async () => {
    const { handle } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    const view = (await call(tools.working_memory_read, {}, context('r1'))) as Record<
      string,
      unknown
    >;
    expect(view).toMatchObject({
      revision: 0,
      goal: { text: 'Ship 2.4' },
      constraints: [{ text: 'No force pushes', writer: 'host' }],
      tasks: { activeTaskId: 't1', listRevision: 1 },
      observations: [],
    });
    expect(view).not.toHaveProperty('applied');
    expect(view).not.toHaveProperty('kind');
  });

  it('adds items as one model patch, keyed by the model step and tool call id', async () => {
    const { handle, patches, snapshot } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    const result = await call(
      tools.working_memory_add,
      {
        items: [
          { kind: 'observation', text: 'CI is green' },
          { kind: 'hypothesis', text: 'The registry is slow' },
          { kind: 'decision', text: 'Publish from CI', rationale: 'Provenance' },
          { kind: 'question', text: 'Which registry?' },
          { kind: 'attempt', text: 'npm publish --dry-run', outcome: 'failed', detail: 'E403' },
        ],
      },
      context('call-7', { modelStep: 3 }),
    );
    expect(result).toEqual({
      status: 'applied',
      revision: 1,
      ids: ['observations-1-0', 'hypotheses-1-1', 'decisions-1-2', 'questions-1-3', 'attempts-1-4'],
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      operationId: JSON.stringify(['working-memory', 'working_memory_add', 3, 'call-7']),
      expectedRevision: 0,
      writer: 'model',
    });
    const after = snapshot();
    expect(after.hypotheses[0]).toMatchObject({ status: 'proposed', writer: 'model' });
    expect(after.decisions[0]).toMatchObject({ status: 'proposed', rationale: 'Provenance' });
    expect(after.attempts[0]).toMatchObject({ outcome: 'failed', detail: 'E403' });
    expect(after.questions[0]).toMatchObject({ status: 'open' });
  });

  it('answers a replayed call as a duplicate and applies it once', async () => {
    const { handle, snapshot } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    const args = { items: [{ kind: 'observation', text: 'once' }] };
    await call(tools.working_memory_add, args, context('c1'));
    expect(await call(tools.working_memory_add, args, context('c1'))).toEqual({
      status: 'duplicate',
      revision: 1,
    });
    expect(snapshot().observations).toHaveLength(1);
    // The same call id at another model step is another call.
    await call(tools.working_memory_add, args, context('c1', { modelStep: 2 }));
    expect(snapshot().observations).toHaveLength(2);
  });

  it('returns a refusal to the model as a tool error and changes nothing', async () => {
    const host = applyWorkingMemoryPatch(
      start(),
      {
        operationId: 'host-1',
        expectedRevision: 0,
        writer: 'host',
        operations: [{ op: 'add-question', id: 'hq', text: 'Host question?' }],
      },
      { now: 2_000 },
    ).snapshot;
    const { handle, snapshot } = memoryHandle(host);
    const tools = workingMemoryTools({ memory: handle });
    await expect(
      call(
        tools.working_memory_update,
        { changes: [{ action: 'answer', id: 'hq', answer: 'npm' }] },
        context('u1'),
      ),
    ).rejects.toThrow(/forbidden|only change items you wrote/i);
    await expect(
      call(
        tools.working_memory_update,
        { changes: [{ action: 'drop', id: 'ghost' }] },
        context('u2'),
      ),
    ).rejects.toThrow(/no item/i);
    for (const args of [
      {},
      { items: [] },
      { items: [{ kind: 'constraint', text: 'none' }] },
      { items: [{ kind: 'observation', text: '' }] },
      { items: [{ kind: 'question', text: 'q?', evidence: ['c1'] }] },
      { changes: [{ action: 'rewrite', id: 'hq' }] },
    ])
      await expect(
        call(
          'items' in args || Object.keys(args).length === 0
            ? tools.working_memory_add
            : tools.working_memory_update,
          args,
          context('bad'),
        ),
      ).rejects.toThrow();
    expect(snapshot()).toBe(host);
  });

  it('updates the model own items: answers, attempt outcomes, removals', async () => {
    const { handle, snapshot } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    const added = (await call(
      tools.working_memory_add,
      {
        items: [
          { kind: 'question', text: 'Which registry?' },
          { kind: 'attempt', text: 'Publish' },
          { kind: 'observation', text: 'Stale' },
        ],
      },
      context('a1'),
    )) as { ids: string[] };
    const [question, attempt, observation] = added.ids;
    expect(snapshot().attempts[0]?.outcome).toBe('in-progress');
    await call(
      tools.working_memory_update,
      {
        changes: [
          { action: 'answer', id: question, answer: 'npm' },
          { action: 'attempt', id: attempt, outcome: 'succeeded' },
          { action: 'remove', list: 'observations', id: observation },
        ],
      },
      context('u1'),
    );
    expect(snapshot().questions[0]).toMatchObject({ status: 'answered', answer: 'npm' });
    expect(snapshot().attempts[0]).toMatchObject({ outcome: 'succeeded' });
    expect(snapshot().observations).toEqual([]);
  });

  it('cites the tool results named as evidence', async () => {
    const { handle, snapshot } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    const result = { status: 403, body: 'forbidden' };
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c7', name: 'npm_publish', input: {} }],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c7', result }] },
    ];
    await call(
      tools.working_memory_add,
      { items: [{ kind: 'observation', text: 'Publishing is refused', evidence: ['c7'] }] },
      context('a1', { messages }),
    );
    expect(snapshot().observations[0]?.sources).toEqual([
      {
        kind: 'tool',
        toolCallId: 'c7',
        toolName: 'npm_publish',
        digest: await sha256Digest(canonicalJson(result)),
      },
    ]);
    await expect(
      call(
        tools.working_memory_add,
        { items: [{ kind: 'observation', text: 'x', evidence: ['nope'] }] },
        context('a2', { messages }),
      ),
    ).rejects.toThrow(/nope/);
  });

  it('retries a write that lost a revision race, then gives up', async () => {
    const { handle, snapshot } = memoryHandle();
    let conflicts = 1;
    const racing: WorkingMemoryHandle = {
      current: handle.current,
      async apply(patch): Promise<WorkingMemoryPatchResult> {
        if (conflicts-- > 0) return { status: 'conflict', snapshot: handle.current() };
        return handle.apply(patch);
      },
    };
    const tools = workingMemoryTools({ memory: racing });
    const args = { items: [{ kind: 'observation', text: 'after a race' }] };
    expect(await call(tools.working_memory_add, args, context('c1'))).toMatchObject({
      status: 'applied',
    });
    expect(snapshot().observations).toHaveLength(1);
    conflicts = 3;
    await expect(call(tools.working_memory_add, args, context('c2'))).rejects.toThrow(/changed/);
  });

  it('gives a sub-agent no write access to the working memory it was handed', async () => {
    const { handle, snapshot } = memoryHandle();
    const tools = workingMemoryTools({ memory: handle });
    const child = context('c1', { agentPath: ['researcher'] });
    await expect(
      call(tools.working_memory_add, { items: [{ kind: 'observation', text: 'x' }] }, child),
    ).rejects.toThrow(/sub-agent/);
    expect(await call(tools.working_memory_read, {}, child)).toMatchObject({ revision: 0 });
    expect(snapshot().observations).toEqual([]);
    // A sub-agent's own working memory is its own.
    const own = workingMemoryTools({ memory: handle, agentPath: ['researcher'] });
    await call(own.working_memory_add, { items: [{ kind: 'observation', text: 'mine' }] }, child);
    expect(snapshot().observations).toHaveLength(1);
  });

  it('refuses options without a working memory handle or with a bad prefix', () => {
    const { handle } = memoryHandle();
    expect(() => workingMemoryTools({} as never)).toThrow(TypeError);
    expect(() => workingMemoryTools({ memory: { current: () => start() } as never })).toThrow(
      TypeError,
    );
    expect(() => workingMemoryTools({ memory: handle, prefix: 'has space' })).toThrow(TypeError);
  });

  it('works in a native run: the model writes through the loop', async () => {
    const { handle, patches, snapshot } = memoryHandle();
    const model = createMockModel({
      responses: [
        {
          toolCalls: [
            {
              toolName: 'working_memory_add',
              id: 'tc-1',
              args: { items: [{ kind: 'hypothesis', text: 'The cache is cold' }] },
            },
          ],
        },
        { text: 'noted' },
      ],
    });
    const result = await runAgent({
      model,
      prompt: 'Investigate the slow build.',
      tools: workingMemoryTools({ memory: handle }),
    });
    expect(result.status).toBe('completed');
    // The loop supplies the model step, so the operation id is stable across a resume.
    const [, , modelStep, toolCallId] = JSON.parse(patches[0]!.operationId) as unknown[];
    expect(modelStep).toEqual(expect.any(Number));
    expect(toolCallId).toBe('tc-1');
    expect(snapshot().hypotheses).toMatchObject([
      { text: 'The cache is cold', status: 'proposed', writer: 'model' },
    ]);
  });
});
