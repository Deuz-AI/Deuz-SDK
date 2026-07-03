# Feature modules

Each module is a set of pure seams you wire to the core inference functions. Embedders/LLMs/stores are injected — nothing reaches the network or filesystem on its own except the explicit Node loaders.

## Memory — `@deuz-sdk/core/memory` (edge) / `@deuz-sdk/core/memory/markdown` (Node)

mem0-style pipeline behind one `MemoryStore` seam. Scope (`userId`/`agentId`/`runId`/`actorId`) is mandatory — at least one or `assertScope` throws.

```ts
import { remember, recall, createInMemoryMemoryStore, createEmbedder, formatMemoriesForPrompt, type MemorySeams } from '@deuz-sdk/core/memory';
import { createOpenAIEmbedding } from '@deuz-sdk/core/openai';
import { generateText } from '@deuz-sdk/core';

const seams: MemorySeams = {
  store: createInMemoryMemoryStore(),
  embedder: createEmbedder(createOpenAIEmbedding({ apiKey: KEY })('text-embedding-3-small')),
  llm: async ({ system, user }) =>
    (await generateText({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })).text,
  clock: { now: () => Date.now(), setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } },
  generateId: () => crypto.randomUUID(),
};

await remember(messages, { userId: 'u1' }, seams);            // extract→embed→reconcile→apply
const hits = await recall({ scope: { userId: 'u1' }, text: 'preferences' }, seams);
const block = formatMemoriesForPrompt(hits);                   // splice into a system prompt
```
- `remember(messages, scope, seams, opts?)` → `MemoryMutation[]`. `opts.infer === false` stores raw turns (zero LLM/embed calls). `planMemory(...)` = `remember` with `apply: false`.
- `createMemoryTools({ scope, seams })` → a `ToolSet` (`memory_append`/`search`/`update`/`delete`/`view`) for a model-driven write path.
- Markdown backend (Node): `createMarkdownMemoryStore({ dir, vectors? })` — one `.md` per record, embeddings in a hidden `.deuz-vectors.json` sidecar.

## RAG — `@deuz-sdk/core/rag` (edge) / `@deuz-sdk/core/rag/node` (Node parsers)

```ts
import { sniffMime, parse, chunkRecursive, indexChunks, retrieve, hybridRetrieve,
         createMemoryVectorStore, createBm25Index, type Embedder } from '@deuz-sdk/core/rag';
import { defaultNodeParserRegistry } from '@deuz-sdk/core/rag/node'; // PDF/DOCX/XLSX (optional peers)

const registry = defaultNodeParserRegistry();
const doc = await parse(bytes, registry, { hint: { filename: 'spec.pdf' } });
const chunks = chunkRecursive(doc.text, { size: 512, overlap: 64 });

const embedder: Embedder = { dims: 1536, embed: async (texts) => /* number[][] */ };
const store = createMemoryVectorStore();
await indexChunks(chunks, { embedder, store });

const top = await retrieve('what is clause 17?', { embedder, store }, { topK: 8, topN: 4 });
```
Hybrid (dense cosine + BM25, fused by Reciprocal Rank Fusion) — best for mixed natural-language + exact-term queries:
```ts
const bm25 = createBm25Index(chunks);
const hits = await hybridRetrieve('clause 17 SKU-9', { embedder, store, bm25 }, { topK: 8 });
```
`Chunk.index` must stay stable across BM25 indexing and RRF. Text/markdown/CSV parse in edge core; PDF/DOCX/XLSX need the Node registry + their optional peers.

## Skills — `@deuz-sdk/core/skills` (edge) / `@deuz-sdk/core/skills/node` (Node)

Zero-dep `SKILL.md` frontmatter parser + progressive disclosure (catalog → trigger → resource).
```ts
import { createSkillRegistry, staticSkillSource, renderSkillCatalog } from '@deuz-sdk/core/skills';
import { nodeSkillSource } from '@deuz-sdk/core/skills/node';

const reg = createSkillRegistry({ source: nodeSkillSource(['./skills']) });
const catalog = await reg.catalog();          // Level 1: id/name/description only
const sys = renderSkillCatalog(catalog);       // <available_skills> block for the prompt
const skill = await reg.trigger('pdf-filler');  // Level 2: parsed manifest + body
// reg.match(query) only PRUNES the catalog — the model decides what to trigger.
```
Sources: `staticSkillSource(map)`, `fetchSkillSource(baseUrl, fetch?)` (edge), `nodeSkillSource(dirs)` (Node), `mergeSkillSources([...])`.

## MCP — `@deuz-sdk/core/mcp` (http/sse) / `@deuz-sdk/core/mcp/stdio` (Node)

`@modelcontextprotocol/sdk` is a lazy optional peer (`^1.29.0` since 1.3.0).
```ts
import { createMcpClient } from '@deuz-sdk/core/mcp';
const mcp = await createMcpClient({
  transport: { type: 'http', url: 'https://server/mcp' },
  onElicitationRequest: async (req) =>            // optional (1.3.0+): form | url union
    req.mode === 'form'
      ? { action: 'accept', content: await showForm(req.message, req.requestedSchema) }
      : { action: (await confirmOpenUrl(req.url)) ? 'accept' : 'decline' }, // NEVER auto-open req.url
});
const tools = await mcp.listTools();           // → ToolSet, ready for generateText({ tools })
const resources = await mcp.listResources();   // 1.3.0+: auto-paginated (100-page cap)
const contents = await mcp.readResource('file://x');
const prompts = await mcp.listPrompts();
const prompt = await mcp.getPrompt('greet', { name: 'u' }); // MCP's own message shape, NOT canonical Message
await generateText({ model, messages, tools, maxSteps: 5 });
await mcp.close();
```
1.3.0 behavior change: tool results with `structuredContent` return that OBJECT verbatim (was: joined text). `outputSchema` rides `Tool.outputSchema` as metadata. Resource/prompt/elicitation methods need installed SDK ≥1.29 (older SDKs get an actionable error).

## Image — `@deuz-sdk/core/image` (sync) / `@deuz-sdk/core/midjourney` (async)

```ts
import { createImageProvider, generateImage } from '@deuz-sdk/core/image';
const provider = createImageProvider({ apiKey: KEY }); // OpenAI-compatible /v1/images/generations
const { images } = await generateImage({ model: provider('gpt-image-1.5'), prompt: 'a cat', size: '1024x1024' });
// images[0].url or .b64Json (responseFormat: 'b64_json')
```
Midjourney is async (submit → poll → action) via `deps.clock.setTimeout`.

## Middleware — `@deuz-sdk/core/middleware`

```ts
import { wrapModel, logging, simpleCache, redactPII, promptInjectionGuard } from '@deuz-sdk/core/middleware';
const m = wrapModel(createAnthropic({ apiKey: KEY })('claude-opus-4-8'),
  [redactPII(), simpleCache({ ttlMs: 60_000 }), logging({ logger })]); // first = OUTERMOST
const { text } = await m.generateText({ messages });
for await (const t of m.streamChat({ messages }).textStream) write(t);
```
`wrapModel(model, middleware[])` returns `{ model, streamChat, generateText }` (model pre-bound). Each middleware can hook `transformParams` / `wrapGenerate` / `wrapStream`. `logging` is a no-op unless you pass `{ logger }`.

## Pricing — `@deuz-sdk/core/pricing`

Core only returns a token `Usage` breakdown; turning tokens into dollars is opt-in.
```ts
import { createPriceProvider, priceUsage, PRICES_2026 } from '@deuz-sdk/core/pricing';
import { createClient } from '@deuz-sdk/core';
const client = createClient({ deps: { priceProvider: createPriceProvider({ margin: 1.3 }) } });
const usd = priceUsage('gpt-5.2', usage);             // one-off; undefined for unknown models
```
`PRICES_2026` is a pinned, NON-authoritative table (USD / 1M tokens) — override per deployment with `createPriceProvider({ table })`.
