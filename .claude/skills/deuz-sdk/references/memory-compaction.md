<!-- verified: 2026-08-12 against @deuz-sdk/core@2.0.0 · api-contract sha256:209a805b7f32
     sources: packages/core/src/{memory.ts, memory-markdown.ts, compaction.ts, chat-request.ts,
     inference/compaction.ts, inference/loop-shared.ts, types/config.ts, types/methods.ts,
     types/message.ts, node/store-sqlite.ts}, docs/content/docs/modules/{memory.mdx, compaction.mdx},
     docs/content/docs/core/compaction.mdx, docs/content/docs/reference/whats-new-2-0.mdx,
     skills/deuz-sdk/rules/{modules.md, pitfalls.md} -->

# Memory across sessions, and surviving long conversations

**Load when:** the assistant must remember a user between conversations, you are replacing mem0 / a LangChain memory class, a run dies on a context-window error, a 40-turn chat is getting expensive, or you need to shrink a stored transcript before replaying it.

Two mechanisms that people conflate. They solve opposite problems and compose.

| | `memory:` + `@deuz-sdk/core/memory` | `compaction:` + `compactMessages` |
| --- | --- | --- |
| Decides | what to **keep forever** out of a conversation | what to **forget** from the conversation in flight |
| Unit | standalone deduplicated facts, in a `MemoryStore` you inject | the `Message[]` array itself, rewritten in place |
| Lifetime | across chats, users, deployments | one run |
| Cost | 2 cheap LLM calls per write pass, 1 embed + 1 search per recall | free (pruning) or 1 model call (summarize) |
| Failure it prevents | re-asking what you were told last week | `ContextOverflowError`, and the bill |

A long-lived assistant wants both. Neither is on by default.

# Part 1 — Memory

## The pipeline

`remember(messages, scope, seams, opts?)` with `infer: true` (default) is five stages, and every option maps to one of them:

1. **`assertScope`** — throws `InvalidRequestError` if every scope field is empty. Nothing is ever written unowned.
2. **Extract** — one `MemoryLLM` call built by `buildExtractionPrompt`. Asks for `{"facts":[{"text","importance","kind"}]}` (plus `links` when `opts.links`). `parseFacts` strips fences, validates each field independently, returns `[]` on garbage instead of throwing. **Zero facts ⇒ `remember` returns immediately** — no embed, no search, no decision call.
3. **Embed + search** — all fact texts in **one** `Embedder.embed(texts, 'add')` batch, then one `store.search` **per fact** (topK each, deduped by record id).
4. **Reconcile** — one `MemoryLLM` call built by `buildDecisionPrompt`. Existing records are shown with **temporary integer ids** (`'0'`, `'1'`, …), never real ids, so a hallucinated id is detectable: `parseDecision` drops any id not in the map. Output is `ADD` / `UPDATE` / `DELETE` / `NOOP`.
5. **Apply** — importance/links copied onto `ADD` events by exact text match, duplicate hashes dropped, `applyEvents` reduces to `MemoryMutation[]`, and (unless `apply: false`) writes them. `planMemory(...)` is exactly `remember` with `apply: false`, for when the write must join a transaction you own.

## The seams — one object, wired once

`MemorySeams` holds every stateful and non-deterministic thing; the module itself is pure and edge-safe. `llm` is required by the type even in a recall-only deployment — pass a stub that throws, nothing will call it.

| Field | Type | Required | What it is for |
| --- | --- | --- | --- |
| `store` | `MemoryStore` | yes | The only stateful seam. Vector DB, SQL, markdown vault. `search` owns its own ranking, which is why backends are interchangeable. |
| `llm` | `MemoryLLM` | yes | `({ system, user }) => Promise<string>`. Extraction + reconciliation. Use a **cheap** model — both prompts are short and JSON-only. |
| `clock` | `Clock` | yes | `{ now(), setTimeout(fn, ms) }`. Every timestamp and TTL. Makes writes deterministic in tests. |
| `generateId` | `() => string` | yes | New record ids. |
| `embedder` | `Embedder` | no | `embed(texts, 'add' \| 'search' \| 'update')`. Needed for cosine recall; without it both reference stores fall back to substring matching. |
| `hashFn` | `HashFn` | no | Content hash for dedup. Default `defaultHashFn` (WebCrypto SHA-256 hex). |
| `logger` | `{ warn(m, f?) }` | no | Currently only link expansion warns here. |

```ts
// memory-seams.ts — build once at startup, reuse everywhere.
import { generateText } from '@deuz-sdk/core';
import { createEmbedder, type MemoryLLM, type MemorySeams } from '@deuz-sdk/core/memory';
import { createSqliteStores } from '@deuz-sdk/core/stores/sqlite';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createGoogleEmbedding } from '@deuz-sdk/core/google';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const googleEmbed = createGoogleEmbedding({ apiKey: process.env.GOOGLE_API_KEY! });

// SQLite implements findByHash + deleteExpired: dedup and the TTL sweep become
// single statements instead of full scans.
export const stores = createSqliteStores({ path: './agent.db' });

const llm: MemoryLLM = async ({ system, user }) => {
  const { text } = await generateText({
    model: anthropic('claude-haiku-5'),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return text;
};

export const seams: MemorySeams = {
  store: stores.memory,
  embedder: createEmbedder(googleEmbed('gemini-embedding-001')),
  llm,
  clock: { now: () => Date.now(), setTimeout: (fn, ms) => (setTimeout(fn, ms), () => {}) },
  generateId: () => crypto.randomUUID(),
};
```

Already have a RAG embedder? `memoryEmbedderFromRag(ragEmbedder, { modelId })` adapts the `@deuz-sdk/core/rag` `Embedder` shape (`embed(texts) => number[][]`) to this one. The task `action` is dropped, so prefer `createEmbedder` when your provider distinguishes query from document embeddings (Gemini does). Without `modelId`, written records are pinned to `embeddingModelId: 'unknown'`.

## Scope is mandatory, and it is a filter — not a namespace

`MemoryScope` has five optional fields — `userId`, `agentId`, `runId`, `actorId`, `chatId` — and at least one must be set or `assertScope` throws. `matchesScope` compares **exactly**, and only over the fields the *query* sets: a `{ userId }` query matches every record with that `userId` whatever else it carries; `{ userId, chatId }` matches only records written in that chat. There is no hierarchy and no wildcard.

**Write with the narrowest scope you might ever want to filter on; read with the widest you want to see.** Writing `{ userId, chatId }` and recalling with `{ userId }` gives cross-conversation memory that can still be pruned per conversation. Writing `{ userId }` alone throws that away permanently. Reconciliation is scoped too, so two scopes can hold contradicting facts forever and nothing will notice.

## The `memory:` call option

Set `memory` on any `streamChat` / `generateText` call and the loop recalls before the first model call and extracts after the run. Setting it **routes even a tool-less call through the agentic loop**, so `step-start` / `step-finish` parts appear on the stream.

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `seams` | `MemorySeams` | — | Required. |
| `scope` | `MemoryScope` | — | Required. |
| `recall` | object \| `false` | on | Retrieve before the first model call. `false` disables. |
| `recall.topK` | `number` | `5` | Breadth handed to `store.search`; also fixes the link-expansion budget (`2 × topK`). |
| `recall.header` | `string` | `'Relevant memories:'` | First line of the spliced block. |
| `recall.scorer` | `MemoryScorer \| 'default'` | raw store ranking | `'default'` selects `defaultMemoryScorer` (recency · importance · relevance) without importing it. |
| `recall.maxChars` | `number` | unbounded | Hard `slice` on the **rendered** block. A context budget, not a relevance control. |
| `recall.expandLinks` | `number` | `0` | Graph hops out of the primary hits. |
| `extract` | `{ infer?: boolean }` \| `false` | on | `infer: false` stores raw turns verbatim: zero LLM, zero embed calls. |
| `writePolicy` | `'each-turn' \| 'session-end' \| 'manual'` | `'each-turn'` | When the automatic extract may run. |
| `sweep` | `'on-extract' \| 'never'` | `'never'` | Chain `sweepExpired` after the extract pass. |

Contracts worth knowing before you rely on them:

- **Recall is a call-site splice, never history.** Computed once per run from the **last user message**, appended to the leading `system` message (or prepended as a new one), and only at the model-call site — checkpoints and `chat` persistence stay recall-free, and resume legs cannot double-inject. No user message with text ⇒ no query at all.
- **Extract is non-blocking.** It starts when the run completes. `result.memory` is a `Promise<MemoryMutation[]>` that **never rejects** and resolves `[]` on suspension, on a blocked input guardrail, or on error. The extract turns are the last user message plus the assistant/tool turns this run appended — never the whole history.
- **Both halves are best-effort.** A failing store/embedder/LLM logs through `deps.logger.error` and the chat proceeds. The default logger is a no-op, so wire one or the failure is invisible.
- **The recall block's size is added to the compaction fill estimate**, because the provider counts it even though `messages` does not contain it. Observation: `operation.*` events under subsystem `'memory'`, operations `memory.recall` and `memory.extract`, parented under the run span.

```ts
// app/api/chat/route.ts — Web-standard handler; adapt keepAlive to your platform.
import { streamChat, type LanguageModel, type Message } from '@deuz-sdk/core';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import type { MemorySeams } from '@deuz-sdk/core/memory';

declare const model: LanguageModel;
declare const seams: MemorySeams;
/** Gate the body with validateChatRequest from '@deuz-sdk/core/chat' first. */
declare function readBody(req: Request): Promise<{ messages: Message[]; userId: string; chatId: string }>;
/** after() on Next.js, ctx.waitUntil() on Workers, a no-op on a long-lived server. */
declare function keepAlive(work: Promise<unknown> | undefined): void;

export async function POST(req: Request): Promise<Response> {
  const { messages, userId, chatId } = await readBody(req);
  const result = streamChat({
    model,
    messages,
    memory: {
      seams,
      scope: { userId, chatId },
      recall: { topK: 8, scorer: 'default', maxChars: 1200 },
      sweep: 'on-extract',
    },
    signal: req.signal,
  });
  const response = toDeuzStreamResponse(result);
  keepAlive(result.consume?.()); // nobody draining the stream ⇒ nothing terminal runs
  keepAlive(result.memory); // the extract pass outlives the response body
  return response;
}
```

### `writePolicy`, exactly

`'each-turn'` extracts after every completed run and you do nothing. `'session-end'` and `'manual'` make the loop do **nothing** — you call `remember()` yourself, when the session closes or whenever you decide. They are identical at loop level: the SDK cannot observe either moment, so both simply suppress the write and hand it to you. One closing `remember(fullTranscript, …)` costs two LLM calls total instead of two per turn and reconciles against a complete conversation; the trade is that a session that never ends is never written. `extract: false` still wins over any policy. One asymmetry: under a suppressing policy `streamChat`'s `result.memory` is still present and resolves `[]`, while `generateText`'s is **absent** — read the array, never the field's presence.

### Dedup, TTL, importance, links

- **Hash dedup (write time).** An `ADD` whose content hash already exists — in this batch, among the reconciliation candidates, or in the store via the optional `findByHash` — is dropped silently, leaving no `NOOP` behind. It is **byte-exact** SHA-256: `"lives in Berlin."` and `"lives in Berlin"` are two records. Paraphrase dedup is the reconciler's job, and it only sees the top-K it retrieved — raise `RememberOptions.topK` before blaming the hash. A store without `findByHash` skips the store-level check entirely rather than scanning every record.
- **TTL.** `expiresAt` (written from `RememberOptions.ttlMs`) only **hides** a record at read time (`isExpired`). Without a sweep the store grows forever. `sweep: 'on-extract'` chains `sweepExpired(store, scope, clock)` after the extract pass — fire-and-forget, off `result.memory`, scoped to that call only. It hard-deletes even under `supersede: 'soft'`. On a backend without `deleteExpired` it is a full `list` of the scope every turn: use a cron instead. Store packs also expose an unscoped `sweepExpiredMemories()`.
- **Per-fact `importance`** (`0..1`, clamped) is what `defaultMemoryScorer` weighs; a record without it contributes `0` to that term, so a fresh trivial fact can outrank an old relevant one. **`links`** are graph edges landing on `metadata.links` — the same shape the markdown backend writes for `[[wikilinks]]`, both read back by `extractLinks(record)`, and only ever requested when you pass `RememberOptions.links: true`. Both are copied onto `ADD` events by exact text match, so an `ADD` the reconciler rephrased gets neither and an `UPDATE` keeps the previous record's importance.

**The chat option never asks for links.** The loop's automatic extract calls `remember(turns, scope, seams, { infer })` and nothing else — no `links`, no `kind`, no `ttlMs`, no `topK`, no `supersede`. So `recall.expandLinks` on an all-automatic write path traverses nothing while still paying for the `store.get` round-trips. Get links in via a manual `remember(..., { links: true })`, a hand-edited markdown vault, or your own `metadata.links` writes.

## Manual control: `remember`, `recall`, `createMemoryTools`

Use the functions directly for batch ingestion, custom recall placement (mid-prompt, or as a tool result), synchronous writes, or a query that is not "the last user message". `RememberOptions`: `infer` (default `true`), `apply` (`true`), `topK` (`5`), `supersede` (`'hard' | 'soft'`), `ttlMs`, `kind`, `customInstructions`, `customExtract`, `links`. `recall(query, seams, opts?)` opts: `scorer`, `dropExpired` (default `true`), `expandLinks` — and `MemoryQuery.asOf` / `.filter` are passed to `store.search` untouched, with no meaning of their own (both reference backends ignore them).

```ts
// manual-memory.ts — recall on every turn, write once when the session closes.
import { generateText, type LanguageModel, type Message } from '@deuz-sdk/core';
import { defaultMemoryScorer, formatMemoriesForPrompt, recall, remember,
  type MemoryScope, type MemorySeams } from '@deuz-sdk/core/memory';

declare const model: LanguageModel;
declare const seams: MemorySeams;

const scope: MemoryScope = { userId: 'u_123', chatId: 'chat-42' };

export async function turn(history: Message[], userText: string): Promise<Message[]> {
  const hits = await recall({ scope, text: userText, topK: 8 }, seams, {
    scorer: defaultMemoryScorer,
    expandLinks: 1,
  });
  // Score 0 means "no match" on both reference stores — they still return it.
  const block = formatMemoriesForPrompt(hits.filter((h) => h.score > 0), {
    header: 'What you know about the user:',
    maxChars: 1200,
  });
  const asked: Message[] = [...history, { role: 'user', content: userText }];
  const { text } = await generateText({
    model,
    messages: block ? [{ role: 'system', content: block }, ...asked] : asked,
  });
  return [...asked, { role: 'assistant', content: text }];
}

export async function onSessionEnd(transcript: Message[]): Promise<void> {
  // One pass over the whole conversation: better facts, two LLM calls total.
  await remember(transcript, scope, seams, { links: true, ttlMs: 90 * 24 * 3_600_000 });
}
```

`createMemoryTools({ scope, seams })` returns a `ToolSet` — `memory_append`, `memory_search`, `memory_update`, `memory_delete`, `memory_view` — so the model curates memory itself. It **bypasses the pipeline**: no extraction, no reconciliation, no hash dedup, and **no embedding**, so appended records score `0` against every embedded query and effectively never surface again on a vector store. `memory_update` rewrites `text` and `hash` but leaves the old vector, making the record findable by the wrong meaning. Use it on a lexically-searched store (a markdown vault), or hand the model only the read half:

```ts no-verify
const memoryTools = createMemoryTools({ scope, seams });
const tools = { memory_search: memoryTools.memory_search, memory_view: memoryTools.memory_view };
// To keep the write half, set needsApproval: true on memory_delete / memory_update first.
```

## Which store

| Store | Import | Use it when |
| --- | --- | --- |
| `createInMemoryMemoryStore()` | `@deuz-sdk/core/memory` | tests, demos, a single process that may lose everything. |
| `createMarkdownMemoryStore({ dir, vectors? })` | `@deuz-sdk/core/memory/markdown` | you want human-auditable, git-versionable memory (Node only). |
| `createSqliteStores` / `createRedisStores` / `createPostgresStores` | `@deuz-sdk/core/stores/sqlite`, `/stores/redis`, `/stores/postgres` | production. Details and trade-offs: the **persistence-durable** reference page. |

The markdown vault writes one `<id>.md` per record — YAML-ish frontmatter plus the fact as the body — and keeps embeddings out of the markdown in a hidden `.deuz-vectors.json` sidecar (`vectors: false` for a pure grep store). Its limits: every `search`/`list` parses the whole directory; it implements neither `findByHash` nor `deleteExpired`; the frontmatter parser is one `key: value` per line with flat arrays only (nested `metadata` is dropped); and there is no locking, so two processes racing on one vault corrupt the sidecar. It is the easiest place to try link expansion, because `[[wikilinks]]` you type by hand read back exactly like model-produced links.

Writing your own `MemoryStore`: `search`/`list`/`findByHash` must exclude soft-deleted records (`invalidAt != null`), `search` must honor `query.topK` and return descending scores (`recall` does not re-sort without a `scorer`), and `get(id, scope)` must return `null` on a scope mismatch — link resolution uses it as an ownership check. `update` is optional; without it a `supersede: 'soft'` invalidate degrades to a hard delete, and `memory_update` degrades to read-modify-`upsert`.

## Memory sharp edges

| Surprise | Cause | Do instead |
| --- | --- | --- |
| Recall injects unrelated facts | No embedder ⇒ substring match; the in-memory store returns score-`0` non-matches up to `topK` | Wire an `Embedder`, or filter `hit.score > 0` |
| Nothing was written on serverless | The extract pass runs after the response body ends | Keep `result.memory` alive (`after` / `waitUntil`), or `await` it |
| `expandLinks` does nothing | The chat option's extract never passes `links: true` | Write links via `remember(..., { links: true })` or a vault |
| Store grows despite `ttlMs` | `expiresAt` only hides at read time | `sweep: 'on-extract'`, or `sweepExpired` from a cron |
| Old memories vanished after a model swap | `cosineSimilarity` returns `0` on dimension mismatch, silently; `embeddingModelId` is recorded but never validated | Re-embed, or version the scope |
| `defaultMemoryScorer` ranks a trivial new fact first | Weights are fixed at `1/1/1`, `importance` defaults to `0`, and `lastAccessedAt` is never written | Implement your own one-method `MemoryScorer` |
| `result.memory` missing on `generateText` | A suppressing `writePolicy` means no pass started | Read the resolved array, not the field |

# Part 2 — Compaction

## `compaction: 'auto' | CompactionPolicy` — loop only

`compaction` lives on `CommonCallOptions`, but **it only runs inside the agentic loop**, and it is *not* one of the options that routes a call into the loop. On a single-turn `generateText` with no `tools` / `chat` / `memory` / `mcp` / `guardrails` / `verifyStep` / `doneWhen` it is accepted and inert — a silent no-op, not an error. That is what `compactMessages()` is for.

```ts no-verify
interface CompactionPolicy {
  threshold?: number;                            // 0.92 — estimated fill that triggers a pass
  keepRecentSteps?: number;                      // 4 — most recent ASSISTANT turns, untouchable
  layers?: CompactionLayer[];                    // ['prune-tool-results','prune-reasoning','summarize']
  summarizeModel?: LanguageModel;                // default: the loop's active model
  countTokens?: (messages: Message[]) => number; // 2.0 — a real tokenizer, synchronous
}
```

A pass runs at the top of **every** step including the first, so an already-oversized history is shrunk before the first request instead of after it fails. Below `threshold` the input array is returned by reference and no event is emitted. Above it, layers run in order, re-estimating after each, stopping as soon as fill drops to `threshold × 0.8` (~0.736). That gap is deliberate hysteresis — compacting back to exactly the trigger would re-trigger on the next step, and `summarize` costs a model call each time.

| Layer | Cost | Removes | Keeps |
| --- | --- | --- | --- |
| `prune-tool-results` | pure array map | old `tool_result` bodies → `[pruned N chars]` | `toolUseId`, `isError`, so the wire stays valid. Idempotent |
| `prune-reasoning` | pure array map | old assistant `reasoning` parts | The last assistant turn; never empties a message |
| `summarize` | **one model call**, metered into `result.usage` and budget stops | the oldest unprotected contiguous run | One `user` message prefixed `[Earlier conversation summarized]` |

The order is by price, not by saving; reordering is legal, but putting `summarize` first means paying on every trigger.

**Never touched, by any layer, in any mode — including forced overflow recovery:** every `system` message; the **first** `user` message; the **last** message; and everything from the `keepRecentSteps`-th-from-last **assistant** message onward (assistant messages, not loop steps — a contiguous tail, tool results included). `summarize` additionally needs at least two unprotected messages *and* a contiguous unprotected run of two, so it never orphans a `tool_use`/`tool_result` pair.

`streamChat` emits one `compaction` `StreamPart` per layer that actually changed the history (`layer`, `tokensBefore`, `tokensAfter`, optional `trigger: 'threshold' | 'manual' | 'overflow'`); `generateText` logs the same through `deps.logger.info`. `response.messages` is never a compacted rewrite — compaction acts on the effective model history only, and `prepareStep` runs *after* it, so you always get the last word.

### The rolling summary

On pass 2 the unprotected run already **begins with** the previous summary. It is pulled out, handed to the summarizer as `previousSummary`, and only the genuinely new messages are summarized — then both are replaced by one folded result. **At most one summary block ever sits in the history**; summaries never stack and a summary is never re-summarized. The slice is flattened into a single plain-text `user` message before it goes out (a slice can start with an assistant turn, which is a 400 on Anthropic), and the side call is stripped of tools, `maxSteps`, `stopWhen`, `prepareStep`, approval hooks and compaction itself so it cannot recurse. Your `onUsage` still fires — the summary really does spend tokens.

The summary is a `user` message on purpose: it splices in immediately before a protected **assistant** turn, two adjacent assistant messages merge on the wire, and that breaks Anthropic's "thinking block leads the turn" rule in a way that is very hard to trace back. A later pass recognizes it by prefix alone (user role, one text part, prefix match) — the sentinel string is internal, so do not hard-code it.

## Automatic overflow recovery

When a step's request is rejected as too long, the adapter maps it to `ContextOverflowError` and the loop **forces** a compaction pass (gate skipped, target tightened to `threshold × 0.5`) and re-runs that step once.

- It fires **even when you never set `compaction`** — a throwaway `'auto'` policy is built for that single pass and is *not* retained.
- If every layer declines (the forced pass returns the input by reference), the original error is rethrown. One retry per step: a second overflow in the same step propagates verbatim.
- It is a **loop** feature: on a single-turn call there is no step to retry, so a `ContextOverflowError` there is final — catch it and call `compactMessages` yourself.

| Adapter | Surface | Overflow signal |
| --- | --- | --- |
| Anthropic | `anthropic` | HTTP `413`, or a `400` whose **message** matches ("prompt is too long", "exceed…context", "input length…maximum") |
| OpenAI-compatible | `chat_completions` | `error.code` / `error.type` = `context_length_exceeded` |
| OpenAI Responses | `responses` | Same signal — its `mapError` delegates to the `chat_completions` one |
| Google native | `native` | **Not mapped.** An over-long request is a generic `InvalidRequestError` and the run ends |

**The Gemini native wire is the stated 2.0 limit.** On `native` there is no recovery at all, so set `compaction` explicitly there — the threshold path never depends on error mapping. The Anthropic path being a message regex also means a proxy that rewrites error strings falls out of it, and an OpenAI-compatible host that omits the code has the same gap as Gemini.

## `compactMessages()` — a pure function over a history you own

```ts no-verify
function compactMessages(
  messages: Message[],
  policy?: CompactionOption,   // default 'auto'
  deps?: CompactMessagesDeps,  // { summarize?, estimateTokens?, contextWindow?, onSkip? }
): Promise<CompactMessagesResult>;  // { messages, events, trigger: 'manual' | 'threshold' }
```

**With no `summarize` dep it makes no network call at all** — the summarize layer is skipped and the two pruning layers do their work for free. The one behavioral fork is `contextWindow`: supplied ⇒ threshold mode (loop semantics, early stop at `threshold × 0.8`, `trigger: 'threshold'`); omitted ⇒ **force** mode, where every layer runs exactly once with no early stop, including the paid one if you supplied a summarizer (`trigger: 'manual'`). Pass a `contextWindow` whenever you know it. It never throws (a failing summarizer skips its layer and calls `onSkip`), untouched messages keep reference equality so a React state or prompt cache survives, `events` only reports layers that **changed** something, `durationMs` is always `0` (this module injects no clock), and the EMA calibration never runs — a policy `countTokens` is the entire estimate, multiplied by a factor pinned at `1.0`.

```ts
// own-your-history.ts — one turn at a time, no loop, so you own both jobs.
import { compactMessages, ContextOverflowError, generateText,
  type LanguageModel, type Message } from '@deuz-sdk/core';

declare const model: LanguageModel;
declare const summarizer: LanguageModel;
declare function renderTranscript(slice: Message[]): string;

// previousSummary is the rolling summary already in the history: FOLD into it.
const summarize = async (slice: Message[], previousSummary?: string): Promise<string> =>
  (
    await generateText({
      model: summarizer,
      prompt: previousSummary
        ? `Running summary:\n${previousSummary}\n\nNew:\n${renderTranscript(slice)}\n\nFold the new transcript into the summary.`
        : `${renderTranscript(slice)}\n\nSummarize this transcript.`,
    })
  ).text;

export async function turn(history: Message[], userText: string): Promise<Message[]> {
  let asked: Message[] = [...history, { role: 'user', content: userText }];
  // Free and local (no summarizer ⇒ no network call): shrink BEFORE asking.
  asked = (await compactMessages(asked, 'auto', { contextWindow: 200_000 })).messages;
  try {
    const { text } = await generateText({ model, messages: asked });
    return [...asked, { role: 'assistant', content: text }];
  } catch (err) {
    if (!(err instanceof ContextOverflowError)) throw err;
    // The estimate was wrong. Force mode + a summarizer, then exactly one retry.
    const forced = await compactMessages(asked, 'auto', { summarize });
    if (forced.messages === asked) throw err; // every layer declined; nothing left to give
    const { text } = await generateText({ model, messages: forced.messages });
    return [...forced.messages, { role: 'assistant', content: text }];
  }
}
```

## `countTokens` — and why the default is a calibrated heuristic

Nothing ships a tokenizer. The default estimate is a cheap linear character model — roughly `+4` framing per message, `length / 3.6` for text/reasoning, `1600` flat per image, `JSON.stringify(payload).length / 3.6 + 10` per `tool_use`/`tool_result`, `8` for anything unrecognized — with one per-run **EMA correction factor** starting at `1.0`, updated as `factor ← factor × (0.7 + 0.3 × actual/estimated)` from provider-reported `inputTokens`, clamped to `[0.5, 2.0]`, ignoring degenerate samples (non-finite, zero, negative). So the **first** step of a run is uncalibrated and every step after it is progressively less wrong — exactly the window overflow recovery exists to catch. Those constants are current implementation, not a stability contract.

`CompactionPolicy.countTokens` replaces the base count only; the EMA keeps running on top of it, because no tokenizer knows the provider's request framing. Four rules: it **must be synchronous** (it runs once per step on the hot path); throwing or returning a non-finite/negative number silently degrades to the built-in heuristic for that call; a tokenizer for the wrong model family is off by a constant the EMA absorbs; and `gpt-tokenizer` / `tiktoken` are recipes — nothing in the SDK imports them. `CompactMessagesDeps.estimateTokens` is the bigger hammer: it replaces the whole estimate, calibration included.

```ts
// tuned-compaction.ts
import { generateText, type LanguageModel, type Message } from '@deuz-sdk/core';

declare const model: LanguageModel;
declare const haiku: LanguageModel;
declare const tools: import('@deuz-sdk/core').ToolSet;
declare const history: Message[];
/** Your own tokenizer — install it yourself; it is not a peer dependency. */
declare function encode(text: string): number[];

const countTokens = (messages: Message[]): number =>
  messages.reduce((total, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return total + encode(text).length + 4; // + per-message framing
  }, 0);

export async function research(): Promise<string> {
  const result = await generateText({
    model,
    messages: history,
    tools,
    maxSteps: 30, // compaction only runs inside the loop — maxSteps defaults to 1
    compaction: {
      threshold: 0.85,
      keepRecentSteps: 6,
      layers: ['prune-tool-results', 'summarize'],
      summarizeModel: haiku, // the summary does not need the frontier model
      countTokens,
    },
    // An unknown slug falls back to a 128k window (1M on the Gemini native
    // surface), so a big-context model compacts ~8x too early. State it:
    capabilities: { contextWindow: 1_000_000 },
  });
  return result.text;
}
```

## Compaction sharp edges

| Surprise | Cause | Do instead |
| --- | --- | --- |
| `compaction: 'auto'` did nothing | Single-turn call — it only runs inside the loop, and it does not route you into one | Add `tools` + `maxSteps`, or use `compactMessages` |
| Compacts immediately on a 1M-context model | Unknown slug ⇒ 128k default window | `capabilities: { contextWindow: … }` per call, or at the factory |
| `compactMessages` summarized far more than expected | No `contextWindow` ⇒ force mode: every layer runs once, no early stop | Pass `contextWindow` |
| A `ContextOverflowError` still escaped | Second overflow in the same step, every layer declined, a single-turn call, or the Gemini `native` wire | Set `compaction` explicitly; lower `threshold`; catch and `compactMessages` |
| Usage jumped with no extra visible step | The `summarize` side call is metered into the run total and budget stops | Pin `summarizeModel` to a cheap model |
| Cost after a handoff looks wrong | Compaction re-points at the active agent, but cost is still priced against the root `model.modelId` | Bound with `budget.tokens` too |

## Deep dive

- [/docs/modules/memory](/docs/modules/memory) — the whole memory module: pipeline, seams, scope, stores, tools, markdown vault, pitfalls.
- [/docs/modules/compaction](/docs/modules/compaction) — `compactMessages`, the rolling summary, overflow recovery, `countTokens`.
- [/docs/core/compaction](/docs/core/compaction) — the `compaction` call option, the three layers, protection rules, the stream part.
- [/docs/modules/stores](/docs/modules/stores) — SQLite / Redis / Postgres `MemoryStore` implementations and their trade-offs.
- [/docs/core/embeddings](/docs/core/embeddings) — `embed` / `embedMany`, the engine behind `createEmbedder`.
- [/docs/reference/whats-new-2-0](/docs/reference/whats-new-2-0) — sections 5 and 7, plus the stated overflow and token-counting limits.
- [/docs/modules/observability](/docs/modules/observability) — the `memory.*` and `compaction` observation events.
