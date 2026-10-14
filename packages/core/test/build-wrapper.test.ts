/**
 * The build runs tsup through `tooling/build.mjs` (2.4): with the 2.4
 * subpaths the declaration worker outgrows Node's default heap, so `build`,
 * `dev` and the `prepare` that `npm ci` runs all go through the wrapper that
 * raises it. Arguments pass through unchanged.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('build wrapper', () => {
  it('is what build, dev and prepare run', () => {
    const { scripts } = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts.build).toBe('node tooling/build.mjs');
    expect(scripts.prepare).toBe('node tooling/build.mjs');
    expect(scripts.dev).toBe('node tooling/build.mjs --watch');
  });

  it('passes its arguments to tsup', () => {
    const result = spawnSync(process.execPath, [join(CORE, 'tooling', 'build.mjs'), '--version'], {
      cwd: CORE,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^tsup\/\d+\.\d+\.\d+/);
  });
});
