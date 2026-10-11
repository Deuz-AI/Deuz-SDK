/**
 * Workspace tasks over the attempt's file snapshot: a bug fix judged by running
 * a hidden test against the final file, and a small config migration judged by
 * parsing every migrated file. Both may only change files inside their scope.
 */
import { runAgent } from '../../../src/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { completes, offline, runWith, workspaceTools, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

const BUGGY_RANGE = [
  '/** The integers 0..n-1. */',
  'export function range(n) {',
  '  const out = [];',
  '  for (let i = 0; i <= n; i++) out.push(i);',
  '  return out;',
  '}',
  '',
].join('\n');

const FIXED_RANGE = BUGGY_RANGE.replace('i <= n', 'i < n');

/** Load `export function range` from source text and run the hidden checks on it. */
function rangeTestFailures(source: string | undefined): string[] {
  if (source === undefined) return ['src/range.js is missing'];
  let range: (n: number) => number[];
  try {
    range = new Function(`${source.replace(/^export /m, '')}\nreturn range;`)() as typeof range;
  } catch (error) {
    return [`src/range.js does not load: ${String(error)}`];
  }
  const failures: string[] = [];
  for (const [n, expected] of [
    [0, []],
    [1, [0]],
    [3, [0, 1, 2]],
  ] as const) {
    const actual = JSON.stringify(range(n));
    if (actual !== JSON.stringify(expected)) failures.push(`range(${n}) = ${actual}`);
  }
  return failures;
}

export const offByOne: EvalTaskManifest = {
  id: 'bug-fix/off-by-one',
  version: 1,
  title: 'Fix an off-by-one so the hidden tests pass',
  tags: ['bug-fix', 'workspace'],
  model: MOCK,
  start: {
    messages: [{ role: 'user', content: 'range(3) returns 4 numbers. Fix src/range.js.' }],
    files: {
      'src/range.js': BUGGY_RANGE,
      'README.md': '# range\n\n`range(n)` returns the integers 0..n-1.\n',
    },
  },
  tools: { allowed: ['read_file', 'run_tests', 'write_file'], scope: 'src/' },
  budget: { usd: 0.01 },
  artifacts: ['patch'],
  acceptance: [
    completes,
    {
      name: 'hidden tests pass on the final file',
      check: (_outcome, context) => rangeTestFailures(context.files['src/range.js']).length === 0,
    },
    {
      name: 'tests were run after the write',
      check: (_outcome, context) => context.store.lastTestRun === 'pass',
    },
  ],
  run: fixRange(
    offline([
      { toolCalls: [{ toolName: 'read_file', args: { path: 'src/range.js' } }] },
      { toolCalls: [{ toolName: 'run_tests', args: {} }] },
      {
        toolCalls: [
          { toolName: 'write_file', args: { path: 'src/range.js', content: FIXED_RANGE } },
        ],
      },
      { toolCalls: [{ toolName: 'run_tests', args: {} }] },
      { text: 'Fixed: the loop ran to n inclusive; it now stops before n. Tests pass.' },
    ]),
  ),
};

/** Run the bug fix on `on`'s model. */
export function fixRange(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const { read_file, write_file } = workspaceTools(context);
    const result = await runAgent({
      ...runWith(on, context),
      messages: context.messages,
      tools: {
        read_file: read_file!,
        write_file: write_file!,
        run_tests: {
          description: 'Run the project tests.',
          parameters: { type: 'object', properties: {} },
          execute: () => {
            const failures = rangeTestFailures(context.files['src/range.js']);
            context.store.lastTestRun = failures.length === 0 ? 'pass' : 'fail';
            return failures.length === 0 ? 'all tests pass' : failures.join('\n');
          },
        },
      },
    });
    context.artifact('patch', {
      file: 'src/range.js',
      before: BUGGY_RANGE.split('\n')[3],
      after: context.files['src/range.js']?.split('\n')[3],
    });
    return result;
  };
}

const CONFIGS = {
  'config/app.json': JSON.stringify({ name: 'app', timeout: 30 }, null, 2),
  'config/worker.json': JSON.stringify({ retries: 2, timeout: 5 }, null, 2),
};

/** The migration: `timeout` (seconds) becomes `timeoutMs` (milliseconds). */
function migrate(source: string): string {
  const { timeout, ...rest } = JSON.parse(source) as Record<string, unknown>;
  return JSON.stringify({ ...rest, timeoutMs: (timeout as number) * 1000 }, null, 2);
}

export const configMigration: EvalTaskManifest = {
  id: 'migration/timeout-to-ms',
  version: 1,
  title: 'Migrate every config from timeout (s) to timeoutMs',
  tags: ['migration', 'workspace'],
  model: MOCK,
  start: {
    messages: [
      {
        role: 'user',
        content: 'Rename `timeout` (seconds) to `timeoutMs` (milliseconds) in every config file.',
      },
    ],
    files: {
      ...CONFIGS,
      'docs/config.md': 'Set `timeout` in seconds.\n',
    },
  },
  tools: { allowed: ['list_files', 'read_file', 'write_file'], scope: 'config/' },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    {
      name: 'every config has timeoutMs in milliseconds and no timeout',
      check: (_outcome, context) =>
        Object.entries(CONFIGS).every(([path, before]) => {
          const after = JSON.parse(context.files[path] ?? 'null') as Record<string, unknown> | null;
          const old = JSON.parse(before) as Record<string, unknown>;
          return (
            after !== null &&
            !('timeout' in after) &&
            after.timeoutMs === (old.timeout as number) * 1000
          );
        }),
    },
    {
      name: 'other keys are kept',
      check: (_outcome, context) =>
        (JSON.parse(context.files['config/app.json']!) as { name?: string }).name === 'app' &&
        (JSON.parse(context.files['config/worker.json']!) as { retries?: number }).retries === 2,
    },
  ],
  run: migrateConfigs(
    offline([
      { toolCalls: [{ toolName: 'list_files', args: { path: 'config/' } }] },
      {
        toolCalls: Object.keys(CONFIGS).map((path) => ({ toolName: 'read_file', args: { path } })),
      },
      {
        toolCalls: Object.entries(CONFIGS).map(([path, source]) => ({
          toolName: 'write_file',
          args: { path, content: migrate(source) },
        })),
      },
      { text: 'Migrated config/app.json and config/worker.json to timeoutMs.' },
    ]),
  ),
};

/** Run the migration on `on`'s model. */
export function migrateConfigs(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return (context) =>
    runAgent({
      ...runWith(on, context),
      messages: context.messages,
      tools: workspaceTools(context),
    });
}
