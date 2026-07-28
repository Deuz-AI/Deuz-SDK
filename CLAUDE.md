# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An npm-workspaces **monorepo** (root is private) with two published packages in a fixed version group:

- **`packages/core`** → `@deuz-sdk/core` — a pure, web-first, multi-provider AI SDK (Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex, Yunwu). It depends on **no other AI SDK** and ships its own canonical streaming + UI protocol. Node ≥ 22, ESM+CJS dual build, zero runtime dependencies.
- **`packages/react`** → `@deuz-sdk/react` — thin optional React adapter (hooks + minimal headless components) binding core's chat/wire APIs to React state. No business logic lives here.

Built for the Deuz platform (Next.js + Supabase, a separate repo) and published to npm. **All `src/`, `test/`, `tooling/` paths in this file are relative to `packages/core/`** unless stated otherwise. Root-level scripts delegate into the workspaces — run commands from the repo root.

Planning docs are in Turkish: the current release's code-verified design spec lives at the repo root. For 1.9.0 there are **two** — `1.9.0-parity.md` (the parity + hardening plan this release actually executes) and `1.9.0.md` (the research-differentiation plan it front-runs); the parity doc says outright that it comes *before* the other, not instead of it. Release history is in `CHANGELOG.md` (changesets-generated — add entries via `npm run changeset`, never by hand). The README is the public-facing API tour.

## Commands

All from the repo root (they fan out over the workspaces):

```bash
npm run build            # core then react: tsup → dist/ (ESM + CJS + .d.ts per subpath export)
npm run dev              # core tsup --watch
npm test                 # vitest run in every workspace
npm run test:watch       # core vitest in watch mode
npm run test:types       # vitest run --typecheck.only → test/*.test-d.ts (the surface locks)
npm run lint             # eslint per workspace (core config enforces edge-safety — see below)
npm run typecheck        # tsc --noEmit per workspace
npm run format           # prettier --write . (root-owned; packages don't carry prettier)
npm run verify:docs-refs # static lint over docs/ + skills/ + README.md (see below)
npm run verify:docs      # verify:docs-refs, then the REAL docs site build (typegen + next build)
npm run check            # the full gate: format:check + verify:docs-refs + lint + typecheck + test
                         #   + test:types + build + verify:package (publint --strict + attw)
                         #   + verify:runtime (browser bundle, no node: leaks) + verify:size (byte
                         #   budgets) + verify:api (contract ratchet)
```

`verify:docs-refs` (`packages/core/tooling/verify-docs.mjs`, zero deps, sub-second) is the cheap guard over prose, which no other gate step reads: **leaked tool-call debris** (a raw tool tag in a written file broke two separate release passes and was only caught by `next build` minutes later), hallucinated `@deuz-sdk` import symbols — resolved against a real symbol table built from `tsup.config.ts`'s `entry` plus `package.json`'s `exports`, following `export *` — dead internal `/docs/…` links and `#anchors`, `meta.json` drift in both directions, and unclosed fences/`<Callout>`s. It is a text linter, not a type checker; `verify:docs` stays the authority on whether the site compiles.

Target one workspace with `-w`: `npm run build -w @deuz-sdk/core`, `npm test -w @deuz-sdk/react`.

Run a **single test file or test** (from the repo root):

```bash
npm test -w @deuz-sdk/core -- test/anthropic.test.ts   # one file
npm test -w @deuz-sdk/core -- -t "maps overloaded to 529"
npx vitest run test/tool-loop.test.ts -t "parallel"    # from packages/core/
```

Before claiming a change is done, run `npm run check` — it's the same gate CI/publish uses.

**Gate-ordering hazard — build core before you trust a red.** `check` runs `typecheck` and `test` *before* `build`, and `packages/react` resolves `@deuz-sdk/core` exactly the way a published consumer does: through the workspace symlink to `packages/core`, whose `exports` point at `dist/`. There is no path alias and no project reference in `packages/react/tsconfig.json` or `vitest.config.ts`. So if you edit core `src/` and run the gate without rebuilding, react's `tsc --noEmit` **and** its vitest run both read the *previous* `dist/` — a false red (or, worse, a false green) that has nothing to do with your change. Run `npm run build -w @deuz-sdk/core` first, then the gate.

Adding a new core subpath export touches **seven** places (all under `packages/core/`); the first four always apply:

1. `package.json` `exports` — import/require blocks with the `types` key FIRST (enforced by `verify:package`).
2. `tsup.config.ts` `entry` — dist name → src file. `verify:docs-refs` cross-checks this list against `exports` and reports any subpath with no entry.
3. `src/edge.ts` — only if the module is edge-safe.
4. `tooling/api-contract.json` — regenerate (see below), never hand-edit.
5. `tooling/bundle-size-budgets.json` — optional, but the ratchet is opt-in: `check-bundle-size.mjs` walks only the `bundles` it is given, so an unlisted subpath ships unmeasured (Sprint 3 shipped ~10 KB of new surface that way).
6. `eslint.config.js` — the twin exemption lists, for Node-only files (or place the file under `src/node/**`, which is pre-exempted).
7. `tooling/check-runtime-compat.mjs` — the node-only regex, again only for Node-only files.

**Regenerating `api-contract.json` — the redirect that eats its own input.** `tooling/check-api-contract.mjs` reads `tooling/api-contract.json` at line 9, *before* it ever looks at `--print`. The shell truncates a `>` target before node starts, so the obvious one-liner destroys the file it is about to read and dies with `SyntaxError: Unexpected end of JSON input`. This has bitten two separate agents. Write to a temp file, then move it into place:

```bash
cd packages/core
npm run build                                   # the contract is read off dist/index.d.ts
node tooling/check-api-contract.mjs --print > tooling/api-contract.next.json
mv tooling/api-contract.next.json tooling/api-contract.json
node tooling/check-api-contract.mjs             # confirm it parses and passes
```

In **Windows PowerShell** `>` additionally writes a UTF-8 BOM, which `JSON.parse` rejects — the next `verify:api` then dies with `SyntaxError: Unexpected token`. Either run the lines above in Git Bash, or write the bytes yourself:

```powershell
[IO.File]::WriteAllText("$PWD/tooling/api-contract.json", ((node tooling/check-api-contract.mjs --print) -join "`n") + "`n")
```

## The two non-negotiable invariants

These are enforced by lint and tests; violating them is the most common way to break this repo.

### 1. Edge-safe purity (enforced by `eslint.config.js`)

Core `src/**` must run on Web APIs only. **Banned by default in core** (lint errors): `node:*`/`Buffer`/`process` imports, ambient clocks/randomness (`Date.now()`, `Math.random()`, `crypto.randomUUID()`/`getRandomValues()`), and `console.*`. Everything used by inference/runtime work is injected through the **single `Dependencies` seam** (`src/types/deps.ts`): `fetch`, `clock`, `logger`, `tracer`, `breakerStore`, `keyProvider`, `priceProvider`, `generateId`, `onUsage`, `onFinish`, `observer` (1.6). `resolveDependencies()` (`src/internal/resolve-deps.ts`) applies the host clock/id defaults. Two opt-in helpers have their own documented, injectable host-clock fallback: `simpleCache({ now })` and `createApprovalSigner({ clock })`. Every allowed fallback carries a local eslint-disable; do not add another ambient read when a seam can be threaded instead.

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
- Flat **provider factories** — `anthropic.ts`, `openai.ts`, `xai.ts`, `google.ts` (+ `google-extras.ts`), `vertex.ts`, `voyage.ts`, `azure.ts`, `bedrock.ts`, and `providers.ts` → `providers-compat.ts` (the OpenAI-compatible host catalog, `createOpenAICompatible` for any unlisted OpenAI-shaped host, and `createProviderRegistry`'s pure `'groq:llama-4-maverick'` string lookup).
- **Feature modules**, one per subpath — `memory*.ts`, `rag*.ts`, `skills*.ts`, `image.ts`, `midjourney.ts`, `yunwu.ts`, `ui.ts`, `chat.ts`, `middleware.ts`, `pricing.ts`, `mcp/`, `observe.ts`, `testing.ts`, `durable.ts`, `autonomy.ts` (which re-exports `plan.ts` and `verify.ts`), `runtime.ts`, `workspace.ts`, `compute.ts`, `browser.ts`, and 1.9's `agent.ts` + `otel.ts`.
- **Modules with no subpath of their own** — easy to miss when you grep for a file and find no `exports` entry. `tool.ts` (`tool()`) and `parts.ts` (`filePart()`/`imagePart()`) ship from the root `.`; `chat-request.ts` (`validateChatRequest`/`parseDeuzChatRequest`) from `./chat` *and* `./edge`; `verify.ts` (`createVerifier`) from `./autonomy`; `server-tools.ts` from `.` and `./edge`. New subpaths in 1.9: `./agent` (`src/agent.ts`), `./otel` (`src/otel.ts`), `./vertex/node` (`src/node/vertex-auth.ts`).
- `packages/core/package.json` `exports` is the **authority** on the surface — currently 46 keys (the root `.`, 44 deep subpaths, and `./package.json`), all 46 locked by name in `tooling/api-contract.json`. Count from the file, never from a prose list like the one above.

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
- **Observation** (1.6): `deps.observer` receives the versioned `ObserveEvent` protocol (`src/types/observe.ts`). The runtime (`internal/observe-runtime.ts`) owns ids/sequence/sampling/redaction/limits/terminal-guard; loops thread context to inner `runStream` calls via `InternalRunOptions.observe` (an inner call NEVER opens a second run) and to sub-agents via a symbol on the per-call ctx.deps clone. Fast path: no observer + noop tracer → `createObservationRuntime` returns `undefined`, zero event objects, zero extra `generateId()` draws (scripted-id fixtures depend on this). The tracer bridge (`internal/tracer-bridge.ts`) is the SINGLE span source — never open spans directly in orchestration code. Built-in observers: `src/observe.ts` (edge) + `src/node/observe.ts` (JSONL). Content capture is opt-in and always passes `redactForObservation` (a `[REDACTED]` profile ADDED to redact.ts — `maskSecret`'s last-4 output is pinned by P0 tests, never change it).
- **Agents as values** (1.9, `agent.ts` → `./agent`): `createAgent(def)` returns a **frozen plain object of closures** in the `createClient` idiom — no class, no `new`, no prototype, no new runtime. Every method is a one-line forward to the same free function, so `streamChat`/`streamObject` stay synchronous (G2). The def is copied before freezing (the caller's object stays mutable, and `Object.freeze` is shallow); `.with(overrides)` returns a *new* frozen agent; `.asTool()` delegates to the existing `inference/agent-tool.ts`, which stays the single implementation of sub-agent delegation. `generateObject`/`streamObject` inherit the free functions' loop-option refusal — an agentic def fails there by design, and an explicitly-`undefined` per-call value is how you unset a def field.
- **OTel bridge** (1.9, `otel.ts` → `./otel`): `createOtelTracer()` fills the existing `deps.tracer` seam (`internal/tracer-bridge.ts` remains the SINGLE span source — this adds no new span site) and `createOtelObserver()` fills `deps.observer`. `@opentelemetry/api` is a lazy optional peer; `otelReady(target)` awaits that import when a test needs to observe the first span.
- **Vertex auth** (`vertex.ts` edge-safe; `node/vertex-auth.ts` → `./vertex/node`, 1.9): both only *return* a `KeyProvider`, i.e. the top link of the G1 chain that `internal/resolve-call.ts` owns. `createAdcKeyProvider()` is the one documented env-var/filesystem exception in the whole package — ADC is *defined* in terms of `GOOGLE_APPLICATION_CREDENTIALS` and the metadata server — and it reaches Node built-ins through a lazy `await import` so the browser bundle never resolves them.
- **Request validation** (1.9, `chat-request.ts` → `./chat` + `./edge`): `validateChatRequest`/`parseDeuzChatRequest` gate an attacker-controlled POST body before it reaches the loop — client-injected `system` turns, forged `tool_result`/assistant turns, and message/byte floods. Pure (no clock, no randomness, no `console`) and it **never repairs**: every failure is a rejection with `issues`, because a silently cleaned array hides the attack.
- **Secret redaction** (`internal/redact.ts`): masks `Authorization`/`x-api-key`/`x-goog-api-key` headers and `sk-`/`sk-ant-`/`AIza`/`Bearer` token patterns (last 4 chars only). This is a **P0 regression-tested invariant** — keys must never appear in any log/error/span. `DeuzError` carries no raw request body/headers by default.

## Testing

Tests use **golden-replay**: inject `deps.fetch` (helpers in `test/fixtures/sse.ts`: `sseResponse`, `sseEvents`, `mockFetch`, `mockFetchSequence` — that file is a thin re-export of `src/testing.ts`, so the same helpers ship publicly on the `./testing` subpath) to return a deterministic SSE `ReadableStream` — no real network, no MSW interception needed for most cases (MSW is available as a devDep). Tool-loop tests use a deterministic mock model (no LLM). The shape is roughly one `*.test.ts` per module under `test/`, so the file count tracks the module count — read it off the directory rather than trusting a number written here. Beside them sit the **type-level locks**, `test/surface.test-d.ts` and `test/observe-surface.test-d.ts`: `vitest.config.ts` sets `typecheck.enabled: false`, so they run only via `npm run test:types` and are *not* in the default `npm test`.

`vitest.config.ts` runs in the `node` environment (undici provides `fetch`/Web Streams). **Never combine `vi.useFakeTimers()` with MSW** — v2's microtask queue breaks. `tsconfig.json` is strict with `moduleResolution: "Bundler"`, `verbatimModuleSyntax`, and `noUncheckedIndexedAccess` — expect `!`/explicit guards on indexed access.

## Conventions

- Comments tagged `G1`/`G2`/`G11`/`G10` etc. mark invariants hardened by adversarial review (key precedence, never-throw, per-client breaker, …). Preserve the tag and the behavior when editing nearby code.
- The `LanguageModel` type and `EmbeddingModel` are deliberately distinct kinds — don't cast between them. Image/Midjourney models reuse `LanguageModel` via intentional casts; leave them.
- `streamChat` returns synchronously by design — don't make the public free functions `async`.
