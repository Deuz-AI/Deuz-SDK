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
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@deuz-sdk/core/agent', () => import('../src/agent'));
vi.mock('@deuz-sdk/core/context', () => import('../src/context/index'));
vi.mock('@deuz-sdk/core/memory/versioned', () => import('../src/memory/versioned/index'));
vi.mock('@deuz-sdk/core/testing', () => import('../src/testing'));

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
export function expectTempDirRemoved(): void {
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
