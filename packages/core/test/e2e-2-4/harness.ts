/**
 * The composite flow of spec §5.1, as a harness the core and React end-to-end
 * tests share: schedule → inbox → goal → V3 context and memory → an approved
 * tool and a Docker step → host crash → recovery → UI replay → host
 * verification → skill proposal. Offline: the model is a mock whose answer
 * depends only on the tool results in its request, so a model call repeated
 * after a crash answers the same.
 *
 * A host "process" is a set of store instances, a supervisor, a scheduler, a
 * Docker runner and a chat route over the persisted data (one SQLite file;
 * the local Postgres and Redis when their variables are set). Every store of
 * a process sits behind a kill switch: once the process crashes, each later
 * store call of that process throws `HostCrashed`, so nothing it does after
 * the crash point lands, as when the process dies, and the client's open
 * connections to it reset. A recovery opens fresh instances on the same data
 * after the crashed process settled and its connections were closed, and
 * moves the shared clock past the lease TTLs.
 *
 * The host's pieces are the ones an app would write: `publish_report` posts to
 * an external outbox once a human approves it (not idempotent: a repeat is a
 * second post); `run_report_job` builds the report in the Docker sandbox under
 * the operation id `<runId>:<toolCallId>` (declared `replay: 'idempotent'`:
 * the runner reconnects to the same operation instead of starting another).
 * The chat route records a verdict as the supervisor's resume intent before it
 * streams the run's next leg (durable mode), and its resume endpoint continues
 * an interrupted run as a new stream producer while it tails the journal.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createClient } from 'redis';
import { resumeStreamAgent } from '../../src/agent-run';
import {
  createDockerProcessRunner,
  createSqliteProcessOperationStore,
  type ProcessOperationRecord,
  type ProcessOperationStore,
  type ProcessReconcileReport,
  type ProcessRunner,
  type ProcessState,
} from '../../src/compute/docker';
import { createMemoryContextSource } from '../../src/context';
import {
  createDurableScheduler,
  createGoalSupervisor,
  createNativeRunLauncher,
  verifyGoalAcceptance,
  type DurableScheduler,
  type DurableSchedulerTickResult,
  type GoalArtifactResolver,
  type GoalRuntimeState,
  type GoalRuntimeStore,
  type GoalSupervisor,
  type GoalSupervisorTickResult,
  type GoalVerifier,
  type RunLauncher,
} from '../../src/goal/runtime';
import type { GoalCommand, GoalRecord } from '../../src/goal';
import { readConfig } from '../../src/internal/config-symbol';
import type { MemoryScope } from '../../src/memory';
import {
  createMemorySession,
  type MemoryForgetResult,
  type MemorySession,
  type VersionedMemoryStore,
} from '../../src/memory/versioned';
import { createPostgresGoalRuntimeStore } from '../../src/node/goal-runtime-postgres';
import { createSqliteGoalRuntimeStore } from '../../src/node/goal-runtime-sqlite';
import { createSqliteOpsStore } from '../../src/node/ops-sqlite';
import { createPostgresAgentRunStoreV3 } from '../../src/node/runs-v3-postgres';
import { createSqliteAgentRunStoreV3 } from '../../src/node/runs-v3-sqlite';
import { createPostgresDurableStreamStateStore } from '../../src/node/stream-state-postgres';
import { createRedisDurableStreamStateStore } from '../../src/node/stream-state-redis';
import { createSqliteDurableStreamStateStore } from '../../src/node/stream-state-sqlite';
import { createPostgresVersionedMemoryStore } from '../../src/node/vmem-postgres';
import { createSqliteVersionedMemoryStore } from '../../src/node/vmem-sqlite';
import { createMemoryObserver } from '../../src/observe';
import { createMockModel, type MockResponse } from '../../src/testing';
import type { AgentToolSet } from '../../src/types/agent-run';
import type {
  AgentRunEnvelopeV3,
  AgentRunOptionsV3,
  AgentRunStoreV3,
} from '../../src/types/agent-run-v3';
import type { Clock, Dependencies, Logger } from '../../src/types/deps';
import type { LeaseProvider } from '../../src/types/lease';
import type { LanguageModel } from '../../src/types/model';
import type { Message } from '../../src/types/message';
import type { ToolApprovalRequest, ToolApprovalResponse } from '../../src/types/tool';
import {
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
  type DurableStreamOptions,
  type DurableStreamStateStore,
} from '../../src/ui';
import {
  FAKE_ENGINE_IMAGE,
  buildFakeEngine,
  fakeEngine,
  type FakeEngineBundle,
} from './fake-engine';
import { dockerAvailable, dockerCommand, postgresUrl, redisUrl } from '../fixtures/services';

// ---------------------------------------------------------------------------
// The scenario's constants
// ---------------------------------------------------------------------------

/** 08:59 in Istanbul (UTC+3, no DST): the nightly schedule fires at 09:00. */
export const T0 = Date.parse('2026-10-15T05:59:00Z');
/** The 09:00 Istanbul occurrence. */
export const OCCURRENCE_AT = Date.parse('2026-10-15T06:00:00Z');
export const GOAL_ID = 'nightly-report';
export const RUN_ID = `${GOAL_ID}:run:1`;
export const SCHEDULE_ID = 'nightly';
export const REPORT_DATE = '2026-10-15';
export const REPORT_CONTENT = `nightly-report-${REPORT_DATE}`;
export const OBJECTIVE = 'Publish the nightly ops report';
export const PROMPT = 'Publish the nightly ops report for today and build its artifact.';
/** What the model writes to versioned memory (a model write: `inferred`). */
export const REMEMBERED = 'The nightly ops report for 2026-10-15 was requested by the schedule.';
/** Host memory the run's context retrieves (the query shares "ops" and "report"). */
export const CHANNEL_FACT = 'Ops reports are published to the ops channel.';
/** A record the operator forgets while the host is down. */
export const SECRET_FACT = 'The ops report webhook token is tok-SECRET-7731.';
export const SECRET_MARK = 'tok-SECRET-7731';
/** Another tenant's memory and goal: must never surface in tenant A's flow. */
export const OTHER_FACT = 'TENANT-B-ONLY ops report escalation list.';
export const OTHER_MARK = 'TENANT-B-ONLY';
export const FINAL_OK = 'The nightly ops report is published and its artifact is built.';
export const FINAL_FAILED = 'The nightly ops report could not be completed.';
/** The leases expire 30 s after their last renewal: recoveries move the clock past them. */
export const LEASE_TTL_MS = 30_000;
const PROCESS_ENDED: readonly ProcessState[] = [
  'exited',
  'failed',
  'cancelled',
  'lost',
  'needs-reconcile',
  'disposed',
];

// ---------------------------------------------------------------------------
// Clock, kill switch
// ---------------------------------------------------------------------------

/**
 * The flow's clock: its time moves only when the test says so (every process
 * and store reads it, so a lease expires exactly when a recovery moves it),
 * while its timers are real ones (coalescing windows, lease renewals and
 * polls fire as usual).
 */
export interface FlowClock extends Clock {
  advance(ms: number): void;
}

export function flowClock(start: number): FlowClock {
  let now = start;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    advance(ms) {
      now += ms;
    },
  };
}

/** What every store call of a crashed process throws. */
export class HostCrashed extends Error {
  constructor(process: string, where: string) {
    super(`host process ${process} crashed (${where})`);
    this.name = 'HostCrashed';
  }
}

interface Life {
  name: string;
  alive: boolean;
}

interface GuardHooks {
  /** Runs before a call; it may crash the process (the call then throws). */
  before?: (path: string, args: unknown[]) => void;
  /** Runs after a call resolved; it may crash the process (the caller then sees the crash). */
  after?: (path: string, args: unknown[], result: unknown) => void;
}

/**
 * The kill switch around a store: every method (nested objects such as
 * `runtime`, `inbox` or `embeddings` included) checks that the process is
 * alive first. Hooks place a crash before or right after a chosen call.
 */
function guard<T extends object>(target: T, life: Life, hooks: GuardHooks = {}, prefix = ''): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof key === 'symbol' || key === 'then') return value;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (!life.alive) throw new HostCrashed(life.name, path);
          hooks.before?.(path, args);
          if (!life.alive) throw new HostCrashed(life.name, path);
          const out: unknown = (value as (...a: unknown[]) => unknown).apply(object, args);
          if (
            out !== null &&
            typeof out === 'object' &&
            typeof (out as Promise<unknown>).then === 'function'
          )
            return (out as Promise<unknown>).then((result) => {
              hooks.after?.(path, args, result);
              if (!life.alive) throw new HostCrashed(life.name, path);
              return result;
            });
          return out;
        };
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return guard(value as object, life, hooks, path);
      return value;
    },
  });
}

// ---------------------------------------------------------------------------
// Docker: the real engine (DEUZ_TEST_DOCKER=1) or the fake CLI
// ---------------------------------------------------------------------------

/** The pinned alpine 3.20 digest the real-Docker tests use. */
export const PINNED_IMAGE =
  'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

/** What the flow knows about one operation's containers. */
export interface ContainerFacts {
  /** Containers labelled with the operation. */
  containers: number;
  /** How many times the container was started (fake), or 1/0 (real: running or exited). */
  starts: number;
  /** The real engine's `State.StartedAt`, to prove a restart never happened. */
  startedAt?: string;
  restartCount?: number;
}

export interface DockerHarness {
  kind: 'fake' | 'real';
  /** Spread into the runner's options. */
  options(): { image: string; dockerPath?: string; dockerArgs?: string[] };
  /** The argv that writes `report.txt` with `content` and prints `built`. */
  command(content: string): string[];
  facts(scope: string, operationId: string): ContainerFacts;
  /** Removes every container of `scope`. */
  removeAll(scope: string): void;
  dispose(): Promise<void>;
}

/** The fake CLI's bundle is built once per test file. */
let bundle: Promise<FakeEngineBundle> | undefined;

/** The Docker of this run: real when DEUZ_TEST_DOCKER=1 (failing if it does not answer), else the fake CLI. */
export async function dockerHarness(): Promise<DockerHarness> {
  if (dockerAvailable()) return realDocker();
  bundle ??= buildFakeEngine();
  const fake = await fakeEngine(await bundle);
  return {
    kind: 'fake',
    options: () => ({ image: FAKE_ENGINE_IMAGE, ...fake.cli }),
    // The fake runs a tiny op script: `write <path> <content>` then `echo`.
    command: (content) => ['sh', '-c', `write report.txt ${content} ; echo built`],
    facts(scope, operationId) {
      const mine = fake
        .containers()
        .filter(
          (c) => c.labels['deuz.operation-id'] === operationId && c.labels['deuz.scope'] === scope,
        );
      return {
        containers: mine.length,
        starts: mine.reduce((sum, c) => sum + c.startCount, 0),
      };
    },
    removeAll() {
      /* the fake daemon's state dies with its directory */
    },
    dispose: async () => {},
  };
}

/** Removes the fake CLI's bundle (call once per test file, after every flow). */
export async function disposeFakeDocker(): Promise<void> {
  if (!bundle) return;
  const built = await bundle;
  bundle = undefined;
  await built.cleanup();
}

function cli(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(dockerCommand(), args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function realDocker(): DockerHarness {
  const labelled = (scope: string, operationId?: string): string[] =>
    cli([
      'ps',
      '-a',
      '-q',
      '--no-trunc',
      '--filter',
      `label=deuz.scope=${scope}`,
      ...(operationId ? ['--filter', `label=deuz.operation-id=${operationId}`] : []),
    ])
      .stdout.split('\n')
      .map((id) => id.trim())
      .filter(Boolean);
  return {
    kind: 'real',
    options: () => ({ image: PINNED_IMAGE, dockerPath: dockerCommand() }),
    command: (content) => ['sh', '-c', `printf '%s' ${content} > report.txt && echo built`],
    facts(scope, operationId) {
      const ids = labelled(scope, operationId);
      if (ids.length !== 1) return { containers: ids.length, starts: ids.length };
      const info = JSON.parse(
        cli(['container', 'inspect', '--format', '{{json .}}', ids[0]!]).stdout,
      ) as { RestartCount: number; State: { StartedAt: string } };
      const started = !info.State.StartedAt.startsWith('0001-');
      return {
        containers: 1,
        starts: started ? 1 : 0,
        startedAt: info.State.StartedAt,
        restartCount: info.RestartCount,
      };
    },
    removeAll(scope) {
      const ids = labelled(scope);
      if (ids.length) cli(['rm', '-f', '-v', ...ids]);
      const volumes = cli(['volume', 'ls', '-q', '--filter', `label=deuz.scope=${scope}`])
        .stdout.split('\n')
        .map((id) => id.trim())
        .filter(Boolean);
      if (volumes.length) cli(['volume', 'rm', '-f', ...volumes]);
    },
    dispose: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export type Backend = 'sqlite' | 'postgres';

/** The backends this run covers: SQLite always, Postgres (and Redis for the stream) when set. */
export function flowBackends(): Backend[] {
  return postgresUrl() ? ['sqlite', 'postgres'] : ['sqlite'];
}

// ---------------------------------------------------------------------------
// The model: a stateless policy over the request's tool results
// ---------------------------------------------------------------------------

/** A Chat Completions request as the mock model receives it. */
export interface WireRequest {
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
}

export function wireText(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as { type?: string; text?: string }[])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}

/** The text of a whole request, every message. */
export const requestText = (request: WireRequest): string =>
  request.messages.map((message) => wireText(message)).join('\n');

function toolResults(request: WireRequest): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of request.messages)
    if (message.role === 'tool' && typeof message.tool_call_id === 'string')
      results.set(message.tool_call_id, wireText(message));
  return results;
}

/**
 * The run's model: remember a fact, ask to publish (gated), build the
 * artifact, then answer. Decided from the tool results the request carries,
 * with fixed tool call ids, so a repeated call answers the same.
 */
function decide(request: WireRequest): MockResponse {
  const results = toolResults(request);
  if (!results.has('mem-1'))
    return {
      toolCalls: [{ toolName: 'memory_remember', id: 'mem-1', args: { text: REMEMBERED } }],
    };
  if (!results.has('pub-1'))
    return {
      toolCalls: [
        { toolName: 'publish_report', id: 'pub-1', args: { channel: 'ops', date: REPORT_DATE } },
      ],
    };
  if (!/"published":true/.test(results.get('pub-1')!)) return { text: FINAL_FAILED };
  if (!results.has('job-1'))
    return {
      toolCalls: [{ toolName: 'run_report_job', id: 'job-1', args: { date: REPORT_DATE } }],
    };
  return { text: /"ok":true/.test(results.get('job-1')!) ? FINAL_OK : FINAL_FAILED };
}

/** A mock model answering through `answer(request)`; every request is logged. */
function policyModel(
  log: WireRequest[],
  answer: (request: WireRequest) => MockResponse,
): LanguageModel {
  const turn: MockResponse[] = [{ text: '' }];
  const model = createMockModel({ responses: turn });
  const config = readConfig(model)!;
  const base = config.fetch!;
  config.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest;
    log.push(request);
    turn[0] = answer(request);
    return base(input, init);
  }) as typeof fetch;
  return model;
}

/**
 * The skill proposal's model: a draft whose steps cite the first projection
 * items it was shown (`[S1]`, `[S2]`, ...), suggesting only `run_report_job`.
 */
export function proposalModel(log: WireRequest[]): LanguageModel {
  return policyModel(log, (request) => {
    const labels = [...requestText(request).matchAll(/\[(S\d+)\]/g)].map((match) => match[1]!);
    const cited = [...new Set(labels)];
    return {
      text: JSON.stringify({
        name: 'nightly-ops-report',
        description:
          'Publishes the nightly ops report after approval and builds its artifact in a sandbox. Use for the scheduled nightly report.',
        steps: [
          {
            text: 'Ask for approval, then publish the report to the ops channel.',
            sources: cited.slice(0, 2),
          },
          {
            text: 'Build the report artifact in the sandbox and check its digest.',
            sources: cited.slice(-1),
          },
        ],
        limitations: ['Seen for one nightly run only.'],
        allowedTools: ['run_report_job'],
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// The flow's shared state
// ---------------------------------------------------------------------------

/** One post in the external outbox. */
export interface OutboxPost {
  id: string;
  channel: string;
  date: string;
  runId: string;
  toolCallId: string;
  by: string;
}

/** A point where a process dies. */
export type CrashPoint =
  /** Right after the memory commit of the model's write, before its acknowledgment. */
  | 'memory-commit'
  /** On the store write that records the outcome of the Docker start (the start command was issued). */
  | 'docker-start-outcome'
  /** Right after `start-dispatched` is durable, before the start command. */
  | 'docker-start-dispatched'
  /** After the Docker artifact was read, before the tool's receipt. */
  | 'docker-artifact'
  /** After the outbox post, before the tool's receipt. */
  | 'publish-effect';

export interface FlowLog {
  process: string;
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface FlowEnv {
  backend: Backend;
  /** The goal's tenancy scope: unique per flow, so real containers never mix. */
  scope: string;
  memoryScope: MemoryScope;
  otherScope: string;
  otherMemoryScope: MemoryScope;
  dir: string;
  dbPath: string;
  pg?: { url: string; schema: string };
  redis?: { url: string; prefix: string };
  clock: FlowClock;
  observer: ReturnType<typeof createMemoryObserver>;
  docker: DockerHarness;
  outbox: OutboxPost[];
  /** Every request the run's model received, across processes. */
  requests: WireRequest[];
  logs: FlowLog[];
  /** Process names in order. */
  processes: string[];
  /** Processes not closed yet: disposing the flow closes them. */
  open: Set<HostProcess>;
}

let flows = 0;

/** A clean flow: a fresh SQLite file, a fresh Postgres schema and Redis prefix when set. */
export async function createFlowEnv(backend: Backend, docker: DockerHarness): Promise<FlowEnv> {
  const n = ++flows;
  const tag = `${process.pid.toString(36)}_${Date.now().toString(36)}_${n}`;
  const dir = await mkdtemp(join(tmpdir(), 'deuz-e1-'));
  const env: FlowEnv = {
    backend,
    scope: `e1-${tag}`,
    memoryScope: { userId: 'ada' },
    otherScope: `e1-other-${tag}`,
    otherMemoryScope: { userId: 'bob' },
    dir,
    dbPath: join(dir, 'host.db'),
    clock: flowClock(T0),
    observer: createMemoryObserver({ maxEvents: 500_000 }),
    docker,
    outbox: [],
    requests: [],
    logs: [],
    processes: [],
    open: new Set(),
  };
  if (backend === 'postgres') {
    const url = postgresUrl();
    if (!url) throw new Error('The postgres flow needs DEUZ_TEST_POSTGRES_URL');
    const schema = `e1_${tag}`;
    const setup = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await setup.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await setup.end();
    }
    env.pg = { url, schema };
    const redis = redisUrl();
    if (redis) env.redis = { url: redis, prefix: `e1-${tag}` };
  }
  return env;
}

/** Drops what the flow made: its containers, schema, stream keys and directory. */
export async function disposeFlowEnv(env: FlowEnv): Promise<void> {
  for (const proc of [...env.open]) await proc.close();
  env.docker.removeAll(env.scope);
  if (env.redis) {
    // Every key the flow's stream store wrote lives under its prefix.
    const client = createClient({ url: env.redis.url });
    await client.connect();
    try {
      for (const pattern of [`{${env.redis.prefix}:*`, `${env.redis.prefix}:*`])
        for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 500 }))
          if (keys.length) await client.unlink(keys);
    } finally {
      await client.quit();
    }
  }
  if (env.pg) {
    const pool = new pg.Pool({ connectionString: env.pg.url, max: 1 });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${env.pg.schema} CASCADE`);
    } finally {
      await pool.end();
    }
  }
  await rm(env.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---------------------------------------------------------------------------
// A host process
// ---------------------------------------------------------------------------

/** What the chat route's POST takes (the body `useChat` sends for a native run gate). */
export interface RouteBody {
  messages?: Message[];
  runId?: string;
  approvalResponses?: ToolApprovalResponse[];
  clientToolResults?: { toolCallId: string; output: unknown; isError?: boolean }[];
}

export type RunOptions = Omit<AgentRunOptionsV3<unknown>, 'session' | 'checkpointVersion'>;

/** The Docker tool's answer. */
export interface ReportJobResult {
  ok: boolean;
  operationId: string;
  path?: string;
  digest?: string;
  size?: number;
  stdout?: string;
  state?: ProcessState;
  error?: string;
}

export interface HostProcess {
  name: string;
  readonly alive: boolean;
  env: FlowEnv;
  deps: Dependencies;
  goals: GoalRuntimeStore;
  runs: AgentRunStoreV3;
  vmem: VersionedMemoryStore;
  operations: ProcessOperationStore;
  streams: DurableStreamStateStore;
  leases: LeaseProvider;
  /** Tenant A's memory session (its forgets redact this process's V3 packages). */
  memory: MemorySession;
  runner: ProcessRunner;
  launcher: RunLauncher;
  supervisor: GoalSupervisor;
  scheduler: DurableScheduler;
  runOptions(runId: string): RunOptions;
  /** The durable-mode stream options of this process. */
  durable(): DurableStreamOptions;
  route: {
    post(body: RouteBody, headers?: HeadersInit): Promise<Response>;
    resume(ctx: { lastEventId?: string; capabilities?: string }): Response;
  };
  /**
   * The host settles unknown effects itself (2.3 reconciliation): it resumes
   * the run with the results it found in the external system, streamed as a
   * new producer leg of the run's journal.
   */
  reconcileRun(results: { toolCallId: string; output: unknown }[]): Promise<void>;
  /** The host's acceptance check of a run: the `evaluate` command for the goal. */
  verifyGoal(goal: GoalRecord, runId: string): Promise<GoalCommand>;
  /** Dies at `point` the next time the flow reaches it. */
  arm(point: CrashPoint): void;
  /** Whether the process died at `point`. */
  crashedAt(): CrashPoint | 'manual' | undefined;
  crash(): void;
  /** Background work this process started (route legs); waits for all of it to end. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** The goal's artifact reference for an operation's file. */
export const artifactRef = (scope: string, operationId: string, path: string): string =>
  `process:${JSON.stringify([scope, operationId, path])}`;

function parseArtifactRef(ref: string): [string, string, string] | undefined {
  if (!ref.startsWith('process:')) return undefined;
  try {
    const parsed = JSON.parse(ref.slice('process:'.length)) as unknown;
    return Array.isArray(parsed) && parsed.length === 3
      ? (parsed as [string, string, string])
      : undefined;
  } catch {
    return undefined;
  }
}

/** The Docker tool's result in a run's canonical history. */
export function reportJobResult(messages: readonly Message[]): ReportJobResult | undefined {
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type: string; toolUseId?: string; result?: unknown }[])
      if (part.type === 'tool_result' && part.toolUseId === 'job-1') {
        const result = part.result;
        if (typeof result === 'string') {
          try {
            return JSON.parse(result) as ReportJobResult;
          } catch {
            return undefined;
          }
        }
        return result as ReportJobResult;
      }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The client's connection to a host process: when the process dies, the
 * connection resets (a transport error), as when a killed process takes its
 * sockets with it. Nothing the dying process still writes reaches the client,
 * not even the error frame a live producer that fails closed would send.
 */
function connection(life: Life, response: Response): Response {
  const source = response.body;
  if (!source) return response;
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (!life.alive) {
          controller.error(new TypeError(`connection reset: host process ${life.name} died`));
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Opens a host process on the flow's data. */
export function openProcess(env: FlowEnv, name: string): HostProcess {
  const life: Life = { name, alive: true };
  let armed: CrashPoint | undefined;
  let crashed: CrashPoint | 'manual' | undefined;
  const background = new Set<Promise<unknown>>();
  env.processes.push(name);
  const { clock, observer } = env;

  const die = (point: CrashPoint | 'manual'): void => {
    if (!life.alive) return;
    life.alive = false;
    crashed = point;
  };
  /** The crash armed at `point` happens now: the caller sees it. */
  const trip = (point: CrashPoint): void => {
    if (armed !== point || !life.alive) return;
    die(point);
    throw new HostCrashed(name, point);
  };

  const log =
    (level: string): Logger[keyof Logger] =>
    (message, fields) =>
      void env.logs.push({ process: name, level, message, ...(fields ? { fields } : {}) });
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  const deps: Dependencies = { clock, observer, logger };

  // --- the stores, behind the kill switch ---------------------------------
  const pool = env.pg ? new pg.Pool({ connectionString: env.pg.url, max: 8 }) : undefined;
  const schema = env.pg?.schema;
  const goalsInner = pool
    ? createPostgresGoalRuntimeStore({ pool, schema: schema!, clock })
    : createSqliteGoalRuntimeStore({ path: env.dbPath, clock });
  const runsInner = pool
    ? createPostgresAgentRunStoreV3({ pool, schema: schema! })
    : createSqliteAgentRunStoreV3({ path: env.dbPath, clock });
  const vmemInner = pool
    ? createPostgresVersionedMemoryStore({
        pool,
        schema: schema!,
        clock,
        observer,
        pgvector: 'off',
      })
    : createSqliteVersionedMemoryStore({ path: env.dbPath, clock, observer });
  const streamsInner = env.redis
    ? createRedisDurableStreamStateStore({ url: env.redis.url, prefix: env.redis.prefix })
    : pool
      ? createPostgresDurableStreamStateStore({ pool, schema: schema! })
      : createSqliteDurableStreamStateStore({ path: env.dbPath, clock });
  // A container lives on this host's daemon: process operations are SQLite only (spec §3.3).
  const operationsInner = createSqliteProcessOperationStore({ path: env.dbPath, clock });
  // The leases every process shares: one SQLite file, on the flow's clock.
  const opsInner = createSqliteOpsStore({ path: env.dbPath, clock });

  const goals = guard<GoalRuntimeStore>(goalsInner, life);
  const runs = guard<AgentRunStoreV3>(runsInner, life);
  const vmem = guard<VersionedMemoryStore>(vmemInner, life, {
    after(path, args) {
      const commit = args[0] as { actor?: string } | undefined;
      if (path === 'commit' && commit?.actor === 'model' && armed === 'memory-commit')
        die('memory-commit');
    },
  });
  let dispatched = false;
  const operations = guard<ProcessOperationStore>(operationsInner, life, {
    before(path) {
      if (path !== 'update') return;
      if (armed === 'docker-start-outcome' && dispatched) die('docker-start-outcome');
    },
    after(path, args) {
      if (path !== 'update') return;
      const changes = args[2] as { state?: ProcessState } | undefined;
      if (changes?.state === 'start-dispatched') {
        dispatched = true;
        if (armed === 'docker-start-dispatched') die('docker-start-dispatched');
      }
    },
  });
  const streams = guard<DurableStreamStateStore>(streamsInner, life);
  const leases = guard<LeaseProvider>(opsInner.leases, life);

  const proc = {} as HostProcess;
  const memory = createMemorySession({
    store: vmem,
    scope: env.memoryScope,
    onForget: (event) => runs.redactForgotten(event),
    deps,
  });
  const runner = createDockerProcessRunner({
    ...env.docker.options(),
    store: operations,
    scope: env.scope,
    deps,
  });
  const model = policyModel(env.requests, decide);

  function tools(runId: string): AgentToolSet {
    return {
      publish_report: {
        description: 'Publishes the nightly report to a channel. A human approves every post.',
        parameters: {
          type: 'object',
          properties: { channel: { type: 'string' }, date: { type: 'string' } },
          required: ['channel', 'date'],
        },
        needsApproval: true,
        execute: (args: unknown, context) => {
          const { channel, date } = args as { channel: string; date: string };
          const post: OutboxPost = {
            id: `post-${env.outbox.length + 1}`,
            channel,
            date,
            runId,
            toolCallId: context.toolCallId,
            by: name,
          };
          // The external effect: it happens here, whatever the host does next.
          env.outbox.push(post);
          trip('publish-effect');
          return { published: true, postId: post.id };
        },
      },
      run_report_job: {
        description: 'Builds the report artifact in the Docker sandbox.',
        parameters: {
          type: 'object',
          properties: { date: { type: 'string' } },
          required: ['date'],
        },
        // The runner reconnects to the same operation: a repeat starts nothing.
        replay: 'idempotent',
        execute: async (args: unknown, context): Promise<ReportJobResult> => {
          const { date } = args as { date: string };
          const operationId = `${runId}:${context.toolCallId}`;
          let session = await runner.start({
            operationId,
            scope: env.scope,
            command: env.docker.command(`nightly-report-${date}`),
          });
          // Polled at least once: the state the tool reports is the daemon's now.
          for (let i = 0; i < 600; i++) {
            session = await runner.poll(env.scope, operationId);
            if (PROCESS_ENDED.includes(session.state)) break;
            await sleep(50);
          }
          if (session.state !== 'exited' || session.exitCode !== 0)
            return {
              ok: false,
              operationId,
              state: session.state,
              ...(session.error ? { error: session.error.code ?? session.error.message } : {}),
            };
          const output = await runner.readOutput(env.scope, operationId);
          const artifact = await runner.readArtifact(env.scope, operationId, 'report.txt');
          trip('docker-artifact');
          return {
            ok: true,
            operationId,
            path: artifact.path,
            digest: artifact.digest,
            size: artifact.size,
            stdout: output.stdout.trim(),
          };
        },
      },
    };
  }

  /** The run's own verifier: the artifact it reported exists now with that digest. */
  async function verifyRun(messages: readonly Message[]) {
    const job = reportJobResult(messages);
    if (!job?.ok || !job.path || !job.digest)
      return { status: 'inconclusive' as const, reason: 'no report artifact' };
    const artifact = await runner
      .readArtifact(env.scope, job.operationId, job.path)
      .catch(() => undefined);
    if (artifact?.digest !== job.digest)
      return { status: 'inconclusive' as const, reason: 'the report artifact changed' };
    return { status: 'verified' as const };
  }

  function runOptions(runId: string): RunOptions {
    return {
      model,
      prompt: PROMPT,
      tools: tools(runId),
      versionedMemory: { session: memory, tools: true },
      context: { sources: [createMemoryContextSource({ session: memory })] },
      workingMemory: {
        create: {
          scope: env.scope,
          goal: OBJECTIVE,
          goalRef: { goalId: GOAL_ID, specGeneration: 1 },
          now: clock.now(),
        },
      },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
      verify: ({ messages }) => verifyRun(messages),
      deps,
    };
  }

  const launcher = createNativeRunLauncher({
    store: runs,
    options: (request) => runOptions(request.runId),
  });

  /** Resolves an artifact ref by reading the file from its stopped container now. */
  const resolver: GoalArtifactResolver = {
    async resolve(ref) {
      const parsed = parseArtifactRef(ref);
      if (!parsed || parsed[0] !== env.scope) return undefined;
      const artifact = await runner
        .readArtifact(parsed[0], parsed[1], parsed[2])
        .catch(() => undefined);
      return artifact ? { ref, kind: 'artifact', digest: artifact.digest } : undefined;
    },
  };
  /** The host's check of the report: its content names the day. */
  const reportVerifier: GoalVerifier = {
    id: 'nightly-report-verifier',
    version: '1',
    async verify({ artifact }) {
      const parsed = artifact && parseArtifactRef(artifact.ref);
      if (!parsed) return { verdict: 'inconclusive', summary: 'no artifact' };
      const file = await runner.readArtifact(parsed[0], parsed[1], parsed[2]);
      const text = new TextDecoder().decode(file.bytes);
      return text === REPORT_CONTENT
        ? { verdict: 'passed', summary: 'the report names the day' }
        : { verdict: 'failed', summary: 'unexpected report content' };
    },
  };

  /** The supervisor's verification of a completed run: acceptance by the artifact digest. */
  async function verifyGoal(context: { goal: GoalRecord; runId: string }): Promise<GoalCommand> {
    const envelope = await runs.load(context.runId);
    const job = reportJobResult(envelope?.messages ?? []);
    const ref =
      job?.ok && job.path ? artifactRef(env.scope, job.operationId, job.path) : `process:missing`;
    const verification = await verifyGoalAcceptance({
      goal: context.goal,
      runId: context.runId,
      now: clock.now(),
      verifiers: { artifact: reportVerifier },
      artifacts: {
        artifact: {
          ref,
          ...(job?.ok && job.digest ? { expectedDigest: job.digest as `sha256:${string}` } : {}),
        },
      },
      resolver,
    });
    return verification.command;
  }

  const supervisor = createGoalSupervisor({
    store: goals,
    launcher,
    lease: { provider: leases, owner: name, ttlMs: LEASE_TTL_MS },
    deps,
    verify: verifyGoal,
  });
  const scheduler = createDurableScheduler({ store: goals, deps });

  const durable = (): DurableStreamOptions => ({
    store: streams,
    lease: { provider: leases, owner: name, ttlMs: LEASE_TTL_MS },
    deps,
  });

  const track = <T>(work: Promise<T>): Promise<T> => {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    background.add(settled);
    void settled.finally(() => background.delete(settled));
    return work;
  };

  /** Reads a response body to its end: the producer keeps journaling whoever reads it. */
  async function drain(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  }

  let continuing: Promise<void> | undefined;
  /** Continues an interrupted run as a new stream producer, once per process at a time. */
  function continueRun(runId: string): Promise<void> {
    continuing ??= (async () => {
      const envelope = await runs.load(runId);
      const status = envelope?.result?.status;
      if (
        !envelope ||
        envelope.phase === 'terminal' ||
        status === 'suspended' ||
        status === 'stopped'
      )
        return;
      const stream = resumeStreamAgent({
        ...runOptions(runId),
        checkpointVersion: 3,
        session: { store: runs, runId, scope: env.scope },
      });
      await drain(
        toDeuzAgentStreamResponse(stream, {
          runId,
          streamId: runId,
          durable: durable(),
        }),
      );
      await stream.result.catch(() => undefined);
    })().finally(() => {
      continuing = undefined;
    });
    return continuing;
  }

  const route: HostProcess['route'] = {
    async post(body, headers) {
      const runId = body.runId;
      if (runId !== RUN_ID)
        return new Response('This chat resumes the goal run only.', { status: 400 });
      const approvalResponses = body.approvalResponses;
      // The verdict is accepted once it is durable: the supervisor's resume intent.
      await supervisor.resume(env.scope, GOAL_ID, {
        ...(approvalResponses ? { approvalResponses } : {}),
      });
      const stream = resumeStreamAgent({
        ...runOptions(runId),
        checkpointVersion: 3,
        session: { store: runs, runId, scope: env.scope },
        ...(approvalResponses ? { approvalResponses } : {}),
      });
      const response = toDeuzAgentStreamResponse(stream, {
        runId,
        streamId: runId,
        messageId: `${runId}:turn`,
        durable: durable(),
        capabilities: { request: new Headers(headers) },
      });
      void track(stream.result);
      return connection(life, response);
    },
    resume(ctx) {
      void track(continueRun(RUN_ID));
      return connection(
        life,
        resumeDeuzStreamResponse(streams, RUN_ID, {
          lastEventId: ctx.lastEventId ?? null,
          pollIntervalMs: 20,
          idleTimeoutMs: 120_000,
          ...(ctx.capabilities ? { capabilities: { request: ctx.capabilities } } : {}),
        }),
      );
    },
  };

  // `alive` stays a getter (Object.assign would copy its value once).
  Object.defineProperty(proc, 'alive', { get: () => life.alive, enumerable: true });
  Object.assign(proc, {
    name,
    env,
    deps,
    goals,
    runs,
    vmem,
    operations,
    streams,
    leases,
    memory,
    runner,
    launcher,
    supervisor,
    scheduler,
    runOptions,
    durable,
    route,
    async reconcileRun(results: { toolCallId: string; output: unknown }[]) {
      const stream = resumeStreamAgent({
        ...runOptions(RUN_ID),
        checkpointVersion: 3,
        session: { store: runs, runId: RUN_ID, scope: env.scope },
        reconciledToolResults: results,
      });
      await drain(
        toDeuzAgentStreamResponse(stream, { runId: RUN_ID, streamId: RUN_ID, durable: durable() }),
      );
      await stream.result;
    },
    verifyGoal: (goal: GoalRecord, runId: string) => verifyGoal({ goal, runId }),
    arm(point: CrashPoint) {
      armed = point;
      dispatched = false;
    },
    crashedAt: () => crashed,
    crash: () => die('manual'),
    async settle() {
      while (background.size > 0) await Promise.all([...background]);
    },
    async close() {
      die('manual');
      await proc.settle();
      env.open.delete(proc);
      const closers: (() => Promise<unknown> | undefined)[] = [
        () => goalsInner.close(),
        () => runsInner.close(),
        () => vmemInner.close(),
        () => streamsInner.close(),
        () => operationsInner.close(),
        () => opsInner.close(),
      ];
      for (const close of closers) await Promise.resolve(close()).catch(() => undefined);
      await pool?.end().catch(() => undefined);
    },
  } satisfies Partial<HostProcess>);
  env.open.add(proc);
  return proc;
}

// ---------------------------------------------------------------------------
// Host steps
// ---------------------------------------------------------------------------

/** Seeds host memory: the channel fact, the secret, and another tenant's record. */
export async function seedMemory(
  proc: HostProcess,
): Promise<{ channel: string; secret: string; other: string }> {
  const channel = await proc.memory.remember(
    { text: CHANNEL_FACT, supersede: 'add' },
    { operationId: 'seed-channel' },
  );
  const secret = await proc.memory.remember(
    { text: SECRET_FACT, supersede: 'add' },
    { operationId: 'seed-secret' },
  );
  const other = await createMemorySession({
    store: proc.vmem,
    scope: proc.env.otherMemoryScope,
    deps: proc.deps,
  }).remember({ text: OTHER_FACT, supersede: 'add' }, { operationId: 'seed-other' });
  return {
    channel: channel.records[0]!.id,
    secret: secret.records[0]!.id,
    other: other.records[0]!.id,
  };
}

/** Submits the goal without a run, waiting for the nightly schedule; and another tenant's goal. */
export async function submitGoal(proc: HostProcess): Promise<void> {
  const { env, supervisor } = proc;
  await supervisor.submit({
    goalId: GOAL_ID,
    scope: env.scope,
    objective: OBJECTIVE,
    criteria: [
      {
        id: 'artifact',
        description: 'The report artifact exists with the digest the run produced.',
      },
    ],
    specGeneration: 1,
    start: false,
  });
  await supervisor.command(env.scope, GOAL_ID, {
    type: 'wait',
    wait: {
      reason: 'event',
      source: { type: 'schedule', id: SCHEDULE_ID },
      note: 'the nightly run',
    },
  });
  await supervisor.submit({
    goalId: `${GOAL_ID}-other`,
    scope: env.otherScope,
    objective: 'Another tenant goal',
    specGeneration: 1,
    start: false,
  });
  await supervisor.command(env.otherScope, `${GOAL_ID}-other`, {
    type: 'wait',
    wait: { reason: 'user', note: 'never answered in this flow' },
  });
}

/** Puts the nightly schedule: 09:00 Europe/Istanbul. */
export async function putSchedule(proc: HostProcess) {
  return proc.scheduler.put({
    scheduleId: SCHEDULE_ID,
    scope: proc.env.scope,
    goalId: GOAL_ID,
    spec: { cron: '0 9 * * *', timezone: 'Europe/Istanbul' },
  });
}

// ---------------------------------------------------------------------------
// A wire-level client
// ---------------------------------------------------------------------------

/**
 * A client that reads every frame exactly as it arrives, across connections:
 * nothing is deduplicated here, so a frame sent twice shows up twice.
 */
export class WireClient {
  /** Frames with an event id, in arrival order, across every connection. */
  readonly frames: { id: number; part: { type: string; [key: string]: unknown } }[] = [];
  /** Frames without an id (the handshake, a fail-closed error). */
  readonly transient: unknown[] = [];
  /** How each connection ended. */
  readonly endings: ('done' | 'dropped')[] = [];
  cursor: string | undefined;

  async read(response: Response): Promise<'done' | 'dropped'> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ending: 'done' | 'dropped' = 'dropped';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let id: number | undefined;
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) id = Number(line.slice(3).trim());
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          const text = data.join('\n');
          if (text === '[DONE]') {
            ending = 'done';
            continue;
          }
          const part = JSON.parse(text) as { type: string; [key: string]: unknown };
          if (id === undefined) this.transient.push(part);
          else {
            this.frames.push({ id, part });
            this.cursor = String(id);
          }
        }
      }
    } catch {
      ending = 'dropped';
    }
    this.endings.push(ending);
    return ending;
  }
}

/** Every stored record of the run's stream, in order. */
export async function storedFrames(proc: HostProcess) {
  const records: { seq: number; part: { type: string } }[] = [];
  for await (const record of proc.streams.read(RUN_ID, -1))
    records.push(record as { seq: number; part: { type: string } });
  return records;
}

// ---------------------------------------------------------------------------
// The main flow
// ---------------------------------------------------------------------------

/** What the client does at the flow's two human moments; the core and React tests differ here. */
export interface FlowClient {
  /**
   * The run waits on its approval: approve it through the route's POST and
   * read the response until it ends (the host dies during this leg).
   */
  approve(proc: HostProcess, pending: ToolApprovalRequest[]): Promise<void>;
  /** Reconnect to the resume endpoint and read until the connection ends. */
  reconnect(proc: HostProcess, phase: 'p3' | 'p4'): Promise<void>;
}

/** What the main flow observed along the way, for the assertions. */
export interface MainFlowFacts {
  ids: { channel: string; secret: string; other: string };
  scheduleTick: DurableSchedulerTickResult;
  /** A second scheduler tick at the same time: nothing new. */
  repeatTick: DurableSchedulerTickResult;
  firstTick: GoalSupervisorTickResult;
  recoveryTick: GoalSupervisorTickResult;
  finalTick: GoalSupervisorTickResult;
  /** Where each process died, by name. */
  crashes: Record<string, CrashPoint | 'manual' | undefined>;
  pendingApprovals: ToolApprovalRequest[];
  /** The goal's status when the run was done but before the supervisor verified it. */
  statusBeforeVerify: string;
  /** The container after the crash during its start, to compare with the end. */
  containerAfterStartCrash: ContainerFacts;
  /** Views read before later writers wrote: what a stale writer still holds. */
  stale: {
    envelope: AgentRunEnvelopeV3;
    runtime: GoalRuntimeState;
    operation: ProcessOperationRecord;
  };
  forget: MemoryForgetResult;
  /** How many model requests were made before the forget. */
  requestsBeforeForget: number;
  reconcile: ProcessReconcileReport;
  /** The last process, still open: read the end state through it. */
  last: HostProcess;
}

/** The Docker step's operation id: `<runId>:<toolCallId>`. */
export const DOCKER_OPERATION = `${RUN_ID}:job-1`;

/**
 * The main flow (spec §5.1): schedule → inbox → goal → V3 context and memory
 * → an approved tool and a Docker step → three host crashes → recovery → UI
 * replay → host verification. Each crash is a fresh process on the same data,
 * after the leases expired.
 */
export async function runMainFlow(env: FlowEnv, client: FlowClient): Promise<MainFlowFacts> {
  const crashes: MainFlowFacts['crashes'] = {};
  const recover = async (dead: HostProcess, name: string): Promise<HostProcess> => {
    await dead.settle();
    crashes[dead.name] = dead.crashedAt();
    await dead.close();
    env.clock.advance(LEASE_TTL_MS + 1_000);
    return openProcess(env, name);
  };

  // P1: the schedule fires into the goal's inbox; the supervisor starts the
  // run, which dies right after its memory commit, before the acknowledgment.
  const p1 = openProcess(env, 'p1');
  const ids = await seedMemory(p1);
  await submitGoal(p1);
  await putSchedule(p1);
  env.clock.advance(OCCURRENCE_AT + 30_000 - env.clock.now());
  const scheduleTick = await p1.scheduler.tick();
  const repeatTick = await p1.scheduler.tick();
  p1.arm('memory-commit');
  const firstTick = await p1.supervisor.tick();

  // P2: a fresh supervisor resumes the run (the receipt settles the lost
  // acknowledgment) up to the gated publish; the reviewer approves; the host
  // dies while recording the outcome of the Docker start.
  const p2 = await recover(p1, 'p2');
  const recoveryTick = await p2.supervisor.tick();
  const suspended = await p2.runs.load(RUN_ID);
  const pendingApprovals =
    suspended?.result?.status === 'suspended' ? suspended.result.pendingApprovals : [];
  p2.arm('docker-start-outcome');
  await client.approve(p2, pendingApprovals);

  // P3: the client reconnects, the route continues the run as a new stream
  // producer; the host dies after the artifact was read, before the receipt.
  const p3 = await recover(p2, 'p3');
  const containerAfterStartCrash = env.docker.facts(env.scope, DOCKER_OPERATION);
  const stale = {
    envelope: (await p3.runs.load(RUN_ID))!,
    runtime: (await p3.goals.runtime.get(env.scope, GOAL_ID))!,
    operation: (await p3.operations.get(env.scope, DOCKER_OPERATION))!,
  };
  p3.arm('docker-artifact');
  await client.reconnect(p3, 'p3');
  await p3.settle();
  crashes[p3.name] = p3.crashedAt();
  await p3.close();

  // While the host is down, the operator forgets the secret: the run's
  // context packages that hold it are redacted.
  const operator = openProcess(env, 'operator');
  const forget = await operator.memory.forget(ids.secret, { operationId: 'forget-secret' });
  const requestsBeforeForget = env.requests.length;
  await operator.close();

  // P4: the client reconnects again; the run completes; the supervisor
  // verifies the goal against the artifact digest.
  const p4 = await recover(operator, 'p4');
  await client.reconnect(p4, 'p4');
  await p4.settle();
  const statusBeforeVerify = (await p4.supervisor.get(env.scope, GOAL_ID))!.goal.status;
  const finalTick = await p4.supervisor.tick();
  // Host maintenance: the labelled containers match their records, none is an orphan.
  const reconcile = await p4.runner.reconcile({ scope: env.scope });
  crashes[p4.name] = p4.crashedAt();
  return {
    ids,
    scheduleTick,
    repeatTick,
    firstTick,
    recoveryTick,
    finalTick,
    crashes,
    pendingApprovals,
    statusBeforeVerify,
    containerAfterStartCrash,
    stale,
    forget,
    requestsBeforeForget,
    reconcile,
    last: p4,
  };
}

/**
 * The start of a flow without a crash: seed, goal, schedule, the occurrence
 * delivered, and the supervisor's run up to its gated publish.
 */
export async function startToApproval(
  env: FlowEnv,
  name: string,
): Promise<{ proc: HostProcess; pending: ToolApprovalRequest[] }> {
  const proc = openProcess(env, name);
  await seedMemory(proc);
  await submitGoal(proc);
  await putSchedule(proc);
  env.clock.advance(OCCURRENCE_AT + 30_000 - env.clock.now());
  await proc.scheduler.tick();
  await proc.supervisor.tick();
  const envelope = await proc.runs.load(RUN_ID);
  const pending = envelope?.result?.status === 'suspended' ? envelope.result.pendingApprovals : [];
  return { proc, pending };
}

/** Waits for a crashed (or finished) process, closes it, expires the leases, opens the next one. */
export async function recoverProcess(dead: HostProcess, name: string): Promise<HostProcess> {
  await dead.settle();
  await dead.close();
  dead.env.clock.advance(LEASE_TTL_MS + 1_000);
  return openProcess(dead.env, name);
}
