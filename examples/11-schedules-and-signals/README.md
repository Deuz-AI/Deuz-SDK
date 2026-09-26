# 11 — Schedules and signals

**Shows:** `@deuz-sdk/core/schedule` (2.2). A weekday `digest` schedule (`0 9 * * MON-FRI`, UTC) is ticked with explicit timestamps, as a host cron trigger would call `tick(now)`. Two schedulers with their own connections to one SQLite file share `createSqliteOpsStore({ path }).claims`, so the same minute runs once and reports `duplicate` in the other process. A restarted scheduler with `catchUp: 'all'` and a four-day `lookbackMs` runs the occurrences it missed and skips the one that already ran. Then `handleSignal` takes a webhook signed locally with HMAC-SHA256 and checked by `verifyHmacSignature`: a dispatch that throws answers `500` and gives the delivery ID back, so the sender's retry gets `202`; a redelivery gets `200` (duplicate); a body that does not match its signature gets `401`.

**Run:** from the repo root, `npm install && npm run build`, then `npm run dev -w @deuz-examples/11-schedules-and-signals`. No API key needed. It needs `node:sqlite`, which ships unflagged from Node 22.13 and 23.4. The SQLite file lives in a temporary directory that the example removes at the end.

**Real provider:** the scheduled run calls `generateText` on `createMockModel` from `@deuz-sdk/core/testing`. Replace it with `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8')` from `@deuz-sdk/core/anthropic` (see the `REAL PROVIDER` comment in `index.ts`).

**Look at:** the scheduler never reads the host clock by itself; the time comes from `tick(now)` or an injected `deps.clock`. The occurrence key is `${id}@${at}` in epoch milliseconds. Claimed keys stay in the `deuz_claims` table until you prune them. For GitHub or Slack, use `verifyGitHubWebhook` or `verifySlackRequest` in `verify` instead.
