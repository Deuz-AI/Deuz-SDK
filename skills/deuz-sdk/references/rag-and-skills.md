<!-- verified: 2026-09-26 against @deuz-sdk/core@2.2.0 · api-contract sha256:c025621e10fd
     sources: packages/core/src/{rag.ts, rag-node.ts, skills.ts, skills/node.ts, parts.ts, ui.ts, voyage.ts, node/store-postgres.ts},
     packages/core/src/internal/rerank-http.ts,
     packages/core/src/types/{tool.ts, stream.ts, methods.ts, message.ts},
     docs/content/docs/modules/{rag.mdx, skills.mdx}, skills/deuz-sdk/rules/modules.md -->

# RAG pipelines, and giving an agent skills

**Load when:** building document Q&A or retrieval over your own corpus (parsing uploads, chunking, embedding, vector or hybrid search, citations in the UI), deciding whether to retrieve at all versus attach the file to the message, or packaging reusable instructions as progressive-disclosure Agent Skills the model loads on demand.

Two modules, one shared idea: **every stateful stage is an injected seam**, and the heavy/Node-only half sits behind a `/node` subpath so the core stays edge-safe.

| Subpath | Runtime | Contains |
| --- | --- | --- |
| `@deuz-sdk/core/rag` | edge-safe, zero-dep | sniff, text/markdown/CSV parse, chunkers, BM25, RRF, retrieval, citations |
| `@deuz-sdk/core/rag/node` | Node only | `pdfParser`, `docxParser`, `xlsxParser`, `htmlToBlocks`, `defaultNodeParserRegistry` |
| `@deuz-sdk/core/skills` | edge-safe, zero-dep | `SKILL.md` parsing, registry, sources, matchers, catalog rendering, tool scoping |
| `@deuz-sdk/core/skills/node` | Node only | `nodeSkillSource` (walks directories for `<id>/SKILL.md`) |

---

# Part 1 — RAG

Pipeline: **sniff → parse → chunk → indexChunks (embed + upsert) → retrieve / hybridRetrieve → rerank → citationsFromHits**.

## First decide whether you need RAG at all

A 4-page PDF against a model with native document support does not want a vector store. `shouldSendWhole` is the pure policy for that fork; `filePart` (root export) is how the document actually rides on the message.

| Function | Signature | Notes |
| --- | --- | --- |
| `estimateTokens` | `(text, countTokens?) => number` | Defaults to `approxCountTokens` (~len/4). |
| `estimatePdfTokens` | `(pages) => number` | Flat ~700 tokens/page. |
| `modelSupportsDocuments` | `(caps: Pick<ModelCapabilities,'nativePdf'>) => boolean` | Feed it `getModelCapabilities(model)`. |
| `shouldSendWhole` | `({ estTokens, modelSupportsDocuments, contextWindow?, thresholdTokens? }) => boolean` | `thresholdTokens` default `6000`. |
| `toNativeDocumentPart` | `({ bytes?, mime, text? }) => Part` | `text` wins; a PDF becomes `{ type:'image', mediaType:'application/pdf' }`. |

Send whole when it is small and the model reads PDFs natively; chunk-and-embed when the corpus is many documents, is queried repeatedly, or exceeds the threshold. Chunking a 3-page contract only loses you its layout.

```ts
import { filePart, generateText, getModelCapabilities } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import {
  estimatePdfTokens,
  modelSupportsDocuments,
  parse,
  RagError,
  shouldSendWhole,
} from '@deuz-sdk/core/rag';
import { defaultNodeParserRegistry } from '@deuz-sdk/core/rag/node';

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');

export async function summarizePdf(bytes: Uint8Array): Promise<string> {
  let pages = 1;
  try {
    const doc = await parse(bytes, defaultNodeParserRegistry(), {
      hint: { filename: 'report.pdf' },
    });
    pages = doc.pages ?? 1;
  } catch (err) {
    // A scanned PDF has no text layer at all — the native path is the only one left.
    if (!(err instanceof RagError && err.code === 'rag_empty_text_layer')) throw err;
  }

  const sendWhole = shouldSendWhole({
    estTokens: estimatePdfTokens(pages),
    modelSupportsDocuments: modelSupportsDocuments(getModelCapabilities(model)),
  });
  if (!sendWhole) return 'chunk-and-embed instead';

  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          filePart({ data: bytes, mediaType: 'application/pdf' }),
          { type: 'text', text: 'Summarise this report.' },
        ],
      },
    ],
  });
  return text;
}
```

## Sniff and parse

`sniffMime(bytes, hint?)` reads **magic bytes**, never the extension: `{ mime, confidence: 'magic' | 'guess', container: 'zip' | 'ole' | 'none' }`. DOCX and XLSX are both ZIP containers, so bytes alone give `application/zip` — pass `hint.filename` to disambiguate, or the binary path cannot resolve a parser. `parse(bytes, registry, opts?)` sniffs then dispatches: text formats (`text/plain`, `text/markdown`, `text/csv`) are decoded inside core (BOM-stripped; CSV through the pure RFC-4180 state machine `parseCsv` + `csvToText`), binary formats need a parser in the `ParserRegistry`. It returns `ParsedDocument { text, pages?, structure?, warnings? }` where `structure` is `DocBlock[]` (`heading` / `paragraph` / `list` / `table` / `code`).

| `parse` option | Type | Effect |
| --- | --- | --- |
| `hint.filename` | `string` | Resolves ZIP → docx/xlsx and extension-less text. |
| `hint.declaredMime` | `string` | Tie-break for text formats only. |
| `minTextChars` | `number` | Minimum non-empty text layer (default `1`). |

`RagError extends DeuzError` and carries `code` plus the detected `mime`:

| `RagErrorCode` | Cause | Do |
| --- | --- | --- |
| `rag_extension_mime_mismatch` | Declared type contradicts magic bytes | Reject the upload — this is the renamed-file attack. |
| `rag_unsupported_legacy_doc` | Legacy `.doc` (OLE) | Tell the user to convert to `.docx`/PDF. |
| `rag_unsupported_mime` | Type undeterminable | Ask for a supported format. |
| `rag_parser_not_registered` | Binary MIME, empty registry | Import `@deuz-sdk/core/rag/node` and register. |
| `rag_empty_text_layer` | Parsed text under `minTextChars` | Scanned PDF — OCR, or send it natively. |

### Node parsers and their peer deps

`defaultNodeParserRegistry()` returns a registry pre-populated with all three. Each peer is **lazily imported at first invocation**, so importing `rag/node` is harmless until a parser actually runs — but install the peer you need or that first call throws.

| Parser | MIME | `npm i` |
| --- | --- | --- |
| `pdfParser` | `application/pdf` | `unpdf` |
| `docxParser` | OOXML `wordprocessingml.document` | `mammoth` |
| `xlsxParser` | OOXML `spreadsheetml.sheet` | `xlsx` |

`docxParser` also fills `structure` (via `htmlToBlocks`), so DOCX is the one format where `chunkBlocks` has real blocks to work with. `xlsxParser` renders every sheet through `csvToText`. Register your own with `createParserRegistry({ 'application/pdf': myParser })` or `registry.register(mime, parser)` — a `DocumentParser` is just `({ bytes, mime }) => Promise<ParsedDocument>`, which is also how you plug in OCR.

## Chunking

| Chunker | Input | Use when |
| --- | --- | --- |
| `chunkFixed` | `text` | You need `startOffset`/`endOffset` back (highlighting in the original), or the text has no structure. |
| `chunkRecursive` | `text` | **Default.** Splits on `DEFAULT_SEPARATORS` (`'\n\n\n'`, `'\n\n'`, `'\n'`, `'. '`, `' '`, `''`) only when a piece exceeds the budget, then packs and adds overlap. Pass `separators` for domain markup. |
| `chunkBlocks` | `DocBlock[]` | You have `doc.structure` (DOCX, your own HTML) — it flushes before every `heading`, so a section never bleeds into the next. |

`ChunkOptions` is shared: `size` (default `512`), `overlap` (default `64`), `countTokens` (default `approxCountTokens`, ~len/4). `DEFAULT_CHUNK_OPTIONS` exposes `{ size: 512, overlap: 64 }`. Only `chunkFixed` records offsets; `chunkRecursive` and `chunkBlocks` do not.

> **`Chunk.index` is the identity key.** RRF fuses rankings by `index`, `citationsFromHits` reports it as `chunkIndex`, and the BM25 index is built over a chunk array positionally. Build the vector index and the BM25 index from the **same array**, and never renumber after indexing. Put stable provenance (`meta.id`, `meta.sourceId`, `meta.url`, `meta.title`) on `chunk.meta` before indexing — those four keys are exactly what citations read back.

## The Embedder seam

RAG's `Embedder` is deliberately **not** an `EmbeddingModel`. It is `{ embed(texts: string[]): Promise<number[][]>; readonly dims: number }`, and you bridge a real model into it with `embedMany` — which is also the only place `taskType` can be set. Sharp edge: `Embedder.embed` takes no query-vs-document argument. If your provider distinguishes them (Voyage `input_type`, Gemini `RETRIEVAL_*`), build **two** `Embedder` values — one with `taskType: 'search_document'` for `indexChunks`, one with `'search_query'` for `retrieve`/`hybridRetrieve` — or accept symmetric embeddings. Going the other way, `memoryEmbedderFromRag(ragEmbedder, { modelId })` (`@deuz-sdk/core/memory`) reuses one RAG embedder as the memory module's `Embedder`, so a single embedding budget serves both.

## Index, retrieve, hybrid

`indexChunks(chunks, { embedder, store })` embeds every chunk's text and upserts. `retrieve(query, { embedder, store, reranker? }, { topK?, topN? })` embeds the query, pulls `topK` from the store (default `8`), reranks to `topN` (default `topK`).

`hybridRetrieve` runs the dense and BM25 stages in parallel and fuses their **rankings** with Reciprocal Rank Fusion — raw cosine and BM25 scores are on incomparable scales, so only rank order is used. It adds `perStageK` (candidates from each stage, default `topK`) and `rrfK` (RRF damping, default `60`) to `RetrieveOptions`. Reach for it whenever queries mix natural language with exact tokens ("clause 17", a SKU, a person's name) — pure dense search blurs rare terms. If nothing is indexed densely yet it degrades to lexical-only rather than returning nothing.

`createBm25Index(chunks, { k1?, b?, tokenize? })` is Okapi BM25 (`k1` default `1.5`, `b` default `0.75`), returning `{ search(query, topK): ScoredChunk[]; size }`; `reciprocalRankFusion(rankings, { k?, topN? })` is exposed separately when you fuse three or more rankings yourself.

```ts
import { embedMany } from '@deuz-sdk/core';
import { createVoyage } from '@deuz-sdk/core/voyage';
import {
  chunkRecursive,
  createBm25Index,
  createMemoryVectorStore,
  createParserRegistry,
  hybridRetrieve,
  indexChunks,
  parse,
  type Embedder,
  type ScoredChunk,
} from '@deuz-sdk/core/rag';

const model = createVoyage({ apiKey: process.env.VOYAGE_API_KEY! })('voyage-3.5');

const forIndexing: Embedder = {
  dims: 1024,
  embed: async (texts) =>
    (await embedMany({ model, values: texts, taskType: 'search_document' })).embeddings,
};
const forQueries: Embedder = {
  dims: 1024,
  embed: async (texts) =>
    (await embedMany({ model, values: texts, taskType: 'search_query' })).embeddings,
};

export async function ingestAndAsk(bytes: Uint8Array, question: string): Promise<ScoredChunk[]> {
  // Empty registry is enough for text/markdown/CSV — no Node parser needed.
  const doc = await parse(bytes, createParserRegistry(), { hint: { filename: 'handbook.md' } });
  const chunks = chunkRecursive(doc.text, { size: 400, overlap: 50 }).map((c) => ({
    ...c,
    meta: { sourceId: 'handbook', title: 'Employee handbook' },
  }));

  const store = createMemoryVectorStore();
  await indexChunks(chunks, { embedder: forIndexing, store });
  const bm25 = createBm25Index(chunks); // SAME array — Chunk.index must line up

  return hybridRetrieve(question, { embedder: forQueries, store, bm25 }, { topK: 8, topN: 4 });
}
```

**`createMemoryVectorStore()` is a reference implementation: process-local, unbounded, gone on restart.** Nothing in the store packs (`@deuz-sdk/core/stores/postgres` and friends) is a RAG `VectorStore` — they give you memory/chat/session/run stores. For production, implement the two-method seam over your own database (pgvector, Qdrant, Turbopuffer, D1 + a vector index):

```ts no-verify
interface VectorStore {
  upsert(items: EmbeddedChunk[]): Promise<void>;      // EmbeddedChunk = Chunk & { embedding: number[] }
  query(vector: number[], topK: number): Promise<ScoredChunk[]>;  // ScoredChunk = Chunk & { score: number }
}
```

`Bm25Index` is the same story at scale — pure, in-memory, rebuilt per process. For a large corpus back the lexical stage with your own search engine behind the same `search(query, topK): ScoredChunk[]` shape.

## The reranker seam — read this before you trust `topN`

`retrieve` and `hybridRetrieve` accept `reranker?: Reranker`. **The default, `identityReranker`, is not a reranker**: it sorts candidates by the score they already had and truncates to `topN`. If precision@3 matters, over-fetch (`topK: 40`) and let a cross-encoder pick the few. Two hosted ones ship (2.2): `createCohereReranker` from `@deuz-sdk/core/rag` (`POST https://api.cohere.com/v2/rerank`, default `rerank-v4.0-pro`) and `createVoyageReranker` from `@deuz-sdk/core/voyage` (`POST https://api.voyageai.com/v1/rerank`, default `rerank-2.5`).

```ts
import { createCohereReranker } from '@deuz-sdk/core/rag';
import type { ScoredChunk } from '@deuz-sdk/core/rag';

// A stand-in for the network so this runs offline; drop `fetch` in production.
const fakeFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.92 }, { index: 0, relevance_score: 0.11 }] }), {
    headers: { 'content-type': 'application/json' },
  });

const reranker = createCohereReranker({ apiKey: 'test-key', fetch: fakeFetch });
const candidates: ScoredChunk[] = [
  { index: 0, text: 'Shipping takes 5 days.', score: 0.8 },
  { index: 1, text: 'Refunds are issued within 14 days.', score: 0.7 },
];
const top = await reranker.rerank('How long do refunds take?', candidates, 1);
console.log(top); // [{ index: 1, text: 'Refunds are issued…', score: 0.92 }]
```

- Settings (both factories): `apiKey` (outranked by `deps.keyProvider.getKey('cohere' | 'voyage')`; neither → `AuthenticationError` before any request), `model`, `topK` (cap: returns `min(topN, topK)`), `baseURL` (`/rerank` appended), `fetch` (wins over `deps.fetch`), `headers`, `deps` (only `fetch` / `keyProvider` are read).
- It returns the **original chunks** with `score` replaced by the provider's relevance score, best first; the input array is not mutated; an index outside the list is rejected, not guessed. Empty candidates or `topN: 0` make no request.
- Errors are the usual classes: 429 `RateLimitError` (`retryAfterMs`), 401/403 `AuthenticationError`, other 4xx `InvalidRequestError`, 5xx retryable `APICallError`, transport `NetworkError`. **One request, no retries** — wrap it if you want them.
- Anything else (a local cross-encoder) implements the seam directly: `rerank(query, candidates: ScoredChunk[], topN): Promise<ScoredChunk[]>`, returning the array re-sorted is the entire contract.

## Citations, and how they reach the UI

`citationsFromHits(hits, { snippetLength? })` maps `Chunk`/`ScoredChunk` hits to canonical `CitationPart[]`. `snippetLength` defaults to `200` (`0` omits the snippet). `id` comes from `meta.id`, falling back to `chunk-${index}`; `sourceId`, `url` and `title` are lifted from `meta` when they are non-empty strings; `chunkIndex` is `Chunk.index`; `score` rides along when the hit has one.

Two delivery routes, and they land in different places on the client:

| Route | Server call | Client |
| --- | --- | --- |
| Canonical wire part | `ctx.emitPart?.(part)` from inside a retrieval tool's `execute` | `useChat().citations` (typed, reconciled per turn) |
| App data part | `createDeuzStream(result).writeData('citations', parts)` | `useChat().dataParts` / `onData({ name, payload })` |

Prefer `emitPart`. It is present only when the parent call is streaming (`streamChat`), which is exactly the case where a UI is watching; under `generateText` it is `undefined` and the optional call is a no-op.

```ts
import { streamChat, tool } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import {
  citationsFromHits,
  hybridRetrieve,
  type Bm25Index,
  type Embedder,
  type VectorStore,
} from '@deuz-sdk/core/rag';

declare const embedder: Embedder;
declare const store: VectorStore;
declare const bm25: Bm25Index;

const searchHandbook = tool({
  description: 'Search the employee handbook for passages relevant to a question.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  execute: async (args, ctx) => {
    const { query } = args as { query: string };
    const hits = await hybridRetrieve(query, { embedder, store, bm25 }, { topK: 8, topN: 4 });
    // Provenance goes on the SAME stream the answer streams over.
    for (const part of citationsFromHits(hits, { snippetLength: 240 })) ctx.emitPart?.(part);
    return hits.map((h) => ({ chunkIndex: h.index, text: h.text }));
  },
});

export function POST(req: Request): Response {
  const result = streamChat({
    model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8'),
    instructions: 'Answer only from retrieved passages. Search before you answer.',
    messages: [{ role: 'user', content: 'What is the refund window?' }],
    tools: { searchHandbook },
    maxSteps: 6, // the default is 1 — without this the tool is requested and never run
    signal: req.signal,
  });
  return toDeuzStreamResponse(result);
}
```

Retrieving inside a tool (rather than stuffing context into the prompt before the call) is the better default: the model decides whether and what to search, can search twice, and the citations attach to the turn that used them.

---

# Part 2 — Agent Skills

An Agent Skill is a directory holding a `SKILL.md`: a leading `---` YAML frontmatter fence (`name`, `description`, optional `license`, optional `allowed-tools`) plus a markdown body, and optionally bundled resource files beside it. The point is **progressive disclosure** — a large library of capabilities without paying tokens for all of it up front.

| Level | What loads into context | API |
| --- | --- | --- |
| 1 — Catalog | `id` + `name` + `description` only | `registry.catalog()` → `renderSkillCatalog(...)` |
| 2 — Trigger | The parsed frontmatter + body | `registry.trigger(id)` → `SkillManifest` |
| 3 — Resource | One bundled file next to the skill | `registry.resource(id, relPath)` → `Uint8Array \| string` |

**The model triggers; you do not.** `registry.match()` only prunes a catalog before you render it — it is not a hidden router and never loads a body by itself.

```text
skills/pdf-filler/SKILL.md
---
name: pdf-filler
description: Fill in PDF forms from structured data.
license: MIT
allowed-tools:
  - Read
  - Bash(python:*)
---

Read the template, map fields, then run the fill script. See forms/w2.json.
```

`parseSkill(raw, opts?)` returns `{ manifest, issues }` and **never throws on content**. `splitFrontmatter` only treats the *first* `---` fence as frontmatter, so the body may contain its own rules and code fences. `allowed-tools` normalizes to `manifest.allowedTools` from a block list, a flow list `[Read, Write]`, or a comma scalar. Unknown frontmatter keys survive untyped under `manifest.metadata`. The built-in YAML parser is a deliberate subset (scalars, quoted strings, block/flow lists, `|`/`>` blocks) — pass `parseYaml` to `parseSkill` or `createSkillRegistry` to swap in a real one.

Validation is advisory, collected not enforced: `validateSkillName` requires `^[a-z0-9-]{1,64}$` with no `anthropic`/`claude` substring and no `<`/`>`; `validateSkillDescription` requires non-empty, ≤1024 chars, no `<`/`>`. Both return `SkillValidationIssue[]` (empty = valid). Check `issues` at authoring/CI time — nothing rejects a bad skill at runtime.

## The registry and its source seams

`createSkillRegistry({ source, matcher?, parseYaml? })` is pure orchestration over two seams; `matcher` defaults to `lexicalMatcher`. `SkillSource` is the **only** IO touchpoint: `list()`, `read(id)`, and optional `readResource(id, rel)`.

| Source | Subpath | For |
| --- | --- | --- |
| `nodeSkillSource(dirs)` | `skills/node` | Filesystem — walks each dir for `<id>/SKILL.md`; lazily imports `node:fs/promises`, throws a clear error on the edge. |
| `fetchSkillSource(baseUrl, fetch?)` | `skills` | Edge/CDN — catalog from `${baseUrl}/index.json`, body from `${baseUrl}/<id>/SKILL.md`, resources over `fetch`. |
| `staticSkillSource(map)` | `skills` | Literal `{ id: { raw, resources? } }` map — tests, a bundled built-in set. |
| `mergeSkillSources(layers, opts?)` | `skills` | Compose the above; each layer takes an optional `prefix` that namespaces ids (`proj:pdf-filler`). Earlier layers win on conflict unless `{ override: true }`. |

Anything satisfying the interface works — a Postgres table, an S3 bucket, a git checkout. Only `list` and `read` are required; without `readResource`, `registry.resource()` throws `InvalidRequestError`.

Matchers prune, they do not route. `lexicalMatcher` is zero-dep token overlap over `name + description`; `embeddingMatcher(embed)` takes the same `(texts) => Promise<number[][]>` shape the RAG `Embedder` uses and scores by cosine. Both accept `{ topK?, threshold? }` and return `SkillMatch[]` (`{ id, score }`). Default thresholds differ: `lexicalMatcher` uses `0` (drops zero-overlap candidates), `embeddingMatcher` uses `-1` (keeps everything, just ordered).

## Wiring a registry into a run

Render the pruned catalog into a `role: 'system'` message (there is no `system` option on a call), and expose Level 2/3 as tools so the model pulls what it needs.

```ts
import { generateText, tool, type ToolSet } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import {
  createSkillRegistry,
  renderSkillCatalog,
  scopeToolsToSkill,
} from '@deuz-sdk/core/skills';
import { nodeSkillSource } from '@deuz-sdk/core/skills/node';

const registry = createSkillRegistry({ source: nodeSkillSource(['./skills', './.deuz/skills']) });

declare const workTools: ToolSet; // Read / Write / Bash …

const loadSkill = tool({
  description: 'Load the full instructions for a skill by id (Level 2).',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: async (args) => (await registry.trigger((args as { id: string }).id)).body,
});

const readSkillResource = tool({
  description: 'Read a file bundled with a skill (Level 3).',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' }, path: { type: 'string' } },
    required: ['id', 'path'],
  },
  execute: async (args) => {
    const { id, path } = args as { id: string; path: string };
    const data = await registry.resource(id, path); // traversal-guarded
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
  },
});

export async function run(question: string): Promise<string> {
  // Level 1 only: prune a big catalog to the plausible few, then render it.
  const top = await registry.match(question, { topK: 5 });
  const catalog = (await registry.catalog()).filter((c) => top.some((m) => m.id === c.id));

  const { text } = await generateText({
    model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8'),
    messages: [
      {
        role: 'system',
        content: `Trigger a skill with load_skill when one applies.\n${renderSkillCatalog(catalog)}`,
      },
      { role: 'user', content: question },
    ],
    tools: { load_skill: loadSkill, read_skill_resource: readSkillResource, ...workTools },
    maxSteps: 8, // the default is 1
  });
  return text;
}

/** Narrow the tool surface for a follow-up call once a skill is committed to. */
export async function toolsForSkill(id: string): Promise<ToolSet> {
  const manifest = await registry.trigger(id);
  return scopeToolsToSkill(workTools, manifest.allowedTools);
}
```

`renderSkillCatalog(candidates)` emits `<available_skills>\n- name (id): description\n</available_skills>`, and returns `''` for an empty array — concatenating it blindly is safe.

`scopeToolsToSkill(tools, allowedTools)` intersects a `ToolSet` **by key**: `'Bash(python:*)'` matches the key `Bash` and the inner pattern is advisory metadata core does not enforce; `undefined` means "no restriction" and passes the full set through. It cannot narrow a run that is already in flight — call it when you build the `tools` for the next call (or inside `prepareStep`), and enforce the inner pattern yourself if it matters.

`normalizeResourcePath(rel)` is the traversal guard behind every Level-3 read: it rewrites `\` to `/`, strips a leading `./`, and throws `InvalidRequestError` on any `..` segment or leading `/`. Both `fetchSkillSource` and `nodeSkillSource` route through it, so a bundled-file read cannot escape the skill directory. Still treat a skill body as untrusted input if it came from a third party — it is instructions going straight into your prompt.

## Sharp edges

- `parse` rejects a renamed upload (`rag_extension_mime_mismatch`) — surface it as a 400, do not retry — and a ZIP with no `hint.filename` cannot be resolved to docx or xlsx, failing with `rag_unsupported_mime`.
- `chunkRecursive`/`chunkBlocks` do not set `startOffset`/`endOffset`; only `chunkFixed` does.
- Chunk arrays for the vector store and the BM25 index must be the same array, in the same order, or RRF fuses unrelated chunks and citations point at the wrong text.
- `identityReranker` is a sort-and-truncate, not a rerank model; use `createCohereReranker` / `createVoyageReranker` or your own `Reranker`.
- `createMemoryVectorStore` and `createBm25Index` are process-local; nothing persists them for you, and the `rag/node` peers (`unpdf`, `mammoth`, `xlsx`) are lazy — a missing install fails at first parse, not at import.
- `ctx.emitPart` is `undefined` outside a streaming parent call, so citations silently vanish under `generateText`.
- `nodeSkillSource` and every `*/node` subpath throw on Edge/Workers; use `fetchSkillSource` there.
- `parseSkill` never throws on bad content — an invalid skill loads silently unless you read `issues`.
- The bundled YAML parser is a subset; anchors, nested maps and multi-line flow collections need an injected `parseYaml`.
- `registry.match` never triggers anything, and `renderSkillCatalog` never loads a body — Level 2 only happens because a tool called `trigger`.

## Deep dive

- [/docs/modules/rag](/docs/modules/rag) — the full RAG pipeline in prose, with the parser, chunker, retrieval and native-document sections.
- [/docs/modules/skills](/docs/modules/skills) — Agent Skills end to end: format, registry, sources, matchers, tool scoping, path safety.
- [/docs/core/embeddings](/docs/core/embeddings) — `embed` / `embedMany`, the `EmbeddingModel` kind, `taskType` and dimension truncation.
- [/docs/modules/ui-streaming](/docs/modules/ui-streaming) — the `citation` and `data-{name}` wire parts and how a client reads them.
- [/docs/agents/tool-loop](/docs/agents/tool-loop) — how `maxSteps` and tool execution work around a retrieval or skill-loading tool.
- [/docs/core/files](/docs/core/files) — `filePart` / `imagePart` and per-wire document support.
