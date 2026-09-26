# 09 — Durable operations

**Shows:** the 2.2 operations surface on one SQLite file. Three swarm executors in one process stand in for three processes: each opens its own `createSqliteSwarmStore` and `createSqliteOpsStore` connections and passes `ops.leases` as its `lease` provider.

1. `worker-a` starts a run and crashes in the middle of a task: its clock stops firing timers, so it stops renewing its lease. `recover()` on `worker-b` skips the run while the lease is live.
2. Once the lease lapses, `recover()` takes the run over. The interrupted task is `replay: 'safe'`, so `worker-b` runs it again and finishes the run.
3. `worker-a` wakes up; its next write meets the store's revision check and its result rejects with `SwarmLeaseError` `'lost'`, leaving `worker-b`'s results in place.
4. `worker-c` calls `requestCancel` on a run `worker-b` drives (`'signalled'`); `worker-b` cancels on its next heartbeat. On a finished run the answer is `'settled'`.
5. `worker-b` drains a run for a deploy (`'suspended'`, remaining tasks pending), and `worker-c` resumes it.

**Run:** from the repo root, `npm install && npm run build`, then `npm run dev -w @deuz-examples/09-durable-ops`. No API key needed. It needs `node:sqlite`, which ships unflagged from Node 22.13 and 23.4. The SQLite file lives in a temporary directory that the example removes at the end.

**Real provider:** the `report` task's agent runs on `createMockModel` from `@deuz-sdk/core/testing`. Swap in a real model such as `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8')` from `@deuz-sdk/core/anthropic` (see the `REAL PROVIDER` comment in `index.ts`).

**Look at:** `TTL` is 1 000 ms so the demo does not wait long; the default lease is 30 000 ms, renewed every `ttlMs / 3`. SQLite leases use the host clock, so processes that share a file need synchronised clocks. Without `replay: 'safe'`, an interrupted task waits in `needs_reconciliation` until you pass it in `retryTaskIds`.
