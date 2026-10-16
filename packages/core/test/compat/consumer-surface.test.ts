/**
 * consumer-surface.test.ts (2.4, W0A) — keeps the frozen 2.3 surface honest.
 *
 * `fixtures/api-contract-2.3.0.json` is the API contract as 2.3.0 shipped it.
 * The live contract (`tooling/api-contract.json`, which `verify:api` checks
 * against the build) may only grow: every 2.3 subpath, root export and locked
 * subpath export must still be in it, and every 2.3 subpath must still be a
 * package export with types for both `import` and `require`.
 *
 * The consumer type fixtures (`consumer-2.3*.test-d.ts`) import source files
 * directly, so this test also checks that each import is the file behind a
 * public subpath (the tsup entry map) and that every 2.3 subpath is imported
 * by one of them: the fixtures then use only the published surface, and all
 * of it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', '..');

interface ApiContract {
  requiredSubpaths: string[];
  requiredRootExports: string[];
  requiredSubpathExports: Record<string, string[]>;
}

const read = (path: string) => readFileSync(path, 'utf8');
const frozen = JSON.parse(read(join(here, 'fixtures', 'api-contract-2.3.0.json'))) as ApiContract;
const live = JSON.parse(read(join(core, 'tooling', 'api-contract.json'))) as ApiContract;
const pkg = JSON.parse(read(join(core, 'package.json'))) as {
  exports: Record<string, unknown>;
};

/** tsup entry name → source file (without `.ts`), read from the config's entry map. */
function tsupEntries(): Map<string, string> {
  const config = read(join(core, 'tsup.config.ts'));
  const entries = new Map<string, string>();
  for (const match of config.matchAll(/^\s*'?([\w/-]+)'?:\s*'src\/([\w/.-]+)\.ts',?$/gm)) {
    entries.set(match[1]!, match[2]!);
  }
  return entries;
}

/** The package subpath an entry name is published as. */
const subpathOf = (entry: string) =>
  entry === 'index' ? '.' : entry === 'mcp/index' ? './mcp' : `./${entry}`;

const FIXTURES = ['consumer-2.3.test-d.ts', 'consumer-2.3-implement.test-d.ts'];

function fixtureImports(): string[] {
  const specifiers = new Set<string>();
  for (const file of FIXTURES) {
    for (const match of read(join(here, file)).matchAll(/from '\.\.\/\.\.\/src\/([\w/.-]+)'/g)) {
      specifiers.add(match[1]!);
    }
  }
  return [...specifiers].sort();
}

describe('the 2.3.0 API contract only grows', () => {
  it('keeps every 2.3 subpath', () => {
    expect(frozen.requiredSubpaths.filter((s) => !live.requiredSubpaths.includes(s))).toEqual([]);
  });

  it('keeps every 2.3 root export', () => {
    expect(frozen.requiredRootExports.filter((n) => !live.requiredRootExports.includes(n))).toEqual(
      [],
    );
  });

  it('keeps every locked 2.3 subpath export', () => {
    const missing: string[] = [];
    for (const [subpath, names] of Object.entries(frozen.requiredSubpathExports)) {
      const now = live.requiredSubpathExports[subpath] ?? [];
      for (const name of names) if (!now.includes(name)) missing.push(`${subpath} ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('publishes every 2.3 subpath with ESM and CJS types', () => {
    const broken = frozen.requiredSubpaths.filter((subpath) => {
      if (subpath === './package.json') return !(subpath in pkg.exports);
      const entry = pkg.exports[subpath] as
        | { import?: { types?: string }; require?: { types?: string } }
        | undefined;
      return !entry?.import?.types || !entry.require?.types;
    });
    expect(broken).toEqual([]);
  });
});

describe('the consumer type fixtures use the published surface, all of it', () => {
  const entries = tsupEntries();
  const files = new Map([...entries].map(([entry, file]) => [file, subpathOf(entry)]));

  it('reads the tsup entry map', () => {
    expect(entries.get('index')).toBe('index');
    expect(entries.get('stores/sqlite')).toBe('node/store-sqlite');
  });

  it('imports only files behind a public subpath', () => {
    expect(fixtureImports().filter((file) => !files.has(file))).toEqual([]);
  });

  it('imports every 2.3 subpath', () => {
    const imported = new Set(fixtureImports().map((file) => files.get(file)));
    const missing = frozen.requiredSubpaths.filter(
      (subpath) => subpath !== './package.json' && !imported.has(subpath),
    );
    expect(missing).toEqual([]);
  });
});
