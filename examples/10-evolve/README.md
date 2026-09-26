# 10 — Evolve

**Shows:** `evolve` (2.2) on a small JavaScript function. Only the code between the `EVOLVE-BLOCK-START` / `EVOLVE-BLOCK-END` markers may change; the model answers with a SEARCH/REPLACE diff that multiplies the number of Leibniz terms by ten, and a two-stage cascade scores each candidate: a cheap `shape` check with a threshold, then `digits`, the correct digits of π the function returns. Candidates go to `createSqlitePopulationStore`. The first run is killed before generation 2 commits (its `commitGeneration` never returns), and `resumeEvolve` from a new store connection replays the two stored generation-2 slots with `modelCalls: 0`.

**Run:** from the repo root, `npm install && npm run build`, then `npm run dev -w @deuz-examples/10-evolve`. No API key needed. It needs `node:sqlite`, which ships unflagged from Node 22.13 and 23.4. The SQLite file lives in a temporary directory that the example removes at the end.

**Real provider:** the model is `createMockModel` from `@deuz-sdk/core/testing`, which always proposes the same diff. Put a real model in `models` instead, such as `{ model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8') }` from `@deuz-sdk/core/anthropic` (see the `REAL PROVIDER` comment in `index.ts`); with several entries a UCB1 bandit picks one per slot. Drop `patch: { diff: 1 }` to let full rewrites and crossovers mix in.

**Look at:** the deterministic candidate IDs (`g{generation}-i{island}-s{slot}`): a resumed run finds every slot it already paid for. `budget` is mandatory. The evaluator runs the candidate with `node:vm` and a timeout, which bounds its run time but is not a security boundary: run model-written code in a worker, a container or a remote sandbox.
