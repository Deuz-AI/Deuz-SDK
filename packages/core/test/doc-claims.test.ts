/**
 * Documentation claims that drifted from the code (roadmap F28), each held against the thing
 * it describes: the Postgres serialization-retry table against the stores that retry, the
 * deploy guide against the deploy directory, and the 2.0 store claim against the Redis pack.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..');
const REPO = resolve(CORE, '../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

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
