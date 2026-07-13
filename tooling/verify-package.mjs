import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const failures = [];

function fail(message) {
  failures.push(message);
}

function parsePackReport(output) {
  const cleaned = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (initialError) {
    const starts = [...cleaned.matchAll(/^\[/gm)].map((match) => match.index ?? 0).reverse();
    for (const start of starts) {
      for (
        let end = cleaned.lastIndexOf(']');
        end > start;
        end = cleaned.lastIndexOf(']', end - 1)
      ) {
        try {
          const report = JSON.parse(cleaned.slice(start, end + 1));
          if (Array.isArray(report) && Array.isArray(report[0]?.files)) return report;
        } catch {
          // Lifecycle output may surround npm's JSON report; keep looking for the report boundary.
        }
      }
    }
    throw initialError;
  }
}

function leaves(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(leaves);
}

function assertConditionalExport(subpath, entry) {
  if (subpath === './package.json') return;
  if (!entry || typeof entry !== 'object' || !entry.import || !entry.require) {
    fail(`${subpath}: expected import and require conditions`);
    return;
  }
  for (const condition of ['import', 'require']) {
    const branch = entry[condition];
    if (!branch || typeof branch !== 'object' || !branch.types || !branch.default) {
      fail(`${subpath}: ${condition} must expose types and default`);
      continue;
    }
    if (Object.keys(branch)[0] !== 'types') {
      fail(`${subpath}: ${condition}.types must precede ${condition}.default`);
    }
  }
}

for (const [subpath, entry] of Object.entries(packageJson.exports ?? {})) {
  assertConditionalExport(subpath, entry);
  for (const target of leaves(entry)) {
    const absolute = resolve(root, target);
    if (!absolute.startsWith(`${resolve(root, 'dist')}${sep}`) && target !== './package.json') {
      fail(`${subpath}: export target escapes dist (${target})`);
    }
    if (!existsSync(absolute)) fail(`${subpath}: missing export target ${target}`);
  }
}

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = [
  ...(npmExecPath ? [npmExecPath] : []),
  'pack',
  '--json',
  '--dry-run',
  '--ignore-scripts',
];
const packed = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    FORCE_COLOR: '0',
    npm_config_cache: resolve(root, '.tmp/npm-cache'),
    npm_config_color: 'false',
    npm_config_ignore_scripts: 'true',
  },
  windowsHide: true,
});
if (packed.status !== 0) {
  const detail = packed.error?.message ?? packed.stderr ?? packed.stdout ?? 'unknown error';
  fail(`npm pack --dry-run failed: ${String(detail).trim()}`);
} else {
  try {
    const report = parsePackReport(packed.stdout);
    const files = new Set((report[0]?.files ?? []).map((file) => file.path.replaceAll('\\', '/')));
    const forbidden = [...files].filter(
      (file) =>
        file.startsWith('src/') ||
        file.startsWith('test/') ||
        file.startsWith('.env') ||
        file.startsWith('.smoke') ||
        file.endsWith('.tsbuildinfo'),
    );
    if (forbidden.length > 0) fail(`forbidden files in tarball: ${forbidden.join(', ')}`);
    for (const entry of Object.values(packageJson.exports ?? {})) {
      for (const target of leaves(entry)) {
        const packedPath = target.replace(/^\.\//, '');
        if (!files.has(packedPath)) fail(`tarball is missing ${packedPath}`);
      }
    }
  } catch (error) {
    fail(
      `could not parse npm pack report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const jsTargets = new Set();
for (const entry of Object.values(packageJson.exports ?? {})) {
  for (const target of leaves(entry)) {
    if (target.endsWith('.js') || target.endsWith('.cjs')) jsTargets.add(target);
  }
}

for (const target of jsTargets) {
  if (!existsSync(resolve(root, target))) continue;
  try {
    if (target.endsWith('.cjs')) require(resolve(root, target));
    else await import(`${pathToFileURL(resolve(root, target)).href}?package-check=1`);
  } catch (error) {
    fail(`${target} cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`Package verification failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Package verification passed (${Object.keys(packageJson.exports).length} subpaths, ${jsTargets.size} runtime targets).`,
  );
}
