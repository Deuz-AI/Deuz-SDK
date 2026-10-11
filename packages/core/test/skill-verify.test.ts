/**
 * The Agent Skill's gates (packages/core/tooling/skills/): verify-skill.mjs resolves every API
 * name the skill states against the real export table, fails on a stale freshness stamp or a
 * stale index, and fails when the two copies of the skill differ; sync-skill-copy.mjs derives
 * the .claude copy from skills/deuz-sdk.
 *
 * The passing fixture is built here from the CURRENT export table and contract hash, so it can
 * never go stale itself; every failure mode is a single mutation of it.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Kind = 'value' | 'type';
interface ExportTable {
  version: string;
  contractHash: string;
  modules: { specifier: string; label: string; names: Map<string, Kind> }[];
  problems: string[];
}
interface CopyDifference {
  path: string;
  kind: 'changed' | 'missing' | 'extra';
}
interface SyncModule {
  diffSkillCopies(source: string, mirror: string): CopyDifference[];
  writeSkillMirror(source: string, mirror: string): CopyDifference[];
}
interface VerifyResult {
  failures: string[];
  stats: { files: number; imports: number; names: number; attributions: number; stamps: number };
}
interface VerifyModule {
  verifySkill(options?: {
    table?: ExportTable;
    skillDir?: string;
    mirrorDir?: string;
  }): VerifyResult;
  verifyAnswers(dir: string, options?: { table?: ExportTable }): VerifyResult;
}

const here = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(here, '..');
const REPO = resolve(CORE, '../..');
const TOOLING = join(CORE, 'tooling/skills');
const load = async <T>(file: string): Promise<T> => import(pathToFileURL(join(TOOLING, file)).href);

let table: ExportTable;
let sync: SyncModule;
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

/** A skill whose names, stamps and index are all current, plus its .claude mirror. */
function freshSkill(): { skill: string; mirror: string; root: string } {
  const root = join(scratch, `skill-${counter++}`);
  const stamp = `@deuz-sdk/core@${table.version} · api-contract sha256:${table.contractHash}`;
  const skill = join(root, 'skills/deuz-sdk');
  const mirror = join(root, '.claude/skills/deuz-sdk');
  writeTree(skill, {
    'SKILL.md': [
      '---',
      'name: deuz-sdk',
      'description: Fixture.',
      '---',
      '',
      '# Deuz',
      '',
      'Await an outcome with `runAgent` from `@deuz-sdk/core/agent`.',
      '',
      '```ts',
      "import { generateText, type Message } from '@deuz-sdk/core';",
      'import {',
      '  createMockModel, // keyless',
      "} from '@deuz-sdk/core/testing';",
      '```',
      '',
      `> Verified against ${stamp} · 2026-01-02`,
      '',
    ].join('\n'),
    'references/core.md': [
      `<!-- verified: 2026-01-02 against ${stamp}`,
      '     sources: packages/core/src/index.ts -->',
      '',
      '# Core',
      '',
      '```ts',
      "import { streamChat } from '@deuz-sdk/core';",
      "import { useChat } from '@deuz-sdk/react';",
      '```',
      '',
      'Render with `useChat` from `@deuz-sdk/react`; the wire lives in `@deuz-sdk/core/ui`.',
      'Coming from `useChat` from `@ai-sdk/react`? Same idea.',
      '',
    ].join('\n'),
    'references/api-index.md': renderApiIndex(table, { date: '2026-01-02' }),
  });
  cpSync(skill, mirror, { recursive: true });
  writeFileSync(join(mirror, 'TESTING.md'), '# How this skill was tested\n');
  return { skill, mirror, root };
}

const edit = (file: string, from: string | RegExp, to: string) => {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(from, to);
  if (next === text) throw new Error(`fixture edit did not apply to ${file}`);
  writeFileSync(file, next);
};

/** Applies the same edit to both copies, so only the check under test can fail. */
const editBoth = (
  fixture: { skill: string; mirror: string },
  path: string,
  from: string | RegExp,
  to: string,
) => {
  edit(join(fixture.skill, path), from, to);
  edit(join(fixture.mirror, path), from, to);
};

const run = (fixture: { skill: string; mirror: string }) =>
  verify.verifySkill({ table, skillDir: fixture.skill, mirrorDir: fixture.mirror });

beforeAll(async () => {
  const tables = await load<{ loadExportTable(): ExportTable }>('export-table.mjs');
  table = tables.loadExportTable();
  ({ renderApiIndex } = await load<{ renderApiIndex: typeof renderApiIndex }>(
    'generate-api-index.mjs',
  ));
  sync = await load<SyncModule>('sync-skill-copy.mjs');
  verify = await load<VerifyModule>('verify-skill.mjs');
  scratch = mkdtempSync(join(tmpdir(), 'deuz-skill-verify-'));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('verify-skill: a current skill passes', () => {
  it('passes when every name resolves, every stamp is current and the copies agree', () => {
    const result = run(freshSkill());
    expect(result.failures).toEqual([]);
    expect(result.stats).toMatchObject({ files: 3, stamps: 3 });
    expect(result.stats.imports).toBe(4);
    expect(result.stats.names).toBe(5);
    expect(result.stats.attributions).toBe(2);
  });
});

describe('verify-skill: names', () => {
  it('fails on a name the subpath does not export', () => {
    const fixture = freshSkill();
    editBoth(fixture, 'SKILL.md', 'generateText,', 'generateTextt,');
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/SKILL.md:11  "generateTextt" is not exported by @deuz-sdk/core',
    ]);
  });

  it('fails on an import from a subpath that does not exist', () => {
    const fixture = freshSkill();
    editBoth(fixture, 'references/core.md', "'@deuz-sdk/react'", "'@deuz-sdk/core/hooks'");
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/references/core.md:8  imports from unknown subpath "@deuz-sdk/core/hooks"',
    ]);
  });

  it('fails on a prose mention of a subpath that does not exist', () => {
    const fixture = freshSkill();
    editBoth(fixture, 'references/core.md', '`@deuz-sdk/core/ui`', '`@deuz-sdk/core/wire`');
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/references/core.md:11  mentions unknown subpath "@deuz-sdk/core/wire"',
    ]);
  });

  it('fails on a name attributed to the wrong subpath in prose', () => {
    const fixture = freshSkill();
    editBoth(fixture, 'SKILL.md', '`runAgent` from', '`createSwarm` from');
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/SKILL.md:8  "createSwarm" is not exported by @deuz-sdk/core/agent',
    ]);
  });

  it('skips a fence tagged no-verify, and only that fence', () => {
    const fixture = freshSkill();
    const fences = [
      '',
      '```ts no-verify',
      "import { defineTool } from '@deuz-sdk/core'; // a fragment shown as the wrong way",
      '```',
      '',
      '```ts',
      "import { createDeuz } from '@deuz-sdk/core';",
      '```',
      '',
    ].join('\n');
    editBoth(fixture, 'references/core.md', /\n$/, `\n${fences}`);
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/references/core.md:19  "createDeuz" is not exported by @deuz-sdk/core',
    ]);
  });
});

describe('verify-skill: freshness stamps', () => {
  it('fails on a stamp for another package version', () => {
    const fixture = freshSkill();
    const stale = `@deuz-sdk/core@0.0.1 · api-contract sha256:${table.contractHash}`;
    editBoth(fixture, 'SKILL.md', /@deuz-sdk\/core@\S+ · api-contract sha256:[0-9a-f]+/, stale);
    expect(run(fixture).failures).toEqual([
      `skills/deuz-sdk/SKILL.md:17  stamp names @deuz-sdk/core@0.0.1, the package is ${table.version}`,
    ]);
  });

  it('fails on a stamp for another API contract', () => {
    const fixture = freshSkill();
    const stale = `@deuz-sdk/core@${table.version} · api-contract sha256:c025621e10fd`;
    editBoth(
      fixture,
      'references/core.md',
      /@deuz-sdk\/core@\S+ · api-contract sha256:[0-9a-f]+/,
      stale,
    );
    expect(run(fixture).failures).toEqual([
      `skills/deuz-sdk/references/core.md:1  stamp names api-contract sha256:c025621e10fd, tooling/api-contract.json is ${table.contractHash}`,
    ]);
  });

  it('fails on a skill file without a stamp', () => {
    const fixture = freshSkill();
    editBoth(fixture, 'SKILL.md', /> Verified against .*\n/, '');
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/SKILL.md  has no freshness stamp ("@deuz-sdk/core@<version> · api-contract sha256:<12 hex>")',
    ]);
  });
});

describe('verify-skill: the API index', () => {
  it('fails when the index is not what the generator writes', () => {
    const fixture = freshSkill();
    editBoth(fixture, 'references/api-index.md', /\n- `createSwarm` — `swarm`/, '');
    const failures = run(fixture).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^skills\/deuz-sdk\/references\/api-index\.md:\d+ {2}is stale: it differs from the generator's output here; regenerate it \(node packages\/core\/tooling\/skills\/generate-api-index\.mjs --date YYYY-MM-DD\)$/,
    );
  });

  it('names an index entry the package does not export', () => {
    const fixture = freshSkill();
    editBoth(
      fixture,
      'references/api-index.md',
      '- `createSwarm` — `swarm`',
      '- `createSwarms` — `swarm`',
    );
    const failures = run(fixture).failures;
    expect(failures).toContainEqual(
      expect.stringMatching(
        /api-index\.md:\d+ {2}"createSwarms" is not exported by @deuz-sdk\/core\/swarm$/,
      ),
    );
    expect(failures).toContainEqual(expect.stringMatching(/api-index\.md:\d+ {2}is stale/));
  });

  it('fails on a type listed as a value', () => {
    const fixture = freshSkill();
    const index = join(fixture.skill, 'references/api-index.md');
    const line = readFileSync(index, 'utf8')
      .split('\n')
      .findIndex((text) => text.startsWith('**Values** (') && text.includes(' runAgent,'));
    expect(line).toBeGreaterThan(0);
    editBoth(fixture, 'references/api-index.md', ' runAgent,', ' AgentResult, runAgent,');
    expect(run(fixture).failures).toContainEqual(
      `skills/deuz-sdk/references/api-index.md:${line + 1}  "AgentResult" is listed as a value of @deuz-sdk/core/agent, which exports it as a type`,
    );
  });

  it('fails when the index is missing', () => {
    const fixture = freshSkill();
    rmSync(join(fixture.skill, 'references/api-index.md'));
    rmSync(join(fixture.mirror, 'references/api-index.md'));
    expect(run(fixture).failures).toEqual([
      'skills/deuz-sdk/references/api-index.md  is missing; generate it (node packages/core/tooling/skills/generate-api-index.mjs --date YYYY-MM-DD)',
    ]);
  });
});

describe('verify-skill: the two copies', () => {
  it('fails when a file differs between the copies, and checks the differing copy too', () => {
    const fixture = freshSkill();
    edit(join(fixture.mirror, 'SKILL.md'), 'generateText,', 'generateTextt,');
    expect(run(fixture).failures).toEqual([
      '.claude/skills/deuz-sdk/SKILL.md:11  "generateTextt" is not exported by @deuz-sdk/core',
      'skills/deuz-sdk/SKILL.md  differs from .claude/skills/deuz-sdk/SKILL.md; edit skills/deuz-sdk and run node packages/core/tooling/skills/sync-skill-copy.mjs --write',
    ]);
  });

  it('fails on a file only one copy has, TESTING.md excepted', () => {
    const fixture = freshSkill();
    writeFileSync(join(fixture.skill, 'references/extra.md'), 'x\n');
    writeFileSync(join(fixture.mirror, 'references/stray.txt'), 'y\n');
    const failures = run(fixture).failures;
    expect(failures).toContain(
      'skills/deuz-sdk/references/extra.md  is missing from .claude/skills/deuz-sdk; edit skills/deuz-sdk and run node packages/core/tooling/skills/sync-skill-copy.mjs --write',
    );
    expect(failures).toContain(
      '.claude/skills/deuz-sdk/references/stray.txt  exists only in the .claude copy; edit skills/deuz-sdk and run node packages/core/tooling/skills/sync-skill-copy.mjs --write',
    );
    expect(failures.some((failure) => failure.includes('TESTING.md'))).toBe(false);
  });

  it('reports an inconsistent export table', () => {
    const fixture = freshSkill();
    const broken = { ...table, problems: ['export "./gamma" has no tsup entry'] };
    const result = verify.verifySkill({
      table: broken,
      skillDir: fixture.skill,
      mirrorDir: fixture.mirror,
    });
    expect(result.failures).toEqual([
      'packages/core/package.json  export "./gamma" has no tsup entry',
    ]);
  });
});

/** Rewrites every freshness stamp under `dir` to the one 2.2.0 shipped with. */
function stampAs220(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = join(entry.parentPath, entry.name);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /@deuz-sdk\/core@[^\s·`]+ · api-contract sha256:[0-9a-f]{12}/g,
        '@deuz-sdk/core@2.2.0 · api-contract sha256:c025621e10fd',
      ),
    );
  }
}

const skillFiles = (dir: string) => [
  'SKILL.md',
  ...readdirSync(join(dir, 'references'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `references/${name}`),
];

describe('verify-skill: the skill as 2.2.0 stamped it', () => {
  it('rejects every file of the real skill while it carries the 2.2.0 stamps', () => {
    const root = join(scratch, `real-${counter++}`);
    const skill = join(root, 'skills/deuz-sdk');
    const mirror = join(root, '.claude/skills/deuz-sdk');
    cpSync(join(REPO, 'skills/deuz-sdk'), skill, { recursive: true });
    cpSync(join(REPO, '.claude/skills/deuz-sdk'), mirror, { recursive: true });
    stampAs220(skill);
    stampAs220(mirror);
    const failures = verify.verifySkill({ table, skillDir: skill, mirrorDir: mirror }).failures;
    expect(table.contractHash).not.toBe('c025621e10fd');
    for (const file of skillFiles(skill)) {
      expect(failures).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^skills/deuz-sdk/${file.replace('.', '\\.')}:\\d+ {2}stamp names api-contract sha256:c025621e10fd, `,
          ),
        ),
      );
    }
  });

  // feat/2.3 before wave 3: the texts still carry 2.2's stamps (SK3 rewrites them). Once they
  // are restamped this no longer applies and the permanent test above keeps the guarantee.
  const realSkill = readFileSync(join(REPO, 'skills/deuz-sdk/SKILL.md'), 'utf8');
  it.runIf(realSkill.includes('api-contract sha256:c025621e10fd'))(
    'rejects the repository skill as it stands before the 2.3 text update',
    () => {
      const failures = verify.verifySkill({ table }).failures;
      expect(failures).toContainEqual(
        expect.stringMatching(
          /^skills\/deuz-sdk\/SKILL\.md:\d+ {2}stamp names api-contract sha256:c025621e10fd/,
        ),
      );
      expect(failures).toContainEqual(
        expect.stringMatching(/^skills\/deuz-sdk\/references\/api-index\.md:\d+ {2}is stale/),
      );
      // The copies are in step today; only the texts are behind.
      expect(failures.filter((failure) => failure.includes('sync-skill-copy'))).toEqual([]);
    },
  );
});

describe('verify-skill: grading answers', () => {
  it('reports invented names in a directory of answers and nothing else', () => {
    const answers = join(scratch, `answers-${counter++}`);
    writeTree(answers, {
      'good.md': "```ts\nimport { streamChat, tool } from '@deuz-sdk/core';\n```\n",
      'nested/bad.md': [
        '```ts',
        "import { defineTool, streamChat } from '@deuz-sdk/core';",
        "import { createDeuz } from '@deuz-sdk/core/client';",
        '```',
        '',
      ].join('\n'),
      'route.ts': "import { toStreamResponse } from '@deuz-sdk/core/ui';\n",
      'notes.txt': "import { ignored } from '@deuz-sdk/core';\n",
    });
    expect(verify.verifyAnswers(answers, { table }).failures).toEqual([
      'nested/bad.md:2  "defineTool" is not exported by @deuz-sdk/core',
      'nested/bad.md:3  imports from unknown subpath "@deuz-sdk/core/client"',
      'route.ts:1  "toStreamResponse" is not exported by @deuz-sdk/core/ui',
    ]);
  });
});

describe('sync-skill-copy', () => {
  it('lists the differences and mirrors skills/deuz-sdk into the .claude copy on --write', () => {
    const fixture = freshSkill();
    const added = `<!-- verified: 2026-01-02 against @deuz-sdk/core@${table.version} · api-contract sha256:${table.contractHash} -->\n\nnew\n`;
    writeFileSync(join(fixture.skill, 'references/new.md'), added);
    edit(join(fixture.mirror, 'SKILL.md'), 'runAgent', 'runAgentX');
    writeFileSync(join(fixture.mirror, 'references/old.md'), 'old\n');
    const expected = [
      { path: 'SKILL.md', kind: 'changed' },
      { path: 'references/new.md', kind: 'missing' },
      { path: 'references/old.md', kind: 'extra' },
    ];
    expect(sync.diffSkillCopies(fixture.skill, fixture.mirror)).toEqual(expected);
    expect(sync.writeSkillMirror(fixture.skill, fixture.mirror)).toEqual(expected);
    expect(sync.diffSkillCopies(fixture.skill, fixture.mirror)).toEqual([]);
    expect(readFileSync(join(fixture.mirror, 'references/new.md'), 'utf8')).toBe(added);
    expect(existsSync(join(fixture.mirror, 'references/old.md'))).toBe(false);
    // The mirror keeps its own TESTING.md.
    expect(readFileSync(join(fixture.mirror, 'TESTING.md'), 'utf8')).toContain('tested');
    expect(run(fixture).failures).toEqual([]);
  });

  it('the repository copies are in step today', () => {
    expect(
      sync.diffSkillCopies(join(REPO, 'skills/deuz-sdk'), join(REPO, '.claude/skills/deuz-sdk')),
    ).toEqual([]);
  });
});

describe('command line', () => {
  const node = (script: string, args: string[]) =>
    spawnSync(process.execPath, [join(TOOLING, script), ...args], { encoding: 'utf8' });

  it('verify-skill exits 0 on a current skill and 1 with the failures listed otherwise', () => {
    const fixture = freshSkill();
    const ok = node('verify-skill.mjs', ['--skill', fixture.skill, '--mirror', fixture.mirror]);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^Skill verified \(3 files/);

    editBoth(fixture, 'SKILL.md', 'generateText,', 'generateTextt,');
    const bad = node('verify-skill.mjs', ['--skill', fixture.skill, '--mirror', fixture.mirror]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('"generateTextt" is not exported by @deuz-sdk/core');
  });

  it('verify-skill grades a directory given as its argument', () => {
    const answers = join(scratch, `answers-${counter++}`);
    writeTree(answers, { 'a.md': "import { createDeuz } from '@deuz-sdk/core';\n" });
    const result = node('verify-skill.mjs', [answers]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a.md:1  "createDeuz" is not exported by @deuz-sdk/core');
  });

  it('sync-skill-copy checks by default and writes with --write', () => {
    const fixture = freshSkill();
    writeFileSync(join(fixture.skill, 'references/new.md'), 'new\n');
    const args = ['--skill', fixture.skill, '--mirror', fixture.mirror];
    const check = node('sync-skill-copy.mjs', args);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('references/new.md');
    expect(existsSync(join(fixture.mirror, 'references/new.md'))).toBe(false);
    const write = node('sync-skill-copy.mjs', [...args, '--write']);
    expect(write.status).toBe(0);
    expect(node('sync-skill-copy.mjs', args).status).toBe(0);
  });
});
