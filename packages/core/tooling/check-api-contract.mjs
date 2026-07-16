import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const declaration = resolve(root, 'dist/index.d.ts');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const contract = JSON.parse(readFileSync(resolve(root, 'tooling/api-contract.json'), 'utf8'));

const program = ts.createProgram([declaration], {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(declaration);
const moduleSymbol = source && checker.getSymbolAtLocation(source);
if (!source || !moduleSymbol)
  throw new Error('Could not inspect dist/index.d.ts. Run npm run build first.');

const rootExports = checker
  .getExportsOfModule(moduleSymbol)
  .map((symbol) => symbol.getName())
  .sort();
const subpaths = Object.keys(packageJson.exports ?? {}).sort();

if (process.argv.includes('--print')) {
  console.log(
    JSON.stringify(
      { schemaVersion: 1, requiredSubpaths: subpaths, requiredRootExports: rootExports },
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
const failures = [];
if (missingSubpaths.length > 0)
  failures.push(`removed package subpaths: ${missingSubpaths.join(', ')}`);
if (missingRootExports.length > 0)
  failures.push(`removed root exports: ${missingRootExports.join(', ')}`);

if (failures.length > 0) {
  console.error(`Public API contract failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Public API contract passed (${contract.requiredRootExports.length} root exports, ${contract.requiredSubpaths.length} subpaths locked).`,
  );
}
