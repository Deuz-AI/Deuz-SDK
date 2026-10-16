/**
 * The light prepublish guard (2.4, spec §5.4). `prepublishOnly` used to run
 * the whole `npm run check`, which `changeset publish` started while the
 * other package was building: a flaky test under that load kept core off npm
 * in the 2.3.0 release. `release.yml` runs `release:verify` before publishing,
 * so the guard only refuses a package with no build or an unpublishable
 * version, and it is fast.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(CORE, 'tooling', 'prepublish-guard.mjs');
const dirs: string[] = [];

function fixture(pkg: Record<string, unknown>, files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'deuz-guard-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  return root;
}

function guard(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const exportsOf = (entry: string) => ({
  [entry === 'index' ? '.' : `./${entry}`]: {
    import: { types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.js` },
    require: { types: `./dist/${entry}.d.cts`, default: `./dist/${entry}.cjs` },
  },
});
const built = (entry: string) =>
  ['.d.ts', '.js', '.d.cts', '.cjs'].map((ext) => `dist/${entry}${ext}`);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('prepublish guard', () => {
  it('passes a built package with a release version', () => {
    const root = fixture(
      {
        name: '@deuz-sdk/core',
        version: '2.4.0',
        main: './dist/index.cjs',
        exports: { ...exportsOf('index'), ...exportsOf('ui'), './package.json': './package.json' },
      },
      [...built('index'), ...built('ui')],
    );
    expect(guard(root)).toMatchObject({ status: 0 });
  });

  it('accepts a prerelease version', () => {
    const root = fixture(
      { name: 'x', version: '2.4.0-rc.1', exports: exportsOf('index') },
      built('index'),
    );
    expect(guard(root).status).toBe(0);
  });

  it('refuses a package whose build is missing or incomplete', () => {
    const none = fixture({ name: 'x', version: '2.4.0', exports: exportsOf('index') }, []);
    const missing = guard(none);
    expect(missing.status).toBe(1);
    expect(missing.output).toMatch(/dist\/index\.js/);

    const partial = fixture(
      { name: 'x', version: '2.4.0', exports: { ...exportsOf('index'), ...exportsOf('ui') } },
      built('index'),
    );
    expect(guard(partial)).toMatchObject({ status: 1 });
    expect(guard(partial).output).toMatch(/dist\/ui/);
  });

  it('refuses a version that is not a publishable semver', () => {
    for (const version of ['0.0.0', '2.4', 'v2.4.0', '', 'latest']) {
      const root = fixture({ name: 'x', version, exports: exportsOf('index') }, built('index'));
      expect(guard(root).status, version).toBe(1);
    }
  });

  it('is what prepublishOnly runs in place of the whole check', () => {
    const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.prepublishOnly).toBe('node tooling/prepublish-guard.mjs');
  });
});
