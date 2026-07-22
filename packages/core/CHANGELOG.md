# @deuz-sdk/core

## 1.8.0

### Minor Changes

- b10c71b: 1.8.0 — "Autonomous Agent Runtime": the primitives to build a Manus-style, fully autonomous system on an edge-safe, zero-runtime-dependency core. Every heavy capability is a seam with a Node-only reference adapter, so the core stays pure and the isolation/browser/host concerns are pluggable.
  - **Workspace (`./workspace`, `./workspace/node`)** — a path-addressed externalized-memory seam (`Workspace`) with an in-memory reference, a sandboxed-directory Node backend (`createFileWorkspace`), and a `ToolSet` (`createWorkspaceTools`). An autonomous run persists `plan.json`, notes, and artifacts here so progress survives compaction, a durable checkpoint, or a restart.
  - **Compute / CodeAct (`./compute`, `./compute/node`)** — a `ComputeSandbox` seam (`runCode`/`runShell`) with `codeActTool`/`shellTool` wrappers and a `node:child_process` reference sandbox (allow-lists, output caps, timeout + abort kill). The model acts by writing executable code; a thrown run self-heals into an is_error the loop feeds back — CodeAct with the self-correction loop. Docker/E2B/Daytona/Fly implement the same two methods.
  - **Planner → Executor → Verifier (`./autonomy`, `verifyStep`)** — `planTasks` decomposes a goal into an ordered `TaskList` (pure reducers included; persist as `plan.json`). A new `verifyStep` loop hook (both loops) runs at every natural completion: a rejection feeds feedback back as a user turn and re-drives the loop (bounded by `maxVerifyAttempts`), recording `providerMetadata.deuz.verified`; streaming emits a `verify` part. `bestOfN`, `selfConsistency`, and `parallelAgents` (Wide Research fan-out) round out verified/parallel generation.
  - **Background runs (`./runtime`, `./runtime/node`)** — a `RunStore` metadata seam over the durable `SessionStore` (`createRunManager`, in-memory + JSONL backends, `pollStaleRuns` for a worker to continue crashed runs). Live-view emitters `emitPlanUpdate`/`emitActivity` push new `plan-update`/`activity` stream parts (surfaced through the UI wire, the chat engine, and `useChat`) so a UI can render a to-do panel and a "Computer" activity feed. `createSteeringController` injects a mid-run user message at the next step boundary.
  - **Browser control (`./browser`, `./browser/node`)** — a `BrowserController` seam with `createBrowserTools` (navigate/click/type/readText/screenshot; screenshots save to a `Workspace`) and a Playwright reference adapter (optional peer, lazily imported).
  - **Providers + model router (`./providers`)** — the previously-internal OpenAI-compatible factories (Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras, Fireworks, Moonshot/Kimi, Qwen, GLM, MiniMax) are now published, plus `createProviderRegistry` for `'groq:llama-4-maverick'`-style string lookup (a unified model router with zero network).
  - **Testing (`./testing`)** — the deterministic `createMockModel` + `runEval` + golden-replay fixtures are now a published subpath, so consumers can test agents deterministically (the evals parity).

  All additive and edge-safe by construction: new heavy code lives only under `*/node` subpaths, the canonical stream/UI wire gains open-union parts (v1 clients unaffected), and `playwright` joins the optional peers.

- b10c71b: Add dedicated Azure OpenAI (`createAzure`) and Amazon Bedrock Mantle (`createBedrock`) provider factories, plus a `createKimi` alias for Moonshot. Document Mistral / DeepSeek / Qwen / Kimi on the compat providers page.

## 1.7.1

### Patch Changes

- Harden chat and memory correctness without changing the public API. Chat-scoped memories are now isolated consistently across in-memory and Markdown stores, suspended buffered runs settle their memory result, and resumed tool calls emit complete lifecycle state.

  Chat persistence now preserves the caller's unmodified conversation instead of compaction or `prepareStep` rewrites, while buffered `response.messages` includes the final text-only assistant turn exactly once.

## 1.7.0

### Minor Changes

- 749cc45: Built-in cross-session chat memory (D1) — `memory: { seams, scope }` on any call wires the existing mem0-style pipeline straight into the chat loop, with no third-party service:
  - **Recall** — before the first model step, relevant memories for the latest user message are retrieved and spliced into the system context (topK/header configurable, `recall: false` to disable). Best-effort: a failing store degrades to a bare call.
  - **Extract** — after the run completes, the extract→reconcile→apply pass runs WITHOUT blocking the response; `result.memory` resolves with the applied mutations (never rejects — await it on serverless). Suspended/errored turns skip extraction.
  - Scope is mandatory (`{ userId, chatId, … }`, mem0 rule) and consistent with `ChatStore` records. Absent option = zero extra work and byte-identical behavior.
  - AI SDK has no built-in memory (`@ai-sdk/memory` does not exist; their docs point to Mem0/Letta or "build your own") — Deuz ships the whole loop in-library.
  - Deliberate gzip budget raise for the 1.7 loop feature set (core 31 kB → 34 kB, edge 28 kB → 31 kB), with static named imports keeping the memory pull tree-shaken to the three pipeline functions.

- 566d7af: Chat persistence and the framework-agnostic chat engine (P2 + P6 core) — new `@deuz-sdk/core/chat` subpath:
  - **`ChatStore`** — a two-method (`saveChat`/`loadChat`) persistence seam with mandatory scope (aligned with the memory scope model; `MemoryScope` gains `chatId`). Set `chat: { store, chatId, scope }` on any call and the loop auto-persists the FULL immutable history at terminal boundaries (completion, approval suspension, even mid-stream errors) — best-effort, a failing store never kills a run. Tool-less calls route through the loop too, so every chat shape persists uniformly. `createInMemoryChatStore()` ships in core; a JSONL file store ships at `./chat/node` (binary parts survive via the `$deuzBytes` codec — `serializeChatRecord`/`deserializeChatRecord` exported for custom adapters).
  - **Pure chat engine** — the state logic `useChat` needs, extracted as pure functions: `applyUIPart` (the per-turn reducer folding wire parts into a render-friendly `UIMessage`, including 1.7's cost/budget/data/citation/tool-state parts), `assistantMessageFromTurn` + `clientToolResultMessage` (canonical reconstruction), and `uiFromMessages` (render a loaded chat).
  - **Branching** — `dropTrailingAssistant` (regenerate) and `branchBeforeUserMessage` (edit-and-resend) cut the UI and canonical views together by user-turn ordinal; immutable history makes a branch a plain prefix. `ChatRecord.parentId` records fork lineage.
  - Everything is edge-safe with zero runtime imports and re-exported from `./edge`.

- a0ab6f0: Mid-conversation cross-provider failover (D6) — possible in-library ONLY because the whole history is canonical; the next provider receives the identical request the failed one got:
  - **`fallbackModels: [model2, model3]`** on `streamChat`/`generateText` (or the composable **`withFallback`** middleware): when the primary fails BEFORE its first content byte — network error, timeout, 5xx/529 after retries, or an OPEN circuit breaker — the call hops to the next model. Streaming semantics stay strict: after the first content part, mid-stream errors remain final. The winner carries `providerMetadata.deuz.failedOver = { from, to, reason }`; `onFallback` gives telemetry per hop.
  - **The circuit breaker is now real** — the long-dormant `deps.breakerStore` seam is wired into the inference pump: `BREAKER_THRESHOLD` consecutive provider-health failures per `provider:model` open it for `BREAKER_COOLDOWN_MS`; open = instant `BreakerOpenError` (new, exported) with zero network — which failover treats as an immediate hop signal. First byte resets it. Per-client store (G11) preserved.
  - Deterministic acceptance goldens: provider-A 529 → provider-B completes with the same canonical history across DIFFERENT wires (Anthropic → OpenAI); breaker opens/fails fast/resets; post-first-content errors never hop. AI SDK tracks this as open feature request vercel/ai#9950 — automatic failover exists only in their hosted Gateway.
  - Final deliberate 1.7 bundle ceilings (core 120 kB raw / 37 kB gzip, edge 110/34) — durable×resumable pulled the wire serializer into the edge surface by design.

- 5ed160a: Durable × resumable together, vendor-free (D5) — `resumeDeuzChatResponse` on `./durable` is ONE endpoint for the whole "unbreakable chatbot" story:
  - Replays the stored wire log from the client's `Last-Event-ID` and keeps tailing while the original producer is still alive (a refreshed tab just re-attaches — the model is never re-driven).
  - If the process DIED mid-run (deploy, crash, serverless freeze — detected by a configurable silence probe over the wire log), it continues the run itself from the last durable checkpoint and pipes the new leg through the same wire log: seq numbering continues, the leg journals itself, and the client sees one gapless stream ending in `[DONE]`.
  - `connectDeuzStream` pointed at this endpoint makes refreshes, network drops and server crashes all look identical to the UI. E2E golden: F5 in the middle of a tool loop → checkpoint continuation completes the turn with monotonic gapless seq ids.
  - Vercel needs the hosted Workflow runtime for durability AND Redis (`resumable-stream`) for resume; Deuz does both in-library over two 2-method seams you can back with anything.

- d11d5e2: Live USD cost streaming (D2) and a conversation budget guardrail (D3) — both in-library, no gateway required:
  - **Live `cost` part** — with a `deps.priceProvider` injected, the streaming loop emits a cumulative `cost` part after every step (`costUsd`, per-step `deltaUsd`, `stepIndex`), and single-turn calls price the finish usage inline. Cumulative totals are cross-leg on durable resumes. Vercel closed this as wontfix (vercel/ai#3932) — Deuz ships it from a verified in-library price catalog.
  - **`cacheSavingsUsd`** — the new optional `PriceProvider.cacheSavings` seam (implemented by `createPriceProvider`, margin-aware, standalone `cacheSavings()` export in `./pricing`) reports the USD saved by prompt-cache reads as its own field.
  - **`budget: { usd?, tokens? }`** — a first-class call option that hard-stops the agentic loop at a spend or token ceiling: sugar over `costExceeds`/`totalTokensExceed` with dedicated `stoppedBy: 'budget.usd' | 'budget.tokens'` markers and a typed `budget-exceeded` stream part before `finish` (render a continue-confirmation directly from it). AI SDK has no built-in budget stop — its docs hardcode prices in a custom condition.
  - `durationExceeds` (written in 1.6, unexported until now) joins the root and edge surfaces.
  - Raw bundle budgets raised deliberately for the 1.7 feature set (core 100 kB → 110 kB, edge 90 kB → 100 kB); the gzip budgets — the delivery-relevant guard — are unchanged.

- 22fbb4d: Resumable UI wire v2 (P1): every SSE event now carries a monotonic `id: <seq>` line, making Deuz streams droppable and resumable with standard `Last-Event-ID` semantics — with no vendor, no Redis requirement, and zero new dependencies.
  - **`StreamStateStore`** — a two-method (`append`/`read`) persistence seam on `@deuz-sdk/core/ui`; pass `{ store, streamId }` to `toDeuzStreamResponse`/`toDeuzObjectStreamResponse` and every emitted event is journaled with its seq (ordered, best-effort — a failing store never kills the response). `createInMemoryStreamStateStore()` ships as the reference implementation; Redis/Supabase adapters are a few lines (see docs).
  - **`resumeDeuzStreamResponse(store, streamId, { lastEventId })`** — server helper that replays from the client's `Last-Event-ID` and keeps tailing a still-live stream, so a refreshed tab reconnects mid-generation and **any number of clients can follow the same stream live**.
  - **`connectDeuzStream(source)`** — fault-tolerant client reader: reconnects with `Last-Event-ID` after a drop, deduplicates replayed events by seq, and yields one gapless part sequence. Object streams (`useObject`) are covered too.
  - **Version negotiation** — wire v2 is additive; v1 clients keep working untouched. An explicit `x-deuz-stream: v1` request header (via `negotiateDeuzStreamVersion(request)`) produces byte-identical pre-1.7 output.
  - `parseSSE` now surfaces `id:` lines (sticky, spec-correct); `sseEvents` test helper accepts `id`.

- 316b338: Typed data parts, tool state machine, and built-in RAG citations on wire v2 (P3):
  - **`createDeuzStream(result)`** — returns `{ response, writeData(name, payload), close() }`: the server injects typed `data-{name}` parts (chart payloads, progress markers, citations) into the SAME SSE response the model streams over — ordered, seq-numbered, journaled to the `StreamStateStore`, replayable like every other part.
  - **Streaming validation (opt-in)** — declare `dataSchemas: { chart: mySchema }` (any Standard Schema: zod/valibot/arktype) and payloads are validated as they stream; invalid ones are dropped with a redacted `error` part while the stream keeps going. Vercel's `validateUIMessages` is a manual after-the-fact call — Deuz validates on the wire.
  - **Tool state machine** — the streaming loop now emits a `tool-state` part at every lifecycle transition (`input-streaming → input-complete → awaiting-approval | executing → complete | error`), so UIs render live tool status without re-deriving it from part ordering.
  - **Built-in citations** — `citationsFromHits(hits)` (`./rag`) maps retrieve/rerank results to canonical `citation` parts (`chunkIndex` stays aligned with `hybridRetrieve`'s stable `Chunk.index`).
  - All three part families are v2-only: a negotiated-v1 client never sees them (byte-compat preserved).

### Patch Changes

- b6fa072: Repository restructured as an npm-workspaces monorepo: the package now lives in `packages/core` (published content unchanged — the pack file list is identical to 1.6.1) alongside a new `packages/react` skeleton for the upcoming `@deuz-sdk/react`. Tooling resolves hoisted dev CLIs; release pipeline publishes via `changeset publish`.
- 057ecf2: New package: **`@deuz-sdk/react`** — the React home for Deuz chat UIs (the `@deuz-sdk/core/react` subpath keeps working but is frozen; new features land here). A THIN adapter by design: every chat-state transformation is a call into `@deuz-sdk/core/chat`'s pure engine; this package only binds it to React state.
  - **`useChat` v2** — everything the legacy hook did (client-tool auto round-trips with self-healing, approval pause/auto-resume, stop) plus 1.7: `chatId`, `initialMessages` actually rendered (`uiFromMessages`), live `cost` state (`costUsd` + `cacheSavingsUsd`), `budgetExceeded`, `dataParts`, `citations`, `regenerate()` / `editAndResend(messageId, text)` via the core branch helpers, signed-approval flow (`addToolApprovalResponse` auto-echoes the request's HMAC `token`), and `reconnect()` over `connectDeuzStream` against a resume endpoint.
  - **`useObject`** — ported from the legacy surface.
  - **Headless components (zero styling)** — `ToolApprovalCard` (render-prop; verdicts always carry the signed token) and `CostBadge` (USD + cache savings).
  - Core patch: `applyUIPart` now preserves `token`/`agentPath` on collected approvals.
  - 20 jsdom tests; publint/attw green in all four resolution modes.

## 1.6.1

### Patch Changes

- c4923e0: Observability hardening — two security fixes plus small additive controls.

  **Security fixes:**
  - **Redaction final barrier.** The built-in observation redaction profile now also runs AFTER a custom `redact` hook (and after structural truncation), so a buggy or malicious redactor can no longer reintroduce secrets into events, and truncation can never split a secret into a decodable prefix. Hardened the JWT pattern to catch tokens embedded mid-string.
  - **Composite observers: per-sink capture projection.** `composeObservers` children now each receive only what their OWN `capture` options allow — `captured*` fields are stripped, `error.message` is gated on that child's `capture.errorMessages`, and a child `redact` hook applies only to that child's view. _Behavior change:_ a composed observer with no options no longer receives captured content from its siblings' opt-ins (it now matches a standalone observer's privacy defaults).

  **Additive:**
  - `result.observation?.settled` on `generateText` / `streamChat` / `embed` / `embedMany` results — await it before `observer.close()` to drain async `cost.calculated` enrichments.
  - `createMemoryObserver({ maxBytes })` — total byte budget alongside `maxEvents`, evicting by the existing `overflow` strategy.
  - `deps.tracerMode: 'legacy'` — opt back into the 1.5 flat span topology (one parent-less `invoke` per model call); default stays `'hierarchical'`.

  **Notes:** `eventId` is now derived as `` `${executionId}:${sequence}` `` (one less id draw per event; the format was never part of the contract). Release workflow supports npm trusted publishing (OIDC) alongside `NPM_TOKEN`.

## 1.6.0

### Minor Changes

- 8cfb9f4: v1.6.0 — Observable Runtime

  Deuz-native versioned observation event protocol (`ObserveEvent`, `schemaVersion: 1`): model, agent-step, tool, approval, checkpoint, compaction and sub-agent lifecycle events, injected through the new `Dependencies.observer` seam. Local-first observers (`@deuz-sdk/core/observe`: memory / callback / composite / filter + `summarizeRun`), Node JSONL persistence (`@deuz-sdk/core/observe/node`), deterministic per-run sampling, privacy-first content capture (everything off by default; captured payloads always pass a `[REDACTED]` redaction profile), and async cost enrichment via the existing `priceProvider` seam. Zero runtime dependencies; no hosted service; no OpenTelemetry dependency.

  The legacy tracer seam is now driven by the same events through a bridge that COMPLETES the documented `invoke → step → execute_tool` span hierarchy (previously only flat per-model-call `invoke` spans fired). Span names and attribute keys are unchanged; agentic loops now produce one `invoke` with step/tool children instead of N flat invokes.

  Behavior fix: a tool-call-first response now clears the TTFT timer (previously only text/reasoning deltas did — a tool-first stream could falsely trip the 60s ttft timeout) and counts as first content in `model.first-content`.

  Observers can never affect a run (isolated, never awaited); with no observer the hot path pays a single boolean branch and draws no ids. Bundle budgets were raised once, with measurement: core 86000→100000 raw bytes (measured 97.7KB fully instrumented), edge 76000→90000.

## 1.5.1

### Patch Changes

- **Foundation release gates:** added Linux/Windows + Node 22/24 CI, tag-to-version verification, npm provenance publishing, documentation builds, and a single `release:verify` command shared by local and CI releases.
- **Package and API contracts:** every export target is checked inside the packed artifact and loaded through both ESM and CommonJS; publint/Are the Types Wrong remain mandatory; 26 subpaths and 141 root declarations are protected from accidental removal.
- **Runtime and size regressions:** representative root, `/edge`, and provider consumers must bundle for the browser; consumer bundles have checked raw/gzip budgets with narrow headroom.
- **Stream and provider conformance:** SSE parsing now covers LF, CRLF, bare CR, BOMs, arbitrary UTF-8 chunk boundaries, EOF tails, multiline data, and early cancellation. Anthropic, OpenAI Chat Completions, OpenAI Responses, and Google native share request/stream/usage/error contract tests.
- **Standard errors:** OpenAI-compatible errors retain the actual provider id; exhausted transport failures normalize to `NetworkError`; `isDeuzError` and secret-safe `toJSON()` make cross-realm detection and logging stable.
- **Documentation structure:** compatibility, stream protocol, provider conformance, and release guarantees now live in a dedicated Reference section.

## 1.5.0

### Minor Changes

- **Durable sessions — `session` option + `SessionStore` seam + `AgentCheckpoint`** (new `@deuz-sdk/core/durable` subpath, everything also re-exported from `/edge`; all additive): pass `session: { store, runId? }` on any agentic call and both loops (`generateText` and `streamChat`) save a serializable `AgentCheckpoint` at every **step boundary** — `{ version, runId, stepId: '${runId}#${stepIndex}', stepIndex, status: 'running' | 'suspended' | 'completed', messages, usage, pendingApprovals?, agentPath?, createdAt }`. `messages` is the full immutable history (the loop never mutates prior arrays, so snapshots stay true and prompt-cache prefixes stay byte-stable across legs); `usage` is CUMULATIVE across all resume legs while each leg's _result_ still reports that leg's own cost. The result carries `runId` — `GenerateTextResult.runId`, and **synchronously** on `StreamChatResult.runId`. Persistence is best-effort by contract: a throwing `store.save` logs `deps.logger.error` and the run continues. Single-turn calls (no `tools`) have no step boundaries — no checkpoint, no `runId`; an aborted call deliberately doesn't checkpoint the interrupted step (a checkpoint is only honest at a completed boundary). `SessionStore` is two required methods (`save`/`load`, plus `delete` and optional `list`) over any backend — **no vendor runtime**; `createInMemorySessionStore()` is the reference (latest save wins per runId). For persistent stores, `serializeCheckpoint`/`deserializeCheckpoint` are a binary-part-safe JSON codec: `Uint8Array` values anywhere in the message tree (raw image parts) round-trip as real `Uint8Array`s instead of decaying into index-keyed objects — including Node `Buffer`s, whose own `toJSON` would otherwise preempt the codec (the replacer reads the pre-`toJSON` holder value); `$deuzBytes` is the codec's reserved key, and a garbled lookalike in tool data passes through as plain data instead of throwing out of resume.
- **`resumeFromCheckpoint(store, runId, options)` / `resumeStreamFromCheckpoint`**: load a checkpoint and continue the run — the stored history becomes the messages, the existing settle-on-resume mechanism answers the trailing pending `tool_use` ids from `approvalResponses`, and step indices + cumulative usage continue across legs (budget stops `totalTokensExceed`/`costExceeds` and `prepareStep` see whole-run usage). Resuming a suspended run **without** a verdict for a pending gated call now **denies it by default** (safe side) instead of resending an unanswered `tool_use` to the provider — an explicitly-empty `approvalResponses: []` array activates the same default-deny settle (previously it was ignored). A mid-step crash resumes from the last completed boundary and re-runs that step (the honest recovery unit is one step — documented; keep tool side effects idempotent). `prepareStep` sees **continuing** cross-leg step indices on a resume leg in BOTH loops (loop-symmetry). Documented limits: a resume cannot hand a **client tool** its real output (`ToolApprovalResponse` carries a verdict, not a result — the escape hatch is loading the checkpoint, appending the `tool_result` message yourself, and re-calling with the same `session`), and a durable sub-agent suspending out of a _parallel_ tool batch discards that step's sibling executions (re-run on resume). Unknown `runId`: the buffered resume rejects with the new `CheckpointNotFoundError`; the streaming twin keeps the sync-return contract (G2) and surfaces it as an `error` part + rejected `usage`/`finishReason`, never a synchronous throw.
- **Client-mode approval inside sub-agents** (the 1.4 limitation, removed): when the parent call carries `session`, a gated tool call inside an `agentTool` (with no inherited server-mode approver) no longer returns an is_error — the **child** loop checkpoints itself as suspended under a per-call key (`${parentRunId}::${agentName}#${toolCallId}` — the model-issued tool_use id is stable across legs because it lives in the parent history, so parallel same-name sub-agents never collide), and the parent suspends too, carrying the pending approvals up tagged with the sub-agent path (`ToolApprovalRequest.agentPath` + `agentPath` on the `tool-approval-request` stream part, both additive). Resuming the **parent** with verdicts keyed by the same `approvalId`s re-executes the sub-agent call, which finds its suspended checkpoint, settles its own pending calls from the forwarded verdicts, and continues where it left off — at any nesting depth. A suspended sub-agent's usage still folds into the parent's checkpoint before suspension. Without `session`, the 1.4 contract is unchanged (clear is_error, parent model can react).
- **HMAC-signed approvals — `createApprovalSigner({ secret, clock? })`** (WebCrypto `crypto.subtle`, edge-safe): `sign(request, { runId? })` produces a `v1.<payload>.<mac>` token over the full `ToolApprovalRequest` + optional run binding + `issuedAt`; `verify(token, { maxAgeMs? })` returns the payload on a valid MAC — a forged, tampered, garbled, or expired token is a verdict of `null`, never a thrown exception (a token whose age is ≥ `maxAgeMs` is expired; omit for no expiry; strictly three token segments — trailing garbage is rejected). Signing is loop-based base64 (no spread), so approval payloads carrying large tool inputs (e.g. a write-file body) don't overflow the stack; an empty `secret` throws a `TypeError` at construction instead of surfacing as an unhandled `importKey` rejection. The clock is injectable for deterministic tests; `ToolApprovalRequest.approvalId` was kept distinct from `toolCallId` in 1.3 exactly so this scheme could land additively. Closes the `approvalResponses` trust-boundary gap documented in client-tools: sign pending approvals server-side, verify verdicts on resume, reject forgeries/replays.

## 1.4.0

### Minor Changes

- **Loop hooks — `prepareStep` + `activeTools`** (on `CommonCallOptions`; work in both `generateText` and `streamChat` whenever `tools` is present): `prepareStep(ctx)` runs before every model step, after automatic compaction, and may return `{ messages, activeTools, toolChoice, model }` — `messages` becomes the base history for this and all following steps (doubling as a user-controlled compaction/rewrite hook, including system-prompt edits via the `system`-role message), while `activeTools`/`toolChoice`/`model` apply to that step only. A thrown `prepareStep` fails the call like any caller code — it is never swallowed. Static `activeTools` restricts which tools are sent every step (unknown names warn and are dropped; matching nothing fails open to the full list); `prepareStep`'s `activeTools` overrides it. `prepareStep` is a plain call option on the free functions (no agent class to instantiate) and composes with the automatic compaction below — compaction runs first, `prepareStep` sees the result.
- **Budget stop conditions — `totalTokensExceed` / `costExceeds`** (`StopCondition` factories, exported from root + `/edge` alongside `stepCountIs` / `hasToolCall`, now also exported): stop the loop once cumulative REAL usage or cost — all steps and sub-agents included — crosses a bound, OR-ed into `stopWhen` like any condition and evaluated at the step boundary (never mid-tool-batch). A budget stop never changes `finishReason` (the locked union is untouched); instead it sets `providerMetadata.deuz.stoppedBy: 'totalTokensExceed' | 'costExceeds'` on the result / `finish` part (`GenerateTextResult.providerMetadata` is a new additive field). `costExceeds` needs `deps.priceProvider` — without one it warns once and never fires. Token- and cost-budget bounds are first-class `StopCondition` factories here (alongside `stepCountIs`/`hasToolCall`), and `stoppedBy` reports which bound ended the loop.
- **Automatic layered compaction** (`compaction?: 'auto' | CompactionPolicy` on `CommonCallOptions`; opt-in, off by default, active only inside the agentic loop): three cheapest-first layers — prune old tool results into `[pruned N chars]` stubs, prune old reasoning parts, summarize the oldest unprotected slice into one message — run before a step once estimated context fill crosses a threshold (default 92%), always leaving every system message, the first user message, the last message, and the last `keepRecentSteps` assistant turns untouched. History stays immutable and prefix-stable for prompt-cache hits; a failed summarize logs a warning and skips the layer instead of ending the call; token counts are a calibrated heuristic, not a real tokenizer. Streaming emits a new `compaction` `StreamPart`/UI part per layer that ran; buffered calls log it. Anthropic's native `providerOptions.anthropic.context_management` still works verbatim alongside this. This is automatic, layered, cache-aware context management from one opt-in flag — the alternative is to estimate tokens and prune inside a per-step hook yourself.
- **Sub-agents — `agentTool`** (exported from root + `/edge`; `AgentToolDef` exported type): wraps a `{ model, tools, system, maxSteps, maxDepth, ... }` definition into a `Tool` that runs a nested agentic loop and returns its final text — no new runtime. When the parent streams, the sub-agent's entire canonical stream forwards live as `agentPath`-tagged `sub-agent` parts, rather than surfacing only the final text. The parent's server-mode `approveToolCall` is inherited to every nesting depth as first-class behavior, so a sub-agent's own tool calls stay gated with no extra wiring. Usage folds into the parent total and is tagged with `meta.agentPath`; `maxDepth` (default 2) guards against runaway nesting; the parent `signal` propagates down. Client-mode approval inside a sub-agent isn't supported yet (needs durable suspend/resume — lands in 1.5); a gated sub-agent call with no inherited approver returns a clear is_error instead.

## 1.3.0

### Minor Changes

- **Tool approval flow** — `needsApproval` (locked since 1.0) is wired end-to-end. Server mode: `approveToolCall(call, { messages })` decides inline; denials become an is_error `'Tool call denied.'` result the model can react to (excluded from the runaway error guard). Client mode: without the callback, gated calls break the loop like client tools — `generateText` returns `pendingApprovals`, streaming emits `tool-approval-request` parts — and the next call's `approvalResponses` settles them (approved → execute, denied → is_error + reason, no verdict → denied by default; every `tool_use` id answered). New UI wire parts `tool-approval-request` / `tool-approval-response`.
- **`streamObject`** — streaming structured output with `partialObjectStream: AsyncIterable<DeepPartial<T>>` + validated `object` promise. Same options as `generateObject`; sync return (G2); zero-dep tolerant partial-JSON parser emits only on change. Tool-strategy models buffer a single final emission. NO repair retry (partials can't be un-streamed) — `usage`/`finishReason` still resolve on validation failure. New exports: `streamObject`, `DeepPartial`, `StreamObjectResult` (root + edge; `NoObjectGeneratedError` added to the edge entry).
- **React hooks** (`@deuz-sdk/core/react`; React becomes an OPTIONAL peer `^18 || ^19`): `useChat` — streaming messages over the Deuz wire with automatic client-tool round-trips (`onToolCall`) and tool-approval pauses (`pendingApprovals` + `addToolApprovalResponse` resume via `approvalResponses`) — and `useObject` — streaming `DeepPartial<T>` from the new `object-delta` part. Plain hooks, no JSX, SSR-safe. `createUseChat` (the 1.0 stub) now returns `useChat` instead of throwing.
- **`toDeuzObjectStreamResponse`** (`@deuz-sdk/core/ui`): serialize a `streamObject` result over the Deuz v1 wire as `object-delta` parts (additive union member); failures become redacted `error` parts.
- **MCP extensions** (peer `@modelcontextprotocol/sdk` floor raised to `^1.29.0`): `listResources`/`readResource`/`listPrompts`/`getPrompt` on `McpClient` (auto-paginated, 100-page cap); tool results with `structuredContent` now return that object verbatim (behavior change vs joined text); server `outputSchema` carried on the new additive `Tool.outputSchema` metadata field; `onElicitationRequest` callback handles form AND url elicitation (MCP 2025-11-25) — url mode is consent-only, the URL is never auto-opened.

## 1.2.0

### Minor Changes

- **`providerOptions` escape hatch** (additive): per-provider raw request-body fields on every call — `{ openai: { service_tier: 'flex' } }`, `{ anthropic: { fallbacks: […] } }`, `{ google: { cachedContent } }`. Canonical fields always win; shallow, top-level only.
- **`promptCaching: 'auto' | 'auto-1h'`**: one flag turns on Anthropic's automatic prompt caching (top-level `cache_control`; the API manages the breakpoint). No-op on providers that cache implicitly.
- **Provider-executed web search on 3 wires**: `anthropicWebSearch()` (`web_search_20260318`), `openaiWebSearch()` (Responses hosted tool), `googleSearch()` (grounding). Results/citations stream as canonical `source` parts; `usage.serverToolUses` counts billed invocations; provider tools never break the loop as client tools. Chat Completions has no hosted tools — entries are dropped there.
- **Responses stateless round-trips fixed**: with tools + reasoning the wire now sends `include: ["reasoning.encrypted_content"]` + `store: false`, replays encrypted reasoning items verbatim ahead of their `function_call` on later steps, and preserves the `phase` field on replayed assistant messages via `Message.providerMetadata` (additive field).
- `ReasoningDeltaPart.encrypted` (additive) marks opaque encrypted reasoning payloads on `fullStream`.

## 1.1.1

### Minor Changes

- **Anthropic effort wire fix:** on Claude Opus 4.7+, Sonnet 5 and Fable 5, `effort` now rides `output_config.effort` — the previous `thinking.budget_tokens` path returns HTTP 400 on those models. Legacy models keep the budget mapping (plus new `xhigh`/`max` → 48k).
- **`effort` union widened** (additive input change): `'xhigh'` and `'max'` levels. OpenAI clamps `max` → `xhigh`; Gemini clamps both to `high` (level wire) or 32,768 budget (2.5 wire); the Responses wire now sends `'none'` verbatim (a real OpenAI value).
- **`samplingRestrictions` on Anthropic rows:** Opus 4.7/4.8, Sonnet 5 and Fable 5 reject non-default `temperature`/`top_p` — the adapter no longer sends them there.
- **Catalog refresh (2026-07, price-page verified):** new registry rows `claude-fable-5`, `claude-sonnet-5`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gemini-3.1-pro-preview` (both wires), `gemini-3.1-flash-lite`, `gemini-embedding-2`; `gpt-5.5`/`gpt-5.5-pro` gain reasoning + 1.05M context. Pricing corrections: `gpt-5.5` $5/$30, `gpt-5.5-pro` $30/$180, `grok-4.3` $1.25/$2.50, `gemini-3.5-flash` $1.50/$9; new GPT-5.4-family and Claude 5 rows; retired `text-embedding-004` and `gemini-3-pro-preview` removed.
- **Long-context pricing tiers:** `ModelPrice.over200k` — `priceUsage` switches rates when prompt tokens exceed 200k (Gemini 3.1 Pro: $4/$18).
- **Gemini thinking levels fixed:** `medium` no longer collapses to `low` on Gemini 3.x flash-tier models; pro tier stays low/high-only.
- **Anthropic usage extensions:** `usage.reasoningTokens` now populated from `output_tokens_details.thinking_tokens`; server-side fallback/compaction `usage.iterations[]` are summed so billing covers every attempt.
- **`FinishStreamPart.providerMetadata`** (additive): Anthropic refusal `stop_details` surfaces as `providerMetadata.anthropic.stop_details` (finish reason stays `content_filter`).

## 0.1.0

### Minor Changes

- Initial public release. Pure, web-first, multi-provider AI SDK (Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex, Yunwu) with zero runtime dependencies and an ESM+CJS dual build. Ships a canonical streaming + tool-loop core, structured output, memory, RAG, skills, MCP, media generation, middleware, and a versioned Deuz UI wire.

## 0.0.0

- Scaffolding (Faz 0): tooling (tsup dual ESM/CJS + dts, vitest, ESLint edge-safety, Prettier, changesets), publish hygiene (subpath exports, publint/attw gate, MIT), and the locked 1.0 public surface (`streamChat`/`generateText`/`generateObject` free functions, `createClient`, provider factories, `Message`/`Part`/`Usage`/`StreamPart`/`CommonCallOptions` types, `DeuzError` base). Methods throw `NotImplementedError` until Faz 1.
