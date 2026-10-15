/**
 * The published `@deuz-sdk/core@2.3.0` for the rollback test (2.4 spec §4.2).
 *
 * It is installed from npm, with the `pg` driver the repo uses, into a scratch
 * directory outside the repo (`<os tmp>/deuz-rollback/`, or
 * `DEUZ_ROLLBACK_CACHE_DIR`), and the install is kept for the next run. A
 * bare `@deuz-sdk/core` import from a script in that directory loads 2.3.0
 * through its own `exports` map, as a 2.3 worker would; inside the repo the
 * same import would load the workspace package instead.
 *
 * The tarball is pinned by its npm integrity, so a cache or a registry that
 * hands over anything else fails the test instead of testing it. An install
 * goes into a staging directory first and is renamed into place only once it
 * checks out, so an interrupted install is never mistaken for a cached one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** The release the rollback rule protects, as npm serves it. */
export const LEGACY_CORE = {
  name: '@deuz-sdk/core',
  version: '2.3.0',
  integrity:
    'sha512-ePyfPRl28256In103gSqhrNnHSIuM/z9/Fd76CSKXsgJxnJu2uAQSx2UhAd+VimylqOu3k7VpALSTpKAqsDT0Q==',
} as const;

export interface LegacyInstall {
  /** The scratch project: `node_modules/@deuz-sdk/core` (2.3.0) and `node_modules/pg`. */
  dir: string;
  /** The `pg` version installed beside it (the repo's own). */
  pgVersion: string;
  /** False when this call ran `npm install`. */
  cached: boolean;
}

const MARKER = '.deuz-rollback.json';

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** Why `dir` is not a complete install of 2.3.0 and `pg@pgVersion`, or undefined when it is. */
export function checkLegacyInstall(dir: string, pgVersion: string): string | undefined {
  const core = readJson(join(dir, 'node_modules', '@deuz-sdk', 'core', 'package.json'));
  if (core?.version !== LEGACY_CORE.version)
    return `node_modules/@deuz-sdk/core is ${String(core?.version ?? 'missing')}, not ${LEGACY_CORE.version}`;
  const pg = readJson(join(dir, 'node_modules', 'pg', 'package.json'));
  if (pg?.version !== pgVersion)
    return `node_modules/pg is ${String(pg?.version ?? 'missing')}, not ${pgVersion}`;
  const lock = readJson(join(dir, 'package-lock.json')) as
    | { packages?: Record<string, { integrity?: string }> }
    | undefined;
  const integrity = lock?.packages?.['node_modules/@deuz-sdk/core']?.integrity;
  if (integrity !== LEGACY_CORE.integrity)
    return `the installed tarball's integrity is ${String(integrity ?? 'unknown')}, not the published ${LEGACY_CORE.integrity}`;
  return undefined;
}

/**
 * The environment for the nested `npm install`: npm passes its own settings
 * to a script as `npm_*` variables, and one such as `npm_config_workspace`
 * (from `npm run … -w @deuz-sdk/core`) would point the scratch install at a
 * workspace it does not have. Only the settings that say where and how to
 * reach the registry are kept.
 */
function npmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep =
    /registry|proxy|^npm_config_(cache|userconfig|globalconfig|cafile|ca|strict_ssl|fetch_\w+|maxsockets|prefer_offline|offline)$/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_/i.test(key) && !keep.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Runs npm: the CLI that runs this script when there is one, else `npm` on PATH. */
function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const cli = env.npm_execpath;
  const viaNode = cli !== undefined && /^npm-cli\.c?js$/.test(basename(cli));
  const result = viaNode
    ? spawnSync(process.execPath, [cli, ...args], {
        cwd,
        env: npmEnv(env),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300_000,
      })
    : spawnSync('npm', args, {
        cwd,
        env: npmEnv(env),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300_000,
        // npm is a .cmd shim on Windows, which only a shell runs; every argument is a fixed word.
        shell: process.platform === 'win32',
      });
  if (result.status !== 0)
    throw new Error(
      `npm ${args.join(' ')} failed in ${cwd} (${result.error?.message ?? `exit ${String(result.status)}`}):\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
}

/**
 * The scratch install of 2.3.0, reused when a complete one is already there.
 * Needs the npm registry (or npm's cache) only when it installs.
 */
export function installLegacyCore(env: NodeJS.ProcessEnv = process.env): LegacyInstall {
  const pgVersion = (createRequire(import.meta.url)('pg/package.json') as { version: string })
    .version;
  const base = env.DEUZ_ROLLBACK_CACHE_DIR || join(tmpdir(), 'deuz-rollback');
  const dir = join(base, `core-${LEGACY_CORE.version}-pg-${pgVersion}`);
  if (existsSync(join(dir, MARKER)) && checkLegacyInstall(dir, pgVersion) === undefined)
    return { dir, pgVersion, cached: true };

  const staging = `${dir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(
      join(staging, 'package.json'),
      `${JSON.stringify(
        {
          name: 'deuz-rollback-legacy',
          private: true,
          description: `${LEGACY_CORE.name}@${LEGACY_CORE.version} for the Deuz SDK rollback test`,
          dependencies: { [LEGACY_CORE.name]: LEGACY_CORE.version, pg: pgVersion },
        },
        null,
        2,
      )}\n`,
    );
    // Every peer of 2.3.0 is optional; pg is the one the Postgres stores need.
    runNpm(
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--prefer-offline',
        '--loglevel=error',
      ],
      staging,
      env,
    );
    const problem = checkLegacyInstall(staging, pgVersion);
    if (problem) throw new Error(`The scratch install of ${LEGACY_CORE.name} is wrong: ${problem}`);
    writeFileSync(
      join(staging, MARKER),
      `${JSON.stringify({ ...LEGACY_CORE, pg: pgVersion }, null, 2)}\n`,
    );
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try {
      renameSync(staging, dir);
    } catch (error) {
      // Another run finished the same install first: use it.
      if (!(existsSync(join(dir, MARKER)) && checkLegacyInstall(dir, pgVersion) === undefined))
        throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { dir, pgVersion, cached: false };
}
