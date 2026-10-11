/**
 * extract-examples.mjs, the first half of the skill's shapes gate (TESTING.md): every fence
 * tagged ts/tsx in SKILL.md and references/*.md becomes its own module in a scratch project,
 * which `tsc` then checks against the built package. Fences tagged no-verify are skipped.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Example {
  file: string;
  source: string;
  line: number;
  code: string;
}
interface ExamplesModule {
  extractExamples(skillDir: string): Example[];
  writeExamples(skillDir: string, outDir: string): string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const TOOLING = resolve(here, '../tooling/skills');
const SCRIPT = join(TOOLING, 'extract-examples.mjs');

let examples: ExamplesModule;
let scratch: string;

const SKILL = [
  '# Skill',
  '',
  '```ts',
  "import { streamChat } from '@deuz-sdk/core';",
  '```',
  '',
  '```text',
  'not code',
  '```',
  '',
].join('\n');

const REFERENCE = [
  '<!-- verified: … -->',
  '',
  '```tsx',
  "import { useChat } from '@deuz-sdk/react';",
  'export const App = () => <div>{String(useChat)}</div>;',
  '```',
  '',
  '```ts no-verify',
  'fragment(',
  '```',
  '',
  '````ts',
  'const fence = "```";',
  '````',
  '',
  '```bash',
  'npm run build',
  '```',
  '',
  '~~~ts',
  'export {};',
  '~~~',
  '',
].join('\n');

function skillDir(): string {
  const dir = mkdtempSync(join(scratch, 'skill-'));
  mkdirSync(join(dir, 'references'));
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  writeFileSync(join(dir, 'references/core-calls.md'), REFERENCE);
  writeFileSync(join(dir, 'references/notes.txt'), '```ts\nignored\n```\n');
  return dir;
}

beforeAll(async () => {
  examples = await import(pathToFileURL(SCRIPT).href);
  scratch = mkdtempSync(join(tmpdir(), 'deuz-skill-examples-'));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('extract-examples', () => {
  it('takes every ts/tsx fence, skips no-verify and other languages, and names files stably', () => {
    expect(examples.extractExamples(skillDir())).toEqual([
      {
        file: 'SKILL-01.ts',
        source: 'SKILL.md',
        line: 4,
        code: "import { streamChat } from '@deuz-sdk/core';\n",
      },
      {
        file: 'core-calls-01.tsx',
        source: 'references/core-calls.md',
        line: 4,
        code: "import { useChat } from '@deuz-sdk/react';\nexport const App = () => <div>{String(useChat)}</div>;\n",
      },
      {
        file: 'core-calls-02.ts',
        source: 'references/core-calls.md',
        line: 13,
        code: 'const fence = "```";\n',
      },
      {
        file: 'core-calls-03.ts',
        source: 'references/core-calls.md',
        line: 21,
        code: 'export {};\n',
      },
    ]);
  });

  it('writes one module per example and replaces only its own earlier output', () => {
    const dir = skillDir();
    const out = join(scratch, 'out', 'src');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'shims.d.ts'), 'declare const shim: unknown;\n');
    writeFileSync(
      join(out, 'SKILL-09.ts'),
      '// extracted by extract-examples.mjs from SKILL.md:1\n',
    );

    expect(examples.writeExamples(dir, out)).toEqual([
      'SKILL-01.ts',
      'core-calls-01.tsx',
      'core-calls-02.ts',
      'core-calls-03.ts',
    ]);
    expect(readdirSync(out).sort()).toEqual([
      'SKILL-01.ts',
      'core-calls-01.tsx',
      'core-calls-02.ts',
      'core-calls-03.ts',
      'shims.d.ts',
    ]);
    // The header maps a compiler error back to the line in the skill (header + code lines).
    expect(readFileSync(join(out, 'core-calls-02.ts'), 'utf8')).toBe(
      '// extracted by extract-examples.mjs from references/core-calls.md:13\nconst fence = "```";\n',
    );
  });

  it('runs from the command line', () => {
    const dir = skillDir();
    const out = join(scratch, 'cli-out');
    const result = spawnSync(process.execPath, [SCRIPT, out, '--skill', dir], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('4 examples');
    expect(readdirSync(out)).toHaveLength(4);

    const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/usage/i);
  });

  it('finds the examples of the real skill', () => {
    const found = examples.extractExamples(resolve(here, '../../../skills/deuz-sdk'));
    expect(found.length).toBeGreaterThan(50);
    expect(new Set(found.map((example) => example.file)).size).toBe(found.length);
  });
});
