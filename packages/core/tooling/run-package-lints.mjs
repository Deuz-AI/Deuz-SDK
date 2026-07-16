import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = resolve(root, '.tmp/package-lints');
const cache = resolve(root, '.tmp/npm-cache');
mkdirSync(temp, { recursive: true });
mkdirSync(cache, { recursive: true });

// Dev tools may live in the package's own node_modules or hoisted at the
// workspace root — probe both.
function findCli(rel, name) {
  const candidates = [resolve(root, 'node_modules', rel), resolve(root, '../../node_modules', rel)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`${name} CLI not found; looked in:\n  ${candidates.join('\n  ')}`);
    process.exit(1);
  }
  return found;
}

const env = {
  ...process.env,
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  npm_config_cache: cache,
};
const commands = [
  {
    name: 'publint',
    cli: findCli('publint/src/cli.js', 'publint'),
    args: ['--strict'],
  },
  {
    name: 'attw',
    cli: findCli('@arethetypeswrong/cli/dist/index.js', 'attw'),
    args: ['--pack', '--profile', 'node16'],
  },
];

for (const command of commands) {
  const result = spawnSync(process.execPath, [command.cli, ...command.args], {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(`${command.name} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(result.status ?? 1);
  }
}
