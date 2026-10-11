#!/usr/bin/env node
/**
 * sync-skill-copy — keeps the two copies of the `deuz-sdk` Agent Skill one.
 *
 * `skills/deuz-sdk/` is the source: it is what `npx skills add` publishes and
 * what `verify:docs-refs` reads. `.claude/skills/deuz-sdk/` is where Claude
 * Code loads the skill inside this repository; it is derived from the source
 * and adds only its own `TESTING.md`. Edit the source, then mirror it:
 *
 *   node packages/core/tooling/skills/sync-skill-copy.mjs           # check: list differences, exit 1 on any
 *   node packages/core/tooling/skills/sync-skill-copy.mjs --write   # make the .claude copy match
 *
 * `--write` overwrites changed files and deletes files the source does not
 * have, so an edit made directly in the .claude copy is lost: check first.
 * `--skill <dir>` / `--mirror <dir>` point at other copies.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './export-table.mjs';

export const SKILL_DIR = join(REPO_ROOT, 'skills/deuz-sdk');
export const MIRROR_DIR = join(REPO_ROOT, '.claude/skills/deuz-sdk');

/** Files that belong to the .claude copy alone (relative to the skill root). */
export const MIRROR_ONLY = new Set(['TESTING.md']);

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function filesOf(dir) {
  const out = [];
  const walk = (current, prefix) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(path).isDirectory()) walk(path, relative);
      else if (!MIRROR_ONLY.has(relative)) out.push(relative);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * How `mirror` differs from `source`, byte for byte: `changed` (both have it),
 * `missing` (only the source has it), `extra` (only the mirror has it).
 */
export function diffSkillCopies(source = SKILL_DIR, mirror = MIRROR_DIR) {
  const sourceFiles = filesOf(source);
  const mirrorFiles = new Set(filesOf(mirror));
  const differences = [];
  for (const path of sourceFiles) {
    if (!mirrorFiles.has(path)) differences.push({ path, kind: 'missing' });
    else if (!readFileSync(join(source, path)).equals(readFileSync(join(mirror, path)))) {
      differences.push({ path, kind: 'changed' });
    }
    mirrorFiles.delete(path);
  }
  for (const path of mirrorFiles) differences.push({ path, kind: 'extra' });
  return differences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Makes `mirror` match `source` (its own TESTING.md kept). Returns what it changed. */
export function writeSkillMirror(source = SKILL_DIR, mirror = MIRROR_DIR) {
  const differences = diffSkillCopies(source, mirror);
  for (const { path, kind } of differences) {
    const target = join(mirror, path);
    if (kind === 'extra') {
      rmSync(target);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
  }
  return differences;
}

const DESCRIBE = {
  changed: 'differs',
  missing: 'is missing from the .claude copy',
  extra: 'exists only in the .claude copy',
};

function main() {
  const args = process.argv.slice(2);
  const options = { write: false, skill: SKILL_DIR, mirror: MIRROR_DIR };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') options.write = true;
    else if ((args[i] === '--skill' || args[i] === '--mirror') && args[i + 1]) {
      options[args[i].slice(2)] = resolve(args[++i]);
    } else throw new Error(`unknown argument "${args[i]}"`);
  }
  if (options.write) {
    const changed = writeSkillMirror(options.skill, options.mirror);
    for (const { path, kind } of changed) {
      console.log(`${kind === 'extra' ? 'deleted' : 'wrote'} ${path}`);
    }
    console.log(`The .claude copy matches skills/deuz-sdk (${changed.length} file(s) updated).`);
    return;
  }
  const differences = diffSkillCopies(options.skill, options.mirror);
  if (differences.length === 0) {
    console.log('The two skill copies are identical (TESTING.md aside).');
    return;
  }
  console.error(
    `The two skill copies differ:\n- ${differences
      .map(({ path, kind }) => `${path}  ${DESCRIBE[kind]}`)
      .join('\n- ')}\nEdit skills/deuz-sdk, then run with --write.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`sync-skill-copy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
