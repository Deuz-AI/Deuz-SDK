/**
 * verify-docs — the cheap static gate over the DOCUMENTATION surface
 * (`docs/`, `skills/`, `README.md`, the root specs and `.changeset/`). Wired
 * into the root `npm run check` as `verify:docs-refs`.
 *
 * It exists because the docs are written by the same agents that write the
 * code, and the two failure modes that actually shipped were both invisible to
 * the code gate:
 *
 *   1. TOOL-CALL DEBRIS. A literal tool-call closing tag leaked into the tail
 *      of 13 written files in one pass — and the same failure had already
 *      broken the pass before it. Nothing in `npm run check` read prose, so it
 *      surfaced minutes later as a `next build` crash in `docs/`. Check 1 is
 *      that grep. It runs FIRST and BAILS OUT on the first hit: a file with a
 *      raw tool tag in it is mid-write garbage, so every downstream result
 *      would be noise.
 *   2. HALLUCINATED SYMBOLS. `import { thing } from '@deuz-sdk/core'` where
 *      `thing` does not exist. `tsc` never looks inside a fenced code block, so
 *      a confidently-wrong example survives every other gate step. Check 3
 *      builds a REAL symbol table from `tsup.config.ts`'s `entry` map plus
 *      `package.json`'s `exports` (following `export *` recursively) and
 *      resolves every documented `@deuz-sdk` import against it.
 *
 * Zero dependencies, no build required, sub-second — so it can afford to run on
 * every `npm run check`. It is deliberately a LINTER OVER TEXT, not a type
 * checker: `npm run verify:docs` (fumadocs typegen + `next build`) stays the
 * authority on whether the site actually compiles.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(CORE, '../..');
const DOCS = resolve(ROOT, 'docs/content/docs');

const failures = [];
const show = (file) => relative(ROOT, file).replace(/\\/g, '/');
const fail = (file, line, message) =>
  failures.push(`${show(file)}${line ? `:${line}` : ''}  ${message}`);

const report = (headline) => {
  console.error(`${headline}:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.source',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const SKIP_FILES = new Set(['package-lock.json', 'tsconfig.tsbuildinfo']);
const TEXT_FILE = /\.(?:mdx?|[cm]?[jt]sx?|json|css|ya?ml|txt|svg)$/;
const PROSE_FILE = /\.mdx?$/;

function walk(dir, match, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(path, match, out);
    } else if (!SKIP_FILES.has(entry) && match.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const rootMarkdown = readdirSync(ROOT)
  .filter((entry) => entry.endsWith('.md'))
  .map((entry) => join(ROOT, entry));

// Prose = what the site renders and what an agent reads: doc pages + skills + README.
const proseFiles = [
  ...walk(DOCS, PROSE_FILE),
  ...walk(resolve(ROOT, 'skills'), PROSE_FILE),
  join(ROOT, 'README.md'),
];

// Debris scope is wider on purpose: every hand/agent-written text file in the
// docs app, the skills, the root specs and the pending changesets.
const debrisFiles = [
  ...walk(resolve(ROOT, 'docs'), TEXT_FILE),
  ...walk(resolve(ROOT, 'skills'), TEXT_FILE),
  ...walk(resolve(ROOT, '.changeset'), /\.md$/),
  ...rootMarkdown,
];

// ---------------------------------------------------------------------------
// 1. Leaked tool-call debris (the non-negotiable check — runs first, bails)
// ---------------------------------------------------------------------------

// The needles are ASSEMBLED FROM FRAGMENTS so this file never contains a
// literal tool-call tag itself. A checker that trips its own check is worse
// than no checker, and this file is inside the scan scope of any future
// repo-wide grep.
const TOOL_TAGS = ['invoke', 'parameter', 'function_calls', 'function_results'];
const TOOL_NS = 'ant' + 'ml';
const DEBRIS_RULES = [
  // CASE-SENSITIVE on purpose: leaked tool tags are always lowercase, while a
  // capitalised `<Parameter>` / `<Invoke>` is a perfectly ordinary MDX
  // component (MDX only treats capitalised tags as components at all). An `i`
  // flag here would fail the gate on a legitimate docs component.
  {
    label: 'leaked tool-call tag',
    re: new RegExp(`<\\/?\\s*(?:[A-Za-z_][\\w.-]*:)?(?:${TOOL_TAGS.join('|')})(?=[\\s/>])`),
  },
  // The namespace itself has no plausible legitimate use, so stay case-blind.
  {
    label: 'leaked tool-call namespace',
    re: new RegExp(`<\\/?\\s*${TOOL_NS}\\s*:`, 'i'),
  },
];

for (const file of debrisFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of DEBRIS_RULES) {
      const hit = rule.re.exec(line);
      if (hit)
        fail(file, index + 1, `${rule.label} — remove "${hit[0]}" (${line.trim().slice(0, 80)})`);
    }
  });
}

if (failures.length > 0) {
  report(`Docs references failed — TOOL-CALL DEBRIS in ${failures.length} place(s)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. MDX safety — the three things that break `next build` silently
// ---------------------------------------------------------------------------

for (const file of proseFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  if (file.startsWith(DOCS)) {
    if (lines[0] !== '---') fail(file, 1, 'doc page has no frontmatter block');
    else if (lines.indexOf('---', 1) < 1) fail(file, 1, 'doc page frontmatter is never closed');
  }
  let fenceToken = '';
  let fenceLine = 0;
  let callouts = 0;
  lines.forEach((line, index) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!fenceToken) {
        fenceToken = fence[1][0];
        fenceLine = index + 1;
      } else if (fence[1][0] === fenceToken) {
        fenceToken = '';
      }
      return;
    }
    if (fenceToken) return; // inside a code fence: prose rules do not apply
    callouts += (line.match(/<Callout[\s>/]/g) ?? []).length;
    callouts -= (line.match(/<\/Callout>/g) ?? []).length;
    callouts -= (line.match(/<Callout[^>]*\/>/g) ?? []).length;
    if (callouts < 0) {
      fail(file, index + 1, '</Callout> without a matching opener');
      callouts = 0;
    }
  });
  if (fenceToken) fail(file, fenceLine, 'code fence opened here is never closed');
  if (callouts !== 0) fail(file, 0, `${callouts} unclosed <Callout>`);
}

// ---------------------------------------------------------------------------
// 3. Symbol table: subpath -> src entry -> exported names (following export *)
// ---------------------------------------------------------------------------

// tsup's `entry` map is the only place that knows dist name -> src file.
const tsup = readFileSync(join(CORE, 'tsup.config.ts'), 'utf8');
const entryStart = tsup.indexOf('{', tsup.indexOf('entry:'));
let depth = 0;
let entryEnd = entryStart;
for (; entryEnd < tsup.length; entryEnd++) {
  if (tsup[entryEnd] === '{') depth++;
  else if (tsup[entryEnd] === '}' && --depth === 0) break;
}
const distToSrc = new Map();
for (const m of tsup
  .slice(entryStart, entryEnd)
  .matchAll(/['"]?([\w./-]+)['"]?\s*:\s*['"](src\/[\w./-]+\.ts)['"]/g)) {
  distToSrc.set(m[1], join(CORE, m[2]));
}

const corePkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));
const moduleToSrc = new Map([['@deuz-sdk/react', join(ROOT, 'packages/react/src/index.ts')]]);
for (const [subpath, value] of Object.entries(corePkg.exports)) {
  if (subpath === './package.json') continue;
  const specifier = subpath === '.' ? '@deuz-sdk/core' : `@deuz-sdk/core/${subpath.slice(2)}`;
  const dist = value?.import?.default?.replace('./dist/', '').replace(/\.js$/, '');
  const src = dist && distToSrc.get(dist);
  // A subpath with no tsup entry would ship a 404 — that is a config bug, not a docs bug,
  // but this is the only place that cross-checks the two lists, so report it here.
  if (!src) fail(join(CORE, 'package.json'), 0, `export "${subpath}" has no tsup entry`);
  else moduleToSrc.set(specifier, src);
}

const memo = new Map();
const inProgress = new Set();
let cycles = 0;

function resolveRelative(from, specifier) {
  if (specifier.startsWith('@deuz-sdk/')) return moduleToSrc.get(specifier) ?? '';
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return `${base}.ts`;
}

/** Exported names of a src file, expanding `export * from` transitively. */
function exportsOf(file) {
  const hit = memo.get(file);
  if (hit) return hit;
  if (!file || !existsSync(file)) return new Set();
  if (inProgress.has(file)) {
    // Import cycle: return a partial set and mark the whole chain uncacheable,
    // so a laxer snapshot can never be memoised into a FALSE "missing export".
    cycles++;
    return new Set();
  }
  inProgress.add(file);
  const cyclesBefore = cycles;
  const code = readFileSync(file, 'utf8');
  const names = new Set();
  // export { a, b as c } [from '…']  /  export type { … } from '…'
  for (const m of code.matchAll(
    /export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g,
  )) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0] ?? '').replace(/^type\s+/, '').trim();
      if (name) names.add(name);
    }
  }
  // export function/const/class/interface/type/enum X
  for (const m of code.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  // export [type] * [as ns] from '…'
  for (const m of code.matchAll(
    /export\s+(?:type\s+)?\*\s+(?:as\s+([\w$]+)\s+)?from\s*['"]([^'"]+)['"]/g,
  )) {
    if (m[1]) names.add(m[1]);
    else for (const name of exportsOf(resolveRelative(file, m[2]))) names.add(name);
  }
  inProgress.delete(file);
  if (cycles === cyclesBefore) memo.set(file, names);
  return names;
}

let importStatements = 0;
let importedSymbols = 0;

for (const file of proseFiles) {
  const code = readFileSync(file, 'utf8');
  const lineOf = (index) => code.slice(0, index).split(/\r?\n/).length;

  // Multi-line aware: `import [type] { … } from '@deuz-sdk/…'` across newlines.
  for (const m of code.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@deuz-sdk\/[^'"]+)['"]/g,
  )) {
    importStatements++;
    const specifier = m[2];
    const line = lineOf(m.index);
    const available = moduleToSrc.has(specifier) ? exportsOf(moduleToSrc.get(specifier)) : null;
    if (!available) {
      fail(file, line, `imports from unknown subpath "${specifier}"`);
      continue;
    }
    // Strip trailing `// …` comments BEFORE splitting on commas.
    for (const raw of m[1].replace(/\/\/[^\n]*/g, '').split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!name || name.startsWith('/')) continue;
      importedSymbols++;
      if (!available.has(name)) {
        fail(file, line, `"${name}" is not exported by ${specifier}`);
      }
    }
  }

  // A quoted/backticked subpath mention anywhere in prose (delimiters bound the
  // match, so trailing punctuation cannot produce a phantom path).
  for (const m of code.matchAll(/(['"`])(@deuz-sdk\/(?:core|react)(?:\/[\w./-]+)?)\1/g)) {
    if (!moduleToSrc.has(m[2])) fail(file, lineOf(m.index), `mentions unknown subpath "${m[2]}"`);
  }
}

// ---------------------------------------------------------------------------
// 4. Internal /docs/… links and #anchors
// ---------------------------------------------------------------------------

const anchorsByRoute = new Map();
const slugify = (heading) =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s/g, '-');

for (const file of walk(DOCS, /\.mdx$/)) {
  let route = `/docs${file
    .slice(DOCS.length)
    .replace(/\\/g, '/')
    .replace(/\.mdx$/, '')}`;
  if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
  const anchors = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) anchors.add(slugify(heading[2]));
  }
  anchorsByRoute.set(route, anchors);
}

for (const file of proseFiles) {
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/\]\((\/docs\/[^)\s]*)\)/g)) {
    const line = code.slice(0, m.index).split(/\r?\n/).length;
    const [path, anchor] = m[1].split('#');
    if (!anchorsByRoute.has(path)) fail(file, line, `dead internal link ${m[1]}`);
    else if (anchor && !anchorsByRoute.get(path).has(anchor)) {
      fail(file, line, `dead anchor ${m[1]} (page exists, heading does not)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. meta.json <-> disk, both directions (fumadocs sidebar)
// ---------------------------------------------------------------------------

// fumadocs page-tree sugar that does not name a file on disk.
const isSugar = (entry) =>
  entry.startsWith('---') ||
  entry.startsWith('...') ||
  entry.startsWith('[') ||
  entry.startsWith('!');

for (const metaPath of walk(DOCS, /^meta\.json$/)) {
  const dir = dirname(metaPath);
  const pages = JSON.parse(readFileSync(metaPath, 'utf8')).pages ?? [];
  for (const page of pages) {
    if (isSugar(page)) continue;
    if (existsSync(join(dir, `${page}.mdx`)) || existsSync(join(dir, page))) continue;
    fail(metaPath, 0, `lists "${page}", which is not on disk`);
  }
  for (const entry of readdirSync(dir)) {
    const isPage = entry.endsWith('.mdx');
    const isSection = statSync(join(dir, entry)).isDirectory() && !SKIP_DIRS.has(entry);
    if (!isPage && !isSection) continue;
    const name = isPage ? entry.slice(0, -'.mdx'.length) : entry;
    if (!pages.includes(name)) {
      fail(metaPath, 0, `does not list "${name}", so it is invisible in the sidebar`);
    }
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  report('Docs references failed');
} else {
  console.log(
    `Docs references passed (${proseFiles.length} prose files, ${debrisFiles.length} scanned for debris, ` +
      `${importStatements} @deuz-sdk imports / ${importedSymbols} symbols, ${anchorsByRoute.size} routes).`,
  );
}
