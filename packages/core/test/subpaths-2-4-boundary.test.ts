/**
 * The edge-safe 2.4 entries stay edge-safe and small (W0): none reaches a
 * node: builtin, and none pulls the native executor (`agent-run.ts`) or the
 * loops in statically: the goal supervisor starts runs through its
 * `RunLauncher` seam and loads the executor lazily. (`npm run verify:runtime`
 * holds the node: line over the built `dist`.)
 */
import { build, type Metafile } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (file: string): string => fileURLToPath(new URL(`../src/${file}`, import.meta.url));

async function browserBundle(entry: string): Promise<{ inputs: string[]; text: string }> {
  const result = await build({
    entryPoints: [src(entry)],
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'browser',
    splitting: true,
    outdir: 'boundary-check',
    write: false,
  });
  return {
    inputs: Object.keys((result.metafile as Metafile).inputs),
    text: result.outputFiles.map((file) => file.text).join('\n'),
  };
}

const EXECUTOR = /(?:^|[\/])src[\/](?:agent-run\.ts|inference[\/])/;
const NODE_IMPORT = /(?:from\s*|import\s*\(|require\s*\()\s*["']node:/;

describe('the 2.4 edge-safe entries', () => {
  it.each([
    'memory/versioned/index.ts',
    'context/index.ts',
    'goal/runtime/index.ts',
    'skills/learning/index.ts',
  ])(
    '%s reaches no node: builtin and no native executor module',
    async (entry) => {
      const { inputs, text } = await browserBundle(entry);
      expect(inputs.filter((input) => EXECUTOR.test(input))).toEqual([]);
      expect(inputs.filter((input) => /[\/]node[\/]/.test(input))).toEqual([]);
      expect(NODE_IMPORT.test(text)).toBe(false);
    },
    30_000,
  );
});
