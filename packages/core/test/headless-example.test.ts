/**
 * examples/13-headless (2.3 preview, 23.8): the command line runs, resumes,
 * inspects and checks, printing JSON reports and exiting with their codes.
 * The example imports the package by name; here those imports load the
 * sources, so no build is needed. Each command is a fresh import of the
 * example, as each is a separate process from the shell.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@deuz-sdk/core/anthropic', () => import('../src/anthropic'));
vi.mock('@deuz-sdk/core/headless', () => import('../src/node/headless'));
vi.mock('@deuz-sdk/core/ops/sqlite', () => import('../src/node/ops-sqlite'));
vi.mock('@deuz-sdk/core/testing', () => import('../src/testing'));

const EXAMPLE = new URL('../../../examples/13-headless/index.ts', import.meta.url).href;

let dir: string;
const argv = process.argv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deuz-headless-example-'));
  // Never a real provider call from a test, whatever the developer's shell holds.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
});
afterEach(async () => {
  process.argv = argv;
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Run one command of the example: its exit code, the JSON it printed (`{}`
 * when it printed none) and its stderr lines.
 */
async function cli(
  ...args: string[]
): Promise<{ code: number; json: Record<string, unknown>; stderr: string[] }> {
  const lines: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    stderr.push(String(line));
  });
  process.argv = [argv[0]!, 'index.ts', ...args, '--json', '--db', join(dir, 'runs.sqlite')];
  process.exitCode = 0;
  vi.resetModules();
  await import(/* @vite-ignore */ EXAMPLE);
  vi.mocked(console.log).mockRestore();
  vi.mocked(console.error).mockRestore();
  return {
    code: Number(process.exitCode ?? 0),
    json: JSON.parse(lines.join('\n') || '{}'),
    stderr,
  };
}

/** The stderr lines that show the release being tagged (the effect). */
const tagged = (stderr: string[]) => stderr.filter((line) => line.includes('tagged v2.3.0'));

describe('examples/13-headless', () => {
  it('runs, waits for an approval (exit 3), and resumes to completion (exit 0)', async () => {
    const doctor = await cli('doctor');
    expect(doctor.code).toBe(0);
    expect(doctor.json).toMatchObject({ kind: 'deuz-headless-doctor', ok: true });

    const run = await cli('run', 'Publish the notes.', '--run-id', 'notes-1');
    expect(run.code).toBe(3);
    expect(run.json).toMatchObject({ runId: 'notes-1', outcome: 'pending' });

    const inspected = await cli('inspect', 'notes-1');
    expect(inspected.code).toBe(3);
    expect(inspected.json.pending).toEqual(run.json.pending);

    const resumed = await cli('resume', 'notes-1', '--approve');
    expect(resumed.code).toBe(0);
    expect(resumed.json).toMatchObject({ outcome: 'completed', output: 'Published the notes.' });
  }, 30_000);

  it('exits 4 on a refusal and 8 when doctor finds an error', async () => {
    const refused = await cli('run', '--mock', 'refusal');
    expect(refused.code).toBe(4);
    expect(refused.json).toMatchObject({ outcome: 'refused', reason: 'refusal' });

    // An Anthropic model without a key: doctor says so before any run.
    const doctor = await cli('doctor', '--model', 'claude-opus-5-5');
    expect(doctor.code).toBe(8);
    expect(JSON.stringify(doctor.json.findings)).toContain('missing-api-key');
  }, 30_000);

  it('records a landed effect with --reconcile (exit 0), and never repeats it', async () => {
    // The store goes down mid-call: the tag lands, its outcome is never saved.
    const crashed = await cli('run', '--mock', 'crash', '--run-id', 'tag-1');
    expect(crashed.code).toBe(1);
    expect(crashed.json).toMatchObject({ outcome: 'failed', phase: 'running' });
    expect(tagged(crashed.stderr)).toHaveLength(1);

    const inspected = await cli('inspect', 'tag-1');
    expect(inspected.code).toBe(3);
    expect(inspected.json.pending).toEqual([
      expect.objectContaining({
        kind: 'unknown-effect',
        toolName: 'tag_release',
        toolCallId: 'call_1',
        resumeWith: ['retryToolCallIds', 'reconciledToolResults'],
      }),
      { kind: 'resume', phase: 'running' },
    ]);

    // A file that cannot be read is a usage error, and the run still waits.
    const missing = await cli('resume', 'tag-1', '--reconcile', join(dir, 'missing.json'));
    expect(missing.code).toBe(2);
    expect((await cli('inspect', 'tag-1')).code).toBe(3);
    // JSON that holds no answers is passed on, so the resume refuses it (exit 1)
    // instead of quietly resuming without them; nothing is written.
    const empty = join(dir, 'null.json');
    await writeFile(empty, 'null');
    const refused = await cli('resume', 'tag-1', '--reconcile', empty);
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({
      outcome: 'failed',
      error: { name: 'TypeError', message: expect.stringContaining('reconciledToolResults') },
    });
    expect((await cli('inspect', 'tag-1')).code).toBe(3);

    const landed = join(dir, 'landed.json');
    await writeFile(landed, JSON.stringify([{ toolCallId: 'call_1', output: { tag: 'v2.3.0' } }]));
    const done = await cli('resume', 'tag-1', '--reconcile', landed);
    expect(done.code).toBe(0);
    expect(done.json).toMatchObject({ outcome: 'completed', output: 'Tagged v2.3.0.' });
    expect(tagged(done.stderr)).toHaveLength(0);
  }, 30_000);

  it('runs an unknown effect again with --retry-call', async () => {
    await cli('run', '--mock', 'crash', '--run-id', 'tag-2');
    const stopped = await cli('resume', 'tag-2');
    expect(stopped.code).toBe(3);
    expect(stopped.json).toMatchObject({ reason: 'tool-reconciliation-required' });
    const again = await cli('resume', 'tag-2', '--retry-call', 'call_1');
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({ outcome: 'completed', output: 'Tagged v2.3.0.' });
    expect(tagged(again.stderr)).toHaveLength(1);
  }, 30_000);

  it('re-enters a run that failed in transit with --retry-failed', async () => {
    const failed = await cli('run', '--mock', 'outage', '--run-id', 'draft-1');
    expect(failed.code).toBe(1);
    expect(failed.json).toMatchObject({
      outcome: 'failed',
      error: { code: 'breaker_open' },
      retry: { cause: 'model-call', phase: 'running', resumeWith: 'retryFailed' },
    });
    // Without the flag, the stored failure comes back, still retryable.
    const still = await cli('resume', 'draft-1');
    expect(still.code).toBe(1);
    expect(still.json.retry).toEqual(failed.json.retry);
    const retried = await cli('resume', 'draft-1', '--retry-failed');
    expect(retried.code).toBe(0);
    expect(retried.json).toMatchObject({ outcome: 'completed', output: 'The notes are ready.' });
  }, 30_000);
});
