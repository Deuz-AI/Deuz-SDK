/**
 * examples/headless (2.3 preview, 23.8): the command line runs, resumes,
 * inspects and checks, printing JSON reports and exiting with their codes.
 * The example imports the package by name; here those imports load the
 * sources, so no build is needed. Each command is a fresh import of the
 * example, as each is a separate process from the shell.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@deuz-sdk/core/anthropic', () => import('../src/anthropic'));
vi.mock('@deuz-sdk/core/headless', () => import('../src/node/headless'));
vi.mock('@deuz-sdk/core/ops/sqlite', () => import('../src/node/ops-sqlite'));
vi.mock('@deuz-sdk/core/testing', () => import('../src/testing'));

const EXAMPLE = new URL('../../../examples/headless/index.ts', import.meta.url).href;

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

/** Run one command of the example: its exit code and the JSON it printed. */
async function cli(...args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  process.argv = [argv[0]!, 'index.ts', ...args, '--json', '--db', join(dir, 'runs.sqlite')];
  process.exitCode = 0;
  vi.resetModules();
  await import(/* @vite-ignore */ EXAMPLE);
  vi.mocked(console.log).mockRestore();
  return { code: Number(process.exitCode ?? 0), json: JSON.parse(lines.join('\n')) };
}

describe('examples/headless', () => {
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
});
