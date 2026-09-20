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
const staticChunks = (metafile, entries) => {
  const outputs = metafile.outputs;
  const seen = new Set();
  const queue = [...entries];
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

  const entry = Object.keys(result.metafile.outputs).find(
    (path) => basename(result.metafile.outputs[path].entryPoint ?? '') === `${name}-size-entry.mjs`,
  );
  if (entry === undefined) {
    failures.push(`${name}: no entry chunk in the metafile`);
    continue;
  }
  const eagerNames = staticChunks(result.metafile, [entry]);
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
  if (budget.lazyFeatures) {
    // Follow each feature's static dependency closure. Shared lazy dependencies
    // count against each feature that downloads them, never disappear from the
    // ratchet, and do not let a new feature consume the existing MCP allowance.
    const accounted = new Set();
    const groups = {
      mcp: {
        entryPoint: budget.legacyLazyEntryPoint,
        maxRawBytes: budget.maxLazyRawBytes,
        maxGzipBytes: budget.maxLazyGzipBytes,
      },
      ...budget.lazyFeatures,
    };
    for (const [feature, limits] of Object.entries(groups)) {
      const roots = Object.entries(result.metafile.outputs)
        .filter(([, output]) => {
          const input = output.entryPoint && basename(output.entryPoint);
          return (
            input &&
            (input.startsWith(`${limits.entryPoint}-`) || input === `${limits.entryPoint}.ts`)
          );
        })
        .map(([path]) => path);
      if (roots.length === 0 || roots.some((path) => eagerNames.has(basename(path)))) {
        failures.push(`${name}/${feature}: expected optional entry is missing or became eager`);
        continue;
      }
      const names = staticChunks(result.metafile, roots);
      const files = lazyFiles.filter((file) => names.has(basename(file.path)));
      for (const file of files) accounted.add(file.path);
      const measured = size(files.map((file) => Buffer.from(file.contents)));
      console.log(
        `${name} (${feature} lazy): ${measured.raw} B raw / ${measured.gzip} B gzip (limits ${limits.maxRawBytes} / ${limits.maxGzipBytes})`,
      );
      if (measured.raw > limits.maxRawBytes)
        failures.push(`${name}/${feature}: lazy raw ${measured.raw} > ${limits.maxRawBytes}`);
      if (measured.gzip > limits.maxGzipBytes)
        failures.push(`${name}/${feature}: lazy gzip ${measured.gzip} > ${limits.maxGzipBytes}`);
    }
    for (const file of lazyFiles) {
      if (!accounted.has(file.path))
        failures.push(`${name}: unbudgeted optional chunk ${basename(file.path)}`);
    }
  } else if (lazyFiles.length > 0) {
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
    } else failures.push(`${name}: optional chunks have no size budget`);
  }
}

if (failures.length > 0) {
  console.error(`Bundle size regression:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Bundle size budgets passed.');
}
