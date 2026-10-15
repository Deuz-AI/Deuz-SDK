/**
 * The 2.3 side of the rollback test (2.4 spec §4.2): a 2.3.0 worker on the
 * databases a 2.4 worker wrote. `rollback.spec.ts` copies this file into the
 * scratch install of `@deuz-sdk/core@2.3.0` (`legacy-install.ts`) and runs it
 * there with Node, so every bare `@deuz-sdk/core` import below loads the
 * published 2.3.0 through its own `exports` map.
 *
 *   node legacy-smoke.mjs <input.json> <output.json>
 *
 * On each backend it opens every 2.3 store (the memory, chat, session and run
 * pack; ops; budget; swarm; evolve on SQLite), reads the legacy records the
 * 2.4 code wrote, writes and reads its own, continues the legacy jobs 2.4
 * left (a suspended native run, a swarm, an evolve run, a background run),
 * lists the native runs, tries to resume and reconcile the V3 runs, and runs
 * the 2.3 maintenance calls. It asserts nothing itself: every step's value,
 * or its error, goes to the output file, and the spec checks them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { generateText } from '@deuz-sdk/core';
import { reconcileAgentRun, resumeAgent, runAgent } from '@deuz-sdk/core/agent';
import { createSqlitePopulationStore } from '@deuz-sdk/core/evolve/sqlite';
import { createPostgresBudgetStore, createPostgresOpsStore } from '@deuz-sdk/core/ops/postgres';
import { createSqliteBudgetStore, createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createPostgresStores } from '@deuz-sdk/core/stores/postgres';
import { createSqliteStores } from '@deuz-sdk/core/stores/sqlite';
import { createPostgresSwarmStore } from '@deuz-sdk/core/swarm/postgres';
import { createSqliteSwarmStore } from '@deuz-sdk/core/swarm/sqlite';
import { createMockModel } from '@deuz-sdk/core/testing';

const [inputPath, outputPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const TENANT = input.tenant;
const USER = input.user;
const MINUTE = 60_000;
const parameters = { type: 'object', properties: {} };

/** Which file each import resolved to, and the version of the package it loaded. */
function loadedPackage() {
  const resolved = {};
  for (const specifier of [
    '@deuz-sdk/core',
    '@deuz-sdk/core/agent',
    '@deuz-sdk/core/ops/sqlite',
    '@deuz-sdk/core/stores/postgres',
    'pg',
  ])
    resolved[specifier] = fileURLToPath(import.meta.resolve(specifier));
  const manifest = fileURLToPath(import.meta.resolve('@deuz-sdk/core/package.json'));
  return { version: JSON.parse(readFileSync(manifest, 'utf8')).version, resolved };
}

const describeError = (error) => ({
  name: error?.name ?? typeof error,
  message: String(error?.message ?? error),
  ...(error?.code !== undefined ? { code: error.code } : {}),
});

/** Runs one step; its value (as JSON) or its error goes to the report. */
async function step(steps, name, run) {
  try {
    const value = await run();
    steps[name] = {
      ok: true,
      value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
    };
    return value;
  } catch (error) {
    steps[name] = { ok: false, error: describeError(error) };
    return undefined;
  }
}

/** A mock model whose `calls` counts the model calls it answered (one `responses` read per call). */
function countingModel(responses) {
  const counter = { calls: 0 };
  const model = createMockModel({
    get responses() {
      counter.calls += 1;
      return responses;
    },
  });
  return { model, counter };
}

/** A tool behind an approval; `calls` counts its executions. */
function gateTool() {
  const gate = {
    calls: 0,
    tool: {
      description: 'Deploy, once a human approved it.',
      parameters,
      needsApproval: true,
      execute: () => {
        gate.calls += 1;
        return 'deployed';
      },
    },
  };
  return gate;
}

/** Every 2.3 store on the backend, opened the way a 2.3 worker opens it. */
function openLegacy(backend) {
  if (backend.kind === 'sqlite') {
    const { path } = backend;
    const pack = createSqliteStores({ path });
    const ops = createSqliteOpsStore({ path });
    const budget = createSqliteBudgetStore({ path });
    const swarm = createSqliteSwarmStore({ path });
    const evolve = createSqlitePopulationStore({ path });
    return {
      pack,
      ops,
      budget,
      swarm,
      evolve,
      async close() {
        for (const store of [pack, ops, budget, swarm, evolve]) await store.close();
      },
    };
  }
  const client = new pg.Pool({ connectionString: backend.url, max: 4 });
  const { schema } = backend;
  const pack = createPostgresStores({ client, schema });
  return {
    pack,
    ops: createPostgresOpsStore({ client, schema }),
    budget: createPostgresBudgetStore({ client, schema }),
    swarm: createPostgresSwarmStore({ client, schema }),
    evolve: undefined,
    async close() {
      await pack.close();
      await client.end();
    },
  };
}

/** The legacy records under `ids`, in the shape `current-sdk.ts` `readLegacy` reads them. */
async function readLegacy(stores, ids) {
  const { pack, ops } = stores;
  return {
    memory: await pack.memory.get(ids.memory),
    expiredMemory: await pack.memory.get(ids.expiredMemory),
    memoryIds: (await pack.memory.list(USER)).map((record) => record.id).sort(),
    chat: await pack.chats.loadChat(ids.chat),
    chatIds: [...(await pack.chats.listChats(USER))].sort(),
    session: await pack.sessions.load(ids.session),
    run: await pack.runs.get(ids.run),
    agentRunDone: await ops.agentRuns.load(ids.agentRunDone),
    agentRunSuspended: await ops.agentRuns.load(ids.agentRunSuspended),
    budget: await stores.budget.usage(input.budget.key, { byModel: true }),
    swarm: await stores.swarm.load(ids.swarm),
    evolve: stores.evolve
      ? {
          run: await stores.evolve.loadRun(ids.evolve),
          candidates: await stores.evolve.listCandidates(ids.evolve),
        }
      : null,
  };
}

/** Writes what a 2.3 worker writes; returns the approval its suspended run waits for. */
async function writeLegacy(stores, ids, records) {
  const { pack, ops } = stores;
  await pack.memory.upsert([records.memory, records.expiredMemory]);
  await pack.chats.saveChat(records.chat);
  await pack.runs.create(records.run);
  await generateText({
    model: createMockModel({
      responses: [{ toolCalls: [{ toolName: 'lookup', args: {} }] }, { text: 'found it' }],
    }),
    prompt: 'Look it up',
    tools: { lookup: { parameters, execute: async () => 'tea' } },
    maxSteps: 2,
    session: { store: pack.sessions, runId: ids.session },
  });
  const done = await runAgent({
    model: createMockModel({ responses: [{ text: 'done by 2.3' }] }),
    prompt: 'Say done',
    session: { store: ops.agentRuns, runId: ids.agentRunDone, scope: TENANT },
  });
  const suspended = await runAgent({
    model: createMockModel({
      responses: [{ toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] }],
    }),
    prompt: 'Deploy',
    tools: { gate: gateTool().tool },
    session: { store: ops.agentRuns, runId: ids.agentRunSuspended, scope: TENANT },
  });
  const lease = await ops.leases.acquire({
    key: ids.lease,
    owner: 'worker-23',
    ttlMs: 30 * MINUTE,
  });
  const claimed = await ops.claims(ids.claim);
  const reservation = await stores.budget.reserve({
    requestId: ids.budgetRequest,
    modelId: 'mock-model',
    tokens: 100,
    usd: 0.01,
    scopes: [{ key: input.budget.key, limits: input.budget.limits }],
  });
  await stores.budget.settle(ids.budgetRequest, { tokens: 50, usd: 0.005 });
  await stores.swarm.create(records.swarm, [{ type: 'run.started', timestamp: input.now }]);
  if (stores.evolve) {
    await stores.evolve.createRun(records.evolveRun);
    await stores.evolve.putCandidate(records.evolveCandidate);
  }
  return {
    done: done.status,
    suspended: suspended.status,
    approvalId: suspended.pendingApprovals?.[0]?.approvalId ?? null,
    lease: lease ? { key: lease.key, owner: lease.owner } : null,
    claimed,
    reservation,
  };
}

/** A 2.3 resume (or reconcile) of a run: what happened, and whether a model or tool ran. */
async function attempt(run) {
  const { model, counter } = countingModel([{ text: 'a 2.3 model call' }]);
  const gate = gateTool();
  try {
    const result = await run(model, gate.tool);
    return {
      threw: null,
      status: result?.status ?? null,
      output: result?.output ?? null,
      error: result?.error ? describeError(result.error) : null,
      modelCalls: counter.calls,
      toolCalls: gate.calls,
    };
  } catch (error) {
    return {
      threw: describeError(error),
      modelCalls: counter.calls,
      toolCalls: gate.calls,
    };
  }
}

async function smoke(backend) {
  const steps = {};
  const stores = await step(steps, 'open', async () => {
    const opened = openLegacy(backend);
    // The first call of each store opens (or migrates) its schema.
    await opened.pack.chats.listChats(USER);
    await opened.ops.agentRuns.list();
    await opened.budget.usage(input.budget.key);
    await opened.swarm.load({ scope: TENANT, runId: 'open-probe' });
    await opened.evolve?.loadRun({ scope: TENANT, runId: 'open-probe' });
    return opened;
  });
  if (!stores) return steps;
  const ids24 = input.ids24;
  const ids23 = input.ids23;
  try {
    // What 2.4 wrote into the 2.3 stores, before 2.3 changes anything.
    await step(steps, 'read24', () => readLegacy(stores, ids24));
    await step(steps, 'write23', () => writeLegacy(stores, ids23, input.records23));
    await step(steps, 'read23', () => readLegacy(stores, ids23));

    // Exclusive ownership 2.4 took holds against 2.3.
    await step(steps, 'contend', async () => ({
      lease24:
        (await stores.ops.leases.acquire({
          key: ids24.lease,
          owner: 'worker-23',
          ttlMs: MINUTE,
        })) ?? null,
      claim24: await stores.ops.claims(ids24.claim),
    }));

    // The legacy jobs 2.4 left, continued by 2.3.
    await step(steps, 'continueRun', async () => {
      await stores.pack.runs.update(ids24.run, { status: 'completed', updatedAt: input.now + 1 });
      return stores.pack.runs.get(ids24.run);
    });
    await step(steps, 'continueSwarm', async () => {
      const snapshot = await stores.swarm.load(ids24.swarm);
      const task = snapshot.tasks[0];
      await stores.swarm.commit({
        ...ids24.swarm,
        expectedRevision: snapshot.run.revision,
        run: { status: 'completed', updatedAt: input.now + 1 },
        tasks: [{ ...task, status: 'completed', attempt: 1, result: { output: 23 } }],
        events: [
          { type: 'task.completed', taskId: task.task.id, timestamp: input.now + 1 },
          { type: 'run.settled', timestamp: input.now + 1 },
        ],
      });
      return {
        snapshot: await stores.swarm.load(ids24.swarm),
        events: await stores.swarm.readEvents(ids24.swarm, 0, 100),
      };
    });
    if (stores.evolve)
      await step(steps, 'continueEvolve', async () => {
        const run = await stores.evolve.loadRun(ids24.evolve);
        await stores.evolve.commitGeneration({
          ...ids24.evolve,
          expectedGeneration: run.generation,
          run: { ...run, generation: run.generation + 1, updatedAt: input.now + 1 },
        });
        return stores.evolve.loadRun(ids24.evolve);
      });
    await step(steps, 'resume24', () =>
      attempt((model, tool) =>
        resumeAgent({
          model,
          prompt: 'Deploy',
          tools: { gate: tool },
          session: { store: stores.ops.agentRuns, runId: ids24.agentRunSuspended, scope: TENANT },
          approvalResponses: [{ approvalId: backend.legacyApprovalId, approved: true }],
        }),
      ),
    );

    // The V3 runs: invisible to 2.3, and refused without a model or tool call.
    await step(steps, 'listRuns', async () =>
      (await stores.ops.agentRuns.list()).runs.map((run) => run.runId).sort(),
    );
    await step(steps, 'refuseV3', async () => {
      const out = {};
      for (const runId of input.v3RunIds) {
        const session = { store: stores.ops.agentRuns, runId, scope: TENANT };
        out[runId] = {
          resume: await attempt((model, tool) =>
            resumeAgent({
              model,
              prompt: 'Deploy',
              tools: { gate: tool },
              session,
              approvalResponses: [{ approvalId: backend.v3ApprovalId, approved: true }],
            }),
          ),
          reconcile: await attempt(() => reconcileAgentRun({ session })),
          stored: (await stores.ops.agentRuns.load(runId)) ?? null,
        };
      }
      return out;
    });
    // The V3 record itself, handed to a 2.3 resume through a store that serves it.
    await step(steps, 'refuseV3Envelope', async () => {
      const envelope = backend.v3Envelope;
      let saves = 0;
      const store = {
        load: async (runId) => (runId === envelope.runId ? structuredClone(envelope) : undefined),
        save: async () => {
          saves += 1;
        },
      };
      const session = { store, runId: envelope.runId, scope: envelope.scope };
      return {
        resume: await attempt((model, tool) =>
          resumeAgent({
            model,
            prompt: 'Deploy',
            tools: { gate: tool },
            session,
            approvalResponses: [{ approvalId: backend.v3ApprovalId, approved: true }],
          }),
        ),
        reconcile: await attempt(() => reconcileAgentRun({ session })),
        saves,
      };
    });

    // 2.3 maintenance on the shared database.
    await step(steps, 'maintenance', async () => ({
      prunedRuns: await stores.ops.agentRuns.prune(Date.now() + MINUTE),
      sweptMemories: await stores.pack.sweepExpiredMemories(),
      prunedSwarms: await stores.swarm.prune({ before: 0 }),
      runsAfter: (await stores.ops.agentRuns.list()).runs.map((run) => run.runId).sort(),
    }));

    // Where 2.3 leaves both sets of records, for the 2.4 side to read the same.
    await step(steps, 'final24', () => readLegacy(stores, ids24));
    await step(steps, 'final23', () => readLegacy(stores, ids23));
  } finally {
    await step(steps, 'close', () => stores.close());
  }
  return steps;
}

const report = { package: loadedPackage(), backends: {} };
for (const backend of input.backends) report.backends[backend.kind] = await smoke(backend);
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
