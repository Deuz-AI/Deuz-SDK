/**
 * The 2.4 examples (21-23) run end to end and print what their READMEs say
 * they show, in the style of examples-keyless.test.ts. They need no API key:
 * 21 and 22 run on `createMockModel`; 23 needs a Docker engine with the
 * pinned alpine image, so here it always runs once without one (its skip
 * path), and its full run is gated like docker-live.test.ts: with
 * DEUZ_TEST_DOCKER=1 it runs (and fails, not skips, when Docker is missing).
 * The examples import the package by name; here those imports load the
 * sources, so no build is needed. Each run is a fresh instance of the example
 * over one module graph of the sources.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerAvailable, dockerCommand } from './fixtures/services';

vi.mock('@deuz-sdk/core/agent', () => import('../src/agent'));
vi.mock('@deuz-sdk/core/compute/docker', () => import('../src/compute/docker/index'));
vi.mock('@deuz-sdk/core/context', () => import('../src/context/index'));
vi.mock('@deuz-sdk/core/goal/runtime', () => import('../src/goal/runtime/index'));
vi.mock('@deuz-sdk/core/goal/runtime/sqlite', () => import('../src/node/goal-runtime-sqlite'));
vi.mock('@deuz-sdk/core/memory/versioned', () => import('../src/memory/versioned/index'));
vi.mock('@deuz-sdk/core/ops/sqlite', () => import('../src/node/ops-sqlite'));
vi.mock('@deuz-sdk/core/schedule', () => import('../src/schedule'));
vi.mock('@deuz-sdk/core/testing', () => import('../src/testing'));
vi.mock('@deuz-sdk/core/workspace', () => import('../src/workspace'));

/** The temporary directories an example made (22 and 23 keep their SQLite files in one). */
const tempDirs = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => {
      const dir = fs.mkdtempSync(prefix);
      tempDirs.push(dir);
      return dir;
    },
  };
});

let runs = 0;
/**
 * A fresh instance of the example's module: a new query string, not
 * `vi.resetModules()`, so every example shares one module graph of the
 * sources (see examples-keyless.test.ts).
 */
const example = (name: string): string =>
  new URL(`../../../examples/${name}/index.ts?run=${++runs}`, import.meta.url).href;

/** Run an example once and return what it printed, one entry per console.log call. */
async function run(name: string): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  tempDirs.length = 0;
  await import(/* @vite-ignore */ example(name));
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The printed lines of step `step` ("2) …"), up to the next step's header. */
function section(lines: string[], step: number): string {
  const header = /^\n?(\d+)\) /;
  const start = lines.findIndex((line) => header.exec(line)?.[1] === String(step));
  expect(start, `no step ${step}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && header.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The last run kept its files in one temporary directory and removed it when it finished. */
function expectTempDirRemoved(): void {
  expect(tempDirs).toHaveLength(1);
  expect(existsSync(tempDirs[0]!), tempDirs[0]).toBe(false);
}

describe('examples/21-versioned-memory-context', () => {
  it('revises, replays and forgets versioned memory placed by the compiler in a V3 run', async () => {
    const lines = await run('21-versioned-memory-context');
    const remembered = section(lines, 1);
    const revised = section(lines, 2);
    const ran = section(lines, 3);
    const forgot = section(lines, 4);
    const resumed = section(lines, 5);

    // Host writes are asserted and cite Ada's messages; a repeated operation id replays.
    expect(remembered).toContain(
      'mem-1 r1 asserted [user] "Ada deploys the billing service to eu-west-1."',
    );
    expect(remembered).toContain(`mem-3 r1 asserted [user] "Ada's staging password is hunter2."`);
    expect(remembered).toContain('onboarding-m1 again: replayed=true, mem-1 r1, scope revision 1');

    // A revise is a new revision; a stale expected revision conflicts; history and recordedAsOf.
    expect(revised).toContain(`revise: mem-2 r2 asserted [user] "Ada's deploy window is Tuesday`);
    expect(revised).toContain('a stale revise: revision_conflict, the record is at revision 2');
    expect(revised).toMatch(/history: r1 "[^"]*Friday[^"]*"\n.*history: r2 "[^"]*Tuesday/);
    expect(revised).toMatch(/recall as recorded before the fix: r1 "[^"]*Friday/);
    expect(revised).toMatch(/recall now: r2 "[^"]*Tuesday/);

    // Step 0 retrieves and places the current revisions; step 1 reuses the package.
    expect(ran).toMatch(
      /\[context\] step 0 \(refresh: initial\): placed (?=.*mem-1@1)(?=.*mem-2@2)(?=.*mem-3@1).*; working memory in the tail/,
    );
    expect(ran).toContain('[context] step 1 (refresh: reused): placed nothing new');
    // The model's memory write goes intent -> commit -> acknowledgment, and is inferred.
    expect(ran).toMatch(
      /\[memory-intent\] intended\n.*\[memory-intent\] committed\n.*\[memory-intent\] acknowledged/,
    );
    expect(ran).toContain(
      'written by the model: mem-4 r1 inferred [assistant] "Ada wants a message in #billing after each deploy."',
    );
    expect(ran).toContain('status: suspended');
    // Records are labelled with their origin and source kinds.
    expect(ran).toContain(
      '<record source="memory" kind="memory" id="mem-3" revision="1" origin="asserted" source_kinds="user">',
    );

    // The forget redacts the package that held the record; the next one is untouched.
    expect(forgot).toContain('[onForget] mem-3: 1 context package(s) redacted');
    expect(forgot).toContain('forget mem-3: revisions [1], redaction complete');
    expect(forgot).toContain('step 0 package: redacted');
    expect(forgot).toContain('step 1 package: found');
    expect(forgot).toContain('recall "password": 0 hits');

    // The resume runs the approved tool once and compiles again without the forgotten record.
    expect(
      resumed.match(/\[tool\] schedule_deploy\(billing, eu-west-1, Tuesday 10:00 UTC\)/g),
    ).toHaveLength(1);
    const recompiled =
      /\[context\] step 2 \(refresh: redacted, redacted: true\): placed (.*);/.exec(resumed);
    expect(recompiled?.[1]?.split(' ').sort()).toEqual(['mem-1@1', 'mem-2@2', 'mem-4@1']);
    expect(resumed).toContain('status: completed');
    expect(resumed).toContain("retrieval blocks in the history: 1 (step 0's was dropped)");
    expect(resumed).toContain('the stored run still holds the password: false');
    expect(resumed).toContain('the working memory tail entered the history: false');
    expect(resumed).toContain('memory intents: acknowledged');
    expect(resumed).toMatch(/Ada's records now: (?=.*mem-1 r1)(?=.*mem-2 r2)(?=.*mem-4 r1)/);
    expect(resumed).not.toContain('mem-3 r');
  }, 30_000);
});

describe('examples/22-goal-supervisor', () => {
  it('runs schedule -> inbox -> supervisor -> V3 run across a restart and an approval, then verifies', async () => {
    const lines = await run('22-goal-supervisor');
    const thursday = section(lines, 1);
    const caughtUp = section(lines, 2);
    const approved = section(lines, 3);
    const cancelled = section(lines, 4);

    // The goal waits for its schedule; 09:00 Berlin is 07:00Z before the clocks go back, 08:00Z after.
    expect(thursday).toContain('goal deps-clean: active, spec generation 1');
    expect(thursday).toContain('goal waiting for schedule weekly-audit');
    expect(thursday).toContain(
      'schedule weekly-audit r1: Mondays 09:00 Europe/Berlin, next 2026-10-19 07:00Z and 2026-10-26 08:00Z',
    );
    expect(thursday).toContain('ticks: 0 occurrences due, 0 runs dispatched');

    // After the restart: one catch-up delivery, applied with its start intent, one run that suspends.
    expect(caughtUp).toContain('host B opens deuz.sqlite');
    expect(caughtUp.match(/occurrence weekly-audit at .*: delivered/g)).toHaveLength(1);
    expect(caughtUp).toContain('occurrence weekly-audit at 2026-10-19 07:00Z: delivered');
    expect(caughtUp).toContain('a second tick: 0 occurrences');
    expect(caughtUp).toContain('[supervisor] claimed deps-clean under its goal lease');
    expect(caughtUp).toContain(
      '[supervisor] inbox entry schedule:weekly-audit weekly-audit@2026-10-19 07:00Z: applied',
    );
    expect(caughtUp).toMatch(
      /\[supervisor\] start intent for run deps-clean:run:1\n.*\[tool\] audit_dependencies: 2 vulnerable[^\n]*\n.*\[supervisor\] run deps-clean:run:1 suspended/,
    );
    expect(caughtUp).toContain('supervisor tick: 1 inbox entry applied, 1 run dispatched');
    expect(caughtUp).toContain('goal waiting (user: approval), run deps-clean:run:1 kept');
    expect(caughtUp).toContain(
      'waiting for approval: upgrade_packages({"packages":["lodash@4.17.21","minimist@1.2.8"]})',
    );
    expect(caughtUp).not.toContain('[tool] upgrade_packages');

    // The approval resumes the same run once; the verifier passes the clean report; the goal completes.
    expect(approved).toContain('[supervisor] resume intent for run deps-clean:run:1');
    expect(approved).not.toContain('start intent');
    expect(approved.match(/\[tool\] upgrade_packages\(/g)).toHaveLength(1);
    expect(approved).toContain('[tool] audit_dependencies: 0 vulnerable (reports/audit-2.json)');
    expect(approved).toContain('[supervisor] run deps-clean:run:1 completed');
    expect(approved).toContain('[verify] no-vulnerable-deps: passed on reports/audit-2.json');
    // Four mock calls of 10 + 5 tokens, charged once.
    expect(approved).toContain('goal completed (accepted), spent 60 of 20000 tokens');
    expect(approved).toContain(
      'evidence verifier: dependency-audit@1, reports/audit-2.json, generation 1, run deps-clean:run:1',
    );
    expect(approved).toContain('run deps-clean:run:1: version 3, terminal, completed');

    // The cancelled schedule delivers nothing more.
    expect(cancelled).toContain('schedule weekly-audit: cancelled, revision 2');
    expect(cancelled).toContain('tick at 2026-10-26 08:00Z: 0 occurrences');
    expect(cancelled).toContain('occurrence records: 2026-10-19 07:00Z delivered');
    expectTempDirRemoved();
  }, 30_000);
});

describe('examples/23-docker-runner', () => {
  /** Runs example 23 with `DOCKER_PATH` set to `docker`, the CLI it reads from the environment. */
  async function withDocker(docker: string): Promise<string[]> {
    const before = process.env.DOCKER_PATH;
    process.env.DOCKER_PATH = docker;
    try {
      return await run('23-docker-runner');
    } finally {
      if (before === undefined) delete process.env.DOCKER_PATH;
      else process.env.DOCKER_PATH = before;
    }
  }

  it('says why it skips and finishes normally when the Docker CLI cannot run', async () => {
    const lines = await withDocker('deuz-no-such-docker-cli');
    const skipped = section(lines, 1);
    expect(skipped).toMatch(/skipped: Docker is not available \(.*deuz-no-such-docker-cli/);
    expect(skipped).toContain('set DOCKER_PATH to its CLI');
    // Nothing past the probe ran: no step 2, no temporary directory.
    expect(lines.some((line) => /^\n?2\) /.test(line))).toBe(false);
    expect(tempDirs).toHaveLength(0);
  }, 30_000);

  // Gated like docker-live.test.ts: needs DEUZ_TEST_DOCKER=1 and the pinned image pulled.
  const docker = dockerAvailable();
  it.runIf(docker)(
    'isolates, stages, reconnects, cancels and cleans up on a real engine',
    async () => {
      const lines = await withDocker(dockerCommand());
      const sandboxed = section(lines, 1);
      const processed = section(lines, 2);
      const restarted = section(lines, 3);
      const cancelled = section(lines, 4);
      const cleaned = section(lines, 5);

      expect(sandboxed).not.toContain('skipped');
      expect(sandboxed).toContain('uid 10001');
      expect(sandboxed).toContain('orders 3');
      expect(sandboxed).toContain('offline');
      expect(sandboxed).toContain('exit 0; made.txt on the host: false');
      expect(sandboxed).toContain('sleep 30 with a 1 s timeout: timedOut=true, exit null');
      expect(sandboxed).toMatch(/cwd \.\.\/etc: exit null \(.*outside/);
      expect(sandboxed).toContain(
        'seq 1 1000 with a 64-byte tail: ends "1000", truncated={"stdout":true,"stderr":false}',
      );

      // The local image id differs by engine for the same pinned digest: Docker
      // Desktop's containerd store reports the index digest, a classic engine
      // (the CI runner) the config digest.
      expect(processed).toMatch(
        /start: (running|exited), container [0-9a-f]{12}, image [0-9a-f]{12}\n/,
      );
      expect(processed).toContain('poll: exited, exit code 0');
      expect(processed).toContain(String.raw`output: "done\n", truncated false`);
      expect(processed).toMatch(/artifact out\/total\.txt: "68", 3 bytes, sha256:[0-9a-f]{12}…/);
      expect(processed).toContain('artifact ../etc/passwd: artifact_rejected');

      expect(restarted).toContain('start again: exited, same container true');
      expect(restarted).toContain('the same id with another command: operation_conflict');

      expect(cancelled).toContain('long-job: running');
      expect(cancelled).toContain('cancel: cancelled, killed: true');

      expect(cleaned).toContain('reconcile: 2 matched, 0 orphans, 0 lost');
      expect(cleaned).toContain(String.raw`the stored output tail is still "done\n"`);
      expect(cleaned).toContain('records: orders-total disposed, long-job disposed');
      expect(cleaned).toContain('prune: 2 terminal records removed');
      expectTempDirRemoved();
      // No container of this run is left behind.
      const left = spawnSync(
        dockerCommand(),
        ['ps', '-a', '-q', '--filter', `label=deuz.scope=example-23-${process.pid}`],
        { encoding: 'utf8', shell: false, windowsHide: true, timeout: 60_000 },
      );
      expect(left.status).toBe(0);
      expect(left.stdout.trim()).toBe('');
    },
    120_000,
  );
});
