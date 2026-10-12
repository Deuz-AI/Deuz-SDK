<!-- verified: 2026-10-12 against @deuz-sdk/core@2.2.0 · api-contract sha256:d0398bbef8c4
     sources: docs/content/docs/modules/stores.mdx, docs/content/docs/modules/chat-persistence.mdx,
     docs/content/docs/agents/durable-runtime.mdx, docs/content/docs/agents/unbreakable-chatbot.mdx,
     docs/content/docs/reference/whats-new-2-0.mdx, packages/core/src/durable.ts,
     packages/core/src/runtime.ts, packages/core/src/chat.ts, packages/core/src/memory.ts,
     packages/core/src/node/store-sqlite.ts, packages/core/src/node/store-redis.ts,
     packages/core/src/node/store-postgres.ts, packages/core/src/node/chat-store.ts,
     packages/core/src/node/runtime.ts, packages/core/src/types/session.ts,
     packages/core/src/types/runtime.ts, packages/core/src/types/config.ts,
     packages/core/src/node/{ops-sqlite,ops-postgres,swarm-postgres,budget-sqlite,budget-postgres,evolve-sqlite}.ts,
     packages/core/src/node/{ops-redis,redis-budget,swarm-redis,postgres-migrate}.ts,
     packages/core/src/internal/checkpoint-version.ts, packages/core/src/inference/tool-loop.ts,
     docs/content/docs/modules/operations.mdx -->

# Persistence: stores, chat history, checkpoints and resumable runs

**Load when:** picking a database for an AI feature, persisting a conversation across requests, making an agent survive a crash, a deploy or an approval a human answers hours later, resuming a chat stream after F5, running long agent jobs in the background, or choosing the SQLite / Postgres / Redis backend for native runs, swarms, leases and persistent budgets.

The store packs and checkpoints below belong to the existing APIs. Native `runAgent` uses a separate strict `AgentRunStore`; swarm uses atomic `SwarmStore` snapshots/events. Their durable backends (2.2; Redis since 2.3) are in [Native, swarm and ops backends](#native-swarm-and-ops-backends-22) below. These stores are not interchangeable. See `references/native-execution.md` for approval recovery, interrupted-effect reconciliation, leases and cross-process operations.

## The four seams

Four independent storage interfaces. Nothing is global — each one is a value you pass to a call option, so you can mix backends.

| Seam | Holds | How it is wired | Reference impls |
| --- | --- | --- | --- |
| `MemoryStore` | Long-term facts (`MemoryRecord`): scoped, hashed, optionally embedded, TTL'd. Knowledge, not transcript. | `memory: { seams: { store, … }, scope }` | `createInMemoryMemoryStore` (`/memory`), `createMarkdownMemoryStore` (`/memory/markdown`) |
| `ChatStore` | The full canonical transcript for one `chatId` (`ChatRecord` = `{ chatId, scope, messages, parentId?, updatedAt }`). | `chat: { store, chatId, scope }` | `createInMemoryChatStore` (`/chat`), `createJsonlChatStore` (`/chat/node`) |
| `SessionStore` | One `AgentCheckpoint` per `runId` — resumable run state at a step boundary. | `session: { store, runId }` | `createInMemorySessionStore` (`/durable`) |
| `RunStore` | `RunRecord` metadata for a background run: `status`, `goal`, `plan`, `stepIndex`, `meta`, timestamps. | No call option — you drive it via `createRunManager` (`/runtime`). | `createInMemoryRunStore` (`/runtime`), `createFileRunStore` (`/runtime/node`) |

`ChatStore` and `SessionStore` are **not** the same thing and you usually want both. The checkpoint's `messages` is the *effective model history* at that boundary (post-compaction, post-`prepareStep`); the chat record is the full raw transcript you re-render. A checkpoint is deleted when the run ends; a chat lives as long as the user does.

## Choosing a backend

Three packs, one factory each, all returning named seams — a single object cannot implement `MemoryStore` and `SessionStore` at once, because `delete(ids: string[])` and `delete(runId: string)` collide.

| | `@deuz-sdk/core/stores/sqlite` | `@deuz-sdk/core/stores/redis` | `@deuz-sdk/core/stores/postgres` |
| --- | --- | --- | --- |
| Factory | `createSqliteStores` | `createRedisStores` | `createPostgresStores` |
| Peer dependency | none (`node:sqlite`) | optional `redis` (v4, v5 or v6), or inject a client (ioredis through `wrapIoredisClient`, 2.3) | optional `pg`, or inject a client |
| Seams returned | `memory` `chats` `sessions` `runs` | `memory` `chats` `sessions` `runs` (`runs` since 2.3) | `memory` `chats` `sessions` `runs` |
| Vector search | in-process cosine over a bounded prefetch (`max(1000, topK × 50)` freshest rows) | in-process cosine over the **whole scope**, pulled with one `mGet` | in-database HNSW `vector_cosine_ops` when pgvector is installed; 1000-row JS-cosine fallback when not |
| Lexical search | FTS5 `bm25()`, `LIKE` fallback | substring | `ILIKE` |
| `text` + `embedding` together | hybrid, RRF-fused (k = 60) | no fusion | no fusion |
| Transactions | yes | **no `MULTI`** | yes (the migration batch) |
| `metadata` filter | evaluated in JS, SQL `LIMIT` widened to 1000 | JS | pushed down as `metadata @> $json::jsonb` |
| Namespace | one file | `prefix` (default `'deuz'`) | `schema` (default `'public'`) |

Stop at the first "yes": (1) CLI, desktop app, test, or one process that owns its data → **SQLite**. (2) Several processes or machines share the data → SQLite is out. (3) Semantic recall over thousands of records per user is a real feature → **Postgres with pgvector**, the only pack that ranks in the database. (4) You already run Redis and scopes are narrow → **Redis**. Two things decide it before the technical merits: who owns the schema, and whether the runtime has a writable filesystem at all. Honest limits, stated so you do not find them at runtime:

- **Redis serves `runs` since 2.3** (the 2.0 notes listed it before it existed): a record string plus one sorted set per status, so `list({ status })` is an index read, oldest `createdAt` first. It uses only the pack's existing commands. **`RedisStores` widened with `runs`.**
- **Redis has no `MULTI`.** A write is a sequence of commands (index sets first, record string last), so a crash mid-write can leave an id in an index whose record is missing. Every reader tolerates it — `mGet` returns `null` and the row is skipped — so an orphan costs a wasted slot, never a wrong answer. Saving a chat is two commands, so a crash between them leaves a chat `loadChat` finds but `listChats` does not; rebuild by re-saving, not by patching keys. A run save writes its new status index, the record, then removes the stale status entry, so a crash leaves a membership `list` filters out, never a run its own status cannot find.
- **Redis memory search is client-side**, O(records in scope) and moved over the wire. Keep scopes narrow (`chatId`, or `userId` + `chatId`); migrate past a few thousand records per scope.
- **SQLite needs `node:sqlite`.** Unflagged on Node 22.13+ / 23.4+ / 24+; flagged (`--experimental-sqlite`) on 22.5–22.12; absent below 22.5, where `options.database` is the only route. The first store call rejects with exactly that matrix as its message.
- **fts5 may be missing even when the module is present** (Node 22.14 answers *"no such module: fts5"*, 24.x has it). The index build runs in its own transaction, rolls back, and lexical search degrades to `LIKE` — no `bm25()` ranking, same API and result shape. Vector and hybrid search are unaffected. Inject a `better-sqlite3` handle if ranking quality matters there.
- **SQLite vector ranking is approximate at scale** — a genuinely relevant old record outside the freshest prefetch window is never scored.
- **Postgres without pgvector is SQLite's trade plus a network hop**: 1000 freshest candidates *including* their `embedding_json` (~20 KB each at 1536 dims), scored in JS. Set `pgvector: 'require'` so you never ship that by accident.
- **A loaded Postgres `MemoryRecord` carries no `embedding`** — the read column set omits `embedding_json` on purpose. Re-embed rather than reading it back.

## Factory signatures and options

```ts no-verify
createSqliteStores(options: SqliteStoreOptions): SqliteStores      // memory, chats, sessions, runs
createRedisStores(options: RedisStoreOptions): RedisStores          // memory, chats, sessions, runs (2.3)
createPostgresStores(options: PostgresStoreOptions): PostgresStores // memory, chats, sessions, runs
```

| Pack | Option | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| sqlite | `path` | `string` | — | Required. A file path, or `':memory:'`. |
| sqlite | `database` | `SqliteDatabaseLike` | — | Use this handle instead of importing `node:sqlite`. Four structural members (`prepare`, `exec`, `close`, and a statement's `run`/`get`/`all`) — better-sqlite3 fits with no peer dependency. |
| sqlite | `wal` | `boolean` | `true` | `PRAGMA journal_mode = WAL`; ignored for `':memory:'`. |
| sqlite | `fts` | `boolean` | `true` | Build the FTS5 index; automatic `LIKE` fallback. |
| redis | `client` | `RedisClientLike` | — | An **already connected** client (node-redis v4–v6; ioredis through `wrapIoredisClient(client)`, 2.3, its `keyPrefix` included). Union arm A. |
| redis | `url` | `string` | — | Union arm B: lazily imports the optional `redis` peer and connects on first use. |
| redis | `prefix` | `string` | `'deuz'` | Key namespace, not escaped — a constant you own, never user-derived. |
| postgres | `client` | `PgClientLike` | — | Anything with `query(sql, params?) => Promise<{ rows }>`: `pg.Pool`, `pg.Client`, `@neondatabase/serverless`, a proxy. |
| postgres | `connectionString` | `string` | — | Lazily imports the optional `pg` peer and opens a pool the pack owns. |
| postgres | `schema` | `string` | `'public'` | Must already exist. Validated against `/^[a-z_][a-z0-9_]*$/`. |
| postgres | `pgvector` | `'auto' \| 'require' \| 'off'` | `'auto'` | `'require'` refuses to migrate when the extension is missing **or** unreadable. |
| postgres | `dimensions` | `number` | `1536` | 1–16000. Must match the embedding model's width. |

Every pack also exposes `sweepExpiredMemories(now?): Promise<number>` and `close(): Promise<void>`; Postgres adds `migrate(): Promise<void>`.

Lifecycle rules that bite:

- **The factory is synchronous and opens nothing.** Building a pack at module scope is free. The one eager step is Postgres *option validation* — a bad `schema`, an out-of-range `dimensions`, or neither `client` nor `connectionString` throws `InvalidRequestError` at construction, because those are typos.
- **The connection opens on the first store call and is memoized.** A bad DSN or an unsupported runtime is a rejected store call with an actionable message, never a throw out of module evaluation.
- **A failed open retries — except on SQLite**, which memoizes the rejection. Fix the cause and build a new pack; there is nothing to retry into.
- **`close()` closes only what the pack opened.** Redis `{ client }` and Postgres `{ client }` are left alone — they are yours. SQLite `{ database }` is the exception: passing a handle hands it over, and `close()` closes it. A closed Redis `{ url }` pack is **final** — later store calls reject rather than silently opening a second connection.
- **`MemoryRecord.expiresAt` only hides a record at read time.** Without `sweepExpiredMemories` (cron) or `memory.sweep: 'on-extract'` a TTL'd store grows forever. The pack-level sweep is unscoped and also garbage-collects Redis crash orphans; `stores.memory.deleteExpired(now, scope)` is the scoped one and cannot remove an orphan it cannot prove a scope for.
- **A corrupt row is skipped, never thrown.** One bad record must not take a chat down.
- **Scope is a filter over the fields you set**, exactly as `matchesScope` behaves: `{ userId }` matches every record of that user regardless of `chatId`. An unset field is no test at all, not a `NULL` test.
- **All three are Node subpaths** and are not re-exported from `@deuz-sdk/core/edge`.

## Schema and migrations

| | SQLite | Redis | Postgres |
| --- | --- | --- | --- |
| Who creates it | the pack, on first use | nobody — keys are the schema | the pack, via `migrate()` |
| Version marker | `PRAGMA user_version` | none | `deuz_meta.schema_version` |
| Runs automatically | yes | n/a | yes — every store method awaits `migrate()` |
| Needs a DBA | no | no | only for `CREATE SCHEMA` and `CREATE EXTENSION vector` |

Tables are `deuz_memory`, `deuz_chats`, `deuz_sessions`, `deuz_runs` (+ `deuz_meta` on Postgres). `record` / `checkpoint` columns hold `serializeChatRecord` / `serializeCheckpoint` output, so binary parts survive.

Postgres specifics worth planning around: since 2.3 every single-statement write of the pack runs again on a serialization failure or deadlock (40001 / 40P01), up to five attempts. `migrate()` is idempotent and memoized, a *failed* attempt is not cached, and the whole DDL batch is one multi-statement query wrapped in `BEGIN … COMMIT` (a separate `query('BEGIN')` can land on a different pooled connection). `CREATE SCHEMA` and `CREATE EXTENSION vector` are **never** issued — the app connection needs `CREATE` on the schema, `SELECT` on `pg_extension`, and ordinary DML. A `deuz_meta.schema_version` newer than the SDK understands makes `migrate()` refuse with `InvalidRequestError` instead of corrupting rows during a rolling deploy. `dimensions` is checked against `pg_attribute` and a mismatch refuses to migrate rather than "succeeding" and failing every write; changing the embedding model later means an `ALTER COLUMN … TYPE vector(D)` **and** re-embedding every row.

The Redis store pack has no migration story at all: `prefix` is the entire isolation boundary, changing it migrates nothing (old keys stay, invisible), and no key carries a TTL. (The 2.3 Redis ops, budget and swarm stores do stamp a key layout version; see below.)

## Native, swarm and ops backends (2.2)

The store packs above never hold native agent runs, swarms, leases, persistent budgets or evolve populations. Those have their own backends, each keeping its own schema-version table (never `PRAGMA user_version`):

| Holds | Memory (tests, one process) | SQLite (Node, one machine) | Postgres (Node, many machines) | Redis (Node, many machines, 2.3) |
| --- | --- | --- | --- | --- |
| Native `AgentRunStore` | `createInMemoryAgentRunStore` (`/agent`) | `createSqliteOpsStore(...).agentRuns` (`/ops/sqlite`) | `createPostgresOpsStore(...).agentRuns` (`/ops/postgres`) | `createRedisOpsStore(...).agentRuns` (`/ops/redis`) |
| `LeaseProvider` | `createInMemoryLeaseProvider` (`/ops`) | `createSqliteOpsStore(...).leases` | `createPostgresOpsStore(...).leases` | `createRedisOpsStore(...).leases` |
| Schedule / signal claims | an in-memory set (the default) | `createSqliteOpsStore(...).claims` | `createPostgresOpsStore(...).claims` | `createRedisOpsStore(...).claims` |
| `SwarmStore` | `createInMemorySwarmStore` (`/swarm`) | `createSqliteSwarmStore` (`/swarm/sqlite`) | `createPostgresSwarmStore` (`/swarm/postgres`) | `createRedisSwarmStore` (`/swarm/redis`) |
| `BudgetStore` | `createInMemoryBudgetStore` (`/agent`) | `createSqliteBudgetStore` (`/ops/sqlite`) | `createPostgresBudgetStore` (`/ops/postgres`) | `createRedisBudgetStore` (`/ops/redis`) |
| `PopulationStore` (evolve) | `createInMemoryPopulationStore` (`/evolve`) | `createSqlitePopulationStore` (`/evolve/sqlite`) | — | — |

```ts
import { createAgent } from '@deuz-sdk/core/agent';
import { createSwarm } from '@deuz-sdk/core/swarm';
import { createSqliteSwarmStore } from '@deuz-sdk/core/swarm/sqlite';
import { createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createMockModel } from '@deuz-sdk/core/testing';

const model = createMockModel({ responses: [{ text: 'ok' }] });

// One file can hold swarms, leases and agent runs; every process runs this same code.
const store = createSqliteSwarmStore({ path: './runs.sqlite' });
const ops = createSqliteOpsStore({ path: './runs.sqlite' });
const swarm = createSwarm({
  agents: { worker: { agent: createAgent({ model }), version: 'worker-v1' } },
  store,
  definitionVersion: 'jobs-v1',
  lease: { provider: ops.leases, ttlMs: 30_000 },
});

try {
  const { handles, failed } = await swarm.recover({ scope: 'tenant-a' });
  for (const { key, error } of failed) console.error('cannot resume', key.runId, error);
  for (const handle of handles) await handle.result;
} finally {
  await store.close();
  await ops.close();
}
```

- **SQLite** writes in `BEGIN IMMEDIATE`, so several processes can share a file. Lease times and budget windows come from the store's `clock` (the host clock by default): processes sharing a file need synchronised clocks. `database` accepts an injected `SqliteDatabaseLike` (better-sqlite3), which `close()` then closes.
- **SQLite swarm schema 2 is a one-way upgrade.** The first 2.2 open of a 2.1 swarm file adds indexed `status` / `updated_at` columns and a channel table in one transaction; existing runs resume. **2.1 then refuses the file — copy it before the first 2.2 open** if you may roll back.
- **Postgres** takes any `PgClientLike` and `schema?` (default `'public'`, must exist; tables are created on first use). Pools may run consecutive queries on different connections, so every write is **one statement**: a swarm commit updates the run row only at the expected revision and gates every task, channel and event write on it; a budget admission locks its scope rows in the same statement. Leases and budget windows use the **database clock**.
- **Native agent run revisions.** `AgentRunEnvelope.revision` increases on every save; the SQLite, Postgres, Redis and in-memory agent run stores reject anything but stored + 1 (a 2.1 envelope without one counts as 0). A custom `AgentRunStore` should enforce the same rule to fence a stale executor. Since 2.3 an envelope that records memory, a transcript, a chat projection or fail-over state is `version: 2`, which a 2.2 reader refuses; every other envelope stays version 1.
- **Redis (2.3).** `createRedisOpsStore({ client | url, prefix? })` (`leases`, `agentRuns`, `claims`, `close()`) and `createRedisBudgetStore` from `@deuz-sdk/core/ops/redis`, and `createRedisSwarmStore` (`'spawn'`, `'channels'` and `'list'` capabilities, `head`, `prune`) from `@deuz-sdk/core/swarm/redis`, have the 2.3 semantics of the SQLite and Postgres stores. Every operation is one Lua script, atomic on the server with no `WATCH` / `MULTI`; lease, claim and budget-window time is the server's `TIME`; every key of a store carries one hash tag (`{<prefix>:ops}`, `{<prefix>:budget}`, `{<prefix>:swarm}`), so a Redis Cluster keeps each store in one slot. They need **Redis 7+** and a server that **never evicts their keys** (`maxmemory-policy noeviction` or a `volatile-*` policy; they set no TTL): an evicted budget scope admits its whole limit again, and an evicted lease, claim or run key loses what it held. The client is a connected node-redis client (standalone or cluster) or `wrapIoredisClient(ioredis)`; an ioredis `keyPrefix` applies to every key. Each store stamps its key layout version (`<tag>:schema`) on first use and refuses another. `agentRuns.list` keeps sorted-set indexes in the save script (times from the server's `TIME`) and indexes runs saved before those indexes existed on the first listing.
- **Retention (2.3).** `agentRuns.prune(before)` deletes terminal native runs, `claims.prune(before)` old claim keys (claimable again), `leases.prune(before)` keys nobody holds that queue no cancel, `SwarmStore.prune({ before, scope?, limit? })` settled swarm runs, and `BudgetStore.prune({ before })` folds closed budget history without changing usage (`references/ops.md`). Memory, SQLite, Postgres and Redis implement them all.
- **Postgres (2.3).** The ops, swarm and budget stores' schema statement now upgrades a schema stored at an older version in place, under its advisory lock and in one statement, and refuses a newer one naming both versions. No store changes its schema version in 2.3; on first use they add indexes (`deuz_claims_claimed_at`, `deuz_agent_runs_updated_at`, `deuz_budget_requests_state`; on SQLite also `deuz_swarm_runs_settled`) that 2.2 ignores, so 2.2 and 2.3 processes can share a database. On a large Postgres table create them beforehand with `CREATE INDEX CONCURRENTLY` under the same names. Contended writes (40001 / 40P01) retry up to five times; a swarm write that runs out rejects with `SwarmConflictError` carrying the driver error as `cause`.

## Wiring a pack into one call

The seams are ordinary values. One call, three kinds of persistence:

```ts
import { streamChat } from '@deuz-sdk/core';
import type { Clock, StreamChatResult, ToolSet } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createPostgresStores } from '@deuz-sdk/core/stores/postgres';
import type { Embedder, MemoryLLM } from '@deuz-sdk/core/memory';

declare const tools: ToolSet;
declare const embedder: Embedder;
declare const llm: MemoryLLM;
declare const clock: Clock;
declare const generateId: () => string;

// Module scope is safe: the factory is synchronous and connects to nothing.
const stores = createPostgresStores({
  connectionString: process.env.DATABASE_URL!,
  schema: 'agent',
  pgvector: 'require', // fail loudly rather than degrading to JS cosine
  dimensions: 1536, // must match the embedder
});

export const boot = (): Promise<void> => stores.migrate(); // fail at boot, not on write
export const shutdown = (): Promise<void> => stores.close(); // no-op for an injected client

export function turn(chatId: string, userId: string, runId: string): StreamChatResult {
  return streamChat({
    model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8'),
    messages: [{ role: 'user', content: 'refund my last invoice' }],
    tools, maxSteps: 8,
    chat: { store: stores.chats, chatId, scope: { userId } }, // transcript
    session: { store: stores.sessions, runId }, // checkpoints
    memory: {
      seams: { store: stores.memory, embedder, llm, clock, generateId },
      scope: { userId, chatId }, // multi-tenant isolation is this object
      sweep: 'on-extract',
    },
  });
}
```

Mixing packs is legitimate — Postgres for `memory` and `runs`, Redis for `sessions` because checkpoints are hot and short-lived.

## Chat persistence

`ChatPersistOptions` is `{ store, chatId, scope, parentId? }`. `scope` is mandatory and is the same `MemoryScope` memory uses, so chats, memories and runs share one ownership model.

- The loop saves the **full immutable history** at terminal boundaries: completion, suspension on an approval break, and mid-stream error (completed turns still persist). There is no diff machinery — every save is a superset of the last.
- **Best-effort by contract.** A throwing `saveChat` logs via `deps.logger.error` and never kills the run. The default logger is a no-op, so wire one or you will never learn the store is down.
- **Setting `chat` routes even a tool-less call through the agentic loop.** The visible consequence is `step-start` / `step-finish` parts on the stream where there were none — keep the `default` case in your part switch.
- For a SQL/text column, serialize with `serializeChatRecord` / `deserializeChatRecord` (`@deuz-sdk/core/chat`). Plain `JSON.stringify` decays a `Uint8Array` image part into `{ "0": 1, … }`. The codec tags bytes as `{ "$deuzBytes": "<base64>" }`; only that exact shape converts back, so lookalike payloads stay plain data. The store packs already do this for you.
- `createJsonlChatStore({ dir })` from `@deuz-sdk/core/chat/node` is the file-backed reference: one JSON file per chat, zero dependencies, lazy `node:fs/promises`, write-to-`.tmp`-then-`rename` so a crash cannot tear an existing chat, and `loadChat` returns `undefined` for a missing or corrupt file instead of throwing. Good for a single-user CLI; use a pack for a server.
- To render a loaded chat, project it: `uiFromMessages(record.messages, generateId)`. To fork one (edit-and-resend), `branchBeforeUserMessage` then save under a new `chatId` with `parentId` pointing at the original.

## Durable runs: checkpoints and resume

`session` is opt-in per call on `CommonCallOptions`: `DurableSessionOptions` is `{ store: SessionStore; runId?: string; durability?: 'best-effort' | 'strict' }`, where `runId` defaults to `deps.generateId()` and reusing one continues that run. **Behaviour change (2.3):** a plain call that reuses a stored `runId` (without `resumeFromCheckpoint`) reads its checkpoint first and continues its step counter and approval count, so `stepIndex` is monotonic over every leg and an approval bound to a step is never issued again; a failed read is logged and the leg counts from 0, and under `session.durability: 'strict'` the call fails instead. Only agentic calls checkpoint. A single-turn call has no step boundaries and carries no `runId`. `GenerateTextResult.runId` is on the buffered result; `StreamChatResult.runId` is available synchronously, before the first part.

`SessionStore` is `save(checkpoint)` + `load(runId)`, with optional `delete(runId)` and `list()`. Latest save wins per `runId`; a store may keep every snapshot, but the loop only ever loads the latest. **A throwing `save` is logged and the run continues** — durability must never be a run-killer — unless `durability: 'strict'`, which fails the run with `ExecutionPersistenceError` instead.

`AgentCheckpoint`: `version: 1`, `runId`, `stepId` (`${runId}#${stepIndex}`), `stepIndex` (monotonic across *all* legs), `status`, `messages`, `usage` (cumulative across the whole run), `pendingApprovals?`, `agentPath?`, `handoff?` (`{ to, count }`, 2.0), `approvalRequestCounts?` (2.3: approval requests per tool call id over all legs, so the bare-id verdict form counts only for an id used once, even after compaction or a `prepareStep` window dropped the earlier call), `createdAt`. A 2.2 process reads a checkpoint that carries the new field and ignores it. `deserializeCheckpoint`, `resumeFromCheckpoint` and `resumeStreamFromCheckpoint` refuse a checkpoint whose `version` is not 1 with `CheckpointVersionError` (code `checkpoint_version_unsupported`, 2.3); one without a version reads as 1.

| `CheckpointStatus` | Meaning |
| --- | --- |
| `'running'` | A step completed and the loop was still going. |
| `'suspended'` | The loop broke on a client-mode approval or a client tool. `pendingApprovals` carries any gated calls awaiting a verdict (a break caused only by client tools has none). |
| `'completed'` | The run finished — final text, stop condition, or runaway guard. |

**The honest recovery unit is one step.** A crash between steps loses nothing; a crash mid-step re-runs that step, so non-idempotent tool `execute` functions need to be written for it. An aborted call (`signal`) deliberately does not checkpoint the interrupted step.

```ts
import { generateText } from '@deuz-sdk/core';
import type { LanguageModel, ToolSet } from '@deuz-sdk/core';
import { createInMemorySessionStore, resumeFromCheckpoint } from '@deuz-sdk/core/durable';

declare const model: LanguageModel;
declare const tools: ToolSet;

const store = createInMemorySessionStore(); // swap for stores.sessions in production

export async function run(): Promise<string> {
  const first = await generateText({
    model, tools, maxSteps: 12,
    messages: [{ role: 'user', content: 'Refactor the auth module.' }],
    session: { store, runId: 'run-42' }, // opt-in durability
  });
  if (!first.pendingApprovals?.length) return first.text;

  // …the process may die here; the checkpoint outlives it. Checkpoints store
  // DATA, not closures, so re-supply model and tools on the next leg.
  const done = await resumeFromCheckpoint(store, 'run-42', {
    model, tools, maxSteps: 12,
    approvalResponses: first.pendingApprovals.map((r) => ({
      approvalId: r.approvalId,
      approved: true,
    })),
  });
  return done.text;
}
```

`ResumeOptions` is `Omit<CommonCallOptions, 'messages' | 'session'>` — the checkpoint's history *is* the messages, and the session is derived from `store` + `runId`. An unknown `runId` rejects with `CheckpointNotFoundError`. `resumeStreamFromCheckpoint(store, runId, options)` is the streaming twin with identical semantics and the usual G2 contract: it returns synchronously, and that same error arrives as an `error` part with rejected `usage` / `finishReason` instead of a throw.

Resume semantics to design around:

- **No verdict means denied.** Resuming without an entry in `approvalResponses` for a pending gated call denies it (safe side) rather than resending an unanswered `tool_use`.
- **Counters continue.** `stepIndex` and checkpoint `usage` are cumulative, so `totalTokensExceed` / `costExceeds` and `prepareStep` see the whole run. Each leg's *result* still reports only that leg's usage.
- **A client tool cannot get its real result back.** `ToolApprovalResponse` carries a verdict, not a result, so a resume feeds the placeholder `"No result provided for this client tool."`. To carry a real result across a restart, `load` the checkpoint yourself, append the `tool_result` message to its history, and call `generateText` / `streamChat` with those messages and the same `session`. Approval-gated **server** tools (`needsApproval` + `execute`) have no such limit and are the better durable-HITL shape.
- **Parallel batches re-run.** If a durable sub-agent suspends out of a parallel tool batch, sibling executions from that step are discarded and re-run; keep them idempotent or set `maxToolConcurrency: 1`.
- **Client-mode approval inside a sub-agent works with a session** (this was the 1.4 limitation). The child checkpoints under a per-call key, the parent's pending approvals carry `agentPath`, and you resume the **parent** with the verdicts.
- **A handoff survives resume.** `checkpoint.handoff` re-applies the active agent's model and tools before the first step, and compaction on that leg measures against the active agent's model.
- **Approval ids bind the call (2.3).** Answer with the `approvalId` you were given (`references/tools-agents.md`); the bare tool call id still counts when the run used that id once.
- **Native runs recover differently.** A native run (`runAgent` + `AgentRunStore`) stops on an interrupted effect instead of re-running the step, and 2.3 adds `retryToolCallIds`, `reconciledToolResults`, `retryFailed` and a resume-time `onCatalogChange: 'accept'`: see `references/native-execution.md`.

## Resuming a crashed chat stream

`resumeDeuzChatResponse` is one endpoint that covers all three ways a turn dies — connection drop, tab refresh, server crash — by combining the durable `SessionStore` with the wire-log `StreamStateStore` from `@deuz-sdk/core/ui`.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `sessionStore` | `SessionStore` | required | Where checkpoints live. |
| `streamStateStore` | `StreamStateStore` | required | Where the wire log lives. |
| `runId` / `streamId` | `string` | required | Checkpoint identity / `Last-Event-ID` replay identity. Often equal. |
| `lastEventId` | `string \| number \| null` | replay from start | The client's header value, verbatim. |
| `call` | `ResumeOptions` | required | Model, tools and deps for a continuation leg. |
| `liveProbeMs` | `number` | `1500` | Silence tolerated before declaring the producer dead. |
| `pollIntervalMs` | `number` | `150` | Replay/tail cadence. |
| `wireVersion` | `'v1' \| 'v2'` | `'v2'` | Serve v2 — the client needs event ids to resume. |
| `headers`, `clock`, `onStoreError` | — | — | Extra response headers, a timer seam for tests, and a hook for wire-log append failures. |

Phase 1 replays the log and tails a live producer. Phase 2 — silence past `liveProbeMs` with no terminal `done` sentinel — calls `resumeStreamFromCheckpoint` and pipes the new leg through the same log, so seq numbering continues and the client cannot tell the two apart.

```ts
import type { LanguageModel, ToolSet } from '@deuz-sdk/core';
import { resumeDeuzChatResponse } from '@deuz-sdk/core/durable';
import type { SessionStore } from '@deuz-sdk/core/durable';
import type { StreamStateStore } from '@deuz-sdk/core/ui';

declare const sessionStore: SessionStore;
declare const streamStateStore: StreamStateStore;
declare const model: LanguageModel;
declare const tools: ToolSet;

// GET /api/chat/:runId/resume — the client points connectDeuzStream here.
export function resumeRoute(req: Request, runId: string): Response {
  return resumeDeuzChatResponse({
    sessionStore, streamStateStore,
    runId, streamId: runId,
    lastEventId: req.headers.get('last-event-id'),
    call: { model, tools, maxSteps: 12 }, // data, not closures — re-supply them
  });
}
```

**Run at most one continuation resumer per `runId`.** Two clients hitting the resume route after a crash both pass the liveness probe and start two legs — doubling the model call and interleaving seqs. Guard the route with a Redis `SET NX`, a Postgres advisory lock, or a row claim. Tailing clients are unlimited; only the continuing leg needs the lock. Never point the client at the POST route to reconnect — that re-runs the model.

## HMAC-signed approvals

A verdict arriving from a browser is untrusted input. `createApprovalSigner({ secret, clock? })` returns `{ sign(request, context?), verify(token, options?) }` over WebCrypto HMAC-SHA256 (edge-safe). Token format is `v1.<payload>.<mac>`; the payload is the whole `ToolApprovalRequest` plus optional `runId` binding and `issuedAt`. An empty `secret` throws at construction. `verify` returns `SignedApprovalPayload` or `null` — a forged, garbled or expired token is `null`, never an exception.

Since 1.7 the signer is a call option and the plumbing happens inside the loop:

```ts
import { generateText } from '@deuz-sdk/core';
import type { GenerateTextResult, LanguageModel, ToolSet } from '@deuz-sdk/core';
import { createApprovalSigner, resumeFromCheckpoint } from '@deuz-sdk/core/durable';
import type { SessionStore } from '@deuz-sdk/core/durable';

declare const model: LanguageModel;
declare const tools: ToolSet; // some gated by needsApproval, no approveToolCall → client mode
declare const store: SessionStore;

// The secret stays server-side. The client only ever echoes opaque tokens.
const approvalSigner = createApprovalSigner({ secret: process.env.APPROVAL_SECRET! });
const approvalMaxAgeMs = 60 * 60 * 1000; // omit for no expiry

export function firstLeg(): Promise<GenerateTextResult> {
  return generateText({
    model, tools, maxSteps: 8,
    messages: [{ role: 'user', content: 'Delete the stale S3 bucket.' }],
    session: { store, runId: 'run-42' },
    approvalSigner, // every request now carries an HMAC token, bound to this runId
    approvalMaxAgeMs,
  });
}

// The browser sends back { approvalId, approved, token } — the token verbatim.
export function secondLeg(approvalId: string, token: string): Promise<GenerateTextResult> {
  return resumeFromCheckpoint(store, 'run-42', {
    model, tools, maxSteps: 8, approvalSigner, approvalMaxAgeMs,
    approvalResponses: [{ approvalId, approved: true, token }],
  });
}
```

An APPROVED verdict is honored only if the HMAC verifies, the token's `approvalId` matches the call being approved, the token is younger than `approvalMaxAgeMs` when set, and — when both are present — the token's `runId` matches `session.runId`. Anything else flips to a denial with the reason `'Approval token missing, invalid, expired, or bound to another run.'`; the tool gets an `is_error` result and the loop continues. Denials need no token. Verification runs wherever `approvalResponses` are settled, including a plain same-process call — `session` is only needed for the runId binding. Signing is best-effort: a throwing signer logs and the requests go out *unsigned*, which then default-deny on resume. What this does **not** do is authenticate who clicked approve — the token is a bearer credential for one call, and its payload is base64url-encoded, not encrypted, so keep fresh secrets out of tool inputs. Your session/auth layer still guards the resume endpoint.

## `consume()` — without it nothing above happens

The stream pump is lazy. If nobody drains it, the run never reaches a terminal boundary, so **chat persistence, session checkpoints, memory extraction and `onFinish` silently never run**. Returning `toDeuzStreamResponse(result)` and walking away on a serverless runtime is exactly that failure.

```ts
import { streamChat } from '@deuz-sdk/core';
import type { LanguageModel, Message, ToolSet } from '@deuz-sdk/core';
import type { ChatStore } from '@deuz-sdk/core/chat';
import type { SessionStore } from '@deuz-sdk/core/durable';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';

declare const model: LanguageModel;
declare const tools: ToolSet;
declare const chats: ChatStore;
declare const sessions: SessionStore;
declare const messages: Message[]; // from validateChatRequest(await req.json())
declare function after(task: () => unknown): void; // next/server

export function route(req: Request, chatId: string, runId: string): Response {
  const result = streamChat({
    model, messages, tools, maxSteps: 12, signal: req.signal,
    chat: { store: chats, chatId, scope: { userId: 'u_1' } },
    session: { store: sessions, runId },
  });
  const response = toDeuzStreamResponse(result);
  after(() => result.consume?.()); // Workers: ctx.waitUntil(result.consume?.() ?? Promise.resolve())
  return response;
}
```

`consume()` never rejects, is memoized, and takes its own subscription, so it is safe alongside the serializer. It works on the `fallbackModels` / `withFallback` paths too (forwarded since 1.9); call it with `?.` because the type marks it optional.

## Background runs (`@deuz-sdk/core/runtime`)

`RunStore` is metadata bookkeeping *alongside* the checkpoints — it never drives the model. `createRunManager({ store, now? })` gives `startRun`, `getRun`, `listRuns`, `setStatus`, `setPlan`; `RunStatus` is `'queued' | 'running' | 'suspended' | 'completed' | 'failed'`. `emitPlanUpdate` and `emitActivity` push live parts through a tool's `ctx.emitPart` (a no-op on a buffered call). `createSteeringController()` queues user text you inject at the next step boundary from `prepareStep`.

```ts
import { streamChat, tool } from '@deuz-sdk/core';
import type { LanguageModel, StreamChatResult } from '@deuz-sdk/core';
import { createRunManager, createSteeringController, emitActivity } from '@deuz-sdk/core/runtime';
import { createFileRunStore, pollStaleRuns } from '@deuz-sdk/core/runtime/node';
import type { SessionStore } from '@deuz-sdk/core/durable';

declare const model: LanguageModel;
declare const sessions: SessionStore;

const runs = createFileRunStore({ dir: './data/runs' }); // or stores.runs
const manager = createRunManager({ store: runs });
const steering = createSteeringController(); // steering.enqueue('focus on enterprise tiers')

const openPage = tool({
  description: 'Open a page and report progress',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  execute: async (args, ctx) => {
    const { url } = args as { url: string };
    // ctx.emitPart exists only in a streaming parent; the emitters no-op without it.
    emitActivity(ctx.emitPart, `opened ${url}`, { level: 'info' });
    return { ok: true };
  },
});

export async function start(runId: string): Promise<StreamChatResult> {
  await manager.startRun({ runId, goal: 'research', meta: { userId: 'u_1' } });
  return streamChat({
    model, tools: { openPage }, maxSteps: 30,
    messages: [{ role: 'user', content: 'Research our competitors.' }],
    session: { store: sessions, runId },
    prepareStep: ({ messages }) => {
      const texts = steering.drain(); // injected at this step boundary
      const extra = texts.map((content) => ({ role: 'user' as const, content }));
      return extra.length ? { messages: [...messages, ...extra] } : undefined;
    },
  });
}

// A cron/worker: find runs whose producer died, continue each from its checkpoint.
export async function sweepStale(): Promise<void> {
  for (const record of await pollStaleRuns(runs, { staleMs: 60_000 })) {
    await manager.setStatus(record.runId, 'running');
    // then: resumeFromCheckpoint(sessions, record.runId, { model, tools: { openPage } })
  }
}
```

`pollStaleRuns(store, { staleMs = 60_000, statuses = ['running', 'suspended'], now? })` returns the records a worker should continue. It only *finds* them — resuming is your call, which is the whole trade against a managed workflow runtime: no vendor lock, and you own the retry policy.

## Deep dive

- [/docs/modules/stores](/docs/modules/stores) — the three packs in full: options, key layouts, complete SQL schemas, the `node:sqlite` version matrix, the better-sqlite3 and ioredis escape hatches, performance expectations.
- [/docs/modules/chat-persistence](/docs/modules/chat-persistence) — the `ChatStore` seam, the pure chat engine (`applyUIPart`, ordered `parts`), the `$deuzBytes` codec, branching, and a Supabase adapter.
- [/docs/agents/durable-runtime](/docs/agents/durable-runtime) — `SessionStore`, `AgentCheckpoint`, resume semantics, sub-agent approvals, the full signed-approval trust boundary.
- [/docs/agents/unbreakable-chatbot](/docs/agents/unbreakable-chatbot) — durable × resumable in one endpoint, the two phases, the at-most-one-resumer rule, the complete route pair and client.
- [/docs/modules/autonomy](/docs/modules/autonomy) — `RunStore`, background runs and the live plan/activity view.
- [/docs/modules/memory](/docs/modules/memory) — the `MemoryStore` seam, scope rules, TTL sweeping and the recall/extract pipeline.
- [/docs/modules/ui-streaming](/docs/modules/ui-streaming) — `StreamStateStore`, wire v2, `resumeDeuzStreamResponse` and `connectDeuzStream`.
- [/docs/reference/whats-new-2-0](/docs/reference/whats-new-2-0) — what the store packs added, and the known-limits list they belong to.
- [/docs/modules/operations](/docs/modules/operations) — leases, drain, recovery, cross-process cancellation, retention, and the SQLite / Postgres / Redis ops and swarm backends (the Redis section covers eviction and Cluster).
- [/docs/reference/whats-new-2-2](/docs/reference/whats-new-2-2) — the one-way SQLite swarm upgrade and what 2.1 can no longer read.
