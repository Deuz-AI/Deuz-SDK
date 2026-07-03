# @deuz-sdk/core

## Unreleased

### Minor Changes

- **Tool approval flow** — `needsApproval` (locked since 1.0) is wired end-to-end. Server mode: `approveToolCall(call, { messages })` decides inline; denials become an is_error `'Tool call denied.'` result the model can react to (excluded from the runaway error guard). Client mode: without the callback, gated calls break the loop like client tools — `generateText` returns `pendingApprovals`, streaming emits `tool-approval-request` parts — and the next call's `approvalResponses` settles them (approved → execute, denied → is_error + reason, no verdict → denied by default; every `tool_use` id answered). New UI wire parts `tool-approval-request` / `tool-approval-response`.
- **`streamObject`** — streaming structured output with `partialObjectStream: AsyncIterable<DeepPartial<T>>` + validated `object` promise. Same options as `generateObject`; sync return (G2); zero-dep tolerant partial-JSON parser emits only on change. Tool-strategy models buffer a single final emission. NO repair retry (partials can't be un-streamed) — `usage`/`finishReason` still resolve on validation failure. New exports: `streamObject`, `DeepPartial`, `StreamObjectResult` (root + edge; `NoObjectGeneratedError` added to the edge entry).
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
