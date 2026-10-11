/**
 * The Agent Skill's API index generator (packages/core/tooling/skills/generate-api-index.mjs).
 *
 * The index is the skill's name table: an agent checks it before importing anything, so its
 * format is a contract. The golden below pins that format on a small fixture package; the last
 * test pins the generator against the index that shipped with 2.2.0 (when the tag is in the clone).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Kind = 'value' | 'type';
interface ExportModule {
  specifier: string;
  label: string;
  names: Map<string, Kind>;
}
interface ExportTable {
  version: string;
  contractHash: string;
  modules: ExportModule[];
  problems: string[];
}
interface ExportTableModule {
  loadExportTable(options?: { core?: string; react?: string }): ExportTable;
  compareNames(a: string, b: string, locale?: string): number;
}
interface GeneratorModule {
  SUBPATH_DESCRIPTIONS: Record<string, string>;
  renderApiIndex(
    table: ExportTable,
    options: { date: string; locale?: string; descriptions?: Record<string, string> },
  ): string;
  resolveStampDate(options: { date?: string; env?: Record<string, string | undefined> }): string;
}

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..');
const REPO = resolve(CORE, '../..');
const TOOLING = join(CORE, 'tooling/skills');
const GENERATOR = join(TOOLING, 'generate-api-index.mjs');

// Non-literal specifiers: the tooling is plain .mjs run by node, with no declarations to import.
const load = async <T>(file: string): Promise<T> => import(pathToFileURL(join(TOOLING, file)).href);

let tables: ExportTableModule;
let generator: GeneratorModule;
let scratch: string;

/** Writes `files` (path -> content) under `dir`. */
function writeTree(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const entry = (dist: string) => ({
  import: { types: `./dist/${dist}.d.ts`, default: `./dist/${dist}.js` },
  require: { types: `./dist/${dist}.d.cts`, default: `./dist/${dist}.cjs` },
});

const CONTRACT = '{\n  "schemaVersion": 1\n}\n';
const contractHash = createHash('sha256').update(CONTRACT).digest('hex').slice(0, 12);

/** A miniature @deuz-sdk/core + @deuz-sdk/react pair covering every export form the walk handles. */
const FIXTURE: Record<string, string> = {
  'core/package.json': JSON.stringify({
    name: '@deuz-sdk/core',
    version: '9.8.7',
    exports: {
      '.': entry('index'),
      './alpha': entry('alpha'),
      './alpha/node': entry('alpha/node'),
      './beta': entry('beta/index'),
      './edge': entry('edge'),
      './react': entry('react'),
      './package.json': './package.json',
    },
  }),
  'core/tsup.config.ts': [
    "import { defineConfig } from 'tsup';",
    '',
    'export default defineConfig({',
    '  entry: {',
    "    index: 'src/index.ts',",
    "    alpha: 'src/alpha.ts',",
    "    'alpha/node': 'src/node/alpha.ts',",
    "    'beta/index': 'src/beta/index.ts',",
    "    edge: 'src/edge.ts',",
    "    react: 'src/react.ts',",
    '  },',
    "  format: ['esm', 'cjs'],",
    '});',
    '',
  ].join('\n'),
  'core/tooling/api-contract.json': CONTRACT,
  'core/src/index.ts': [
    "export { tool, type ToolDef } from './tool';",
    "export * from './errors';",
    "export type * from './types';",
    "export const VERSION = '1';",
    '',
  ].join('\n'),
  'core/src/tool.ts':
    'export function tool(): void {}\nexport interface ToolDef {\n  name: string;\n}\n',
  'core/src/errors.ts': [
    'export abstract class DeuzError extends Error {}',
    'export class InvalidRequestError extends DeuzError {}',
    'export function isDeuzError(): boolean {',
    '  return true;',
    '}',
    'export const imagePart = (): number => 0;',
    '',
  ].join('\n'),
  'core/src/types.ts': [
    'export interface Message {',
    '  role: Role;',
    '}',
    'export type Usage = { tokens: number };',
    "export type Role = 'user';",
    '',
  ].join('\n'),
  'core/src/internal.ts': 'export const helper = 1;\nexport type Secret = string;\n',
  'core/src/alpha.ts': [
    "import { helper } from './internal';",
    "import type { Secret } from './internal';",
    '',
    'const local = 1;',
    'interface LocalShape {',
    '  a: number;',
    '}',
    'export { local, helper, type LocalShape };',
    'export type { Secret };',
    "export { tool as alphaTool } from './tool';",
    "export * as ns from './internal';",
    '// export const commentedOut = 1;',
    '/** export const inJsDoc = 1; */',
    'export enum Mode {',
    '  A,',
    '}',
    'export let counter = 0,',
    '  other = 1;',
    'export const { destructured } = { destructured: 1 };',
    'export declare function declared(): void;',
    'export const Kind = { a: 1 } as const;',
    "export type Kind = (typeof Kind)['a'];",
    'const template = `export const inTemplate = 1;`;',
    'void template;',
    '',
  ].join('\n'),
  'core/src/node/alpha.ts': [
    "export { helper as nodeHelper } from '../internal';",
    "export { tool } from '../tool';",
    '',
  ].join('\n'),
  'core/src/beta/index.ts': 'export {};\n',
  'core/src/edge.ts': "export { helper } from './internal';\nexport * from './index';\n",
  'core/src/react.ts': 'export function useThing(): void {}\n',
  'react/package.json': JSON.stringify({ name: '@deuz-sdk/react', version: '9.8.7' }),
  'react/src/index.ts': [
    "export { useThing } from './use-thing';",
    "export { Card } from './components';",
    "export type { Message, ToolDef } from '@deuz-sdk/core';",
    '',
  ].join('\n'),
  'react/src/use-thing.ts': 'export function useThing(): void {}\n',
  'react/src/components.tsx': 'export function Card() {\n  return <div className="card" />;\n}\n',
};

const DESCRIPTIONS = {
  '@deuz-sdk/core': 'The root.',
  '@deuz-sdk/core/alpha': 'Alpha things.',
  '@deuz-sdk/core/alpha/node': 'Alpha on Node.',
  '@deuz-sdk/core/beta': 'Nothing yet.',
  '@deuz-sdk/core/edge': 'The edge subset.',
  '@deuz-sdk/core/react': 'Legacy hooks.',
  '@deuz-sdk/react': 'React bindings.',
};

const GOLDEN = `<!-- GENERATED FILE — do not hand-edit.
     regenerate: node packages/core/tooling/skills/generate-api-index.mjs --date YYYY-MM-DD
     source: packages/core/{package.json exports, tsup.config.ts} + src walk (export * followed)
     verified: 2026-01-02 against @deuz-sdk/core@9.8.7 · api-contract sha256:${contractHash} -->

# API index — every subpath, every export

**Load when:** checking whether a name exists, finding which subpath exports it, or exploring an unfamiliar module.

\`@deuz-sdk/core@9.8.7\` ships **6 subpaths**; \`@deuz-sdk/react\` ships one. Names marked under **Types** are type-only — import them with \`import type\`, or a bundler-free runtime will crash looking for a value that was erased at compile time.

If anything here disagrees with \`packages/core/package.json\` \`exports\` or \`tooling/api-contract.json\`, those win — and this file is stale; regenerate it.

## \`@deuz-sdk/core\`

The root.

**Values** (6): DeuzError, imagePart, InvalidRequestError, isDeuzError, tool, VERSION

**Types** (4): Message, Role, ToolDef, Usage

## \`@deuz-sdk/core/alpha\`

Alpha things.

**Values** (10): alphaTool, counter, declared, destructured, helper, Kind, local, Mode, ns, other

**Types** (2): LocalShape, Secret

## \`@deuz-sdk/core/alpha/node\`

Alpha on Node.

**Values** (2): nodeHelper, tool

**Types** (0): _none_

## \`@deuz-sdk/core/beta\`

Nothing yet.

**Values** (0): _none_

**Types** (0): _none_

## \`@deuz-sdk/core/edge\`

The edge subset.

**Values** (7): DeuzError, helper, imagePart, InvalidRequestError, isDeuzError, tool, VERSION

**Types** (4): Message, Role, ToolDef, Usage

## \`@deuz-sdk/core/react\`

Legacy hooks.

**Values** (1): useThing

**Types** (0): _none_

## \`@deuz-sdk/react\`

React bindings.

**Values** (2): Card, useThing

**Types** (2): Message, ToolDef

## Where a value lives (everything not exported from the root)

Reverse lookup for "which subpath do I import this from?". Root exports are omitted — try \`@deuz-sdk/core\` first.

- \`alphaTool\` — \`alpha\`
- \`Card\` — \`@deuz-sdk/react\`
- \`counter\` — \`alpha\`
- \`declared\` — \`alpha\`
- \`destructured\` — \`alpha\`
- \`helper\` — \`alpha\`
- \`Kind\` — \`alpha\`
- \`local\` — \`alpha\`
- \`Mode\` — \`alpha\`
- \`nodeHelper\` — \`alpha/node\`
- \`ns\` — \`alpha\`
- \`other\` — \`alpha\`
- \`useThing\` — \`react\`, \`@deuz-sdk/react\`
`;

const fixtureTable = () =>
  tables.loadExportTable({ core: join(scratch, 'core'), react: join(scratch, 'react') });

beforeAll(async () => {
  tables = await load<ExportTableModule>('export-table.mjs');
  generator = await load<GeneratorModule>('generate-api-index.mjs');
  scratch = mkdtempSync(join(tmpdir(), 'deuz-skill-index-'));
  writeTree(scratch, FIXTURE);
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('export table', () => {
  it('walks package.json exports through the tsup entry map, following export *', () => {
    const table = fixtureTable();
    expect(table.version).toBe('9.8.7');
    expect(table.contractHash).toBe(contractHash);
    expect(table.problems).toEqual([]);
    expect(table.modules.map((module) => module.specifier)).toEqual([
      '@deuz-sdk/core',
      '@deuz-sdk/core/alpha',
      '@deuz-sdk/core/alpha/node',
      '@deuz-sdk/core/beta',
      '@deuz-sdk/core/edge',
      '@deuz-sdk/core/react',
      '@deuz-sdk/react',
    ]);
    const alpha = table.modules[1]!.names;
    // Comments and string contents are not exports; a merged const + type is a value.
    expect(alpha.has('commentedOut')).toBe(false);
    expect(alpha.has('inJsDoc')).toBe(false);
    expect(alpha.has('inTemplate')).toBe(false);
    expect(alpha.get('Kind')).toBe('value');
    expect(alpha.get('Secret')).toBe('type');
  });

  it('reports a subpath that has no tsup entry instead of skipping it silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deuz-skill-noentry-'));
    try {
      writeTree(dir, FIXTURE);
      const pkg = JSON.parse(FIXTURE['core/package.json']!);
      pkg.exports['./gamma'] = entry('gamma');
      writeFileSync(join(dir, 'core/package.json'), JSON.stringify(pkg));
      const table = tables.loadExportTable({ core: join(dir, 'core'), react: join(dir, 'react') });
      expect(table.problems).toEqual(['export "./gamma" has no tsup entry']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes api-contract.json the same way on a CRLF checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deuz-skill-crlf-'));
    try {
      writeTree(dir, FIXTURE);
      writeFileSync(join(dir, 'core/tooling/api-contract.json'), CONTRACT.replace(/\n/g, '\r\n'));
      const table = tables.loadExportTable({ core: join(dir, 'core'), react: join(dir, 'react') });
      expect(table.contractHash).toBe(contractHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collates names case-insensitively in a pinned locale, not the machine one', () => {
    const names = ['isDeuzError', 'InvalidRequestError', 'imagePart', 'Image'];
    expect([...names].sort((a, b) => tables.compareNames(a, b))).toEqual([
      'Image',
      'imagePart',
      'InvalidRequestError',
      'isDeuzError',
    ]);
    // Turkish collation (capital I is dotless, before dotted i) is what the 2.2.0 file was
    // sorted with.
    expect([...names].sort((a, b) => tables.compareNames(a, b, 'tr'))).toEqual([
      'Image',
      'InvalidRequestError',
      'imagePart',
      'isDeuzError',
    ]);
  });
});

describe('renderApiIndex', () => {
  it('renders the index in its published format', () => {
    const text = generator.renderApiIndex(fixtureTable(), {
      date: '2026-01-02',
      descriptions: DESCRIPTIONS,
    });
    expect(text).toBe(GOLDEN);
  });

  it('is deterministic: the same input renders the same bytes', () => {
    const options = { date: '2026-01-02', descriptions: DESCRIPTIONS };
    expect(generator.renderApiIndex(fixtureTable(), options)).toBe(
      generator.renderApiIndex(fixtureTable(), options),
    );
  });

  it('honours an explicit collation locale', () => {
    const text = generator.renderApiIndex(fixtureTable(), {
      date: '2026-01-02',
      descriptions: DESCRIPTIONS,
      locale: 'tr',
    });
    expect(text).toContain(
      '**Values** (6): DeuzError, InvalidRequestError, imagePart, isDeuzError, tool, VERSION',
    );
  });

  it('refuses a subpath without a description', () => {
    const { '@deuz-sdk/core/beta': _beta, ...rest } = DESCRIPTIONS;
    expect(() =>
      generator.renderApiIndex(fixtureTable(), { date: '2026-01-02', descriptions: rest }),
    ).toThrow(/@deuz-sdk\/core\/beta.*SUBPATH_DESCRIPTIONS/);
  });

  it('refuses a malformed date', () => {
    expect(() =>
      generator.renderApiIndex(fixtureTable(), { date: '2026-13-01', descriptions: DESCRIPTIONS }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('describes every subpath the real package exports', { timeout: 30_000 }, () => {
    const table = tables.loadExportTable();
    expect(table.problems).toEqual([]);
    const missing = table.modules
      .map((module) => module.specifier)
      .filter((specifier) => !(specifier in generator.SUBPATH_DESCRIPTIONS));
    expect(missing).toEqual([]);
    expect(() => generator.renderApiIndex(table, { date: '2026-01-02' })).not.toThrow();
  });
});

describe('stamp date', () => {
  it('never reads the clock: no --date and no SOURCE_DATE_EPOCH is an error', () => {
    expect(() => generator.resolveStampDate({ env: {} })).toThrow(/--date.*SOURCE_DATE_EPOCH/);
  });

  it('takes SOURCE_DATE_EPOCH (UTC) when no date is given', () => {
    expect(generator.resolveStampDate({ env: { SOURCE_DATE_EPOCH: '1767312000' } })).toBe(
      '2026-01-02',
    );
    expect(() => generator.resolveStampDate({ env: { SOURCE_DATE_EPOCH: 'soon' } })).toThrow(
      /SOURCE_DATE_EPOCH/,
    );
  });

  it('prefers an explicit date over SOURCE_DATE_EPOCH', () => {
    expect(
      generator.resolveStampDate({ date: '2026-03-04', env: { SOURCE_DATE_EPOCH: '1767312000' } }),
    ).toBe('2026-03-04');
  });
});

// Each case starts node, which loads the TypeScript parser: allow for a slow CI runner.
describe('generate-api-index CLI', { timeout: 30_000 }, () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [GENERATOR, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SOURCE_DATE_EPOCH: undefined, ...env },
    });

  it('exits non-zero without a date', () => {
    const out = join(scratch, 'no-date.md');
    const result = run(['--core', join(scratch, 'core'), '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--date/);
  });

  it('never writes another checkout into this repository: --core needs --out', () => {
    const result = run(['--core', join(scratch, 'core'), '--date', '2026-01-02']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--core needs --out/);
  });

  it('reads --core and stops on a subpath it has no description for', () => {
    const out = join(scratch, 'fixture-core.md');
    const result = run(['--core', join(scratch, 'core'), '--date', '2026-01-02', '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no description for @deuz-sdk\/core\/alpha/);
  });

  it('writes the index for the real package to --out', () => {
    const out = join(scratch, 'real-core.md');
    const result = run(['--date', '2026-01-02', '--out', out]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text).toBe(generator.renderApiIndex(tables.loadExportTable(), { date: '2026-01-02' }));
  });
});

/** `git cat-file --batch` over every file under `paths` at `ref`, written below `dir`. */
function materialize(ref: string, paths: string[], dir: string): void {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, ...paths], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO,
    input: files.map((file) => `${ref}:${file}`).join('\n') + '\n',
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  for (const file of files) {
    const headerEnd = batch.indexOf(0x0a, offset);
    const size = Number(batch.subarray(offset, headerEnd).toString('utf8').split(' ')[2]);
    const body = batch.subarray(headerEnd + 1, headerEnd + 1 + size);
    offset = headerEnd + 1 + size + 1;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
}

const hasTag = (tag: string): boolean =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: REPO })
    .status === 0;

describe('reproduction', () => {
  // CI clones are shallow and carry no tags; the check runs wherever v2.2.0 is present.
  it.skipIf(!hasTag('v2.2.0'))(
    'reproduces the index that shipped with 2.2.0 from the v2.2.0 sources',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'deuz-skill-v220-'));
      try {
        materialize(
          'v2.2.0',
          [
            'packages/core/src',
            'packages/core/package.json',
            'packages/core/tsup.config.ts',
            'packages/core/tooling/api-contract.json',
            'packages/react/src',
          ],
          dir,
        );
        const shipped = execFileSync(
          'git',
          ['show', 'v2.2.0:skills/deuz-sdk/references/api-index.md'],
          { cwd: REPO, encoding: 'utf8' },
        );
        const table = tables.loadExportTable({
          core: join(dir, 'packages/core'),
          react: join(dir, 'packages/react'),
        });
        // The 2.2.0 file was sorted in a tr-TR default locale; its regenerate line named the
        // untracked scripts/ directory this tooling replaces. Everything else is byte-identical.
        const rendered = generator.renderApiIndex(table, { date: '2026-09-26', locale: 'tr' });
        const expected = shipped.replace(
          'regenerate: node .claude/skills/deuz-sdk/scripts/generate-api-index.mjs',
          'regenerate: node packages/core/tooling/skills/generate-api-index.mjs --date YYYY-MM-DD',
        );
        expect(rendered).toBe(expected);
        // With the pinned default collation, the only other change is one swapped pair.
        const english = generator.renderApiIndex(table, { date: '2026-09-26' });
        expect(english).toBe(
          expected.replace('InvalidRequestError, imagePart', 'imagePart, InvalidRequestError'),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
