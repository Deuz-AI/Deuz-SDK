# @deuz-sdk/core

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
