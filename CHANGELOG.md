# @deuz-sdk/core

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
