/**
 * The rollback acceptance test (2.4 spec §4.2, §4.6, §5.3):
 * `npm run test:rollback -w @deuz-sdk/core`.
 *
 * The published `@deuz-sdk/core@2.3.0`, installed from npm into a scratch
 * directory outside the repo, must open the SQLite file and the Postgres
 * schema a 2.4 worker wrote and carry on with its legacy work there, as in a
 * rolling upgrade or a rollback that stops the 2.4 workers and keeps their
 * tables:
 *
 *   1. The current code writes, beside the 2.3 stores' tables, every kind of
 *      2.4 record, and into the 2.3 stores the legacy records a 2.4 worker
 *      writes, a native run suspended on its approval among them.
 *   2. A 2.3.0 worker (`legacy-smoke.mjs`, a child process) opens every 2.3
 *      store there, reads 2.4's legacy records, writes and reads its own,
 *      continues the legacy jobs 2.4 left, never lists a V3 run, refuses to
 *      resume or reconcile one without a model call, a tool call or a write,
 *      and runs its maintenance calls.
 *   3. The current code finds every 2.4 record as it left it, reads what 2.3
 *      left, continues the legacy run 2.3 suspended and the V3 run 2.3
 *      refused, and every schema version is where 2.3 needs it.
 *
 * The Postgres half needs DEUZ_TEST_POSTGRES_URL (it skips without it, and
 * fails without it under DEUZ_TEST_REQUIRE_SERVICES); it works in a schema of
 * its own and drops it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRecord } from '../../src/chat';
import type { EvolveCandidate, EvolveRunRecord } from '../../src/evolve/types';
import type { MemoryRecord } from '../../src/memory';
import type { SqliteDatabaseLike } from '../../src/node/store-sqlite';
import type { AgentRunEnvelope } from '../../src/types/agent-run';
import type { BudgetStoreReservation, BudgetUsage } from '../../src/types/budget-store';
import type { RunRecord } from '../../src/types/runtime';
import type { AgentCheckpoint } from '../../src/types/session';
import type { SwarmEvent, SwarmSnapshot } from '../../src/types/swarm';
import { postgresUrl } from '../fixtures/services';
import {
  json,
  openCurrent,
  readLegacy,
  readModern,
  resumeLegacy,
  resumeV3,
  writeLegacy,
  writeModern,
  type Backend,
  type CurrentStores,
  type CurrentWrites,
} from './current-sdk';
import { LEGACY_CORE, installLegacyCore, type LegacyInstall } from './legacy-install';
import {
  BUDGET_KEY,
  BUDGET_LIMITS,
  MODERN,
  TENANT,
  USER,
  V3_RUN_IDS,
  legacyIds,
  legacyRecords,
} from './records';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../../..');
/** Throws here, failing the file, when Postgres is required and the URL is missing. */
const liveUrl = postgresUrl();
const BACKENDS: Backend['kind'][] = liveUrl ? ['sqlite', 'postgres'] : ['sqlite'];

const ids24 = legacyIds('24');
const ids23 = legacyIds('23');
const NOW = Date.now();

interface ErrorReport {
  name: string;
  message: string;
}

/** The legacy records under one writer's ids (`readLegacy` on either side). */
interface LegacyRead {
  memory: MemoryRecord | null;
  expiredMemory: MemoryRecord | null;
  memoryIds: string[];
  chat: ChatRecord | null;
  chatIds: string[];
  session: AgentCheckpoint | null;
  run: RunRecord | null;
  agentRunDone: AgentRunEnvelope | null;
  agentRunSuspended: AgentRunEnvelope | null;
  budget: BudgetUsage;
  swarm: SwarmSnapshot | null;
  evolve: { run: EvolveRunRecord | null; candidates: EvolveCandidate[] } | null;
}

/** A 2.3 resume or reconcile: what it did, and whether a model or a tool ran. */
interface Attempt {
  threw: ErrorReport | null;
  status?: string | null;
  output?: unknown;
  error?: ErrorReport | null;
  modelCalls: number;
  toolCalls: number;
}

/** What each step of the 2.3 worker (`legacy-smoke.mjs`) reports. */
interface StepValues {
  open: unknown;
  read24: LegacyRead;
  write23: {
    done: string;
    suspended: string;
    approvalId: string | null;
    lease: { key: string; owner: string } | null;
    claimed: boolean;
    reservation: BudgetStoreReservation;
  };
  read23: LegacyRead;
  contend: { lease24: unknown; claim24: boolean };
  continueRun: RunRecord;
  continueSwarm: { snapshot: SwarmSnapshot; events: SwarmEvent[] };
  continueEvolve: EvolveRunRecord;
  resume24: Attempt;
  listRuns: string[];
  refuseV3: Record<string, { resume: Attempt; reconcile: Attempt; stored: unknown }>;
  refuseV3Envelope: { resume: Attempt; reconcile: Attempt; saves: number };
  maintenance: {
    prunedRuns: number;
    sweptMemories: number;
    prunedSwarms: number;
    runsAfter: string[];
  };
  final24: LegacyRead;
  final23: LegacyRead;
  close: unknown;
}

/** One step of the 2.3 worker: its value, or the error it threw. */
type Step<T = unknown> = { ok: true; value: T } | { ok: false; error: ErrorReport };

/** Each 2.3 store's first call on a database whose 2.3 versions are one ahead: null, or its refusal. */
type Probe = Partial<Record<'pack' | 'ops' | 'budget' | 'swarm' | 'evolve', ErrorReport | null>>;

interface Report {
  package: { version: string; resolved: Record<string, string> };
  backends: Partial<Record<Backend['kind'], Partial<Record<keyof StepValues, Step>>>>;
  controls: Partial<Record<Backend['kind'], { probe?: Step<Probe>; close?: Step }>>;
}

interface BackendRun {
  backend: Backend;
  writes: CurrentWrites;
  /** The 2.4 view of 2.4's legacy records before 2.3 ran. */
  legacyBefore: unknown;
  /** Every 2.4 record before 2.3 ran. */
  modernBefore: Awaited<ReturnType<typeof readModern>>;
  /** The current code's stores, opened again after 2.3 ran. */
  after?: CurrentStores;
}

let install: LegacyInstall;
let work: string;
let pool: pg.Pool | undefined;
let report: Report;
const runs = new Map<Backend['kind'], BackendRun>();
/** The negative controls: databases whose 2.3 schema versions are one ahead. */
const controls = new Map<Backend['kind'], Backend>();
const schema = `deuz_r1_rollback_${NOW.toString(36)}`;
const controlSchema = `${schema}_control`;

/** The current code writes everything into one backend and closes its stores. */
async function prepare(backend: Backend): Promise<BackendRun> {
  const stores = openCurrent(backend);
  try {
    const legacyApprovalId = await writeLegacy(stores, NOW);
    const modern = await writeModern(stores);
    const writes = { legacyApprovalId, ...modern };
    return {
      backend,
      writes,
      legacyBefore: await readLegacy(stores, ids24),
      modernBefore: await readModern(stores, writes),
    };
  } finally {
    await stores.close();
  }
}

/**
 * The negative control: the 2.3 stores' schemas, created by the current code,
 * with every 2.3 version moved one ahead, as a 2.4 that raised them would leave
 * them. 2.3 must refuse to open them, or this test could not see such a change.
 */
async function prepareControl(backend: Backend): Promise<Backend> {
  const stores = openCurrent(backend);
  try {
    await stores.pack.chats.listChats(USER);
    await stores.ops.agentRuns.list();
    await stores.budget.usage(BUDGET_KEY);
    await stores.swarm.load({ scope: TENANT, runId: 'probe' });
    await stores.evolve?.loadRun({ scope: TENANT, runId: 'probe' });
  } finally {
    await stores.close();
  }
  if (backend.kind === 'sqlite') {
    const db = await openSqlite(backend.path);
    try {
      for (const table of Object.keys(SQLITE_23_VERSIONS))
        db.exec(`UPDATE ${table} SET version = version + 1 WHERE singleton = 1`);
      db.exec('PRAGMA user_version = 2');
    } finally {
      db.close();
    }
  } else {
    const at = backend.schema;
    await backend.pool.query(`UPDATE ${at}.deuz_meta SET value = '2' WHERE key = 'schema_version'`);
    for (const table of Object.keys(POSTGRES_23_VERSIONS))
      await backend.pool.query(
        `UPDATE ${at}.${table} SET version = version + 1 WHERE singleton = 1`,
      );
  }
  return backend;
}

/** Runs the 2.3 worker on every prepared backend and control. */
async function runLegacySmoke(): Promise<Report> {
  // In the scratch install, so `@deuz-sdk/core` resolves to 2.3.0, never to the workspace.
  const script = join(install.dir, 'legacy-smoke.mjs');
  copyFileSync(join(HERE, 'legacy-smoke.mjs'), script);
  const backends = [];
  for (const run of runs.values()) {
    const opened = openCurrent(run.backend);
    try {
      const target =
        run.backend.kind === 'sqlite'
          ? { kind: 'sqlite', path: run.backend.path }
          : { kind: 'postgres', url: liveUrl, schema: run.backend.schema };
      backends.push({
        ...target,
        legacyApprovalId: run.writes.legacyApprovalId,
        v3ApprovalId: run.writes.v3ApprovalId,
        v3Envelope: json(await opened.runsV3.load(MODERN.v3Suspended)),
      });
    } finally {
      await opened.close();
    }
  }
  const inputPath = join(work, 'input.json');
  const outputPath = join(work, 'output.json');
  writeFileSync(
    inputPath,
    JSON.stringify({
      tenant: TENANT,
      user: USER,
      budget: { key: BUDGET_KEY, limits: BUDGET_LIMITS },
      now: NOW,
      ids24,
      ids23,
      records23: legacyRecords('23', NOW),
      v3RunIds: V3_RUN_IDS,
      backends,
      controls: [...controls.values()].map((backend) =>
        backend.kind === 'sqlite'
          ? { kind: 'sqlite', path: backend.path }
          : { kind: 'postgres', url: liveUrl, schema: backend.schema },
      ),
    }),
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', script, inputPath, outputPath],
    { cwd: install.dir, env, encoding: 'utf8', timeout: 300_000, windowsHide: true },
  );
  if (child.status !== 0)
    throw new Error(
      `The 2.3 worker failed (${child.error?.message ?? `exit ${String(child.status)}`}):\n${child.stdout}\n${child.stderr}`,
    );
  return JSON.parse(readFileSync(outputPath, 'utf8')) as Report;
}

beforeAll(async () => {
  install = installLegacyCore();
  work = mkdtempSync(join(tmpdir(), 'deuz-rollback-run-'));
  runs.set('sqlite', await prepare({ kind: 'sqlite', path: join(work, 'rollback.db') }));
  controls.set('sqlite', await prepareControl({ kind: 'sqlite', path: join(work, 'control.db') }));
  if (liveUrl) {
    pool = new pg.Pool({ connectionString: liveUrl, max: 8 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE SCHEMA ${controlSchema}`);
    runs.set('postgres', await prepare({ kind: 'postgres', pool, schema }));
    controls.set(
      'postgres',
      await prepareControl({ kind: 'postgres', pool, schema: controlSchema }),
    );
  }
  report = await runLegacySmoke();
  for (const run of runs.values()) run.after = openCurrent(run.backend);
});

afterAll(async () => {
  try {
    for (const run of runs.values()) await run.after?.close();
    for (const name of [schema, controlSchema])
      if (pool) await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  } finally {
    await pool?.end();
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe(`the 2.3 worker is ${LEGACY_CORE.name}@${LEGACY_CORE.version} from npm`, () => {
  it('loads the published package from the scratch install, never the workspace', () => {
    expect(report.package.version).toBe(LEGACY_CORE.version);
    const inside = (dir: string, file: string) => {
      const path = relative(dir, file);
      return path !== '' && !path.startsWith('..') && !isAbsolute(path);
    };
    for (const [specifier, file] of Object.entries(report.package.resolved)) {
      expect(inside(install.dir, file), `${specifier}: ${file}`).toBe(true);
      expect(inside(REPO, file), `${specifier}: ${file}`).toBe(false);
    }
  });
});

/** The 2.3 version tables, at their 2.3.0 values (test/compat/schema-pins.test.ts). */
const SQLITE_23_VERSIONS = {
  deuz_ops_schema: 1,
  deuz_budget_schema: 1,
  deuz_swarm_schema: 2,
  deuz_evolve_schema: 1,
};

const POSTGRES_23_VERSIONS = {
  deuz_ops_schema: 1,
  deuz_budget_schema: 1,
  deuz_swarm_pg_schema: 1,
};

const SQLITE_VERSIONS = {
  ...SQLITE_23_VERSIONS,
  // The 2.4 stores' own version tables.
  deuz_vmem_schema: 1,
  deuz_runs_v3_schema: 1,
  deuz_goal_runtime_schema: 1,
  deuz_chat_conditional_schema: 1,
  deuz_stream_state_schema: 1,
  deuz_process_ops_schema: 1,
};

const POSTGRES_VERSIONS = {
  ...POSTGRES_23_VERSIONS,
  deuz_vmem_schema: 1,
  deuz_runs_v3_schema: 1,
  deuz_goal_runtime_schema: 1,
  deuz_chat_conditional_schema: 1,
  deuz_stream_state_schema: 1,
};

async function openSqlite(path: string): Promise<SqliteDatabaseLike> {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => SqliteDatabaseLike;
  };
  return new DatabaseSync(path);
}

async function schemaVersions(backend: Backend): Promise<Record<string, unknown>> {
  if (backend.kind === 'sqlite') {
    const db = await openSqlite(backend.path);
    try {
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'deuz%schema' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      const out: Record<string, unknown> = {
        user_version: (db.prepare('PRAGMA user_version').get() as { user_version: number })
          .user_version,
      };
      for (const table of tables)
        out[table] = (
          db.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as {
            version: number;
          }
        ).version;
      return out;
    } finally {
      db.close();
    }
  }
  const { rows } = await backend.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'deuz%schema' ORDER BY table_name",
    [backend.schema],
  );
  const out: Record<string, unknown> = {
    deuz_meta: (
      await backend.pool.query(
        `SELECT value FROM ${backend.schema}.deuz_meta WHERE key = 'schema_version'`,
      )
    ).rows[0]?.value,
  };
  for (const { table_name: table } of rows)
    out[table] = (
      await backend.pool.query(`SELECT version FROM ${backend.schema}.${table} WHERE singleton = 1`)
    ).rows[0]?.version;
  return out;
}

const legacyRunIds = [
  ids24.agentRunDone,
  ids24.agentRunSuspended,
  ids23.agentRunDone,
  ids23.agentRunSuspended,
].sort();

for (const kind of ['sqlite', 'postgres'] as const) {
  const enabled = BACKENDS.includes(kind);
  const suite = enabled ? describe : describe.skip;
  const label =
    kind === 'sqlite'
      ? 'SQLite: one file shared by every store'
      : `Postgres: one schema shared by every store${enabled ? '' : ' (DEUZ_TEST_POSTGRES_URL is not set)'}`;

  suite(label, () => {
    const run = () => runs.get(kind)!;
    const steps = () => report.backends[kind] ?? {};
    /** The value of a 2.3 step that must have succeeded. */
    const value = <K extends keyof StepValues>(name: K): StepValues[K] => {
      const result: Step | undefined = steps()[name];
      if (result === undefined) throw new Error(`The 2.3 worker never ran step ${name}`);
      if (!result.ok)
        throw new Error(`2.3 step ${name} failed: ${result.error.name}: ${result.error.message}`);
      return result.value as StepValues[K];
    };

    it('the current code wrote every kind of 2.4 record beside the 2.3 tables', () => {
      const modern = run().modernBefore;
      expect(modern.v3.runs).toMatchObject([
        { runId: MODERN.v3Suspended, version: 3, result: { status: 'suspended' } },
        { runId: MODERN.v3Done, version: 3, phase: 'terminal', result: { status: 'completed' } },
      ]);
      expect(modern.v3.list.map((summary) => summary.runId).sort()).toEqual([...V3_RUN_IDS].sort());
      // Content-addressed packages; the forget redacted the ones holding the forgotten record.
      const blobs = modern.v3.blobs.map(({ blob }) => blob.status);
      expect(blobs).toContain('found');
      expect(blobs).toContain('redacted');
      expect(modern.memory.history.map((revisions) => revisions.length)).toEqual([2, 1]);
      expect(modern.memory.forgotten).toBeNull();
      expect(modern.memory.receipts).toEqual([
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
      ]);
      expect(modern.goals).toMatchObject({
        goal: { goalId: MODERN.goal },
        charged: { goalId: MODERN.chargedGoal },
        state: { goalId: MODERN.goal },
        schedule: { scheduleId: MODERN.schedule },
        intent: { intentId: MODERN.intent },
        watermark: { runId: MODERN.watermarkRun, tokens: 100 },
      });
      // The webhook delivery and the schedule's occurrence.
      expect(modern.goals.inbox.entries).toHaveLength(2);
      expect(modern.goals.occurrences?.occurrences).toHaveLength(1);
      expect(modern.chat).toMatchObject({
        live: { status: 'found' },
        projected: { status: 'found' },
        tombstoned: { status: 'deleted' },
      });
      expect(modern.chat.search.length).toBeGreaterThan(0);
      expect(modern.streams.lastSeq).toEqual([2, 0]);
      if (kind === 'sqlite')
        expect(modern.processOps?.record).toMatchObject({
          operationId: MODERN.processOperation,
          state: 'recorded',
        });
    });

    it('2.3 refuses a schema version it does not know, so this test would see a moved one', () => {
      const control = report.controls[kind];
      expect(control?.close?.ok).toBe(true);
      const probe = control?.probe;
      if (!probe?.ok) throw new Error(`the control probe failed: ${JSON.stringify(probe)}`);
      // The SQLite stores throw; the Postgres ones also refuse in the database (RAISE, P0001).
      const refused = (message: RegExp) =>
        expect.objectContaining({ message: expect.stringMatching(message) });
      expect(probe.value).toEqual(
        kind === 'sqlite'
          ? {
              // PRAGMA user_version is no gate: the 2.3 pack skips its migration at a newer
              // value and opens. test/compat/schema-pins.test.ts pins it all the same.
              pack: null,
              ops: refused(/^Unsupported SQLite ops schema version/),
              budget: refused(/^Unsupported SQLite budget schema version/),
              swarm: refused(/^Unsupported SQLite swarm schema version/),
              evolve: refused(/^Unsupported SQLite evolve schema version/),
            }
          : {
              pack: refused(/reports deuz schema_version 2, newer than the 1 /),
              ops: refused(/^Unsupported Postgres ops schema version 2/),
              budget: refused(/^Unsupported Postgres budget schema version 2/),
              swarm: refused(/^Unsupported Postgres swarm schema version 2/),
            },
      );
    });

    it('2.3 opens every one of its stores there, and closes them', () => {
      value('open');
      value('close');
      const failed = Object.entries(steps()).filter(([, result]) => !result.ok);
      expect(failed).toEqual([]);
    });

    it('2.3 reads the legacy records 2.4 wrote exactly as 2.4 reads them', () => {
      expect(value('read24')).toEqual(run().legacyBefore);
      const read = value('read24');
      // And they are what 2.4 wrote: the native runs as envelope version 1.
      const written = legacyRecords('24', NOW);
      expect(read.memory).toMatchObject(json(written.memory) as object);
      expect(read.chat).toMatchObject(json(written.chat) as object);
      expect(read.run).toMatchObject(json(written.run) as object);
      expect(read.session).toMatchObject({ version: 1, runId: ids24.session });
      expect(read.agentRunDone).toMatchObject({
        version: 1,
        phase: 'terminal',
        result: { status: 'completed', output: 'done by 2.4' },
      });
      // Version 2: a run suspended on an open tool turn, as 2.3 writes it (a 2.2 reader refuses it).
      expect(read.agentRunSuspended).toMatchObject({ version: 2, result: { status: 'suspended' } });
      expect(read.budget).toMatchObject({ tokens: 80, usd: 0.008 });
      expect(read.swarm?.run).toMatchObject({ runId: ids24.swarm.runId, status: 'running' });
      if (kind === 'sqlite') expect(read.evolve?.candidates).toHaveLength(1);
      // The legacy listings hold legacy records only.
      expect(read.memoryIds).toEqual([ids24.memory, ids24.expiredMemory].sort());
      expect(read.chatIds).toEqual([ids24.chat]);
    });

    it('2.3 writes its own legacy records there and reads them back', () => {
      const written = value('write23');
      expect(written).toMatchObject({
        done: 'completed',
        suspended: 'suspended',
        lease: { key: ids23.lease, owner: 'worker-23' },
        claimed: true,
        // Admitted against the same budget, which counts what 2.4 settled.
        reservation: { admitted: true, scopes: [{ key: BUDGET_KEY, tokens: 180, usd: 0.018 }] },
      });
      expect(written.approvalId).toEqual(expect.any(String));
      const read = value('read23');
      const records = legacyRecords('23', NOW);
      expect(read.memory).toMatchObject(json(records.memory) as object);
      expect(read.chat).toMatchObject(json(records.chat) as object);
      expect(read.run).toMatchObject(json(records.run) as object);
      expect(read.session).toMatchObject({ version: 1, runId: ids23.session });
      expect(read.agentRunDone).toMatchObject({ version: 1, result: { status: 'completed' } });
      expect(read.agentRunSuspended).toMatchObject({ version: 2, result: { status: 'suspended' } });
      expect(read.budget).toMatchObject({ tokens: 130, usd: 0.013 });
      expect(read.memoryIds).toEqual(
        [ids24.memory, ids24.expiredMemory, ids23.memory, ids23.expiredMemory].sort(),
      );
      expect(read.chatIds).toEqual([ids23.chat, ids24.chat].sort());
    });

    it('2.3 cannot take the lease or the claim 2.4 holds', () => {
      expect(value('contend')).toEqual({ lease24: null, claim24: false });
    });

    it('2.3 continues the legacy jobs 2.4 left: a suspended native run, a background run, a swarm', () => {
      // The 2.4-started run, resumed on its approval: one tool call, one model call.
      expect(value('resume24')).toEqual({
        threw: null,
        status: 'completed',
        output: 'a 2.3 model call',
        error: null,
        modelCalls: 1,
        toolCalls: 1,
      });
      expect(value('continueRun')).toMatchObject({ runId: ids24.run, status: 'completed' });
      const swarm = value('continueSwarm');
      expect(swarm.snapshot.run).toMatchObject({ status: 'completed' });
      expect(swarm.snapshot.tasks[0]).toMatchObject({
        status: 'completed',
        result: { output: 23 },
      });
      expect(swarm.events.map((event) => event.type)).toEqual([
        'run.started',
        'task.completed',
        'run.settled',
      ]);
      if (kind === 'sqlite') expect(value('continueEvolve')).toMatchObject({ generation: 0 });
    });

    it('2.3 never lists a V3 run, and refuses one without a model call, a tool call or a write', () => {
      expect(value('listRuns')).toEqual(legacyRunIds);
      // A 2.3 resume ends as a failed result, a 2.3 reconcile throws; neither runs anything.
      const refusal = (message: string | RegExp) => {
        const error = {
          name: 'TypeError',
          message: typeof message === 'string' ? message : expect.stringMatching(message),
        };
        return {
          resume: {
            threw: null,
            status: 'failed',
            output: null,
            error,
            modelCalls: 0,
            toolCalls: 0,
          },
          reconcile: { threw: error, modelCalls: 0, toolCalls: 0 },
        };
      };
      const refused = value('refuseV3');
      for (const runId of V3_RUN_IDS)
        expect(refused[runId]).toEqual({ ...refusal(/^Unknown native run: /), stored: null });
      // The V3 record itself: refused by its version, before anything runs or is saved.
      expect(value('refuseV3Envelope')).toEqual({
        ...refusal('Native checkpoint version, identity, or scope mismatch.'),
        saves: 0,
      });
    });

    it('2.3 maintenance touches only legacy records, and every 2.4 record is as 2.4 left it', async () => {
      expect(value('maintenance')).toEqual({
        // The two completed runs and the one 2.3 resumed; 2.3's suspended run stays.
        prunedRuns: 3,
        sweptMemories: 2,
        prunedSwarms: 0,
        runsAfter: [ids23.agentRunSuspended],
      });
      expect(await readModern(run().after!, run().writes)).toEqual(run().modernBefore);
    });

    it('2.4 reads what 2.3 left exactly as 2.3 does, and keeps out of its lease and claim', async () => {
      const stores = run().after!;
      expect(await readLegacy(stores, ids24)).toEqual(value('final24'));
      expect(await readLegacy(stores, ids23)).toEqual(value('final23'));
      expect(
        await stores.ops.leases.acquire({ key: ids23.lease, owner: 'worker-24', ttlMs: 60_000 }),
      ).toBeUndefined();
      expect(await stores.ops.claims(ids23.claim)).toBe(false);
    });

    it('2.4 continues the legacy run 2.3 suspended', async () => {
      const outcome = await resumeLegacy(
        run().after!,
        ids23.agentRunSuspended,
        value('write23').approvalId!,
      );
      expect(outcome).toMatchObject({
        result: { status: 'completed', output: 'resumed by 2.4' },
        modelCalls: 1,
        toolCalls: 1,
      });
      expect(await run().after!.ops.agentRuns.load(ids23.agentRunSuspended)).toMatchObject({
        version: 1,
        phase: 'terminal',
      });
    });

    it('2.4 continues the V3 run 2.3 refused (it waited for a compatible worker)', async () => {
      const stores = run().after!;
      const outcome = await resumeV3(stores, run().writes.v3ApprovalId);
      expect(outcome).toMatchObject({
        result: { status: 'completed', output: 'deployed after approval' },
        modelCalls: 1,
        toolCalls: 1,
      });
      expect(await stores.runsV3.load(MODERN.v3Suspended)).toMatchObject({
        version: 3,
        phase: 'terminal',
      });
    });

    it('no schema version moved: 2.3 keeps its own, each 2.4 store has its own', async () => {
      const backend = run().backend;
      expect(await schemaVersions(backend)).toEqual(
        backend.kind === 'sqlite'
          ? { user_version: 1, ...SQLITE_VERSIONS }
          : { deuz_meta: '1', ...POSTGRES_VERSIONS },
      );
    });
  });
}
