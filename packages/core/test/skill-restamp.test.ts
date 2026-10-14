/**
 * restamp-skills.mjs (packages/core/tooling/skills/): after a version bump or an API contract
 * change, it brings every freshness stamp of both skill copies, the generated api-index and the
 * subpath/export counts SKILL.md states up to date, so `verify-skill` passes again without a
 * hand edit of 38 stamps. It is the release step; verify-skill stays the gate.
 *
 * Each fixture is a skill stamped for an older release (`2.2.0`, a zero hash, wrong counts); the
 * gate it must satisfy afterwards is the real verify-skill against the CURRENT export table.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Kind = 'value' | 'type';
interface ExportTable {
  core: string;
  version: string;
  contractHash: string;
  modules: { specifier: string; label: string; names: Map<string, Kind> }[];
  problems: string[];
}
interface Contract {
  requiredSubpaths: string[];
  requiredRootExports: string[];
}
interface RestampResult {
  changed: string[];
  stamps: number;
  counts: { subpaths: number; exportKeys: number; rootExports: number };
}
interface RestampModule {
  restampSkills(options: {
    table?: ExportTable;
    contract?: Contract;
    skillDir?: string;
    mirrorDir?: string;
    date?: string;
  }): RestampResult;
}
interface VerifyModule {
  verifySkill(options: { table: ExportTable; skillDir: string; mirrorDir: string }): {
    failures: string[];
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..');
const TOOLING = join(CORE, 'tooling/skills');
const load = async <T>(file: string): Promise<T> => import(pathToFileURL(join(TOOLING, file)).href);

const OLD = '@deuz-sdk/core@2.2.0 · api-contract sha256:000000000000';
const OLD_COUNTS =
  '1 code subpaths (2 package export keys including `package.json`), 3 root exports';

let table: ExportTable;
let contract: Contract;
let restamp: RestampModule;
let verify: VerifyModule;
let renderApiIndex: (table: ExportTable, options: { date: string }) => string;
let scratch: string;
let counter = 0;

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A skill (and its .claude mirror) stamped for 2.2.0 with stale counts and a stale index. */
function staleSkill(): { skill: string; mirror: string } {
  const root = join(scratch, `skill-${counter++}`);
  const skill = join(root, 'skills/deuz-sdk');
  const mirror = join(root, '.claude/skills/deuz-sdk');
  writeTree(skill, {
    'SKILL.md': [
      '---',
      'name: deuz-sdk',
      'description: Fixture.',
      '---',
      '',
      `# Deuz`,
      '',
      `A runtime. ${OLD_COUNTS}, 29 provider ids across four wire surfaces.`,
      '',
      'Roll back with `npm i @deuz-sdk/core@2.2.0`; `@deuz-sdk/core@2.2.0` refuses version 2 envelopes.',
      '',
      `> Verified against ${OLD} · 2026-01-02`,
      '',
    ].join('\n'),
    'references/core.md': [
      `<!-- verified: 2026-01-02 against ${OLD}`,
      '     sources: packages/core/src/index.ts -->',
      '',
      '# Core',
      '',
    ].join('\n'),
    'references/api-index.md': renderApiIndex(
      { ...table, version: '2.2.0', contractHash: '000000000000' },
      { date: '2026-01-02' },
    ),
  });
  cpSync(skill, mirror, { recursive: true });
  writeFileSync(join(mirror, 'TESTING.md'), `# How this skill was tested\n\n${OLD}\n`);
  return { skill, mirror };
}

const files = ({ skill, mirror }: { skill: string; mirror: string }) =>
  [
    'SKILL.md',
    'references/core.md',
    'references/api-index.md',
    '.claude:SKILL.md',
    '.claude:references/core.md',
    '.claude:references/api-index.md',
    '.claude:TESTING.md',
  ].map((path) =>
    readFileSync(
      path.startsWith('.claude:') ? join(mirror, path.slice(8)) : join(skill, path),
      'utf8',
    ),
  );

const run = (fixture: { skill: string; mirror: string }, date?: string) =>
  restamp.restampSkills({
    table,
    contract,
    skillDir: fixture.skill,
    mirrorDir: fixture.mirror,
    ...(date ? { date } : {}),
  });

const current = () => `@deuz-sdk/core@${table.version} · api-contract sha256:${table.contractHash}`;

beforeAll(async () => {
  const tables = await load<{ loadExportTable(): ExportTable }>('export-table.mjs');
  table = tables.loadExportTable();
  contract = JSON.parse(readFileSync(join(CORE, 'tooling/api-contract.json'), 'utf8')) as Contract;
  ({ renderApiIndex } = await load<{ renderApiIndex: typeof renderApiIndex }>(
    'generate-api-index.mjs',
  ));
  verify = await load<VerifyModule>('verify-skill.mjs');
  restamp = await load<RestampModule>('restamp-skills.mjs');
  scratch = mkdtempSync(join(tmpdir(), 'deuz-skill-restamp-'));
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('restamp-skills', () => {
  it('brings every stamp, the index and the SKILL.md counts up to date, and verify-skill passes', () => {
    const fixture = staleSkill();
    expect(
      verify.verifySkill({ table, skillDir: fixture.skill, mirrorDir: fixture.mirror }).failures,
    ).not.toEqual([]);

    const result = run(fixture);

    expect(
      verify.verifySkill({ table, skillDir: fixture.skill, mirrorDir: fixture.mirror }).failures,
    ).toEqual([]);
    const [skillMd, core, , mirrorSkillMd, , , testing] = files(fixture);
    // The counts come from tooling/api-contract.json: `./package.json` is a key, not code.
    const keys = contract.requiredSubpaths.length;
    const counts = `${keys - 1} code subpaths (${keys} package export keys including \`package.json\`), ${contract.requiredRootExports.length} root exports`;
    expect(result.counts).toEqual({
      subpaths: keys - 1,
      exportKeys: keys,
      rootExports: contract.requiredRootExports.length,
    });
    expect(skillMd).toContain(counts);
    expect(mirrorSkillMd).toContain(counts);
    // Stamps everywhere in both trees, the mirror's own TESTING.md included; dates kept.
    expect(skillMd).toContain(`> Verified against ${current()} · 2026-01-02`);
    expect(core).toContain(`<!-- verified: 2026-01-02 against ${current()}`);
    expect(testing).toContain(current());
    // Seven stamps: SKILL.md, core.md and api-index.md in each copy, plus TESTING.md.
    expect(result.stamps).toBe(7);
    expect(result.changed).toHaveLength(7);
  });

  it('leaves version mentions that are not stamps, and counts it does not own, alone', () => {
    const fixture = staleSkill();
    run(fixture);
    const [skillMd] = files(fixture);
    expect(skillMd).toContain(
      'Roll back with `npm i @deuz-sdk/core@2.2.0`; `@deuz-sdk/core@2.2.0` refuses version 2 envelopes.',
    );
    expect(skillMd).toContain('29 provider ids across four wire surfaces');
  });

  it('is idempotent: a second run changes nothing, byte for byte', () => {
    const fixture = staleSkill();
    run(fixture);
    const once = files(fixture);
    const again = run(fixture);
    expect(again.changed).toEqual([]);
    expect(files(fixture)).toEqual(once);
  });

  it('re-dates every stamp and the index when given a date', () => {
    const fixture = staleSkill();
    run(fixture, '2026-02-03');
    const [skillMd, core, index] = files(fixture);
    expect(skillMd).toContain(`> Verified against ${current()} · 2026-02-03`);
    expect(core).toContain(`<!-- verified: 2026-02-03 against ${current()}`);
    expect(index).toBe(renderApiIndex(table, { date: '2026-02-03' }));
    expect(
      verify.verifySkill({ table, skillDir: fixture.skill, mirrorDir: fixture.mirror }).failures,
    ).toEqual([]);
  });

  it('refuses, writing nothing, when SKILL.md no longer states a count it refreshes', () => {
    const fixture = staleSkill();
    for (const dir of [fixture.skill, fixture.mirror]) {
      const path = join(dir, 'SKILL.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace(', 3 root exports', ''));
    }
    const before = files(fixture);
    expect(() => run(fixture)).toThrow(/SKILL\.md.*root exports/);
    expect(files(fixture)).toEqual(before);
  });

  it('rejects a date that is not a real YYYY-MM-DD day', () => {
    const fixture = staleSkill();
    const before = files(fixture);
    expect(() => run(fixture, '2026-02-30')).toThrow(/YYYY-MM-DD/);
    expect(files(fixture)).toEqual(before);
  });
});
