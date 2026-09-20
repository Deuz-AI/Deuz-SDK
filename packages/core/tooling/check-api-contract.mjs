import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const declaration = resolve(root, 'dist/index.d.ts');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const contract = JSON.parse(readFileSync(resolve(root, 'tooling/api-contract.json'), 'utf8'));
const require = createRequire(import.meta.url);
const subpaths = Object.keys(packageJson.exports ?? {}).sort();
const subpathContracts = contract.requiredSubpathExports ?? {};
const failures = [];

// Inspect published conditional targets, not source files that might hide a
// missing or stale declaration/runtime export in the package.
const entries = [];
for (const subpath of Object.keys(subpathContracts)) {
  for (const condition of ['import', 'require']) {
    const entry = packageJson.exports?.[subpath]?.[condition];
    if (!entry || typeof entry.types !== 'string' || typeof entry.default !== 'string') {
      failures.push(`${subpath}: missing ${condition} declaration/runtime export targets`);
      continue;
    }
    entries.push({
      subpath,
      condition,
      declaration: resolve(root, entry.types),
      runtime: resolve(root, entry.default),
    });
  }
}

const program = ts.createProgram([declaration, ...entries.map((entry) => entry.declaration)], {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
});
const checker = program.getTypeChecker();

function exportedSymbols(path) {
  const source = program.getSourceFile(path);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!source || !moduleSymbol)
    throw new Error(`Could not inspect ${path}. Run npm run build first.`);
  return new Map(
    checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol]),
  );
}

const rootExports = [...exportedSymbols(declaration).keys()].sort();
if (process.argv.includes('--print')) {
  const requiredSubpathExports = Object.fromEntries(
    entries
      .filter((entry) => entry.condition === 'import')
      .map((entry) => [entry.subpath, [...exportedSymbols(entry.declaration).keys()].sort()]),
  );
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        requiredSubpaths: subpaths,
        requiredRootExports: rootExports,
        requiredSubpathExports,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const missingSubpaths = contract.requiredSubpaths.filter((name) => !subpaths.includes(name));
const missingRootExports = contract.requiredRootExports.filter(
  (name) => !rootExports.includes(name),
);
if (missingSubpaths.length > 0)
  failures.push(`removed package subpaths: ${missingSubpaths.join(', ')}`);
if (missingRootExports.length > 0)
  failures.push(`removed root exports: ${missingRootExports.join(', ')}`);

for (const entry of entries) {
  const label = `${entry.subpath} (${entry.condition})`;
  try {
    const symbols = exportedSymbols(entry.declaration);
    const missing = subpathContracts[entry.subpath].filter((name) => !symbols.has(name));
    if (missing.length) failures.push(`${label}: removed named exports: ${missing.join(', ')}`);
    const runtime =
      entry.condition === 'import'
        ? await import(pathToFileURL(entry.runtime).href)
        : require(entry.runtime);
    for (const name of subpathContracts[entry.subpath]) {
      const symbol = symbols.get(name);
      if (!symbol) continue;
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (target.flags & ts.SymbolFlags.Value && !Object.hasOwn(runtime, name)) {
        failures.push(`${label}: declared runtime export ${name} is absent from JavaScript`);
      }
    }
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`Public API contract failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  const namedCount = Object.values(subpathContracts).reduce(
    (total, names) => total + names.length,
    0,
  );
  console.log(
    `Public API contract passed (${contract.requiredRootExports.length} root exports, ${contract.requiredSubpaths.length} subpaths, ${namedCount} subpath exports locked in ESM/CJS).`,
  );
}
