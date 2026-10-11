/**
 * The export table the Agent Skill tooling shares: every public module of
 * `@deuz-sdk/core` (and `@deuz-sdk/react`) with every name it exports, each
 * marked as a value or a type.
 *
 * Built the way `tooling/verify-docs.mjs` builds its symbol table — tsup's
 * `entry` map crossed with `package.json` `exports`, following `export *`
 * through `src` — so no build is needed. The walk reads each file with the
 * TypeScript parser rather than a regex, so commented-out code and string
 * contents never become exports and every name gets its exact kind (the
 * index splits Values from Types).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO_ROOT = resolve(CORE_DIR, '../..');

const collators = new Map();

/**
 * Case-insensitive name order, pinned to a locale so the output never depends
 * on the machine (`localeCompare()` without one follows the OS: the 2.2.0
 * index was sorted in tr-TR, where `I` is a different letter from `i`).
 */
export function compareNames(a, b, locale = 'en') {
  let collator = collators.get(locale);
  if (!collator) collators.set(locale, (collator = new Intl.Collator(locale)));
  return collator.compare(a, b);
}

/** First 12 hex of the sha256 of `tooling/api-contract.json` (line endings normalised). */
export function contractHashOf(core = CORE_DIR) {
  const text = readFileSync(join(core, 'tooling/api-contract.json'), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** tsup's `entry` map: dist name -> src file. The only place that knows the pairing. */
function readTsupEntries(core) {
  const tsup = readFileSync(join(core, 'tsup.config.ts'), 'utf8');
  const start = tsup.indexOf('{', tsup.indexOf('entry:'));
  let depth = 0;
  let end = start;
  for (; end < tsup.length; end++) {
    if (tsup[end] === '{') depth++;
    else if (tsup[end] === '}' && --depth === 0) break;
  }
  const entries = new Map();
  for (const m of tsup
    .slice(start, end)
    .matchAll(/['"]?([\w./-]+)['"]?\s*:\s*['"](src\/[\w./-]+\.tsx?)['"]/g)) {
    entries.set(m[1], join(core, m[2]));
  }
  return entries;
}

const hasModifier = (node, kind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  return out;
}

/** Names a statement declares, with their kind. */
function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) =>
      bindingNames(d.name).map((name) => [name, 'value']),
    );
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return [[statement.name.text, 'type']];
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name &&
    ts.isIdentifier(statement.name)
  ) {
    return [[statement.name.text, 'value']];
  }
  return [];
}

/** A value wins: a name that is both (a class, a const + type pair) imports as a value. */
const merge = (map, name, kind) => {
  if (map.get(name) !== 'value') map.set(name, kind);
};

/**
 * Loads the table. `core` / `react` point at a package directory (defaults:
 * this repository's), which is how the tooling runs against another checkout.
 */
export function loadExportTable({ core = CORE_DIR, react = join(core, '../react') } = {}) {
  const pkg = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'));
  const distToSrc = readTsupEntries(core);
  const problems = [];
  const modules = [];
  const specifierToSrc = new Map();

  for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
    if (subpath === './package.json') continue;
    const specifier = subpath === '.' ? '@deuz-sdk/core' : `@deuz-sdk/core/${subpath.slice(2)}`;
    const dist = value?.import?.default?.replace('./dist/', '').replace(/\.js$/, '');
    const src = dist && distToSrc.get(dist);
    if (!src) {
      problems.push(`export "${subpath}" has no tsup entry`);
      continue;
    }
    specifierToSrc.set(specifier, src);
    modules.push({ specifier, label: subpath === '.' ? '' : subpath.slice(2), src });
  }
  const reactSrc = ['src/index.ts', 'src/index.tsx'].map((p) => join(react, p)).find(existsSync);
  if (reactSrc) {
    specifierToSrc.set('@deuz-sdk/react', reactSrc);
    modules.push({ specifier: '@deuz-sdk/react', label: '@deuz-sdk/react', src: reactSrc });
  }

  const memo = new Map();
  const inProgress = new Set();
  let cycles = 0;

  /** Resolves a module specifier from `from` to a src file, or '' when it is external. */
  function resolveModule(from, specifier) {
    if (specifierToSrc.has(specifier)) return specifierToSrc.get(specifier);
    if (!specifier.startsWith('.')) return '';
    const base = resolve(dirname(from), specifier.replace(/\.(?:[cm]?js|jsx)$/, ''));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return '';
  }

  /** name -> kind for one name of another module; external modules count as values. */
  const kindIn = (file, name) => (file ? exportsOf(file).get(name) : undefined) ?? 'value';

  /** Exported names of a src file (name -> 'value' | 'type'), following `export *`. */
  function exportsOf(file) {
    const hit = memo.get(file);
    if (hit) return hit;
    if (!file || !existsSync(file)) return new Map();
    if (inProgress.has(file)) {
      // Import cycle: answer with a partial set and keep the whole chain out of
      // the memo, so a laxer snapshot is never cached as the module's surface.
      cycles++;
      return new Map();
    }
    inProgress.add(file);
    const cyclesBefore = cycles;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      false,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // Local bindings first, so `export { a }` can say what `a` is.
    const locals = new Map();
    for (const statement of source.statements) {
      for (const [name, kind] of declaredNames(statement)) merge(locals, name, kind);
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      const clause = statement.importClause;
      const target = resolveModule(file, statement.moduleSpecifier.text);
      if (clause.name) locals.set(clause.name.text, clause.isTypeOnly ? 'type' : 'value');
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        locals.set(bindings.name.text, clause.isTypeOnly ? 'type' : 'value');
      } else if (bindings) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          locals.set(
            element.name.text,
            clause.isTypeOnly || element.isTypeOnly ? 'type' : kindIn(target, imported),
          );
        }
      }
    }

    const names = new Map();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier
          ? resolveModule(file, statement.moduleSpecifier.text)
          : '';
        const clause = statement.exportClause;
        if (!clause) {
          // export [type] * from '…'
          for (const [name, kind] of exportsOf(target)) {
            merge(names, name, statement.isTypeOnly ? 'type' : kind);
          }
        } else if (ts.isNamespaceExport(clause)) {
          merge(names, clause.name.text, statement.isTypeOnly ? 'type' : 'value');
        } else {
          for (const element of clause.elements) {
            const local = (element.propertyName ?? element.name).text;
            let kind;
            if (statement.isTypeOnly || element.isTypeOnly) kind = 'type';
            else if (statement.moduleSpecifier) kind = kindIn(target, local);
            else kind = locals.get(local) ?? 'value';
            merge(names, element.name.text, kind);
          }
        }
        continue;
      }
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;
      for (const [name, kind] of declaredNames(statement)) merge(names, name, kind);
    }

    inProgress.delete(file);
    if (cycles === cyclesBefore) memo.set(file, names);
    return names;
  }

  return {
    core,
    version: pkg.version,
    contractHash: contractHashOf(core),
    modules: modules.map((module) => ({ ...module, names: exportsOf(module.src) })),
    problems,
  };
}
