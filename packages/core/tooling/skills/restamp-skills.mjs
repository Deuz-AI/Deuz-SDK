#!/usr/bin/env node
/**
 * restamp-skills — stamps both copies of the `deuz-sdk` Agent Skill for the current release,
 * so verify-skill passes again after a version bump or an API contract change.
 *
 *   node packages/core/tooling/skills/restamp-skills.mjs                     # keep the dates
 *   node packages/core/tooling/skills/restamp-skills.mjs --date 2026-10-20   # and re-date
 *
 * In every .md file of skills/deuz-sdk and .claude/skills/deuz-sdk it:
 *
 *   1. rewrites each `@deuz-sdk/core@<version> · api-contract sha256:<12 hex>` stamp (the
 *      shape verify-skill checks) to the package version and the tooling/api-contract.json
 *      hash, both as export-table.mjs computes them. Only the version and the hash change;
 *      a version named without the `· api-contract` half is prose, not a stamp.
 *   2. re-renders references/api-index.md with generate-api-index.mjs for the date it was
 *      verified on: the index names the version outside its stamp too, and verify-skill
 *      wants it exactly as generated.
 *   3. refreshes the counts SKILL.md states ("<n> code subpaths (<n> package export keys
 *      including `package.json`), <n> root exports") from tooling/api-contract.json.
 *
 * `--date YYYY-MM-DD` also re-dates every stamp and the index. Everything is computed before
 * anything is written, so a refusal (a SKILL.md that no longer states a count, an
 * inconsistent export table, a bad date) leaves every file as it was, and a second run
 * changes nothing. It neither checks names nor syncs the copies: verify-skill is the gate.
 * `--skill <dir>`, `--mirror <dir>` and `--core <dir>` point elsewhere.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadExportTable } from './export-table.mjs';
import { REGENERATE_COMMAND, renderApiIndex, resolveStampDate } from './generate-api-index.mjs';
import { MIRROR_DIR, SKILL_DIR } from './sync-skill-copy.mjs';

/** verify-skill's stamp, with what surrounds the version and the hash captured. */
const STAMP = /(@deuz-sdk\/core@)[^\s·`]+(\s*·\s*api-contract sha256:)[0-9a-f]+/g;
/** The date of a reference header: `verified: <date> against <stamp>`. */
const HEADER_DATE = /(verified: )\d{4}-\d{2}-\d{2}( against @deuz-sdk\/core@)/g;
/** The date after SKILL.md's closing stamp: `<stamp> · <date>`. */
const TRAILING_DATE = /(api-contract sha256:[0-9a-f]+ · )\d{4}-\d{2}-\d{2}/g;
const INDEX = 'references/api-index.md';

/** The counts SKILL.md states, read from `tooling/api-contract.json`. */
export function contractCounts(contract) {
  const exportKeys = contract.requiredSubpaths.length;
  return {
    subpaths: exportKeys - (contract.requiredSubpaths.includes('./package.json') ? 1 : 0),
    exportKeys,
    rootExports: contract.requiredRootExports.length,
  };
}

/** Where each count sits in SKILL.md: the number right before its phrase. */
const COUNT_PHRASES = {
  subpaths: 'code subpaths',
  exportKeys: 'package export keys',
  rootExports: 'root exports',
};
const countBefore = (phrase) => new RegExp(`\\b\\d+( ${phrase})\\b`, 'g');

function readContract(core) {
  return JSON.parse(readFileSync(join(core, 'tooling/api-contract.json'), 'utf8'));
}

/** Every .md file under `dir`, as sorted POSIX paths relative to it. */
function markdownFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(path).isDirectory()) walk(path, rel);
      else if (entry.endsWith('.md')) out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out.sort();
}

/**
 * Restamps both copies. Returns the files it changed (absolute paths), the number of stamps
 * the copies carry afterwards, and the counts it wrote into SKILL.md. `write: false` computes
 * the same without touching a file.
 */
export function restampSkills({
  table = loadExportTable(),
  contract = readContract(table.core),
  skillDir = SKILL_DIR,
  mirrorDir = MIRROR_DIR,
  date,
  write = true,
} = {}) {
  if (date !== undefined) resolveStampDate({ date });
  if (table.problems.length > 0) {
    throw new Error(`the export table is inconsistent:\n- ${table.problems.join('\n- ')}`);
  }
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    throw new Error(`no skill at ${skillDir} (no SKILL.md there)`);
  }
  const counts = contractCounts(contract);
  const updates = [];
  let stamps = 0;

  for (const dir of [skillDir, mirrorDir]) {
    for (const path of markdownFiles(dir)) {
      const file = join(dir, path);
      const before = readFileSync(file, 'utf8');
      let after;
      if (path === INDEX) {
        const verified = /verified: (\d{4}-\d{2}-\d{2}) against/.exec(before)?.[1];
        if (!date && !verified) {
          throw new Error(`${file} has no "verified: <date>"; pass --date (${REGENERATE_COMMAND})`);
        }
        after = renderApiIndex(table, { date: date ?? verified });
      } else {
        after = before.replace(STAMP, `$1${table.version}$2${table.contractHash}`);
        if (date) {
          after = after.replace(HEADER_DATE, `$1${date}$2`).replace(TRAILING_DATE, `$1${date}`);
        }
        if (path === 'SKILL.md') {
          for (const [key, phrase] of Object.entries(COUNT_PHRASES)) {
            const count = countBefore(phrase);
            if (after.search(count) === -1) {
              throw new Error(
                `${file} no longer states "<n> ${phrase}"; update COUNT_PHRASES in restamp-skills.mjs`,
              );
            }
            after = after.replace(count, `${counts[key]}$1`);
          }
        }
      }
      stamps += after.match(STAMP)?.length ?? 0;
      if (after !== before) updates.push([file, after]);
    }
  }

  if (write) for (const [file, text] of updates) writeFileSync(file, text);
  return { changed: updates.map(([file]) => file), stamps, counts };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--date', '--skill', '--mirror', '--core'].includes(flag)) {
      throw new Error(`unknown argument "${flag}"`);
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = flag === '--date' ? value : resolve(value);
  }
  const table = loadExportTable(options.core ? { core: options.core } : {});
  const { changed, stamps, counts } = restampSkills({
    table,
    skillDir: options.skill ?? SKILL_DIR,
    mirrorDir: options.mirror ?? MIRROR_DIR,
    date: options.date,
  });
  for (const file of changed) console.log(`restamped ${relative('.', file).replace(/\\/g, '/')}`);
  console.log(
    `Skill stamped for @deuz-sdk/core@${table.version} · api-contract sha256:${table.contractHash}: ` +
      `${stamps} stamps; ${counts.subpaths} code subpaths, ${counts.exportKeys} export keys, ` +
      `${counts.rootExports} root exports; ${changed.length} file(s) changed.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`restamp-skills: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
