# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@deuz/core` — a pure, web-first, multi-provider AI SDK (Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex, Yunwu). It depends on **no other AI SDK** and ships its own canonical streaming + UI protocol. Built for the Deuz platform (Next.js + Supabase, a separate repo) and published to npm. Node ≥ 22, ESM+CJS dual build, zero runtime dependencies.

Planning docs are in Turkish: `yapilacak.md` is the authoritative action list / roadmap (Faz 0–6). The README is the public-facing API tour.

## Commands

```bash
npm run build          # tsup → dist/ (ESM + CJS + .d.ts for every subpath export)
npm run dev            # tsup --watch
npm test               # vitest run (all test/**/*.test.ts)
npm run test:watch     # vitest in watch mode
npm run test:types     # vitest run --typecheck.only → runs test/*.test-d.ts (the 1.0 surface lock)
npm run lint           # eslint . (enforces edge-safety — see below)
npm run typecheck      # tsc --noEmit
npm run format         # prettier --write .
npm run check          # the full gate: format:check + lint + typecheck + test + test:types + build + publint --strict + attw
```

Run a **single test file or test**:

```bash
npm test -- test/anthropic.test.ts          # one file
npm test -- -t "maps overloaded to 529"     # tests matching a name (across all files)
npx vitest run test/tool-loop.test.ts -t "parallel"
```

Before claiming a change is done, run `npm run check` — it's the same gate CI/publish uses. Adding a new subpath export means updating **three** places in lockstep: `package.json` `exports`, `tsup.config.ts` `entry`, and (if edge-safe) `src/edge.ts`.

## The two non-negotiable invariants

These are enforced by lint and tests; violating them is the most common way to break this repo.

### 1. Edge-safe purity (enforced by `eslint.config.js`)

Core `src/**` must run on Web APIs only. **Banned in core** (lint errors): `node:*`/`Buffer`/`process` imports, `Date.now()`, `Math.random()`, `crypto.randomUUID()`/`getRandomValues()`, and `console.*`. Everything stateful or non-deterministic is injected through the **single `Dependencies` seam** (`src/types/deps.ts`): `fetch`, `clock`, `logger`, `tracer`, `breakerStore`, `keyProvider`, `priceProvider`, `generateId`, `onUsage`, `onFinish`. Resolve them via `resolveDependencies()` (`src/internal/resolve-deps.ts`), which applies no-op/in-memory defaults — that file holds the *only* two sanctioned ambient calls (`Date.now`, `crypto.randomUUID`), each with an explicit eslint-disable.

Node-only code lives in dedicated files that the lint config exempts and that ship as separate subpaths: `src/mcp/stdio.ts`, `src/rag-node.ts`, `src/skills/node.ts`, `src/memory-markdown.ts`, `src/node/**`. They reach Node APIs via lazy `import('node:fs/promises')` so tsup's `.d.ts` resolution stays clean. **Never** add a `node:` import to a core file — move the logic to a `…/node` surface instead.

### 2. The canonical line — adapters never proxy raw provider bytes

```
Request:  canonical Message[]/Part[] → adapter (1 of 4 wires) → upstream fetch
Response: upstream SSE → robust parser → CANONICAL DELTA STREAM (StreamPart)
          → inference orchestration (retry / timeout / tool-loop)
          → (a) canonical stream to the consumer   (b) versioned Deuz UI wire
```

Everything is normalized to canonical `StreamPart` deltas (`src/types/stream.ts`) *first*. Without that, abort, retry-after-first-byte, multi-wire merging, and typed UI events are impossible. Don't add a code path that streams a provider's raw SSE to a caller.

## Architecture

### Layers (`src/`)

- **`types/`** — the locked 1.0 public surface: `Message`/`Part` (incl. `ReasoningPart`), `Usage`, `LanguageModel` descriptor, `CommonCallOptions`, `StreamPart`, `ToolSet`. `test/surface.test-d.ts` pins these; changing a public type is breaking.
- **`core/`** — orchestration: `inference.ts` (the pump + adapter dispatch), `registry.ts` (capability matrix), `normalize.ts`, `metering.ts`, `resilience.ts`, `timeout.ts`.
- **`adapters/`** — the 4 wire implementations of the `Adapter` seam.
- **`inference/`** — entry-point orchestrators: `stream-chat.ts`, `generate-text.ts`, `generate-object.ts`, `embed.ts`, and the agentic loop (`tool-loop.ts`, `stream-tool-loop.ts`, `run-step.ts`, `loop-shared.ts`, `stop.ts`).
- **`internal/`** — plumbing: `resolve-deps`, `resolve-call`, `config-symbol`, `client-context`, `sse`, `async-iter`, `p-limit`, `redact`, `image`, `http`.
- **`schema/`** — Standard Schema / JSON Schema bridging for structured output (`bridge.ts`, `gemini.ts`).
- Flat **provider factories** (`anthropic.ts`, `openai.ts`, `xai.ts`, `google.ts`, `vertex.ts`, `voyage.ts`, `google-extras.ts`) and **feature modules** (`memory*.ts`, `rag*.ts`, `skills*.ts`, `image.ts`, `midjourney.ts`, `yunwu.ts`, `ui.ts`, `middleware.ts`, `pricing.ts`, `mcp/`).

### Model dispatch & the registry

A provider factory (`createAnthropic(...)('claude-opus-4-8')`) returns a tiny **`LanguageModel` descriptor `{ provider, modelId, surface }`**. Factory settings (apiKey, baseURL, fetch, headers, Vertex OAuth details) are stashed on a **non-enumerable Symbol** (`internal/config-symbol.ts`) so they never leak via `Object.keys`/`JSON.stringify` and never widen the public type. Read them back only via `readConfig()`.

`core/inference.ts:getAdapter(surface)` is the **single exhaustive switch** mapping `ModelSurface` → adapter:

| surface | adapter | covers |
| --- | --- | --- |
| `anthropic` | `anthropicAdapter` | `/v1/messages` (incl. Claude-on-Vertex) |
| `chat_completions` | `openaiCompatibleAdapter` | OpenAI Chat Completions, xAI, **Gemini-compat** |
| `responses` | `openaiResponsesAdapter` | OpenAI Responses API (GPT-5.x reasoning+tools) |
| `native` | `googleNativeAdapter` | Gemini `generateContent` (reasoning, thoughtSignature, caching, native PDF) |

`core/registry.ts` is the **single source of truth** for per-model behavior: capability matrix (vision/tools/reasoning/structuredOutput/caching/nativePdf/audio/contextWindow/maxOutput) + quirk flags. Unknown slugs **do not throw** — they fall back to conservative `(provider, surface)` defaults and log a warning, so new model releases work without a code change. Tests that assert quirks must pin slugs.

The `Adapter` seam (`adapters/types.ts`) is three pure methods, free of orchestration concerns: `buildRequest(ctx) → {url, init}`, `parseStream(body, ctx) → AsyncIterable<StreamPart>`, `mapError(status, body, headers) → DeuzError`.

### Key/baseURL resolution precedence (the "G1" rule)

`internal/resolve-call.ts`: `deps.keyProvider` (highest) → factory config (Symbol) → `createClient`'s `apiKeys`/`baseUrls` (lowest, via `client-context.ts` Symbol) → else throw `AuthenticationError`. Factory `fetch` wins over `deps.fetch`. Client-level keys are intentionally *not* wrapped in a keyProvider — that would invert the precedence.

### `streamChat` is synchronous and never throws (the "G2" rule)

`runStream` (`core/inference.ts`) returns a `StreamChatResult` synchronously; the network pump starts **lazily** on first access of any output (`textStream`/`fullStream`/`usage`/`finishReason`). Failures surface as an `error` part on `fullStream` and rejected `usage`/`finishReason` promises — never a synchronous throw. A `createBroadcaster` fans the single pump out to multiple consumers, with both subscriptions registered *before* lazy start so awaiting `usage` then iterating the stream loses nothing.

Resilience: **pre-first-byte retry only** (`maxRetries` default 2, exponential backoff + full jitter, `Retry-After` honored). Once streaming begins, a mid-stream error is final. Jitter randomness is derived from `deps.generateId()` (FNV-1a hash → unit interval) so it's deterministic in tests. 3-layer timeout (`timeout.ts`): TTFT (~60s, cleared on first content delta) + total (~300s), driven by injected `clock`, merged with the user `signal` via `combineSignals`. A user abort resolves `finishReason: 'aborted'` with partial usage; a `TimeoutError` is a failure.

### The agentic tool loop — invariants that must hold

In `inference/tool-loop.ts` / `stream-tool-loop.ts` / `loop-shared.ts`:

- **Immutable message history.** Each step builds a *new* array (`[...messages, turn]`); never mutate prior steps' arrays — prompt-cache hits and React state depend on stable history.
- **Stop on accumulated `tool_use` count, not `finishReason`** (the Gemini stop-bug guard): Gemini can emit `finish: stop` while tool calls are pending; the loop re-invokes when `toolUseParts.length > 0` regardless.
- **Parallel tool execution**, concurrency-capped via `mapWithConcurrency` (`maxToolConcurrency`, default 5).
- **Self-healing:** a thrown tool becomes an `is_error` `tool_result` fed back to the model, never a throw. Every `tool_use_id` *must* get a `tool_result` (Anthropic 400s otherwise).
- **Runaway guards:** the same tool failing `MAX_SAME_TOOL_ERRORS` (3) consecutively hard-stops; `stopWhen`/`maxSteps` (default 1) bound the loop.
- **Client tools** (no `execute`) break the loop early — the caller owns the round-trip.

### Streaming tool-call accumulation differs per wire

Adapters accumulate tool-call argument fragments as **strings**, parsing JSON once per block. Strategies diverge: OpenAI-CC keys by `index` (name may arrive late); **Gemini-compat sends every fragment with `index=0`** so it slots by position; Responses keys by `item_id`; Anthropic uses `content_block` + `input_json_delta`. Gemini-compat also re-emits **usage on every chunk** — adapters keep the *last* one. These quirks are flagged in the registry; preserve them when touching adapter parsing.

## Subsystem notes

- **Structured output** (`generate-object.ts`): picks `json` vs `tool` strategy from capabilities, with one repair retry on parse/validation failure (else `NoObjectGeneratedError`). Special case: Anthropic + extended thinking forces `json` mode (forced tool-choice is rejected with thinking on).
- **Memory** (`memory.ts`, edge-safe core; `memory-markdown.ts`, Node): one `MemoryStore` seam, two interchangeable backends — cosine vector store *or* an Obsidian-style markdown vault (YAML frontmatter + `[[wikilinks]]`, embeddings in a hidden `.deuz-vectors.json` sidecar so the `.md` stays clean). mem0 pipeline: extract → embed+search → reconcile (ADD/UPDATE/DELETE/NOOP, using temp integer ids to prevent UUID hallucination) → apply. Scope (`userId`/`agentId`/…) is mandatory.
- **RAG** (`rag.ts` edge-safe; `rag-node.ts` Node): magic-byte `sniffMime` → `ParserRegistry` (PDF/DOCX/XLSX are optional-peer Node parsers; text/markdown/CSV parsed in core) → chunkers (fixed/recursive/blocks, token-aware) → `retrieve`→`rerank` seam. `hybridRetrieve` fuses dense (cosine) + lexical (BM25) via Reciprocal Rank Fusion; `Chunk.index` must stay stable across BM25 indexing and RRF fusion.
- **Skills** (`skills.ts`; `skills/node.ts`): zero-dep `SKILL.md` frontmatter parser + progressive disclosure (`catalog` → `trigger` → `resource`). `SkillSource` and `SkillMatcher` are seams; the matcher only *prunes* the catalog — the model decides what to trigger. `normalizeResourcePath` guards against traversal.
- **Media:** `image.ts` is synchronous (OpenAI-compatible `/v1/images/generations`); `midjourney.ts` is async (submit → poll via `deps.clock.setTimeout` → action). `yunwu.ts` is a unified relay — one `baseURL` derives chat/image/embed at `/v1` and Midjourney at the bare root, with a pinned 2026 `YUNWU_MODELS` catalog.
- **MCP** (`mcp/index.ts` http/sse edge-safe; `mcp/stdio.ts` Node-only): `@modelcontextprotocol/sdk` is a lazy optional peer; `listTools()` returns a canonical `ToolSet`.
- **UI wire** (`ui.ts`): `toDeuzStreamResponse` (server, canonical → versioned SSE) + `readDeuzStream` (client). This is *our* wire, not a provider's.
- **Middleware** (`middleware.ts`): `wrapModel(model, [...])` with `transformParams`/`wrapGenerate`/`wrapStream`; bundled `logging`/`simpleCache`/`redactPII`/`promptInjectionGuard`. Array order: first element is outermost.
- **Secret redaction** (`internal/redact.ts`): masks `Authorization`/`x-api-key`/`x-goog-api-key` headers and `sk-`/`sk-ant-`/`AIza`/`Bearer` token patterns (last 4 chars only). This is a **P0 regression-tested invariant** — keys must never appear in any log/error/span. `DeuzError` carries no raw request body/headers by default.

## Testing

Tests use **golden-replay**: inject `deps.fetch` (helpers in `test/fixtures/sse.ts`: `sseResponse`, `sseEvents`, `mockFetch`, `mockFetchSequence`) to return a deterministic SSE `ReadableStream` — no real network, no MSW interception needed for most cases (MSW is available as a devDep). Tool-loop tests use a deterministic mock model (no LLM). There is one test file per module under `test/` (~26 `*.test.ts`) plus `test/surface.test-d.ts` (the type-contract lock, run via `npm run test:types`, *not* in the default `npm test`).

`vitest.config.ts` runs in the `node` environment (undici provides `fetch`/Web Streams). **Never combine `vi.useFakeTimers()` with MSW** — v2's microtask queue breaks. `tsconfig.json` is strict with `moduleResolution: "Bundler"`, `verbatimModuleSyntax`, and `noUncheckedIndexedAccess` — expect `!`/explicit guards on indexed access.

## Conventions

- Comments tagged `G1`/`G2`/`G11`/`G10` etc. mark invariants hardened by adversarial review (key precedence, never-throw, per-client breaker, …). Preserve the tag and the behavior when editing nearby code.
- The `LanguageModel` type and `EmbeddingModel` are deliberately distinct kinds — don't cast between them. Image/Midjourney models reuse `LanguageModel` via intentional casts; leave them.
- `streamChat` returns synchronously by design — don't make the public free functions `async`.
