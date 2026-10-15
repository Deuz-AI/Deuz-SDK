# Rollback test (2.4 spec §4.2)

`npm run test:rollback -w @deuz-sdk/core` checks the rollback rule: the
published `@deuz-sdk/core@2.3.0` opens the SQLite file and the Postgres schema
a 2.4 worker wrote, and keeps doing its legacy work there. It is the CI job
`rollback` in `.github/workflows/ci.yml`; `../release-pipeline.test.ts` checks
the job and the script together.

It has its own `vitest.config.ts` and `*.spec.ts` files because it installs a
package from npm, which the offline `npm test` never does.

| File                | Role                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `rollback.spec.ts`  | Runs the three phases below on each backend and checks every result                                         |
| `legacy-install.ts` | Installs `@deuz-sdk/core@2.3.0` (integrity pinned) and the repo's `pg` into a cached scratch directory      |
| `current-sdk.ts`    | The 2.4 side: opens the current code's stores on a backend, writes, reads, resumes                          |
| `legacy-smoke.mjs`  | The 2.3 side: a child process run inside the scratch install, so `@deuz-sdk/core` resolves to 2.3.0         |
| `records.ts`        | The ids and the legacy records both sides write                                                             |

## What it does

1. The current code writes, into one SQLite file and one Postgres schema,
   every kind of 2.4 record (versioned memory with revisions, receipts,
   vectors and a forget; V3 runs with their context package blobs and
   redactions; the goal runtime with a goal, state, inbox delivery, schedule
   occurrence, run intent and watermark; conditional chats with their
   transcript index and a tombstone; durable streams; process operations on
   SQLite) and, into the 2.3 stores, the legacy records a 2.4 worker writes
   (memory, chat, durable session, background run, native runs, a lease, a
   claim, a budget request, a swarm and an evolve run).
2. The 2.3.0 worker opens every 2.3 store there (the memory, chat, session and
   run pack; ops; budget; swarm; evolve on SQLite), reads 2.4's legacy records
   exactly as 2.4 reads them, writes and reads its own, cannot take the lease
   or the claim 2.4 holds, resumes the native run 2.4 suspended, finishes its
   background run, commits to 2.4's swarm and evolve runs, never lists a V3 run,
   refuses to resume or reconcile one (by its id, and handed the V3 record
   itself) without a model call, a tool call or a write, and runs its
   maintenance calls (run prune, memory TTL sweep, swarm prune).
3. The current code finds every 2.4 record unchanged, reads what 2.3 left,
   resumes the legacy run 2.3 suspended and the V3 run 2.3 refused, and finds
   every 2.3 schema version at its 2.3.0 value beside each 2.4 store's own
   version table.

A negative control runs alongside: the 2.3 stores' schemas with every version
moved one ahead. The 2.3.0 stores refuse them (the SQLite pack's
`PRAGMA user_version` is no gate in 2.3: it skips its migration and opens), so
a 2.4 change that raised a version would fail this test.

## Running it

- The first run needs the npm registry (or npm's cache). The install is kept
  under `<os tmp>/deuz-rollback/`, or `DEUZ_ROLLBACK_CACHE_DIR`, and reused.
- The Postgres half needs `DEUZ_TEST_POSTGRES_URL` (see
  `../fixtures/services.ts`). It skips without it, and fails without it when
  `DEUZ_TEST_REQUIRE_SERVICES` names `postgres`. It works in schemas of its own
  and drops them.
- Everything is offline otherwise: the models are `createMockModel` on both
  sides.
