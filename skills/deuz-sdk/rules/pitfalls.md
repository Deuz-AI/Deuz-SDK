# Pitfalls (read before debugging)

These are the sharp edges that produce confusing failures. Most "it doesn't work" reports are one of these.

## 1. Core never reads env — inject keys
There is no `process.env.OPENAI_API_KEY` fallback inside the SDK (it must run on Edge). If you don't supply a key it throws `AuthenticationError`. Provide it one of three ways (G1 precedence, highest first):
1. `deps.keyProvider` (`{ getKey(provider) }`) — wins over everything, can be async/refreshing (use for Vertex OAuth).
2. factory `apiKey`: `createOpenAI({ apiKey })`.
3. `createClient({ apiKeys: { openai: KEY } })` — lowest priority; intentionally NOT wrapped as a keyProvider.

Factory `fetch` wins over `deps.fetch`. Client-level keys are last on purpose — don't try to "fix" precedence by passing them as a keyProvider.

## 2. Node-only subpaths vs edge core
These import Node builtins (lazily) and will throw a clear error on Edge/Workers:
`@deuz-sdk/core/rag/node`, `@deuz-sdk/core/skills/node`, `@deuz-sdk/core/memory/markdown`, `@deuz-sdk/core/mcp/stdio`.
Everything else (`/`, `/anthropic`, `/openai`, `/google`, `/ui`, `/rag`, `/skills`, `/memory`, `/mcp` http-sse, `/middleware`, `/pricing`, `/image`, `/google/extras`, `/edge`) is edge-safe. In a Worker, read keys from `env`, never `process.env`. Never add a `node:` import to a core file — move logic to a `…/node` surface.

## 3. EmbeddingModel is NOT a LanguageModel
They are deliberately distinct kinds. An `EmbeddingModel` (from `createOpenAIEmbedding`, `createGoogleEmbedding`, `createVoyage`, `yunwu.embedding`) only works with `embed` / `embedMany`. Passing one to `streamChat`/`generateText` (or vice-versa) is a type error — don't cast around it.

## 4. maxSteps defaults to 1 — tools won't loop
With `tools` set but `maxSteps` left at its default of 1, the model can request a tool call but the loop will NOT execute it and feed the result back; you get a `finishReason: 'tool_calls'` and no answer. Set `maxSteps` to the max turns you'll allow (e.g. 5). See `rules/tools-agents.md`.

## 5. streamChat errors surface on the stream, not as throws
`streamChat()` returns synchronously and never throws. Wrapping the call in try/catch catches nothing. Failures arrive as an `{ type: 'error' }` part on `fullStream`, and `usage`/`finishReason` reject; iterating `textStream` throws at the error point. Put try/catch around the `for await`, not the call. Don't make wrappers `async`.

## 6. Optional peers — install only what you use
All are optional peer deps (no install unless used), each with a clear "install X" error:
- `zod` + `@standard-community/standard-json` → Standard Schema tool `parameters` and `generateObject` schemas. Raw JSON Schema needs NO peer.
- `@modelcontextprotocol/sdk` → MCP.
- `unpdf` (PDF), `mammoth` (DOCX), `xlsx` (XLSX) → RAG Node parsers.

## 7. Every tool_use gets a tool_result automatically
The loop guarantees a matching `tool_result` for every `tool_use_id` (Anthropic 400s otherwise). A thrown `execute` becomes an `is_error` tool_result fed back to the model (self-healing) — it does NOT propagate out. Don't manually append tool_results inside `execute`, and don't try to suppress errors there. (Exception: a CLIENT tool — no `execute` — breaks the loop and YOU must append the result message before the next call.)

## 8. Gemini quirks are handled internally — don't work around them
The registry + adapters already handle: the Gemini "finish: stop with a pending tool call" stop-bug (the loop counts accumulated `tool_use`, not `finishReason`); usage re-emitted on every chunk (last one kept); per-fragment tool-call args arriving with `index=0` (slotted by position); thoughtSignature round-trip. Do NOT add your own finishReason checks, dedupe usage, or strip provider metadata — that breaks multi-step tools. Prefer `createGoogleNative` for reasoning/cache/PDF; the compat surface lacks them by design.

## 9. Don't stream raw provider bytes
Everything normalizes to canonical `StreamPart` deltas first so abort/retry/multi-wire/typed UI work. Don't add a code path that pipes a provider's SSE straight to a caller — use `toDeuzStreamResponse` or iterate `fullStream`.

## 10. Adding a new subpath export = three files in lockstep
`package.json` `exports` + `tsup.config.ts` `entry` + (if edge-safe) `src/edge.ts`. Run `npm run check` (the full gate: format + lint + typecheck + test + test:types + build + publint + attw) before claiming done.

## 11. streamObject has NO repair retry
`generateObject` retries once on a parse/validation miss; `streamObject` cannot (partials were already emitted). A bad final payload rejects `object` (NoObjectGeneratedError) AND the partial stream — but `usage`/`finishReason` still resolve. Handle the rejection; don't assume the generateObject retry saved you.

## 12. Approval: no verdict = DENIED
On an `approvalResponses` resume, a gated call with no matching response is denied by default (safe side) — it does NOT stay pending for another round. Send a verdict for every `approvalId` you received. Denials are excluded from the runaway error guard, and unknown approvalIds are silently ignored (replay-safe).

## 13. `compaction` only runs inside the agentic loop
`compaction: 'auto' | CompactionPolicy` (1.4.0+) does nothing on a single-turn call — it only activates when `tools` is present, same gate as the agentic loop itself. Setting `compaction` with no `tools` is a silent no-op, not an error; if you need it, add at least an empty-ish tool set and `maxSteps > 1`.

## 14. Budget stops don't change `finishReason` — read `providerMetadata.deuz.stoppedBy`
`totalTokensExceed(n)` / `costExceeds(usd)` (1.4.0+) stopping the loop does NOT alter `finishReason` (the union stays whatever the model actually returned, typically `'tool_calls'`). Don't branch on `finishReason` to detect a budget stop — check `result.providerMetadata?.deuz?.stoppedBy` (or the `finish` stream part's `providerMetadata`) instead. Also remember `costExceeds` silently never fires without `deps.priceProvider` (one warning, then it's inert for the rest of the call).

## 15. Client-mode approval does not work inside a sub-agent (1.4)
`agentTool`'s sub-agent inherits the PARENT's server-mode `approveToolCall` to every depth — that part works today. But breaking into `pendingApprovals`/`tool-approval-request` (client mode, no `approveToolCall`) is NOT supported inside a sub-agent in 1.4; a gated sub-agent tool call with no inherited approver comes back as a clear self-healing is_error instead of pausing. Pass `approveToolCall` on the outermost call if any sub-agent tool needs `needsApproval`. Durable suspend/resume for client-mode sub-agent approval is deferred to 1.5.

## 16. `agentTool`'s map key should match `def.name`
`agentTool({ name, ... })` uses `name` to build `agentPath` (what shows up in `sub-agent` stream parts and `onUsage`'s `meta.agentPath`), but nothing enforces that it matches the `tools` map key the model actually calls. Always use the same string for both — a mismatch doesn't error, it just makes `agentPath` confusing to read.
