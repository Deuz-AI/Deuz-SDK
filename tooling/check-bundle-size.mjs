import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'tooling/bundle-size-budgets.json'), 'utf8'));
const failures = [];

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
  const output = Buffer.concat(result.outputFiles.map((file) => Buffer.from(file.contents)));
  const raw = output.byteLength;
  const gzip = gzipSync(output, { level: 9 }).byteLength;
  console.log(
    `${name}: ${raw} B raw / ${gzip} B gzip (limits ${budget.maxRawBytes} / ${budget.maxGzipBytes})`,
  );
  if (raw > budget.maxRawBytes) failures.push(`${name}: raw ${raw} > ${budget.maxRawBytes}`);
  if (gzip > budget.maxGzipBytes) failures.push(`${name}: gzip ${gzip} > ${budget.maxGzipBytes}`);
}

if (failures.length > 0) {
  console.error(`Bundle size regression:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Bundle size budgets passed.');
}
