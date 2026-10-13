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
  {
    name: 'native-agent',
    source: `export {
      runAgent, streamAgent, resumeAgent, resumeStreamAgent,
      createAgent, createInMemoryAgentRunStore, createExecutionContext,
      createBudgetLedger, BudgetLedgerError, ExecutionPolicyError,
      ExecutionPersistenceError
    } from '@deuz-sdk/core/agent';`,
  },
  {
    name: 'native-swarm',
    source: `export { createSwarm, createInMemorySwarmStore, SwarmConflictError }
      from '@deuz-sdk/core/swarm';`,
  },
  {
    name: 'ops',
    source: `export { createInMemoryLeaseProvider, findStaleAgentRuns, agentRunLeaseKey }
      from '@deuz-sdk/core/ops';`,
  },
  {
    name: 'goal',
    source: `export { createGoal, transitionGoal, assessGoal, parseGoal, serializeGoal,
      createGoalEvent, goalEventFromOccurrence, goalEventFromSignal, goalWakeupEvent,
      createInMemoryGoalStore, GoalError } from '@deuz-sdk/core/goal';`,
  },
  {
    name: 'evolve',
    source: `export { evolve, resumeEvolve, createInMemoryPopulationStore, applySearchReplace }
      from '@deuz-sdk/core/evolve';`,
  },
  {
    name: 'schedule',
    source: `export { createScheduler, parseCron, handleSignal, verifyGitHubWebhook }
      from '@deuz-sdk/core/schedule';`,
  },
  {
    name: 'budget-store',
    source: "export { createInMemoryBudgetStore, BudgetStoreError } from '@deuz-sdk/core/agent';",
  },
  {
    name: 'mcp-server',
    source: "export { createMcpServer } from '@deuz-sdk/core/mcp/server';",
  },
  {
    name: 'realtime',
    source: `export { createRealtimeSession, createOpenAIRealtime, createGeminiLive,
      createOpenAIClientSecret, createGeminiAuthToken, realtimePriceTable, RealtimeError }
      from '@deuz-sdk/core/realtime';`,
  },
  {
    name: 'batch',
    source:
      "export { createBatchClient, createMemoryBatchJobStore, BatchError } from '@deuz-sdk/core/batch';",
  },
  {
    name: 'a2a',
    source: `export { createA2AClient, fetchAgentCard, createA2AHandler, createInMemoryA2ATaskStore,
      createA2AAgentExecutor, a2aText, A2AError } from '@deuz-sdk/core/a2a';`,
  },
  {
    name: 'testing',
    source:
      "export { createMockModel, runEval, runGradedEval, runEvalSuite } from '@deuz-sdk/core/testing';",
  },
];

function browserBundle(consumer) {
  return build({
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
}

function nodeOnlyReferences(result) {
  const issues = [];
  const output = result.outputFiles?.map((file) => file.text).join('\n') ?? '';
  if (forbiddenBuiltins.test(output)) issues.push('bundled output references a node: builtin');
  const nodeOnlyInput = Object.keys(result.metafile?.inputs ?? {}).find((input) =>
    /(?:rag-node|memory-markdown|skills[\\/]node|mcp[\\/](?:server[\\/])?stdio|swarm[\\/](?:sqlite|postgres|redis)|ops[\\/](?:sqlite|postgres|redis)|evolve[\\/]sqlite|node[\\/](?:observe|chat-store|workspace|compute|browser|runtime|vertex-auth|mcp|store-sqlite|store-redis|store-postgres|swarm-sqlite|swarm-postgres|swarm-redis|ops-sqlite|ops-postgres|ops-redis|budget-sqlite|budget-postgres|redis-budget|redis-scripts|evolve-sqlite|headless))/.test(
      input,
    ),
  );
  if (nodeOnlyInput) issues.push(`reached node-only input ${nodeOnlyInput}`);
  return issues;
}

const failures = [];
for (const consumer of consumers) {
  try {
    const result = await browserBundle(consumer);
    failures.push(...nodeOnlyReferences(result).map((issue) => `${consumer.name}: ${issue}`));
  } catch (error) {
    failures.push(
      `${consumer.name}: browser bundle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Negative controls: the Node-only store entries must never qualify as web-safe.
// A bundler rejection or a detected Node reference both enforce this boundary.
// The Postgres entries import no node: builtin themselves (the client is
// injected), so for them the node-only input regex above is the guard.
const nodeOnlyEntries = [
  ['swarm/sqlite', 'createSqliteSwarmStore'],
  ['swarm/postgres', 'createPostgresSwarmStore'],
  ['ops/sqlite', 'createSqliteOpsStore, createSqliteBudgetStore'],
  ['ops/postgres', 'createPostgresOpsStore, createPostgresBudgetStore'],
  ['ops/redis', 'createRedisOpsStore, createRedisBudgetStore'],
  ['swarm/redis', 'createRedisSwarmStore'],
  ['evolve/sqlite', 'createSqlitePopulationStore'],
  ['mcp/server/stdio', 'serveMcpStdio'],
  ['headless', 'runHeadless, resumeHeadless, inspectRun, doctor, loadProjectInstructions'],
];
for (const [subpath, names] of nodeOnlyEntries) {
  try {
    const result = await browserBundle({
      name: `node-only-${subpath.replace('/', '-')}`,
      source: `export { ${names} } from '@deuz-sdk/core/${subpath}';`,
    });
    if (nodeOnlyReferences(result).length === 0) {
      failures.push(`${subpath}: Node-only entry unexpectedly passed the browser boundary`);
    }
  } catch {
    // Expected: browser resolvers normally reject the lazy node:sqlite import.
  }
}

for (const entry of [
  'dist/index.js',
  'dist/edge.js',
  'dist/agent.js',
  'dist/swarm.js',
  'dist/ops.js',
  'dist/evolve.js',
  'dist/schedule.js',
  'dist/realtime.js',
  'dist/mcp/server.js',
  'dist/goal.js',
  'dist/batch.js',
  'dist/a2a.js',
  'dist/testing.js',
]) {
  const source = readFileSync(resolve(root, entry), 'utf8');
  if (forbiddenBuiltins.test(source)) failures.push(`${entry}: directly imports a node: builtin`);
}

if (failures.length > 0) {
  console.error(`Runtime compatibility failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Runtime compatibility passed (${consumers.length} browser/edge consumers; ${nodeOnlyEntries.length} Node-only store entries excluded).`,
  );
}
