# 07 — Native agent

**Shows:** the 2.1 native engine. `runAgent` with a validated structured `output` (a raw JSON Schema plus the `validate` function that certifies it), a `verify` step that checks the answer, and a `needsApproval` tool: the first call returns `status: 'suspended'` with the pending approval, and `resumeAgent` continues the same run from its `AgentRunStore` checkpoint once the approval arrives. The scripted model's first finalization misses a field, so you also watch the engine ask for a repair before it accepts the output.

**Run:** from the repo root, `npm install && npm run build`, then `npm run dev -w @deuz-examples/07-native-agent`. No API key needed; Node ≥ 22.6 for the type stripping.

**Real provider:** the model is `createMockModel` from `@deuz-sdk/core/testing`, scripted one reply per call. Replace it with `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8')` from `@deuz-sdk/core/anthropic` (see the `REAL PROVIDER` comment in `index.ts`); the rest of the file stays as it is.

**Look at:** the result branches on `status`, and only `completed` has an `output`, already validated and typed as `Receipt`. The checkpoint printed after the first call carries a `revision` that increases on every save, the fence durable stores (2.2) use to reject a stale writer. For a store that survives restarts, pass `createSqliteOpsStore({ path }).agentRuns` from `@deuz-sdk/core/ops/sqlite` instead of `createInMemoryAgentRunStore()`.
