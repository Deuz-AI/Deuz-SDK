/**
 * The headless preview (2.3, 23.8) is Node-only: its code never reaches the
 * edge-safe entries, and its own entry never qualifies as browser-safe.
 * (`npm run verify:runtime` holds the same line over the built `dist`.)
 */
import { build, type Metafile } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (file: string): string => fileURLToPath(new URL(`../src/${file}`, import.meta.url));

async function browserInputs(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [src(entry)],
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'browser',
    write: false,
  });
  return Object.keys((result.metafile as Metafile).inputs);
}

const HEADLESS = /(?:^|[\\/])(?:headless[\\/]|node[\\/]headless\.ts$)/;

describe('the headless boundary', () => {
  it.each(['index.ts', 'edge.ts', 'agent.ts'])(
    '%s pulls in no headless module',
    async (entry) => {
      const inputs = await browserInputs(entry);
      expect(inputs.length).toBeGreaterThan(10);
      expect(inputs.filter((input) => HEADLESS.test(input))).toEqual([]);
    },
    30_000,
  );

  it('the headless entry itself does not pass as browser-safe', async () => {
    let inputs: string[] | undefined;
    try {
      inputs = await browserInputs('node/headless.ts');
    } catch {
      // A browser resolver rejecting the node: imports enforces the boundary too.
      return;
    }
    expect(inputs.some((input) => /skills[\\/]node\.ts$/.test(input))).toBe(true);
  }, 30_000);
});
