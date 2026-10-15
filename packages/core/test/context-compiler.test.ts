/**
 * createContextCompiler (2.4 preview, spec §2.3 "Varsayılanlar" and "Kaynak
 * ve devam etme kuralları"): retrieval refreshes on the first call, an
 * active-task change or a host request, at least `minSteps` model steps
 * apart for automatic refreshes and at most `maxPasses` times per run, then
 * reuses the last package and says so. An optional source failure is a
 * warning; a required one stops the call. The state is plain JSON, and a
 * compiler restored from it compiles the same context.
 */
import { describe, expect, it } from 'vitest';
import { ContextBudgetExceededError } from '../src/errors';
import { sha256Digest } from '../src/internal/digest';
import { createMemoryObserver } from '../src/observe';
import {
  createContextCompiler,
  contextPackageBlob,
  contextWarnings,
} from '../src/context/compiler';
import { sha256DigestSync } from '../src/context/sha256';
import type {
  ContextCandidate,
  ContextPackage,
  ContextSource,
  ContextSourceKind,
  ContextSourceRequest,
  ContextStepInput,
} from '../src/context/types';
import type { WorkingMemorySnapshot } from '../src/context/working-memory/types';
import type { CallWarning } from '../src/types/methods';
import type { Message } from '../src/types/message';

function candidate(
  recordId: string,
  text: string,
  score: number,
  extra: Partial<ContextCandidate> = {},
) {
  return { recordId, text, score, digest: sha256DigestSync(text), ...extra };
}

/** A source answering from a fixed list, recording every request. */
function fake(
  id: string,
  kind: ContextSourceKind,
  answer: ContextCandidate[] | (() => Promise<ContextCandidate[]>),
  required?: boolean,
) {
  const requests: ContextSourceRequest[] = [];
  const source: ContextSource = {
    id,
    kind,
    ...(required !== undefined ? { required } : {}),
    async query(request) {
      requests.push(request);
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  return { source, requests };
}

function snapshot(activeTaskId: string | undefined, revision = 1): WorkingMemorySnapshot {
  return {
    kind: 'deuz-working-memory',
    version: 1,
    revision,
    scope: 'tenant-a',
    goal: { text: 'Plan the trip', writer: 'host', revision: 1, at: 0 },
    constraints: [],
    tasks: {
      list: {
        goal: 'trip',
        tasks: [
          { id: 't1', title: 'Book flights', status: 'in_progress' },
          { id: 't2', title: 'Find a hotel', status: 'pending' },
        ],
      },
      listRevision: 1,
      ...(activeTaskId ? { activeTaskId } : {}),
    },
    observations: [],
    hypotheses: [],
    decisions: [],
    questions: [],
    attempts: [],
    applied: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const system: Message = { role: 'system', content: 'You are a travel agent.' };

function step(
  n: number,
  messages: Message[],
  overrides: Partial<ContextStepInput> = {},
): ContextStepInput {
  return {
    runId: 'run-1',
    step: n,
    messages,
    model: { provider: 'test', modelId: 'm', contextWindow: 100_000, maxOutputTokens: 4_000 },
    overheadTokens: 500,
    ...overrides,
  };
}

const clock = { now: () => 1_000, setTimeout: () => () => {} };

describe('createContextCompiler refresh policy', () => {
  it('refreshes on the first call with the task title and the latest user text', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'Prefers aisle seats', 0.9)]);
    const compiler = createContextCompiler({
      sources: [memory.source],
      scope: { userId: 'u1' },
      deps: { clock },
    });
    const messages: Message[] = [
      system,
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: [{ type: 'text', text: 'Book me a flight to Izmir' }] },
    ];
    const pkg = await compiler.beforeModelCall(
      step(1, messages, { workingMemory: snapshot('t1') }),
    );
    expect(memory.requests).toEqual([
      {
        text: 'Book flights\nBook me a flight to Izmir',
        scope: { userId: 'u1' },
        limit: 20,
        budgetTokens: expect.any(Number),
        recordedAsOf: 1_000,
      },
    ]);
    expect(pkg.manifest).toMatchObject({ refresh: 'initial', pass: 1, step: 1 });
    expect(pkg.manifest).not.toHaveProperty('fallback');
    expect(pkg.blocks.map((block) => block.placement)).toEqual(['append', 'ephemeral-tail']);
    expect(compiler.state()).toMatchObject({
      version: 1,
      passes: 1,
      lastRefreshStep: 1,
      activeTaskId: 't1',
    });
  });

  it('reuses the package between refreshes, the working memory still compiled', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'Prefers aisle seats', 0.9)]);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const first = await compiler.beforeModelCall(
      step(1, [system, { role: 'user', content: 'hi' }], { workingMemory: snapshot('t1') }),
    );
    const history: Message[] = [
      system,
      { role: 'user', content: 'hi' },
      ...first.blocks[0]!.messages,
      { role: 'assistant', content: 'ok' },
    ];
    const second = await compiler.beforeModelCall(
      step(2, history, { workingMemory: snapshot('t1', 2) }),
    );
    expect(memory.requests).toHaveLength(1);
    expect(second.manifest).toMatchObject({
      refresh: 'reused',
      pass: 1,
      cachePrefixChanged: false,
    });
    expect(second.blocks.map((block) => block.placement)).toEqual(['ephemeral-tail']);
    expect(second.blocks[0]!.messages[0]!.content).toContain('revision="2"');
  });

  it('refreshes on an active-task change at most every minSteps steps', async () => {
    const memory = fake('memory', 'memory', []);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const user: Message = { role: 'user', content: 'go' };
    await compiler.beforeModelCall(step(1, [user], { workingMemory: snapshot('t1') }));
    const early = await compiler.beforeModelCall(
      step(2, [user], { workingMemory: snapshot('t2') }),
    );
    expect(early.manifest.refresh).toBe('reused');
    const due = await compiler.beforeModelCall(step(3, [user], { workingMemory: snapshot('t2') }));
    expect(due.manifest).toMatchObject({ refresh: 'active-task-changed', pass: 2 });
    expect(memory.requests.map((request) => request.text)).toEqual([
      'Book flights\ngo',
      'Find a hotel\ngo',
    ]);
  });

  it('refreshes on a host request, whatever minSteps says', async () => {
    const memory = fake('memory', 'memory', []);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const user: Message = { role: 'user', content: 'go' };
    await compiler.beforeModelCall(step(1, [user]));
    compiler.requestRefresh();
    expect(compiler.state().refreshRequested).toBe(true);
    expect((await compiler.beforeModelCall(step(2, [user]))).manifest.refresh).toBe('host-request');
    expect(
      (await compiler.beforeModelCall(step(3, [user], { refresh: true }))).manifest.refresh,
    ).toBe('host-request');
    expect(memory.requests).toHaveLength(3);
    expect(compiler.state().refreshRequested).toBeUndefined();
  });

  it('stops retrieving after maxPasses and says the last package was reused', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'fact', 0.5)]);
    const compiler = createContextCompiler({ sources: [memory.source], refresh: { maxPasses: 2 } });
    const user: Message = { role: 'user', content: 'go' };
    await compiler.beforeModelCall(step(1, [user]));
    await compiler.beforeModelCall(step(2, [user], { refresh: true }));
    const limited = await compiler.beforeModelCall(
      step(3, [user], { refresh: true, workingMemory: snapshot('t1', 9) }),
    );
    expect(memory.requests).toHaveLength(2);
    expect(limited.manifest).toMatchObject({ refresh: 'reused', pass: 2, fallback: 'pass-limit' });
    expect(limited.blocks.at(-1)!.messages[0]!.content).toContain('revision="9"');
    // The due refresh was consumed: the next step without a new trigger is a plain reuse.
    const after = await compiler.beforeModelCall(
      step(4, [user], { workingMemory: snapshot('t1', 10) }),
    );
    expect(after.manifest).not.toHaveProperty('fallback');
  });

  it('uses the default four passes', async () => {
    const memory = fake('memory', 'memory', []);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const user: Message = { role: 'user', content: 'go' };
    for (let n = 1; n <= 6; n++) await compiler.beforeModelCall(step(n, [user], { refresh: true }));
    expect(memory.requests).toHaveLength(4);
  });

  it('skips the sources when there is nothing to ask', async () => {
    const memory = fake('memory', 'memory', []);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const pkg = await compiler.beforeModelCall(step(1, [system]));
    expect(memory.requests).toEqual([]);
    expect(pkg.manifest.sources).toEqual([
      expect.objectContaining({ source: 'memory', status: 'skipped', selected: 0 }),
    ]);
    expect(pkg.manifest).toMatchObject({ refresh: 'reused', pass: 0 });
    // The first retrieval waits for something to ask, without spending a pass.
    const next = await compiler.beforeModelCall(step(2, [system, { role: 'user', content: 'go' }]));
    expect(next.manifest).toMatchObject({ refresh: 'initial', pass: 1 });
    expect(memory.requests).toHaveLength(1);
  });

  it('rewrites the query only when the host configures it', async () => {
    const memory = fake('memory', 'memory', []);
    const compiler = createContextCompiler({
      sources: [memory.source],
      refresh: { rewriteQuery: async (query) => `rewritten: ${query}` },
    });
    await compiler.beforeModelCall(step(1, [{ role: 'user', content: 'go' }]));
    expect(memory.requests[0]!.text).toBe('rewritten: go');
  });

  it('does not take its own blocks for the user text', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'fact', 0.5)]);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const first = await compiler.beforeModelCall(step(1, [{ role: 'user', content: 'question' }]));
    await compiler.beforeModelCall(
      step(2, [{ role: 'user', content: 'question' }, ...first.blocks[0]!.messages], {
        refresh: true,
      }),
    );
    expect(memory.requests.map((request) => request.text)).toEqual(['question', 'question']);
  });
});

describe('createContextCompiler source failures', () => {
  it('warns about an optional source that failed and goes on without it', async () => {
    const warnings: CallWarning[] = [];
    const broken = fake('docs', 'rag', async () => {
      throw new TypeError('index offline');
    });
    const memory = fake('memory', 'memory', [candidate('m1', 'fact', 0.5)]);
    const compiler = createContextCompiler({
      sources: [broken.source, memory.source],
      onWarning: (warning) => warnings.push(warning),
    });
    const pkg = await compiler.beforeModelCall(step(1, [{ role: 'user', content: 'go' }]));
    expect(pkg.manifest.fallback).toBe('source-failed');
    expect(pkg.manifest.sources[0]).toMatchObject({
      source: 'docs',
      status: 'failed',
      error: { name: 'TypeError' },
    });
    expect(pkg.manifest.sources[1]).toMatchObject({ source: 'memory', status: 'ok', selected: 1 });
    expect(warnings).toEqual([
      {
        type: 'context-source-failed',
        setting: 'docs',
        message: expect.stringContaining("'docs'"),
      },
    ]);
    expect(contextWarnings(pkg.manifest)).toEqual(warnings);
  });

  it('stops the call when a required source fails, with its own error', async () => {
    const boom = new Error('policy store down');
    const policies = fake(
      'policies',
      'rag',
      async () => {
        throw boom;
      },
      true,
    );
    const compiler = createContextCompiler({ sources: [policies.source] });
    await expect(compiler.beforeModelCall(step(1, [{ role: 'user', content: 'go' }]))).rejects.toBe(
      boom,
    );
    expect(compiler.state()).toMatchObject({ passes: 0, placed: [] });
  });

  it('treats a non-array answer as a failure', async () => {
    const odd: ContextSource = { id: 'odd', kind: 'rag', query: async () => 'nope' as never };
    const compiler = createContextCompiler({ sources: [odd] });
    const pkg = await compiler.beforeModelCall(step(1, [{ role: 'user', content: 'go' }]));
    expect(pkg.manifest.sources[0]).toMatchObject({
      status: 'failed',
      error: { name: 'TypeError' },
    });
  });

  it('refuses two sources with one id', () => {
    const a = fake('same', 'rag', []);
    const b = fake('same', 'memory', []);
    expect(() => createContextCompiler({ sources: [a.source, b.source] })).toThrow(TypeError);
  });
});

describe('createContextCompiler state, overflow and compaction', () => {
  it('checkpoints plain JSON, and a restored compiler compiles the same', async () => {
    const make = () =>
      createContextCompiler({
        sources: [
          fake('memory', 'memory', [
            candidate('m1', 'fact one', 0.9),
            candidate('m2', 'fact two', 0.5),
          ]).source,
        ],
      });
    const original = make();
    const first = await original.beforeModelCall(
      step(1, [{ role: 'user', content: 'go' }], { workingMemory: snapshot('t1') }),
    );
    const saved = JSON.parse(JSON.stringify(original.state()));
    const restored = createContextCompiler({
      sources: [fake('memory', 'memory', []).source],
      state: saved,
    });
    const next = step(2, [{ role: 'user', content: 'go' }, ...first.blocks[0]!.messages], {
      workingMemory: snapshot('t1', 2),
    });
    expect(await restored.beforeModelCall(next)).toEqual(await original.beforeModelCall(next));
    expect(restored.state()).toEqual(original.state());
  });

  it('records the package blob in the state', async () => {
    const compiler = createContextCompiler({
      sources: [fake('memory', 'memory', [candidate('m1', 'fact', 0.9, { revision: 2 })]).source],
    });
    const pkg = await compiler.beforeModelCall(step(1, [{ role: 'user', content: 'go' }]));
    const blob = await contextPackageBlob(pkg);
    expect(blob.digest).toBe(await sha256Digest(blob.content));
    expect(blob.records).toEqual([{ recordId: 'm1', revision: 2 }]);
    expect(compiler.state().lastPackage).toEqual({ digest: blob.digest, bytes: blob.bytes });
    expect(compiler.state().placed).toEqual([
      {
        source: 'memory',
        recordId: 'm1',
        revision: 2,
        digest: sha256DigestSync('fact'),
        pass: 1,
        step: 1,
      },
    ]);
  });

  it('recompiles on overflow under the smaller budget without a new retrieval', async () => {
    const memory = fake('memory', 'memory', [
      candidate('m1', 'first fact '.repeat(60), 0.9),
      candidate('m2', 'second fact '.repeat(60), 0.8),
    ]);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    const full = await compiler.beforeModelCall(step(1, messages));
    expect(full.manifest.entries.filter((entry) => entry.selected)).toHaveLength(2);
    const smaller = await compiler.onOverflow({ ...step(1, messages), inputTokens: 2_000 });
    expect(memory.requests).toHaveLength(1);
    expect(smaller.manifest).toMatchObject({ refresh: 'overflow-retry', pass: 1 });
    expect(smaller.manifest.budget.inputTokens).toBe(2_000);
    const placed = compiler.state().placed.map((entry) => entry.recordId);
    expect(placed).toEqual(
      smaller.manifest.entries.filter((e) => e.selected).map((e) => e.recordId),
    );
  });

  it('throws ContextBudgetExceededError on overflow when mandatory content cannot fit', async () => {
    const skills = fake('skills', 'skills', [
      candidate('s/SKILL.md', 'body '.repeat(400), 0, { mandatory: true }),
    ]);
    const compiler = createContextCompiler({ sources: [skills.source] });
    const messages: Message[] = [{ role: 'user', content: 'go' }];
    await compiler.beforeModelCall(step(1, messages));
    await expect(
      compiler.onOverflow({ ...step(1, messages), inputTokens: 600 }),
    ).rejects.toMatchObject({
      name: 'ContextBudgetExceededError',
      phase: 'overflow-retry',
    });
    await expect(
      compiler.onOverflow({ ...step(1, messages), inputTokens: 600 }),
    ).rejects.toBeInstanceOf(ContextBudgetExceededError);
  });

  it('places again on an overflow retry what the retry compaction removed, or refuses it', async () => {
    // R2-1: the overflow path compacts away an earlier block; its mandatory
    // entry must come back in the retry (or the retry must throw), never vanish.
    const body = `SKILL BODY: always cite the page. ${'detail '.repeat(300)}`;
    const skills = fake('skills', 'skills', [
      candidate('pdf/SKILL.md', body, 0, { mandatory: true }),
    ]);
    const compiler = createContextCompiler({ sources: [skills.source] });
    const user: Message = { role: 'user', content: 'summarise the pdf' };
    const first = await compiler.beforeModelCall(step(1, [system, user]));
    const block = first.blocks[0]!.messages;
    // Step 2 reuses: the pass-1 block is still in the messages.
    const reused = await compiler.beforeModelCall(
      step(2, [
        system,
        user,
        ...block,
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'go on' },
      ]),
    );
    expect(reused.blocks).toEqual([]);
    // The model call overflows and the 2.3 compaction removes the pass-1 block.
    const compacted: Message[] = [
      system,
      { role: 'user', content: 'Summary: earlier work' },
      { role: 'user', content: 'go on' },
    ];
    // Too small for the body: the retry refuses instead of dropping it.
    await expect(
      compiler.onOverflow({ ...step(2, compacted), inputTokens: 1_000 }),
    ).rejects.toMatchObject({ name: 'ContextBudgetExceededError', phase: 'overflow-retry' });
    const retry = await compiler.onOverflow({ ...step(2, compacted), inputTokens: 50_000 });
    expect(skills.requests).toHaveLength(1);
    expect(retry.manifest.refresh).toBe('overflow-retry');
    expect(retry.manifest.entries).toContainEqual(
      expect.objectContaining({ recordId: 'pdf/SKILL.md', selected: true, reason: 'mandatory' }),
    );
    const append = retry.blocks.find((b) => b.placement === 'append');
    expect(append?.messages[0]!.content).toContain('SKILL BODY: always cite the page');
    expect(compiler.state().placed.map((entry) => entry.recordId)).toEqual(['pdf/SKILL.md']);
    // The next step carries the retry's block: nothing is placed twice.
    const next = await compiler.beforeModelCall(
      step(3, [...compacted, ...append!.messages, { role: 'assistant', content: 'done' }]),
    );
    expect(next.blocks).toEqual([]);
  });

  it('places again what a compaction removed while a due refresh has nothing to ask', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'Prefers aisle seats', 0.9)]);
    const compiler = createContextCompiler({ sources: [memory.source] });
    await compiler.beforeModelCall(step(1, [system, { role: 'user', content: 'book it' }]));
    compiler.requestRefresh();
    // The compaction left no user text: the refresh stays due, the block comes back.
    const pkg = await compiler.beforeModelCall(
      step(2, [system, { role: 'assistant', content: 'Summary: a booking.' }]),
    );
    expect(memory.requests).toHaveLength(1);
    expect(pkg.manifest.sources).toEqual([
      expect.objectContaining({ source: 'memory', status: 'ok', selected: 1 }),
    ]);
    expect(pkg.blocks[0]!.messages[0]!.content).toContain('Prefers aisle seats');
    expect(compiler.state().refreshRequested).toBe(true);
  });

  it('never places an older revision again after a newer one', async () => {
    // R2-2: m1@1 (pass 1) is superseded by m1@2 (pass 2).
    const run = async (keep: 'newer' | 'older') => {
      let revision = 1;
      const memory = fake('memory', 'memory', async () =>
        revision === 1
          ? [candidate('m1', 'OLD seat preference: window', 0.9, { revision: 1 })]
          : [candidate('m1', 'NEW seat preference: aisle', 0.9, { revision: 2 })],
      );
      const compiler = createContextCompiler({ sources: [memory.source] });
      const user: Message = { role: 'user', content: 'book my seat' };
      const block1 = (await compiler.beforeModelCall(step(1, [system, user]))).blocks[0]!.messages;
      revision = 2;
      compiler.requestRefresh();
      const block2 = (
        await compiler.beforeModelCall(
          step(2, [system, user, ...block1, { role: 'assistant', content: 'ok' }]),
        )
      ).blocks[0]!.messages;
      expect(JSON.stringify(block2)).toContain('NEW seat preference');
      // A compaction removes one of the two blocks.
      const pkg = await compiler.beforeModelCall(
        step(3, [
          system,
          { role: 'user', content: 'Summary: earlier turns' },
          user,
          ...(keep === 'newer' ? block2 : block1),
          { role: 'assistant', content: 'ok 2' },
        ]),
      );
      return { pkg, placed: compiler.state().placed, requests: memory.requests.length };
    };

    const newer = await run('newer');
    expect(newer.pkg.blocks).toEqual([]);
    expect(newer.placed).toEqual([expect.objectContaining({ recordId: 'm1', revision: 2 })]);
    // Only the older block is left: the newer revision is placed again after it.
    const older = await run('older');
    const appended = JSON.stringify(older.pkg.blocks[0]!.messages);
    expect(appended).toContain('NEW seat preference');
    expect(appended).not.toContain('OLD seat preference');
    expect(older.requests).toBe(2);
  });

  it('tells a block from a later re-placement block of the same pass', async () => {
    // R2-3: alpha (pass 1), beta (pass 2), alpha again in a pass-2 block at
    // step 3; a second compaction removes the original pass-2 block.
    let pass = 1;
    const memory = fake('memory', 'memory', async () =>
      pass === 1
        ? [candidate('a', 'alpha fact', 0.9)]
        : [candidate('a', 'alpha fact', 0.9), candidate('b', 'beta fact', 0.8)],
    );
    const compiler = createContextCompiler({ sources: [memory.source] });
    const user: Message = { role: 'user', content: 'plan it' };
    const appendOf = (pkg: ContextPackage) =>
      pkg.blocks.filter((block) => block.placement === 'append').flatMap((b) => b.messages);
    const block1 = appendOf(await compiler.beforeModelCall(step(1, [system, user])));
    pass = 2;
    compiler.requestRefresh();
    const block2 = appendOf(
      await compiler.beforeModelCall(
        step(2, [system, user, ...block1, { role: 'assistant', content: 'ok1' }]),
      ),
    );
    expect(JSON.stringify(block2)).toContain('beta fact');
    expect(JSON.stringify(block2)).not.toContain('alpha fact');
    // Compaction 1 removes the pass-1 block: alpha comes back.
    const block3 = appendOf(
      await compiler.beforeModelCall(
        step(3, [
          system,
          { role: 'user', content: 'Summary 1' },
          user,
          ...block2,
          { role: 'assistant', content: 'ok2' },
        ]),
      ),
    );
    expect(JSON.stringify(block3)).toContain('alpha fact');
    expect(compiler.state().placed).toEqual([
      expect.objectContaining({ recordId: 'b', pass: 2, step: 2 }),
      expect.objectContaining({ recordId: 'a', pass: 2, step: 3 }),
    ]);
    // Compaction 2 removes the original pass-2 block and keeps the step-3 one.
    const p4 = await compiler.beforeModelCall(
      step(4, [
        system,
        { role: 'user', content: 'Summary 2' },
        user,
        ...block3,
        { role: 'assistant', content: 'ok3' },
      ]),
    );
    expect(JSON.stringify(appendOf(p4))).toContain('beta fact');
    expect(JSON.stringify(appendOf(p4))).not.toContain('alpha fact');
    expect(memory.requests).toHaveLength(2);
  });

  it('keeps reading the pass alone for an entry checkpointed without its step', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'Prefers aisle seats', 0.9)]);
    const user: Message = { role: 'user', content: 'book it' };
    const original = createContextCompiler({ sources: [memory.source] });
    const first = await original.beforeModelCall(step(1, [system, user]));
    const saved = original.state();
    // A state written before entries carried their block's step.
    for (const entry of saved.placed) delete entry.step;
    const restored = createContextCompiler({ sources: [memory.source], state: saved });
    const pkg = await restored.beforeModelCall(
      step(2, [system, user, ...first.blocks[0]!.messages, { role: 'assistant', content: 'ok' }]),
    );
    expect(pkg.blocks).toEqual([]);
    expect(restored.state().placed).toEqual([expect.objectContaining({ recordId: 'm1', pass: 1 })]);
  });

  it('asks again for a mandatory entry a compaction removed after a restart, past the pass limit', async () => {
    // R2-4: the restored compiler never retrieved the body itself.
    const body = 'SKILL BODY: always cite the page';
    const skillsSource = () =>
      fake('skills', 'skills', [
        candidate('pdf/SKILL.md', body, 0, { mandatory: true }),
        candidate('pdf', 'pdf (pdf): read PDF files', 0.5),
      ]);
    const user: Message = { role: 'user', content: 'summarise the pdf' };
    const original = createContextCompiler({
      sources: [skillsSource().source],
      refresh: { maxPasses: 1 },
    });
    const first = await original.beforeModelCall(step(1, [system, user]));
    expect(first.blocks[0]!.messages[0]!.content).toContain(body);
    const skills = skillsSource();
    const restored = createContextCompiler({
      sources: [skills.source],
      refresh: { maxPasses: 1 },
      state: JSON.parse(JSON.stringify(original.state())),
    });
    const compacted: Message[] = [system, { role: 'user', content: 'Summary: earlier' }, user];
    const pkg = await restored.beforeModelCall(step(2, compacted));
    expect(skills.requests).toHaveLength(1);
    expect(pkg.manifest).toMatchObject({ refresh: 'reused', pass: 1 });
    // Only the mandatory record comes back; the catalog line waits for a refresh.
    expect(pkg.manifest.entries).toEqual([
      expect.objectContaining({ recordId: 'pdf/SKILL.md', selected: true, reason: 'mandatory' }),
    ]);
    expect(pkg.blocks[0]!.messages[0]!.content).toContain(body);
    expect(restored.state()).toMatchObject({
      passes: 1,
      placed: [{ recordId: 'pdf/SKILL.md', pass: 1, step: 2, mandatory: true }],
    });
    // Placed again from what it now retrieved: no second question.
    const later = await restored.beforeModelCall(step(3, compacted));
    expect(later.blocks[0]!.messages[0]!.content).toContain(body);
    expect(skills.requests).toHaveLength(1);
  });

  it('lets a mandatory entry go once its source stops offering it, and reports a failing source', async () => {
    const original = createContextCompiler({
      sources: [
        fake('skills', 'skills', [candidate('pdf/SKILL.md', 'body', 0, { mandatory: true })])
          .source,
      ],
    });
    const user: Message = { role: 'user', content: 'go' };
    await original.beforeModelCall(step(1, [system, user]));
    const saved = original.state();
    const compacted: Message[] = [system, { role: 'user', content: 'Summary' }, user];

    const unloaded = fake('skills', 'skills', []);
    const restored = createContextCompiler({ sources: [unloaded.source], state: saved });
    const gone = await restored.beforeModelCall(step(2, compacted));
    expect(unloaded.requests).toHaveLength(1);
    expect(gone.blocks).toEqual([]);
    expect(restored.state().placed).toEqual([]);

    const warnings: CallWarning[] = [];
    const failing = fake('skills', 'skills', async () => {
      throw new Error('registry down');
    });
    const warned = createContextCompiler({
      sources: [failing.source],
      state: saved,
      onWarning: (warning) => warnings.push(warning),
    });
    const failed = await warned.beforeModelCall(step(2, compacted));
    expect(failed.manifest.sources).toEqual([
      expect.objectContaining({ source: 'skills', status: 'failed' }),
    ]);
    expect(failed.manifest.fallback).toBe('source-failed');
    expect(warnings).toEqual([expect.objectContaining({ type: 'context-source-failed' })]);

    const required = fake(
      'skills',
      'skills',
      async () => {
        throw new Error('registry down');
      },
      true,
    );
    const strict = createContextCompiler({ sources: [required.source], state: saved });
    await expect(strict.beforeModelCall(step(2, compacted))).rejects.toThrow('registry down');
  });

  it('places again what a compaction removed, and notes the prefix change', async () => {
    const memory = fake('memory', 'memory', [candidate('m1', 'Prefers aisle seats', 0.9)]);
    const compiler = createContextCompiler({ sources: [memory.source] });
    const user: Message = { role: 'user', content: 'book it' };
    const first = await compiler.beforeModelCall(step(1, [system, user]));
    const kept = await compiler.beforeModelCall(
      step(2, [system, user, ...first.blocks[0]!.messages, { role: 'assistant', content: 'ok' }]),
    );
    expect(kept.blocks).toEqual([]);
    expect(kept.manifest.cachePrefixChanged).toBe(false);
    const compacted = await compiler.beforeModelCall(
      step(3, [system, { role: 'user', content: 'Summary: the user wants a flight.' }, user]),
    );
    expect(memory.requests).toHaveLength(1);
    expect(compacted.manifest).toMatchObject({ refresh: 'reused', cachePrefixChanged: true });
    expect(compacted.blocks[0]!.messages[0]!.content).toContain('Prefers aisle seats');
  });

  it('never touches the messages it is given or adds a system message', async () => {
    const compiler = createContextCompiler({
      sources: [fake('memory', 'memory', [candidate('m1', 'fact', 0.9)]).source],
    });
    const messages: Message[] = [system, { role: 'user', content: 'go' }];
    const before = JSON.stringify(messages);
    const pkg = await compiler.beforeModelCall(
      step(1, messages, { workingMemory: snapshot('t1') }),
    );
    expect(JSON.stringify(messages)).toBe(before);
    for (const block of pkg.blocks)
      for (const message of block.messages) expect(message.role).toBe('user');
  });

  it('compiles again after a forget redacted the package, past the pass limit', async () => {
    const memory = fake('memory', 'memory', []);
    const compiler = createContextCompiler({ sources: [memory.source], refresh: { maxPasses: 1 } });
    const user: Message = { role: 'user', content: 'go' };
    await compiler.beforeModelCall(step(1, [user]));
    const redacted = await compiler.beforeModelCall(step(1, [user], { redacted: true }));
    expect(memory.requests).toHaveLength(2);
    expect(redacted.manifest).toMatchObject({ refresh: 'redacted', redacted: true });
  });

  it('names the estimator per step', async () => {
    const compiler = createContextCompiler({
      sources: [],
      estimatorKind: { kind: 'tokenizer', calibrated: false },
    });
    const user: Message = { role: 'user', content: 'go' };
    expect((await compiler.beforeModelCall(step(1, [user]))).manifest.estimator).toEqual({
      kind: 'tokenizer',
      calibrated: false,
    });
    const calibrated = await compiler.beforeModelCall(
      step(2, [user], { estimatorKind: { kind: 'tokenizer', calibrated: true } }),
    );
    expect(calibrated.manifest.estimator.calibrated).toBe(true);
  });
});

describe('createContextCompiler telemetry', () => {
  it('reports deuz.context.compile with counts, never content', async () => {
    const observer = createMemoryObserver();
    let ids = 0;
    const compiler = createContextCompiler({
      sources: [fake('memory', 'memory', [candidate('m1', 'secret fact', 0.9)]).source],
      deps: { observer, generateId: () => `id-${++ids}`, clock },
    });
    await compiler.beforeModelCall(step(1, [{ role: 'user', content: 'go' }]));
    const events = observer.events();
    expect(events.map((event) => event.type)).toEqual(['operation.started', 'operation.completed']);
    const completed = events[1] as Extract<
      (typeof events)[number],
      { type: 'operation.completed' }
    >;
    expect(completed).toMatchObject({ subsystem: 'context', operation: 'deuz.context.compile' });
    expect(completed.attributes).toMatchObject({
      'deuz.context.selected': 1,
      'deuz.context.excluded': 0,
      'deuz.context.estimator': 'heuristic',
      'deuz.context.refresh_reason': 'initial',
      'deuz.context.cache_prefix_changed': false,
      'deuz.context.source.memory.selected': 1,
      'deuz.context.source.memory.excluded': 0,
      'deuz.context.manifest_digest': expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    for (const value of Object.values(completed.attributes ?? {}))
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    expect(JSON.stringify(events)).not.toContain('secret fact');
  });
});
