import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenBuiltins = /(?:from\s*|import\s*\(|require\s*\()\s*["']node:/;

const consumers = [
  {
    name: 'root',
    source: "export { streamChat, generateText, createClient, DeuzError } from '@deuz-sdk/core';",
  },
  {
    name: 'edge',
    source:
      "export { streamChat, generateObject, createApprovalSigner } from '@deuz-sdk/core/edge';",
  },
  {
    name: 'provider',
    source:
      "export { createAnthropic } from '@deuz-sdk/core/anthropic'; export { createOpenAIResponses } from '@deuz-sdk/core/openai';",
  },
];

const failures = [];
for (const consumer of consumers) {
  try {
    const result = await build({
      stdin: {
        contents: consumer.source,
        loader: 'js',
        resolveDir: root,
        sourcefile: `${consumer.name}-consumer.mjs`,
      },
      bundle: true,
      conditions: ['browser', 'import', 'default'],
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      platform: 'browser',
      target: ['es2022'],
      treeShaking: true,
      write: false,
    });
    const output = result.outputFiles?.map((file) => file.text).join('\n') ?? '';
    if (forbiddenBuiltins.test(output)) {
      failures.push(`${consumer.name}: bundled output references a node: builtin`);
    }
    const nodeOnlyInput = Object.keys(result.metafile?.inputs ?? {}).find((input) =>
      /(?:rag-node|memory-markdown|skills[\\/]node|mcp[\\/]stdio|node[\\/](?:observe|chat-store|workspace|compute|browser|runtime))/.test(
        input,
      ),
    );
    if (nodeOnlyInput) failures.push(`${consumer.name}: reached node-only input ${nodeOnlyInput}`);
  } catch (error) {
    failures.push(
      `${consumer.name}: browser bundle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

for (const entry of ['dist/index.js', 'dist/edge.js']) {
  const source = readFileSync(resolve(root, entry), 'utf8');
  if (forbiddenBuiltins.test(source)) failures.push(`${entry}: directly imports a node: builtin`);
}

if (failures.length > 0) {
  console.error(`Runtime compatibility failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Runtime compatibility passed (${consumers.length} browser/edge consumers).`);
}
