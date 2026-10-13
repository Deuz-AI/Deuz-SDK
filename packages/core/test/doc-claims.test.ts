/**
 * Documentation claims that drifted from the code (roadmap F28), each held against the thing
 * it describes: the Postgres serialization-retry table against the stores that retry, the
 * deploy guide against the deploy directory, and the 2.0 store claim against the Redis pack.
 * The 2.3 counts and tables that drifted during the release (W3 review V2-7, V4-3, V4-4, V4-5)
 * are held the same way: the /a2a entry row and the support matrix's A2A row against the
 * entry's exports and fixtures, the eval counts against the suites, and the home page's skill
 * card against the skill's reference files.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as a2a from '../src/a2a/index';
import { faultScenarios } from './eval/faults';
import { realModelBatchTasks, realModelTasks } from './eval/real-model';
import { offlineTasks } from './eval/tasks';

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..');
const REPO = resolve(CORE, '../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
/** A page's prose with every line break and indent folded to one space. */
const prose = (path: string) => read(path).replace(/\s+/g, ' ');
/** The line of `page` that starts with `start`. */
const row = (page: string, start: string) => {
  const at = page.indexOf(start);
  expect(at).toBeGreaterThanOrEqual(0);
  return page.slice(at, page.indexOf('\n', at));
};
const NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

describe('operations.mdx: Postgres serialization retries', () => {
  it('lists every Postgres store whose writes run again on 40001 / 40P01', () => {
    const nodeDir = join(CORE, 'src/node');
    const factories = readdirSync(nodeDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(nodeDir, file), 'utf8'))
      .filter((code) => code.includes('retryPostgres(SERIALIZATION_CODES'))
      .flatMap((code) =>
        [...code.matchAll(/^export function (createPostgres\w+)\(/gm)].map((m) => m[1]!),
      );
    expect(factories.sort()).toEqual([
      'createPostgresBudgetStore',
      'createPostgresOpsStore',
      'createPostgresStores',
      'createPostgresSwarmStore',
    ]);

    const page = read('docs/content/docs/modules/operations.mdx');
    const start = page.indexOf('serialization failure (40001)');
    expect(start).toBeGreaterThan(0);
    const passage = page.slice(start, page.indexOf('\n## ', start));
    for (const factory of factories) expect(passage).toContain(`\`${factory}\``);
  });
});

describe('deploy/README.md', () => {
  const readme = read('deploy/README.md');
  const files = readdirSync(join(REPO, 'deploy')).filter((name) => name !== 'README.md');
  const matches = (pattern: string) => {
    const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
    return files.filter((name) => re.test(name));
  };

  it('points only at files the deploy directory contains', () => {
    const named = new Set<string>();
    for (const m of readme.matchAll(/\bdeploy[\\/]([\w.*-]+)/g)) named.add(m[1]!);
    const table = readme.slice(readme.indexOf('## Files'));
    for (const m of table.matchAll(/^\| `([^`]+)` \|/gm)) named.add(m[1]!);
    expect(named.size).toBeGreaterThan(0);
    const missing = [...named].filter((name) => matches(name).length === 0);
    expect(missing).toEqual([]);
  });

  it('documents every file of the deploy directory in its Files table', () => {
    const table = readme.slice(readme.indexOf('## Files'));
    const listed = [...table.matchAll(/^\| `([^`]+)` \|/gm)].flatMap((m) => matches(m[1]!));
    expect(files.filter((name) => !listed.includes(name))).toEqual([]);
  });

  it('deploys from main, not from another branch', () => {
    const branches = [...readme.matchAll(/`([\w./-]+)` branch|branch `([\w./-]+)`/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(branches.filter((branch) => branch !== 'main')).toEqual([]);
  });
});

describe('changelogs: the 2.0 store claim', () => {
  it('the Redis pack serves runs today', () => {
    const redis = readFileSync(join(CORE, 'src/node/store-redis.ts'), 'utf8');
    expect(redis).toMatch(/\bruns\b[^\n]*RunStore/);
  });

  it.each(['packages/core/CHANGELOG.md', 'packages/react/CHANGELOG.md'])(
    '%s corrects the 2.0 claim that Redis had a run store',
    (path) => {
      const changelog = read(path);
      const start = changelog.indexOf('\n## 2.0.0');
      const notes = changelog.slice(start, changelog.indexOf('\n## ', start + 1));
      expect(notes).toContain(
        'Redis, and Postgres — each implementing the memory, chat, session, and run stores',
      );
      expect(notes).toMatch(
        /Correction \(2\.3\): the Redis pack implemented the memory, chat, and session stores only[^\n]*`createRedisStores` returns `runs`/,
      );
    },
  );
});

describe('2.3 release notes: the /a2a entry (W3 review V2-7, V4-5)', () => {
  it('the whats-new entry table lists every value @deuz-sdk/core/a2a exports', () => {
    const entry = row(
      read('docs/content/docs/reference/whats-new-2-3.mdx'),
      '| `@deuz-sdk/core/a2a`',
    );
    expect(Object.keys(a2a)).toContain('createA2AAgentExecutor');
    expect(Object.keys(a2a).filter((name) => !entry.includes(`\`${name}\``))).toEqual([]);
  });

  it("the support matrix's A2A row names the executor and its fixtures", () => {
    const matrix = row(read('docs/content/docs/reference/support-matrix.mdx'), '| A2A v1.0.0');
    expect(matrix).toContain('`createA2AAgentExecutor`');
    for (const fixture of ['a2a-agent', 'a2a-agent-interop']) {
      expect(existsSync(join(CORE, 'test', `${fixture}.test.ts`))).toBe(true);
      expect(matrix).toContain(`\`${fixture}\``);
    }
  });
});

describe('2.3 release notes: the eval baseline (W3 review V4-3)', () => {
  it.each([
    'docs/content/docs/reference/whats-new-2-3.mdx',
    'docs/content/docs/changelog.mdx',
    'docs/content/docs/modules/evals.mdx',
  ])('%s counts the offline tasks and fault scenarios the suites run', (path) => {
    const counts = prose(path).match(
      /(\d+) offline tasks and (\d+) fault-injection scenarios(?: \((\d+) recovered, (\d+) contained\))?/,
    );
    expect(counts).not.toBeNull();
    const [, tasks, scenarios, recovered, contained] = counts!;
    expect(Number(tasks)).toBe(offlineTasks.length);
    expect(Number(scenarios)).toBe(faultScenarios.length);
    if (recovered !== undefined)
      expect(Number(recovered) + Number(contained)).toBe(faultScenarios.length);
  });

  it('the real-model task counts match the tasks the repository defines', () => {
    const live = realModelTasks(() => undefined).length;
    const batch = realModelBatchTasks(() => undefined).length;
    // The support matrix counts what `npm run test:live` runs: the batch twin is defined apart.
    const matrix = prose('docs/content/docs/reference/support-matrix.mdx').match(
      /2\.3 added (\w+) \[real-model eval tasks\]/,
    );
    expect(matrix).not.toBeNull();
    expect(NUMBERS.indexOf(matrix![1]!.toLowerCase())).toBe(live);
    // The release notes and the Evals page count every task defined, the batch twin included.
    for (const path of [
      'docs/content/docs/reference/whats-new-2-3.mdx',
      'docs/content/docs/modules/evals.mdx',
    ]) {
      const defined = prose(path).match(/(\w+) real-model tasks are defined/);
      expect(defined).not.toBeNull();
      expect(NUMBERS.indexOf(defined![1]!.toLowerCase())).toBe(live + batch);
    }
  });
});

describe('home-copy.ts: the deuz-sdk skill card (W3 review V4-4)', () => {
  it('states how many reference files the skill ships', () => {
    const files = readdirSync(join(REPO, 'skills/deuz-sdk/references')).filter((name) =>
      name.endsWith('.md'),
    ).length;
    const copy = read('docs/lib/home-copy.ts');
    const english = copy.match(/a task-to-file router, and (\w+) reference files/);
    expect(english).not.toBeNull();
    expect(NUMBERS.indexOf(english![1]!)).toBe(files);
    // The locales that write the count in digits (ja, ko).
    const digits = [...copy.matchAll(/(\d+) ?(?:個のリファレンス|개의 레퍼런스)/g)];
    expect(digits).toHaveLength(2);
    for (const m of digits) expect(Number(m[1])).toBe(files);
  });
});
