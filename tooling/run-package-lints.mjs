import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = resolve(root, '.tmp/package-lints');
const cache = resolve(root, '.tmp/npm-cache');
mkdirSync(temp, { recursive: true });
mkdirSync(cache, { recursive: true });

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
    cli: resolve(root, 'node_modules/publint/src/cli.js'),
    args: ['--strict'],
  },
  {
    name: 'attw',
    cli: resolve(root, 'node_modules/@arethetypeswrong/cli/dist/index.js'),
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
