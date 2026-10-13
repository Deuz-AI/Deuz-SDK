#!/usr/bin/env node
/**
 * extract-examples — the first half of the skill's shapes gate (TESTING.md).
 *
 *   npm run build -w @deuz-sdk/core
 *   node packages/core/tooling/skills/extract-examples.mjs <scratch>/src
 *   cd <scratch> && npx tsc -p tsconfig.json
 *
 * Every fence tagged `ts` or `tsx` in SKILL.md and references/*.md becomes its
 * own module, `<file>-<nn>.ts(x)`, headed by the line it came from, so `tsc`
 * in a scratch project that installs the built packages checks each example
 * as written. Fences tagged `no-verify` are skipped. A rerun replaces only the
 * files this tool wrote, so the harness's own files (a `shims.d.ts`) stay.
 * `--skill <dir>` reads another copy of the skill.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFences } from './fences.mjs';
import { SKILL_DIR } from './sync-skill-copy.mjs';

const HEADER = '// extracted by extract-examples.mjs from ';
const LANGS = new Map([
  ['ts', 'ts'],
  ['tsx', 'tsx'],
]);

/** The ts/tsx examples of a skill directory, in file order. */
export function extractExamples(skillDir = SKILL_DIR) {
  const references = join(skillDir, 'references');
  const sources = [
    'SKILL.md',
    ...(existsSync(references)
      ? readdirSync(references)
          .filter((name) => name.endsWith('.md'))
          .sort()
          .map((name) => `references/${name}`)
      : []),
  ];
  const examples = [];
  for (const source of sources) {
    const path = join(skillDir, source);
    if (!existsSync(path)) continue;
    const stem = basename(source, '.md');
    let n = 0;
    for (const block of parseFences(readFileSync(path, 'utf8'))) {
      const extension = LANGS.get(block.lang);
      if (!extension || block.noVerify) continue;
      n++;
      examples.push({
        file: `${stem}-${String(n).padStart(2, '0')}.${extension}`,
        source,
        line: block.line,
        code: block.code,
      });
    }
  }
  return examples;
}

/** Writes the examples into `outDir`, replacing this tool's earlier output. Returns the file names. */
export function writeExamples(skillDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (!/\.tsx?$/.test(name)) continue;
    const path = join(outDir, name);
    if (readFileSync(path, 'utf8').startsWith(HEADER)) rmSync(path);
  }
  const examples = extractExamples(skillDir);
  for (const example of examples) {
    writeFileSync(
      join(outDir, example.file),
      `${HEADER}${example.source}:${example.line}\n${example.code}`,
    );
  }
  return examples.map((example) => example.file);
}

function main() {
  const args = process.argv.slice(2);
  let out;
  let skill = SKILL_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skill' && args[i + 1]) skill = resolve(args[++i]);
    else if (!args[i].startsWith('--') && out === undefined) out = resolve(args[i]);
    else throw new Error(`unknown argument "${args[i]}"`);
  }
  if (!out) throw new Error('usage: extract-examples.mjs <out-dir> [--skill <skill-dir>]');
  const files = writeExamples(skill, out);
  console.log(`Wrote ${files.length} examples to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`extract-examples: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
