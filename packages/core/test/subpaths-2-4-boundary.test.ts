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

/**
 * Every module an entry bundles (`inputs`, `text`, lazy chunks included) and
 * the ones it loads statically (`eager`: its entry chunk and every chunk it
 * reaches through import statements). A dynamic `import()` (the supervisor's
 * native launcher) is a chunk of its own, loaded only when it runs (2.4, L4b).
 */
async function browserBundle(
  entry: string,
): Promise<{ inputs: string[]; eager: string[]; text: string }> {
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
  const metafile = result.metafile as Metafile;
  const outputs = metafile.outputs;
  // Lazy chunks are entry points of their own: start from this entry's chunk alone.
  const queue = Object.keys(outputs).filter((path) =>
    (outputs[path]!.entryPoint ?? '').replaceAll('\\', '/').endsWith(`src/${entry}`),
  );
  const chunks = new Set<string>();
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (chunks.has(path)) continue;
    chunks.add(path);
    for (const imported of outputs[path]!.imports)
      if (imported.kind === 'import-statement' && outputs[imported.path]) queue.push(imported.path);
  }
  return {
    inputs: Object.keys(metafile.inputs),
    eager: [...new Set([...chunks].flatMap((path) => Object.keys(outputs[path]!.inputs)))],
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
      const { inputs, eager, text } = await browserBundle(entry);
      // Never statically: the native launcher loads the executor with import().
      expect(eager.filter((input) => EXECUTOR.test(input))).toEqual([]);
      expect(inputs.filter((input) => /[\/]node[\/]/.test(input))).toEqual([]);
      expect(NODE_IMPORT.test(text)).toBe(false);
    },
    30_000,
  );
});
