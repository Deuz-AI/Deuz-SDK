#!/usr/bin/env node
/**
 * build — runs tsup with a heap large enough for its declaration build (2.4).
 * The DTS worker bundles every entry's declarations in one program; with the
 * nine 2.4 subpaths it outgrows Node's default heap (about 4 GB) and dies
 * with ERR_WORKER_OUT_OF_MEMORY, on `npm run build` and on the `prepare` that
 * `npm ci` runs. NODE_OPTIONS reaches the worker too. An explicit
 * `--max-old-space-size` in NODE_OPTIONS wins.
 *
 *   node tooling/build.mjs [tsup arguments]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const HEAP = '--max-old-space-size=8192';

const require = createRequire(import.meta.url);
const manifest = require.resolve('tsup/package.json');
const { bin } = require(manifest);
const cli = join(dirname(manifest), typeof bin === 'string' ? bin : bin.tsup);

const inherited = process.env.NODE_OPTIONS ?? '';
const nodeOptions = /--max-old-space-size=/.test(inherited)
  ? inherited
  : `${inherited} ${HEAP}`.trim();

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
