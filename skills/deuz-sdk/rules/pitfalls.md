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
The loop guarantees a matching `tool_result` for every `tool_use_id` (Anthropic 400s otherwise). A thrown `execute` becomes an `is_error` tool_result fed back to the model (self-healing) — it does NOT propagate out. Don't manually append tool_results inside `execute`, and don't try to suppress errors there. (Exception: a CLIENT tool — a key PRESENT in `tools` with no `execute` — breaks the loop and YOU must append the result message before the next call.)

## 8. Gemini quirks are handled internally — don't work around them
The registry + adapters already handle: the Gemini "finish: stop with a pending tool call" stop-bug (the loop counts accumulated `tool_use`, not `finishReason`); usage re-emitted on every chunk (last one kept); per-fragment tool-call args arriving with `index=0` (slotted by position); thoughtSignature round-trip. Do NOT add your own finishReason checks, dedupe usage, or strip provider metadata — that breaks multi-step tools. Prefer `createGoogleNative` for reasoning/cache/PDF; the compat surface lacks them by design.

## 9. Don't stream raw provider bytes
Everything normalizes to canonical `StreamPart` deltas first so abort/retry/multi-wire/typed UI work. Don't add a code path that pipes a provider's SSE straight to a caller — use `toDeuzStreamResponse` or iterate `fullStream`.

## 10. Adding a new subpath export = several files in lockstep
`package.json` `exports` (`types` key FIRST) + `tsup.config.ts` `entry` + (if edge-safe) `src/edge.ts` + `tooling/api-contract.json` (regenerated, never hand-edited); Node-only files also need the `eslint.config.js` exemption lists (or a home under `src/node/**`) and the node-only regex in `tooling/check-runtime-compat.mjs`. Run `npm run check` (the full gate) before claiming done.

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

## 16. `result.warnings` is populated on `streamChat` ONLY (1.9)
`streamChat().warnings` resolves a real `CallWarning[]` (settles with `usage`, NEVER rejects, `[]` on a clean run) and each notice also arrives on `fullStream` as `{ type: 'warning', warning }`, ahead of the model's output. But:

- `GenerateTextResult.warnings`, `GenerateObjectResult.warnings` and `StreamObjectResult.warnings` are `undefined` on EVERY real call. Notices are produced and logged on those paths and then discarded.
- A `streamChat` carrying `tools` / `chat` / `memory` / `verifyStep` / `doneWhen` routes through the streaming loop, whose set contains the `activeTools` notices ONLY. A model-level warning (`unknown-model`, `unsupported-setting`, a hosted tool dropped on `chat_completions`, a dropped document) is raised inside the per-step pump and never merges into the loop's result or crosses the loop boundary as a part.
- A dropped document reports a typed warning on the `chat_completions` wire only; on `anthropic` / `responses` it is a log line.
- `clamped-setting` has NO producer at all.

So: `deps.logger.warn` is still the complete channel and the DEFAULT LOGGER IS A NO-OP — wire one. Read `result.warnings` as a bonus on a tool-less `streamChat`, never as the only source. `CallWarning.type` is an OPEN union (`'other'` is the escape hatch) — do not switch exhaustively.

## 17. Nobody reading the stream = no persistence, no checkpoints, no onFinish
The pump is lazy and only advances while someone pulls. Returning a `toDeuzStreamResponse` and walking away on a serverless runtime (or a client that disconnects) means the run never reaches a terminal boundary: `chat` persistence, `session` checkpoints, `onFinish` and memory extraction silently never run. Fix: `after(() => res.consume?.())` (Next.js) or `ctx.waitUntil(res.consume?.() ?? Promise.resolve())` (Workers). `consume()` never rejects, is memoized, and takes its own subscription — but it is `undefined` on the `fallbackModels` and `withFallback` paths, so always use `?.`.

## 18. An unknown model slug is silently capped at 4096 output tokens
The conservative fallback row is `maxOutput: 4096`, `reasoning: false`, `structuredOutput: false` — so a brand-new slug truncates long answers, drops `effort`, and pushes `generateObject` onto the tool strategy, with only a (no-op-by-default) `logger.warn`. Pass `capabilities: { maxOutput: 32_000, reasoning: true, structuredOutput: true }` per call, or on `createOpenAICompatible({ capabilities })`. It overrides what the SDK BELIEVES, not what the provider does — `capabilities.tools` is read by no adapter. Check with `getModelCapabilities(model)` (`caps.known === false` = fallback row).

## 19. `generateObject` / `streamObject` REFUSE loop options (1.9)
They are single-turn. Passing `tools`, `maxSteps > 1`, `stopWhen`, `verifyStep`, `memory`, `session`, `chat`, `compaction`, `fallbackModels`, … used to be accepted and IGNORED; now it is an `InvalidRequestError` before any network request. Empty collections and `maxSteps: 1` pass. To combine tools with structure, run `generateText` with the loop and then structure its `text` with `generateObject`. Same guard applies to `createAgent(...).generateObject(...)` on an agentic def — unset the fields (`{ tools: undefined, maxSteps: undefined }`).

## 20. Never `const { messages } = await req.json()` in a route
The body is attacker-controlled and canonical `Message[]` includes `role: 'system'` — a client can overwrite the instructions the route thought it owned, forge a `tool_result` ("payment captured"), replay assistant turns, or send 50k messages. Use `validateChatRequest(body)` (`@deuz-sdk/core/chat` or `/edge`). It NEVER repairs — every failure is a rejection. A route serving CLIENT TOOLS needs `{ rejectToolResults: false }` because `useChat`'s `onToolCall` round-trip POSTs a `role: 'tool'` message; understand that this cannot distinguish a real client result from a forged one, so the real fix is server-side history. `request.rest` is UNVALIDATED passthrough — read fields by name, never spread it into call options.

## 21. A denied tool call is `state: 'error'` + `denied`, not a separate state (1.9)
The STREAMING loop sets `denied` / `deniedReason` on its `tool-state` parts at both terminal sites, so a refusal reaches `UIToolCall.denied` through wire → `applyUIPart` → `useChat`. Branch on `state === 'error' && denied` — `ToolRunState` deliberately gains no 7th member and `UIToolCall.state` no 4th, because consumers switch on both exhaustively. `deniedReason` is the denier's own words, never invented: a client verdict's `reason` verbatim; `'No approval response.'` (default-deny); `'No result provided for this client tool.'`; `'Approval token missing, invalid, expired, or bound to another run.'` (`approvalSigner`). A server-mode `approveToolCall` returns a BOOLEAN, so its refusal sets `denied: true` with NO reason. A tool that THREW gains no denial fields — that is the distinction. Model-facing behaviour is unchanged: the denied call still gets its `is_error` `tool_result`, and denials still do not count toward `MAX_SAME_TOOL_ERRORS`. The BUFFERED `generateText` loop emits no `tool-state` parts at all, so none of this is visible there.

## 22. A sub-agent run lands in `turn.subAgents`, NOT in the parent's `parts` (1.9)
`applyUIPart` folds each `sub-agent` part into its own channel: `turn.subAgents?: Array<{ agentPath: string[]; afterPart: number; turn: AssistantTurnState }>`, one frame per path, surfaced by `useChat` as `subAgents`. `frame.turn` is a full turn folded by the same reducer re-entering itself (child text, reasoning, ordered `parts`, tool cards, citations, activity — all complete). `afterPart` is the parent's ordered-element count at the handoff, so splice the block in there and indent by `agentPath.length`; a 2nd-level sub-agent is a SIBLING frame with a 2-segment path (the wire is single-wrapped). It is deliberately NOT in the parent's buckets or `parts` — that would misattribute the child's prose AND put the child's `tool_use` into `assistantMessageFromTurn`'s output with no matching `tool_result`, which 400s the next request. So `turn.citations` etc. do not include a child's; read `frame.turn`.

## 23. A renderer over `UIMessage.parts` must handle `step-start`
`parts` is OPTIONAL and absent until the first element exists (a pre-1.9 or restored message legitimately has none — fall back to the `content` / `reasoning` / `toolCalls` buckets). And because the streaming loop pushes a `step-start` at the top of every iteration, `parts[0]` of a real streamed turn is normally one — a switch without that case hits `default` on the very first element. Also skip `reasoning` parts flagged `encrypted` (an opaque provider payload, not display text), and remember a `tool` element carries only `{ type, toolCallId }` — look the call up in `message.toolCalls`.

## 24. `agentTool`'s map key should match `def.name`
`agentTool({ name, ... })` uses `name` to build `agentPath` (what shows up in `sub-agent` stream parts and `onUsage`'s `meta.agentPath`), but nothing enforces that it matches the `tools` map key the model actually calls. Always use the same string for both — a mismatch doesn't error, it just makes `agentPath` confusing to read.
