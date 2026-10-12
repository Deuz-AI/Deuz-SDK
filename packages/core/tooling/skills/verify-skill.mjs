#!/usr/bin/env node
/**
 * verify-skill — the name gate and freshness gate of the `deuz-sdk` Agent Skill.
 *
 *   node packages/core/tooling/skills/verify-skill.mjs                 # the skill, both copies
 *   node packages/core/tooling/skills/verify-skill.mjs <dir-of-answers> # grade agent answers
 *
 * Against the export table (`export-table.mjs`: tsup's entry map crossed with
 * `package.json` exports, `export *` followed through src — the table
 * `tooling/verify-docs.mjs` builds), it checks SKILL.md and references/*.md:
 *
 *   1. names: every `import { … } from '@deuz-sdk/…'` resolves name by name;
 *      every quoted or backticked `@deuz-sdk/<package>[/<subpath>]` exists, so
 *      a package other than core and react, or a dynamic `import('…')` of
 *      one, fails too; every name the prose attributes to a subpath (`name`
 *      from|on `@deuz-sdk/…`) is exported there. A bare backticked word is not
 *      taken for an API name: options, fields, methods and other libraries'
 *      names share that notation. Fences tagged `no-verify` (deliberate
 *      fragments) are skipped.
 *   2. freshness: every file carries a stamp
 *      `@deuz-sdk/core@<version> · api-contract sha256:<12 hex>` naming the
 *      current package version and tooling/api-contract.json hash, so a release
 *      that moves either fails here instead of letting the skill drift.
 *   3. the index: references/api-index.md lists only real names of the right
 *      kind, and is byte for byte what generate-api-index.mjs writes for its
 *      stamp date.
 *   4. the copies: skills/deuz-sdk and .claude/skills/deuz-sdk are identical
 *      apart from the latter's TESTING.md (sync-skill-copy.mjs mirrors them).
 *
 * With a directory argument it runs only the name checks, over every .md,
 * .mdx and JS/TS file below it: the grading half of TESTING.md.
 * `--skill <dir>`, `--mirror <dir>` and `--core <dir>` point elsewhere.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadExportTable } from './export-table.mjs';
import { maskNoVerify } from './fences.mjs';
import { REGENERATE_COMMAND, renderApiIndex } from './generate-api-index.mjs';
import { MIRROR_DIR, SKILL_DIR, diffSkillCopies } from './sync-skill-copy.mjs';

const SYNC_COMMAND = 'node packages/core/tooling/skills/sync-skill-copy.mjs --write';
const STAMP = /@deuz-sdk\/core@([^\s·`]+)\s*·\s*api-contract sha256:([0-9a-f]+)/g;
const STAMP_SHAPE = '"@deuz-sdk/core@<version> · api-contract sha256:<12 hex>"';
const IMPORT = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@deuz-sdk\/[^'"]+)['"]/g;
/** Any package of the scope; a version (`@deuz-sdk/core@2.3.0`) never matches. */
const MENTION = /(['"`])(@deuz-sdk\/[\w.-]+(?:\/[\w./-]+)?)\1/g;
/** The specifiers MENTION reads, whole. */
const SPECIFIER = /^@deuz-sdk\/[\w.-]+(?:\/[\w./-]+)?$/;
const ATTRIBUTION = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`\s+\(?(?:from|on)\s+`(@deuz-sdk\/[^`\s]+)`/g;
/** Specifiers the package serves that are not modules. */
const NON_MODULES = new Set(['@deuz-sdk/core/package.json', '@deuz-sdk/react/package.json']);

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function emptyStats() {
  return { files: 0, imports: 0, names: 0, attributions: 0, stamps: 0 };
}

/**
 * The name checks over one text (no-verify fences skipped). `report(line,
 * message)` receives each failure; `stats` is counted up.
 */
function checkNames(source, table, stats, report) {
  const text = maskNoVerify(source);
  const modules = new Map(table.modules.map((module) => [module.specifier, module.names]));
  const importSpans = [];

  for (const m of text.matchAll(IMPORT)) {
    stats.imports++;
    importSpans.push([m.index, m.index + m[0].length]);
    const specifier = m[2];
    const line = lineAt(text, m.index);
    const names = modules.get(specifier);
    if (!names) {
      report(line, `imports from unknown subpath "${specifier}"`);
      continue;
    }
    const list = m[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const raw of list.split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!name) continue;
      stats.names++;
      if (!names.has(name)) report(line, `"${name}" is not exported by ${specifier}`);
    }
  }

  for (const m of text.matchAll(MENTION)) {
    if (importSpans.some(([start, end]) => m.index >= start && m.index < end)) continue;
    if (!modules.has(m[2]) && !NON_MODULES.has(m[2])) {
      report(lineAt(text, m.index), `mentions unknown subpath "${m[2]}"`);
    }
  }

  for (const m of text.matchAll(ATTRIBUTION)) {
    const names = modules.get(m[2]);
    if (!names) {
      // A specifier of MENTION's shape was reported as a mention above.
      if (!SPECIFIER.test(m[2])) {
        report(lineAt(text, m.index), `attributes "${m[1]}" to unknown subpath "${m[2]}"`);
      }
      continue;
    }
    stats.attributions++;
    if (!names.has(m[1])) report(lineAt(text, m.index), `"${m[1]}" is not exported by ${m[2]}`);
  }
}

function checkStamps(text, table, stats, report) {
  let found = 0;
  for (const m of text.matchAll(STAMP)) {
    found++;
    const line = lineAt(text, m.index);
    if (m[1] !== table.version) {
      report(line, `stamp names @deuz-sdk/core@${m[1]}, the package is ${table.version}`);
    }
    if (m[2] !== table.contractHash) {
      report(
        line,
        `stamp names api-contract sha256:${m[2]}, tooling/api-contract.json is ${table.contractHash}`,
      );
    }
  }
  stats.stamps += found;
  if (found === 0) report(0, `has no freshness stamp (${STAMP_SHAPE})`);
}

/** Every Values/Types entry and reverse-lookup entry names a real export of the right kind. */
function checkIndexEntries(text, table, report) {
  const bySpecifier = new Map(table.modules.map((module) => [module.specifier, module]));
  const byLabel = new Map(table.modules.map((module) => [module.label, module]));
  let section;
  text.split('\n').forEach((line, index) => {
    const heading = /^## `(@deuz-sdk\/[^`]+)`$/.exec(line);
    if (heading) {
      section = bySpecifier.get(heading[1]);
      if (!section) report(index + 1, `lists unknown subpath "${heading[1]}"`);
      return;
    }
    if (line.startsWith('## ')) {
      section = undefined;
      return;
    }
    const listed = /^\*\*(Values|Types)\*\* \(\d+\): (.*)$/.exec(line);
    if (listed && section) {
      const kind = listed[1] === 'Values' ? 'value' : 'type';
      for (const name of listed[2] === '_none_' ? [] : listed[2].split(', ')) {
        const actual = section.names.get(name);
        if (!actual) report(index + 1, `"${name}" is not exported by ${section.specifier}`);
        else if (actual !== kind) {
          report(
            index + 1,
            `"${name}" is listed as a ${kind} of ${section.specifier}, which exports it as a ${actual}`,
          );
        }
      }
      return;
    }
    const home = /^- `([^`]+)` — (.*)$/.exec(line);
    if (!home) return;
    for (const label of home[2].split(', ').map((entry) => entry.replace(/^`|`$/g, ''))) {
      const module = byLabel.get(label);
      const kind = module?.names.get(home[1]);
      if (!module) report(index + 1, `lists unknown subpath "${label}"`);
      else if (!kind) report(index + 1, `"${home[1]}" is not exported by ${module.specifier}`);
      else if (kind !== 'value') {
        report(
          index + 1,
          `"${home[1]}" is listed as a value of ${module.specifier}, which exports it as a ${kind}`,
        );
      }
    }
  });
}

/** The index must be exactly what the generator writes for the date it is stamped with. */
function checkIndexFresh(text, table, report) {
  const date = /verified: (\d{4}-\d{2}-\d{2}) against/.exec(text)?.[1];
  let expected = '';
  try {
    expected = date ? renderApiIndex(table, { date }) : '';
  } catch {
    // An unrenderable table or date shows up as a stale index below.
  }
  if (text === expected) return;
  const have = text.split('\n');
  const want = expected.split('\n');
  let line = 0;
  while (line < have.length && have[line] === want[line]) line++;
  report(
    line + 1,
    `is stale: it differs from the generator's output here; regenerate it (${REGENERATE_COMMAND})`,
  );
}

/** SKILL.md then references/*.md, as paths relative to the skill root. */
function skillFiles(dir) {
  const references = join(dir, 'references');
  return [
    'SKILL.md',
    ...(existsSync(references)
      ? readdirSync(references)
          .filter((name) => name.endsWith('.md'))
          .sort()
          .map((name) => `references/${name}`)
      : []),
  ];
}

/**
 * Verifies the skill. Paths in failures are relative to `root`, the directory
 * that holds `skills/` (default: two levels above `skillDir`).
 */
export function verifySkill({
  table = loadExportTable(),
  skillDir = SKILL_DIR,
  mirrorDir = MIRROR_DIR,
  root = resolve(skillDir, '../..'),
} = {}) {
  const failures = [];
  const stats = emptyStats();
  const show = (file) => relative(root, file).replace(/\\/g, '/');
  const failAt = (file) => (line, message) =>
    failures.push(`${show(file)}${line ? `:${line}` : ''}  ${message}`);

  for (const problem of table.problems) failures.push(`packages/core/package.json  ${problem}`);

  const checkFile = (file) => {
    const report = failAt(file);
    if (!existsSync(file)) {
      report(0, 'is missing');
      return;
    }
    const text = readFileSync(file, 'utf8');
    checkNames(text, table, stats, report);
    checkStamps(text, table, stats, report);
  };

  for (const path of skillFiles(skillDir)) {
    stats.files++;
    checkFile(join(skillDir, path));
  }

  const index = join(skillDir, 'references/api-index.md');
  if (!existsSync(index)) {
    failAt(index)(0, `is missing; generate it (${REGENERATE_COMMAND})`);
  } else {
    const text = readFileSync(index, 'utf8');
    checkIndexEntries(text, table, failAt(index));
    checkIndexFresh(text, table, failAt(index));
  }

  const inSkill = (path) => path === 'SKILL.md' || /^references\/[^/]+\.md$/.test(path);
  for (const { path, kind } of diffSkillCopies(skillDir, mirrorDir)) {
    const fix = `edit ${show(skillDir)} and run ${SYNC_COMMAND}`;
    if (kind !== 'missing' && inSkill(path)) checkFile(join(mirrorDir, path));
    if (kind === 'changed') {
      failures.push(
        `${show(join(skillDir, path))}  differs from ${show(join(mirrorDir, path))}; ${fix}`,
      );
    } else if (kind === 'missing') {
      failures.push(`${show(join(skillDir, path))}  is missing from ${show(mirrorDir)}; ${fix}`);
    } else {
      failures.push(`${show(join(mirrorDir, path))}  exists only in the .claude copy; ${fix}`);
    }
  }
  return { failures, stats };
}

const ANSWER_FILE = /\.(?:mdx?|[cm]?[jt]sx?)$/;

/** The name checks alone, over every answer file below `dir` (paths relative to it). */
export function verifyAnswers(dir, { table = loadExportTable() } = {}) {
  const failures = [];
  const stats = emptyStats();
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules' && !entry.startsWith('.')) walk(path);
      } else if (ANSWER_FILE.test(entry)) files.push(relative(dir, path).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  for (const file of files.sort()) {
    stats.files++;
    checkNames(readFileSync(join(dir, file), 'utf8'), table, stats, (line, message) =>
      failures.push(`${file}${line ? `:${line}` : ''}  ${message}`),
    );
  }
  return { failures, stats };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  let answers;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--skill', '--mirror', '--core'].includes(flag) && args[i + 1]) {
      options[flag.slice(2)] = resolve(args[++i]);
    } else if (!flag.startsWith('--') && answers === undefined) answers = resolve(flag);
    else throw new Error(`unknown argument "${flag}"`);
  }
  const table = loadExportTable(options.core ? { core: options.core } : {});
  const { failures, stats } = answers
    ? verifyAnswers(answers, { table })
    : verifySkill({
        table,
        skillDir: options.skill ?? SKILL_DIR,
        mirrorDir: options.mirror ?? MIRROR_DIR,
      });
  const counts = `${stats.files} files, ${stats.imports} @deuz-sdk imports / ${stats.names} names, ${stats.attributions} attributions`;
  if (failures.length > 0) {
    console.error(
      `${answers ? 'Answers' : 'Skill'} verification failed (${failures.length}):\n- ${failures.join('\n- ')}`,
    );
    process.exitCode = 1;
  } else if (answers) {
    console.log(`Answers verified (${counts}): no unresolved names.`);
  } else {
    console.log(`Skill verified (${counts}, ${stats.stamps} stamps; copies identical).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`verify-skill: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
