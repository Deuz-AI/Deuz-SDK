import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'tooling/bundle-size-budgets.json'), 'utf8'));
const failures = [];

const size = (buffers) => {
  const output = Buffer.concat(buffers);
  return { raw: output.byteLength, gzip: gzipSync(output, { level: 9 }).byteLength };
};

/**
 * Output chunks reachable from the entry through `import` statements only.
 * A chunk behind a dynamic `import()` is not in this set: a consumer downloads
 * it when — and only when — they call the feature that awaits it.
 */
const eagerChunks = (metafile) => {
  const outputs = metafile.outputs;
  const entry = Object.keys(outputs).find((path) => outputs[path].entryPoint !== undefined);
  if (entry === undefined) return undefined;
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    for (const imported of outputs[path].imports ?? []) {
      if (imported.kind === 'import-statement' && outputs[imported.path] !== undefined) {
        queue.push(imported.path);
      }
    }
  }
  return new Set([...seen].map((path) => basename(path)));
};

for (const [name, budget] of Object.entries(config.bundles)) {
  const exports = budget.exports.join(', ');
  const result = await build({
    stdin: {
      contents: `export { ${exports} } from '${budget.from}';`,
      loader: 'js',
      resolveDir: root,
      sourcefile: `${name}-size-entry.mjs`,
    },
    bundle: true,
    // `splitting` mirrors tsup.config.ts and every real consumer bundler. Without
    // it esbuild has nowhere to put a dynamic import and inlines it, so a feature
    // that is only fetched when you opt into it gets billed to every import.
    splitting: true,
    outdir: 'size-check',
    metafile: true,
    conditions: ['browser', 'import', 'default'],
    format: 'esm',
    legalComments: 'none',
    logLevel: 'silent',
    minify: true,
    platform: 'browser',
    target: ['es2022'],
    treeShaking: true,
    write: false,
  });

  const eagerNames = eagerChunks(result.metafile);
  if (eagerNames === undefined) {
    failures.push(`${name}: no entry chunk in the metafile`);
    continue;
  }
  const isEager = (file) => eagerNames.has(basename(file.path));
  const eagerFiles = result.outputFiles.filter(isEager);
  const lazyFiles = result.outputFiles.filter((file) => !isEager(file));

  const eager = size(eagerFiles.map((file) => Buffer.from(file.contents)));
  console.log(
    `${name}: ${eager.raw} B raw / ${eager.gzip} B gzip (limits ${budget.maxRawBytes} / ${budget.maxGzipBytes})`,
  );
  if (eager.raw > budget.maxRawBytes) {
    failures.push(`${name}: raw ${eager.raw} > ${budget.maxRawBytes}`);
  }
  if (eager.gzip > budget.maxGzipBytes) {
    failures.push(`${name}: gzip ${eager.gzip} > ${budget.maxGzipBytes}`);
  }

  // Lazy chunks are still weighed, so nothing ships unmeasured — they just get
  // their own ratchet instead of inflating the cost of importing the package.
  if (lazyFiles.length > 0) {
    const lazy = size(lazyFiles.map((file) => Buffer.from(file.contents)));
    const budgeted = budget.maxLazyRawBytes !== undefined;
    console.log(
      `${name} (lazy, ${lazyFiles.length} chunk(s)): ${lazy.raw} B raw / ${lazy.gzip} B gzip ` +
        (budgeted
          ? `(limits ${budget.maxLazyRawBytes} / ${budget.maxLazyGzipBytes})`
          : '(unbudgeted)'),
    );
    if (budgeted) {
      if (lazy.raw > budget.maxLazyRawBytes) {
        failures.push(`${name}: lazy raw ${lazy.raw} > ${budget.maxLazyRawBytes}`);
      }
      if (lazy.gzip > budget.maxLazyGzipBytes) {
        failures.push(`${name}: lazy gzip ${lazy.gzip} > ${budget.maxLazyGzipBytes}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Bundle size regression:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Bundle size budgets passed.');
}
