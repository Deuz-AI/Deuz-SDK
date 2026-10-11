/**
 * run-eval-suite.test.ts (2.3, roadmap 23.7) — the versioned task manifest and
 * `runEvalSuite` in `@deuz-sdk/core/testing`: what each attempt is measured on,
 * how the metrics add up per task and per tier, and that a report is written
 * only when the caller asks for one.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../src/agent-run';
import {
  createMockModel,
  runEvalSuite,
  type EvalTaskContext,
  type EvalTaskManifest,
  type EvalTaskOutcome,
} from '../../src/testing';

const parameters = { type: 'object' as const, properties: {} };
const completed = (output: unknown = 'ok'): EvalTaskOutcome => ({ status: 'completed', output });
const outputIs =
  (expected: unknown) =>
  (outcome: EvalTaskOutcome): boolean =>
    outcome.output === expected;

/** A minimal valid manifest; overrides win. */
function task(overrides: Partial<EvalTaskManifest> = {}): EvalTaskManifest {
  return {
    id: 'task',
    version: 1,
    acceptance: [{ name: 'output is ok', check: outputIs('ok') }],
    run: async () => completed(),
    ...overrides,
  };
}

/** A clock that advances 10 ms per read, so durations are deterministic. */
function steppingClock(): () => number {
  let now = 1_000;
  return () => (now += 10);
}

describe('runEvalSuite: attempts and the start snapshot', () => {
  it('runs every task its repeats, each attempt on a fresh copy of the start snapshot', async () => {
    const seen: Array<{ attempt: number; files: Record<string, string>; store: unknown }> = [];
    const report = await runEvalSuite([
      task({
        id: 'snapshot',
        repeats: 3,
        start: {
          messages: [{ role: 'user', content: 'fix it' }],
          files: { 'src/a.ts': 'old' },
          store: { counter: 0 },
        },
        run: async (context) => {
          seen.push({
            attempt: context.attempt,
            files: { ...context.files },
            store: structuredClone(context.store),
          });
          // Mutate everything: the next attempt must not see it.
          context.files['src/a.ts'] = 'new';
          (context.store as { counter: number }).counter += 1;
          context.messages.push({ role: 'assistant', content: 'done' });
          return completed();
        },
      }),
    ]);
    expect(seen).toEqual(
      [0, 1, 2].map((attempt) => ({
        attempt,
        files: { 'src/a.ts': 'old' },
        store: { counter: 0 },
      })),
    );
    const [entry] = report.tasks;
    expect(entry!.attempts).toHaveLength(3);
    expect(entry!.metrics).toMatchObject({ attempts: 3, successes: 3, successRate: 1 });
  });

  it('takes repeats and timeoutMs from the options for tasks that set none', async () => {
    let attempts = 0;
    const report = await runEvalSuite(
      [
        task({
          id: 'defaults',
          run: async () => {
            attempts += 1;
            return completed();
          },
        }),
        task({ id: 'own', repeats: 1, run: async () => completed() }),
      ],
      { repeats: 2 },
    );
    expect(attempts).toBe(2);
    expect(report.tasks.map((t) => t.attempts.length)).toEqual([2, 1]);
  });

  it('uses the suite runner for a task without its own', async () => {
    const report = await runEvalSuite([task({ id: 'shared', run: undefined })], {
      run: async (context) => completed(context.task.id === 'shared' ? 'ok' : 'wrong'),
    });
    expect(report.tasks[0]!.attempts[0]).toMatchObject({ status: 'completed', success: true });
  });
});

describe('runEvalSuite: success and false completion', () => {
  it('counts a completed run that fails acceptance as a false completion', async () => {
    const report = await runEvalSuite([
      task({ id: 'claims-done', run: async () => completed('wrong') }),
      task({
        id: 'honest-stop',
        run: async () => ({ status: 'stopped', reason: 'max-steps' }),
      }),
    ]);
    const [claims, honest] = report.tasks;
    expect(claims!.attempts[0]).toMatchObject({
      status: 'completed',
      success: false,
      falseCompleted: true,
      failures: ['output is ok'],
    });
    // A run that does not claim success is a failure, not a false completion.
    expect(honest!.attempts[0]).toMatchObject({
      status: 'stopped',
      success: false,
      falseCompleted: false,
    });
    expect(report.aggregate.offline).toMatchObject({
      tasks: 2,
      attempts: 2,
      successes: 0,
      falseCompleted: 1,
    });
  });

  it('scores partial credit with weights, or with the task grader', async () => {
    const report = await runEvalSuite([
      task({
        id: 'weighted',
        run: async () => completed({ a: true, b: false }),
        acceptance: [
          { name: 'a', weight: 3, check: (o) => (o.output as { a: boolean }).a },
          { name: 'b', weight: 1, check: (o) => (o.output as { b: boolean }).b },
        ],
      }),
      task({ id: 'graded', grade: () => 0.4 }),
      task({ id: 'clamped', grade: () => 7 }),
    ]);
    expect(report.tasks.map((t) => t.attempts[0]!.score)).toEqual([0.75, 0.4, 1]);
    expect(report.tasks[0]!.attempts[0]!.failures).toEqual(['b']);
  });

  it('reports a throwing acceptance check as a failed criterion, never a crash', async () => {
    const report = await runEvalSuite([
      task({
        acceptance: [
          {
            name: 'boom',
            check: () => {
              throw new Error('bad fixture');
            },
          },
        ],
      }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: false,
      failures: ['boom: bad fixture'],
    });
  });

  it('records a thrown run as an error attempt', async () => {
    const report = await runEvalSuite([
      task({
        run: async () => {
          throw new Error('kaput');
        },
      }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      status: 'error',
      success: false,
      falseCompleted: false,
      error: 'kaput',
    });
  });

  it('times an attempt out, aborts its signal and moves on', async () => {
    let signal: AbortSignal | undefined;
    const report = await runEvalSuite([
      task({
        id: 'hangs',
        timeoutMs: 20,
        run: (context) => {
          signal = context.signal;
          return new Promise<EvalTaskOutcome>(() => {});
        },
      }),
      task({ id: 'next' }),
    ]);
    expect(signal?.aborted).toBe(true);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({ status: 'timeout', success: false });
    expect(report.tasks[1]!.attempts[0]).toMatchObject({ success: true });
  });

  it('measures duration on the injected clock', async () => {
    const report = await runEvalSuite([task()], { clock: steppingClock() });
    expect(report.tasks[0]!.attempts[0]!.durationMs).toBe(10);
    expect(report.aggregate.offline!.durationMs).toBe(10);
  });
});

describe('runEvalSuite: human rescues are not required approvals', () => {
  /** A native run whose `deploy` tool needs approval; the context answers it. */
  async function deployRun(context: EvalTaskContext): Promise<EvalTaskOutcome> {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'deploy', id: 'd1', args: {} }] }, { text: 'ok' }],
    });
    const options = {
      model,
      prompt: 'deploy',
      session: { store: createInMemoryAgentRunStore(), runId: 'deploy', scope: 'eval' },
      tools: { deploy: { parameters, needsApproval: true, execute: () => 'deployed' } },
      deps: { observer: context.observer },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') return first;
    return resumeAgent({ ...options, approvalResponses: context.approve(first.pendingApprovals) });
  }

  it('counts a declared approval as required, not as a rescue', async () => {
    const report = await runEvalSuite([task({ approvals: ['deploy'], run: deployRun })]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: true,
      requiredApprovals: 1,
      humanRescues: 0,
      recovery: 'not-needed',
    });
  });

  it('counts an approval the task did not declare, and an explicit rescue, as rescues', async () => {
    const report = await runEvalSuite([
      task({ id: 'undeclared', run: deployRun }),
      task({
        id: 'explicit',
        run: async (context) => {
          context.rescue('edited the transcript by hand');
          return completed();
        },
      }),
    ]);
    expect(report.tasks.map((t) => t.attempts[0]!.humanRescues)).toEqual([1, 1]);
    expect(report.tasks.map((t) => t.attempts[0]!.requiredApprovals)).toEqual([0, 0]);
    expect(report.aggregate.offline).toMatchObject({ humanRescues: 2, requiredApprovals: 0 });
  });

  it('echoes signed tokens and denials in the verdicts it returns', async () => {
    let verdicts: unknown;
    await runEvalSuite([
      task({
        approvals: ['deploy'],
        run: async (context) => {
          verdicts = context.approve(
            [{ approvalId: 'a', toolCallId: 'c', toolName: 'deploy', input: {}, token: 't' }],
            false,
          );
          return completed();
        },
      }),
    ]);
    expect(verdicts).toEqual([{ approvalId: 'a', approved: false, token: 't' }]);
  });
});

describe('runEvalSuite: effects, tools, scope, budget and artifacts', () => {
  it('fails an attempt that executed one effect twice and names it', async () => {
    const report = await runEvalSuite([
      task({
        run: async (context) => {
          context.effect('charge:order-1');
          context.effect('charge:order-2');
          context.effect('charge:order-1');
          return completed();
        },
      }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: false,
      repeatedEffects: 1,
      failures: ['repeated effect: charge:order-1'],
    });
  });

  it('fails a run that called a tool outside the allowed set, seen through the observer', async () => {
    const run = async (context: EvalTaskContext): Promise<EvalTaskOutcome> =>
      runAgent({
        model: createMockModel({
          responses: [
            {
              toolCalls: [
                { toolName: 'read', args: {} },
                { toolName: 'delete', args: {} },
              ],
            },
            { text: 'ok' },
          ],
        }),
        prompt: 'tidy up',
        tools: {
          read: { parameters, execute: () => 'content' },
          delete: { parameters, execute: () => 'deleted' },
        },
        deps: { observer: context.observer },
      });
    const report = await runEvalSuite([
      task({ id: 'narrow', tools: { allowed: ['read'] }, run }),
      task({ id: 'wide', tools: { allowed: ['read', 'delete'] }, run }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: false,
      toolCalls: ['read', 'delete'],
      failures: ['tool outside the allowed set: delete'],
    });
    expect(report.tasks[1]!.attempts[0]).toMatchObject({ success: true });
  });

  it('fails a run that changed a file outside its scope', async () => {
    const report = await runEvalSuite([
      task({
        start: { files: { 'src/a.ts': 'a', 'package.json': '{}' } },
        tools: { scope: 'src/' },
        run: async (context) => {
          context.files['src/a.ts'] = 'b';
          context.files['src/new.ts'] = 'new';
          delete context.files['package.json'];
          return completed();
        },
      }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: false,
      failures: ['change outside the scope src/: package.json'],
    });
  });

  it('reads cost and tokens from a native result and fails an attempt over budget', async () => {
    const priced = (context: EvalTaskContext) =>
      runAgent({
        model: createMockModel({ responses: [{ text: 'ok', usage: { inputTokens: 100 } }] }),
        prompt: 'x',
        budget: { usd: 1 },
        deps: {
          observer: context.observer,
          priceProvider: { priceUsage: (_model, usage) => usage.inputTokens / 10_000 },
        },
      });
    const report = await runEvalSuite([
      task({ id: 'within', budget: { usd: 0.5, tokens: 1_000 }, run: priced }),
      task({ id: 'over-usd', budget: { usd: 0.001 }, run: priced }),
      task({ id: 'over-tokens', budget: { tokens: 50 }, run: priced }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: true,
      costUsd: 0.01,
      tokens: 105,
    });
    expect(report.tasks[1]!.attempts[0]).toMatchObject({
      success: false,
      failures: ['over the usd budget: 0.01 > 0.001'],
    });
    expect(report.tasks[2]!.attempts[0]).toMatchObject({
      success: false,
      failures: ['over the token budget: 105 > 50'],
    });
    expect(report.aggregate.offline).toMatchObject({ costUsd: 0.03, tokens: 315 });
  });

  it('keeps the artifacts a task records and fails one it declared but never made', async () => {
    const report = await runEvalSuite([
      task({
        id: 'made',
        artifacts: ['patch'],
        run: async (context) => {
          context.artifact('patch', { file: 'src/a.ts', lines: 2 });
          return completed();
        },
      }),
      task({ id: 'missing', artifacts: ['patch'] }),
    ]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: true,
      artifacts: { patch: { file: 'src/a.ts', lines: 2 } },
    });
    expect(report.tasks[1]!.attempts[0]).toMatchObject({
      success: false,
      failures: ['missing artifact: patch'],
    });
  });
});

describe('runEvalSuite: faults and recovery', () => {
  const fault = { boundary: 'after-effect-before-receipt', recovery: 'reconciled' };

  it('fails a fault scenario whose fault never fired: it proved nothing', async () => {
    const report = await runEvalSuite([task({ fault, run: async () => completed() })]);
    expect(report.tasks[0]!.attempts[0]).toMatchObject({
      success: false,
      failures: ['fault never fired: after-effect-before-receipt'],
    });
  });

  it('classifies the recovery and checks the path against the documented one', async () => {
    const report = await runEvalSuite([
      task({
        id: 'recovered',
        fault,
        run: async (context) => {
          context.interrupt('after-effect-before-receipt');
          return { ...completed(), recovery: 'reconciled' };
        },
      }),
      task({
        id: 'rescued',
        fault,
        run: async (context) => {
          context.interrupt('after-effect-before-receipt');
          context.rescue('chose retryToolCallIds');
          return { ...completed(), recovery: 'reconciled' };
        },
      }),
      task({
        id: 'other-path',
        fault,
        run: async (context) => {
          context.interrupt('after-effect-before-receipt');
          return { ...completed(), recovery: 'replayed' };
        },
      }),
      task({
        id: 'unrecovered',
        run: async (context) => {
          context.interrupt('mid-stream');
          return { status: 'failed', error: { name: 'Error', message: 'gone' } };
        },
      }),
    ]);
    expect(
      report.tasks.map((t) => {
        const a = t.attempts[0]!;
        return [a.success, a.recovery, a.recoveryPath, a.interruptions];
      }),
    ).toEqual([
      [true, 'recovered', 'reconciled', ['after-effect-before-receipt']],
      [true, 'rescued', 'reconciled', ['after-effect-before-receipt']],
      [false, 'recovered', 'replayed', ['after-effect-before-receipt']],
      [false, 'failed', undefined, ['mid-stream']],
    ]);
    expect(report.tasks[2]!.attempts[0]!.failures).toEqual([
      'recovery replayed, documented reconciled',
    ]);
    expect(report.aggregate.offline!.recovery).toEqual({
      'not-needed': 0,
      recovered: 2,
      rescued: 1,
      failed: 1,
    });
  });
});

describe('runEvalSuite: tiers, skips and validation', () => {
  it('aggregates offline and real-model tasks apart, and lists skipped tasks without attempts', async () => {
    const report = await runEvalSuite(
      [
        task({ id: 'offline-1' }),
        task({ id: 'real-1', tier: 'real-model', env: ['ANTHROPIC_API_KEY'] }),
        task({ id: 'real-2', tier: 'real-model', env: ['NOPE_KEY'] }),
      ],
      { skip: (t) => (t.env?.includes('NOPE_KEY') ? 'no NOPE_KEY' : undefined) },
    );
    expect(report.aggregate.offline).toMatchObject({ tasks: 1, attempts: 1 });
    expect(report.aggregate['real-model']).toMatchObject({ tasks: 1, attempts: 1, skipped: 1 });
    expect(report.tasks[2]).toMatchObject({ id: 'real-2', skipped: 'no NOPE_KEY', attempts: [] });
  });

  it('rejects a malformed suite before running any task', async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return completed();
    };
    const bad: Array<[EvalTaskManifest[], RegExp]> = [
      [[task({ run }), task({ run })], /duplicate task id "task"/],
      [[task({ id: '', run })], /id/],
      [[task({ version: 0, run })], /version/],
      [[task({ version: 1.5, run })], /version/],
      [[task({ acceptance: [], run })], /acceptance/],
      [[task({ repeats: 0, run })], /repeats/],
      [[task({ timeoutMs: -1, run })], /timeoutMs/],
      [[task({ run: undefined })], /no run/],
      [[task({ fault: { boundary: '', recovery: 'x' }, run })], /fault/],
    ];
    for (const [tasks, message] of bad) {
      await expect(runEvalSuite(tasks)).rejects.toThrow(message);
    }
    expect(ran).toBe(false);
  });
});

describe('runEvalSuite: the JSON report is opt-in', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes nothing by default and returns the report', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deuz-eval-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const report = await runEvalSuite([task()], { name: 'quiet' });
      expect(report).toMatchObject({ format: 'deuz-eval-suite', version: 1, name: 'quiet' });
    } finally {
      process.chdir(cwd);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('hands the report to a callback', async () => {
    const received: unknown[] = [];
    const report = await runEvalSuite([task()], { report: (r) => void received.push(r) });
    expect(received).toEqual([report]);
  });

  it('writes the report as JSON to a path, creating its directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deuz-eval-'));
    const path = join(dir, 'nested', 'report.json');
    const report = await runEvalSuite(
      [task({ artifacts: ['note'], run: async (c) => (c.artifact('note', 'hi'), completed()) })],
      { report: path, clock: steppingClock() },
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report);
  });
});
