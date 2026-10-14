#!/usr/bin/env node
/**
 * prepublish-guard — what `prepublishOnly` runs (2.4). It only refuses a
 * package that cannot be what we mean to publish: no build (a file named by
 * `main`, `module`, `types` or an `exports` target is missing) or a version
 * that is not a publishable semver. It runs no tests: `release.yml` runs
 * `release:verify` (the whole gate) before `changeset publish`, and running
 * the suite again here, while the other package builds in parallel, is what
 * kept core off npm in the 2.3.0 release.
 *
 *   node tooling/prepublish-guard.mjs [packageRoot]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const failures = [];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version) || pkg.version === '0.0.0')
  failures.push(`version ${JSON.stringify(pkg.version)} is not a publishable semver`);

const targets = new Set();
const collect = (value) => {
  if (typeof value === 'string') targets.add(value);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) collect(item);
};
for (const field of ['main', 'module', 'types']) collect(pkg[field]);
collect(pkg.exports);
targets.delete('./package.json');

for (const target of [...targets].sort()) {
  if (!existsSync(resolve(root, target)))
    failures.push(`missing build output ${target.replace(/^\.\//, '')}`);
}
if (targets.size === 0) failures.push('package.json names no build output');

if (failures.length > 0) {
  console.error(
    `prepublish guard failed for ${pkg.name ?? root}:\n- ${failures.join('\n- ')}\nRun the build (and release:verify) before publishing.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `prepublish guard passed: ${pkg.name}@${pkg.version}, ${targets.size} build outputs present.`,
  );
}
