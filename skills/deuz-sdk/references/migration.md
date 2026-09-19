<!-- verified: 2026-09-20 against @deuz-sdk/core@2.1.0 · api-contract sha256:c301da6ab500
     sources: skills/migrate-from-ai-sdk/SKILL.md, skills/migrate-from-ai-sdk/rules/{imports,streaming,tools,ui,telemetry,providers}.md,
     docs/content/docs/migration/from-vercel-ai-sdk.mdx, docs/content/docs/reference/whats-new-2-0.mdx,
     packages/core/src/types/{config,guardrails}.ts, packages/core/src/{autonomy,rag,memory,middleware,durable,runtime}.ts,
     packages/core/src/inference/{handoff,agent-tool}.ts, packages/core/src/node/store-sqlite.ts -->

# Porting from the AI SDK, LangChain, LangGraph or LlamaIndex

**Load when:** an existing app already imports `ai` / `@ai-sdk/*`, `langchain` / `@langchain/*`, `@langchain/langgraph` or `llamaindex` and you have to move it onto `@deuz-sdk/core` — or when someone asks "what is the Deuz equivalent of X?" for a name from one of those frameworks.

## Verification status

| Column | Trust |
| --- | --- |
| Every `@deuz-sdk` name and subpath here | Verified against `references/api-index.md` and the source. |
| The **AI SDK** column in §1 | Verified against `ai@7.0.40` docs on 2026-07-28. That project renames aggressively across majors — read the app's `package.json` first; a v4/v5/v6 app uses different names. |
| The **LangChain / LangGraph / LlamaIndex** columns in §2–§4 | **Concept mappings only.** There is no in-repo source for those frameworks, so the left column is not machine-verified. Match by behaviour, not by name. |

There is **no codemod** for any of these ports. Port by hand, in the order given, keeping the app compiling at each step. When a name in the source app is not in a table here, do **not** invent a Deuz equivalent — check `references/api-index.md`, and if it is not there, say so.

---

## 1. Vercel AI SDK (`ai`, `@ai-sdk/*`)

### The four decisions to make before editing a file

1. **Keys become explicit.** Core reads no environment variable and has no hosted gateway (it must run unchanged on Workers). Read `process.env` at the app layer and pass `apiKey` to a factory, or use `deps.keyProvider`. Nothing supplied is `AuthenticationError`, not a fallback.
2. **The UI wire is incompatible — the route and its client move in the same commit.** Deuz does not speak the AI SDK's UI message protocol; `toDeuzStreamResponse` emits SSE stamped `x-deuz-stream: v2`, read by `readDeuzStream` / `connectDeuzStream` / `useChat` from `@deuz-sdk/react`. You cannot point the AI SDK's `useChat` at a Deuz route, or the reverse. Half a port is a broken chat.
3. **`maxSteps` defaults to 1.** An AI SDK agent loops by default; a Deuz call with `tools` and no `maxSteps` runs one turn and returns `finishReason: 'tool_calls'` with no answer. This is the single most common porting bug — add an explicit bound to every tool-using call.
4. **`generateObject` / `streamObject` still exist and are single-turn.** AI SDK 7 folded them into `Output.object({ schema })` on `generateText`. Deuz keeps them as their own functions, and they raise `InvalidRequestError` for loop options (`tools`, `maxSteps > 1`, `stopWhen`, `memory`, `session`, `mcp`, …) before any network call. If the source passed `tools` alongside `Output.object`, split it: run the loop with `generateText`, then structure its `text` with `generateObject`.

### Porting order

Each step leaves the app compiling.

1. **Providers** — `@ai-sdk/*` imports become Deuz factory subpaths; thread keys in.
2. **Core calls** — `streamText` → `streamChat`, `generateText` → `generateText`, `Output.object` → `generateObject`. Add `maxSteps`.
3. **Tools** — `inputSchema` → `parameters`; `ToolExecutionOptions` → `ToolExecuteContext`.
4. **Agents** — `ToolLoopAgent` → `createAgent`; `WorkflowAgent` → `session:` + `resumeFromCheckpoint`.
5. **Routes + client together** — `toUIMessageStreamResponse` → `toDeuzStreamResponse`, and add `validateChatRequest`.
6. **Telemetry** — `@ai-sdk/otel` + `registerTelemetry()` → `createOtelTracer` / `createOtelObserver` through `deps` (no global registration). Then **delete `ai` and `@ai-sdk/*`** from `package.json`, and install only the optional peers you actually use.

### Name-by-name

| Vercel AI SDK (7.x) | `@deuz-sdk/core` |
| --- | --- |
| `streamText` / `generateText` | `streamChat` (sync return, never throws, lazy pump) / `generateText` |
| `generateText({ output: Output.object({ schema }) })` | `generateObject({ schema })`; the streaming form is `streamObject` → `partialObjectStream` |
| `result.stream` (`fullStream` pre-7) / `result.consumeStream()` | `result.fullStream` / `result.consume?.()` |
| `result.totalUsage` / `result.finalStep` | `result.usage` (summed across steps and sub-agents) / `result.steps?.at(-1)` (`steps` is `undefined` on a single-turn call) |
| `instructions` (`system` pre-7) / `abortSignal` | `instructions` / `signal` (`abortSignal` accepted, deprecated; `signal` wins) |
| `tool({ inputSchema, execute })` | `tool({ parameters, execute })` |
| `stopWhen: isStepCount(n)` | `maxSteps: n`, or `stopWhen: stepCountIs(n)` |
| `onStepEnd` / `onEnd` | `onStepFinish` / `onFinish` (`onUsage` is separate) |
| `toolApproval` (`needsApproval` pre-7) | `needsApproval` on the tool + `approveToolCall` (server) or `approvalResponses` (client) |
| `ToolExecutionOptions` / `ToolCallOptions` | `ToolExecuteContext` |
| `ToolLoopAgent` / `WorkflowAgent` | `createAgent` (`@deuz-sdk/core/agent`, a frozen value, no `new`) / `session: { store, runId }` + `resumeFromCheckpoint` |
| `result.toUIMessageStreamResponse()` / `toTextStreamResponse()` | `toDeuzStreamResponse(result)` / `toDeuzTextStreamResponse(result)` (`@deuz-sdk/core/ui`) |
| `createUIMessageStream` + a `data-*` write | `createDeuzStream(result).writeData(name, payload, { id?, transient? })` |
| `useChat` / `useObject` (`@ai-sdk/react`) | `useChat` / `useObject` (`@deuz-sdk/react`) |
| `convertToModelMessages(messages)` | nothing — Deuz's `useChat` POSTs canonical `Message[]` already |
| — | `validateChatRequest(body)` (`@deuz-sdk/core/chat`) — **add** this to every ported route |
| `wrapLanguageModel` | `wrapModel(model, [...])` — first array element is outermost |
| `customProvider` / gateway string ids | `createProviderRegistry({...})` (`@deuz-sdk/core/providers`) — local lookup, zero network |
| `createMCPClient` | `createMcpClient` (`@deuz-sdk/core/mcp`), or just the `mcp:` call option |
| `MockLanguageModelV4` (`ai/test`) | `createMockModel` (`@deuz-sdk/core/testing`) |
| `@ai-sdk/anthropic` / `/openai` / `/google` / `/openai-compatible` | `@deuz-sdk/core/anthropic` / `/openai` / `/google`, and `createOpenAICompatible({ id, baseURL })` on `/providers` — one package, one subpath each |

Stream part names differ too: `tool-input-delta` → `tool-call-delta`, `start-step` / `finish-step` → `step-start` / `step-finish`. Everything else keeps its name, and `StreamPart` is an **open** union — keep a `default` case.

### Rows that older mapping tables get wrong at 2.0

Mapping tables written before 2.0 list these as "absent" — including older copies of the companion `migrate-from-ai-sdk` skill. They exist. Verify each against `references/api-index.md` before you tell a user something is missing.

| AI SDK feature | 1.9-era claim | The truth at 2.0 |
| --- | --- | --- |
| `transcribe` | "Absent — no audio entry point" | `transcribe` on `@deuz-sdk/core/transcription`, with `createOpenAITranscription` and `createDeepgram`. |
| `generateSpeech` | "Absent" | `generateSpeech` on `@deuz-sdk/core/speech`, with `createOpenAISpeech` and `createElevenLabs`. |
| `experimental_generateVideo` | "Absent as a function" | `@deuz-sdk/core/video`: `generateVideo`, plus the explicit `submitVideo` → `waitForVideo` → `downloadVideo` flow and `createVideoProvider`. |
| `contextSchema` / `toolsContext` / `runtimeContext` | "Absent — close over what the tool needs" | `runtimeContext` is a real call option: an opaque per-call value threaded untouched into `ToolExecuteContext.runtimeContext`, `prepareStep`, `verifyStep`, `doneWhen` and all three guardrail hooks; sub-agents inherit it. It never reaches checkpoints, chat records or observation events, so a DB handle or a secret is safe there. (`contextSchema` / `toolsContext` — a *typed* per-tool injection — still have no equivalent.) |
| `@ai-sdk/otel` / `registerTelemetry()` | "No package — write a `deps.tracer` adapter by hand" | `@deuz-sdk/core/otel`: `createOtelTracer`, `createOtelObserver`, `otelReady`. `@opentelemetry/api` is a lazy optional peer. Two deliberate differences: no global registration (thread it through `deps`), and content capture is opt-in and always redacted. |
| `@ai-sdk/devtools` | "Absent" | No server, but there is a viewer: `renderRunReport(events)` (`@deuz-sdk/core/observe`) returns one self-contained HTML document, and `writeRunReport` (`@deuz-sdk/core/observe/node`) renders it from a `createJsonlObserver` JSONL file. |

### Genuinely absent — flag these up front

| AI SDK feature | Status |
| --- | --- |
| `useCompletion`; Svelte / Vue / Angular bindings | No equivalent. Use `useChat` against a single-turn route, or drive `readDeuzStream` yourself. Only `@deuz-sdk/react` ships — the wire is plain SSE, so another binding is writable, but nothing ships one. |
| `Output.array()` / element streaming | `streamObject` streams growing partials of **one** object; there is no per-element stream. |
| `contextSchema` / `toolsContext` (typed per-tool context) | `ToolExecuteContext` is a fixed shape. Use `runtimeContext` (untyped, per call) or close over what the tool needs. |
| Codemods (`@ai-sdk/codemod`) | None. This file and the `migrate-from-ai-sdk` skill are the replacement. |
| Hosted gateway / plain string model ids | Deliberately absent. `createProviderRegistry` is a local descriptor lookup with zero network. |
| `result.warnings` parity | Populated on all four calls, in two shapes: a `Promise<CallWarning[]>` on `streamChat` / `streamObject` (settles with `usage`, never rejects, `[]` when clean) and a plain `CallWarning[]` on `generateText` / `generateObject` with the key omitted when empty — so read `result.warnings ?? []` after a port. One gap: the buffered loop's `activeTools` notices reach `deps.logger.warn` only, and the default logger is a no-op, so wire one during the port. |

---

## 2. LangChain → plain function composition

**Concept mapping** (see the verification table above). LangChain's abstractions mostly collapse into ordinary TypeScript: a chain is a function, a prompt template is a template literal, a parser is `generateObject`.

| LangChain | `@deuz-sdk/core` |
| --- | --- |
| LCEL `prompt \| llm \| parser`, `RunnableSequence` | plain `async function` composition over the six call functions |
| `ChatPromptTemplate` / `PromptTemplate` | a template literal for `prompt`, plus `instructions` for the system slot |
| `.withStructuredOutput(schema)`, `StructuredOutputParser`, `JsonOutputParser` | `generateObject({ schema })` — one repair retry, then `NoObjectGeneratedError` |
| `RunnableParallel` / `RunnableMap` | `Promise.all`, or `parallelAgents` (`@deuz-sdk/core/autonomy`) when each branch is its own agent |
| `AgentExecutor`, `createToolCallingAgent` | `tools` + an explicit `maxSteps` on `generateText` / `streamChat` |
| `DynamicStructuredTool`, `@tool` | `tool({ description, parameters, execute })` — `parameters`, never `inputSchema` |
| `VectorStoreRetriever`, `MemoryVectorStore`, `PGVector` | `@deuz-sdk/core/rag`: `createMemoryVectorStore` + `retrieve`, or `createPostgresStores` for a real database |
| `TextSplitter` / `RecursiveCharacterTextSplitter`, document loaders | `chunkRecursive` / `chunkFixed` / `chunkBlocks`, and `parse` + `createParserRegistry` (`/rag`; `defaultNodeParserRegistry` on `/rag/node` for PDF/DOCX/XLSX/HTML, Node only) |
| `EnsembleRetriever` / BM25 hybrid | `hybridRetrieve` + `createBm25Index` + `reciprocalRankFusion` (`/rag`) |
| `ConversationBufferMemory` / `ConversationSummaryMemory` | `compaction: 'auto'` — in-conversation trimming, a different problem from long-term memory |
| `VectorStoreRetrieverMemory`, mem0 | `@deuz-sdk/core/memory` + the `memory:` call option (`recall` before, `extract` after) |
| `BaseCallbackHandler`, `callbacks: [...]` | `deps.observer` — one versioned `ObserveEvent` protocol; `createCallbackObserver` is the adapter |
| `llm.withFallbacks([...])` / `set_llm_cache` | `withFallback(models, hooks?)` (or `fallbackModels:` on the call) / `simpleCache({ ttlMs?, now?, keyFn? })` — both on `@deuz-sdk/core/middleware` |
| `RunnableWithMessageHistory` | `chat: { store, chatId, scope }` + a `ChatStore` pack |

A chain, ported. `wrapModel` returns a thin client with `model` pre-bound, **not** a `LanguageModel` — and it exposes only `streamChat` and `generateText`, so a structuring pass takes the bare descriptor. Middleware order is outermost-first:

```ts
import { generateObject, wrapModel, simpleCache, withFallback } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createOpenAI } from '@deuz-sdk/core/openai';
import { z } from 'zod';

const base = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');
const alt = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })('gpt-5.2');

// `prompt | llm | parser` is two awaits and a function boundary.
const chain = wrapModel(base, [
  withFallback([alt]), // was: llm.withFallbacks([...])
  simpleCache({ ttlMs: 60_000 }), // was: set_llm_cache(InMemoryCache())
]);

declare const ticket: string;
const { text } = await chain.generateText({
  instructions: 'You triage support tickets.', // was: the ChatPromptTemplate system slot
  prompt: `Triage this ticket:\n\n${ticket}`, // was: the human slot — the template literal IS the template
});
const { object } = await generateObject({
  model: base, // wrapModel exposes only streamChat/generateText — pass the descriptor
  prompt: `Structure this triage note:\n${text}`,
  schema: z.object({ severity: z.enum(['low', 'high']), summary: z.string() }),
});
console.log(object.severity); // typed
```

Retrieval, ported. RAG's `Embedder` is `{ embed(texts): Promise<number[][]>, dims }` — a two-line adapter over `embedMany`, not a provider class:

```ts
import { embedMany } from '@deuz-sdk/core';
import { createOpenAIEmbedding } from '@deuz-sdk/core/openai';
import {
  chunkRecursive, citationsFromHits, createMemoryVectorStore, indexChunks, retrieve,
  type Embedder,
} from '@deuz-sdk/core/rag';

const embeddingModel = createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY! })(
  'text-embedding-3-small',
);
const embedder: Embedder = {
  dims: 1536,
  async embed(texts) {
    const { embeddings } = await embedMany({ model: embeddingModel, values: texts });
    return embeddings;
  },
};

declare const sourceText: string;
declare const question: string;

const store = createMemoryVectorStore(); // or createPostgresStores(...) for pgvector
await indexChunks(chunkRecursive(sourceText, { size: 512, overlap: 64 }), { embedder, store });
const hits = await retrieve(question, { embedder, store }, { topK: 5 });
const citations = citationsFromHits(hits, { snippetLength: 200 }); // canonical `citation` parts
console.log(hits.length, citations.length);
```

Sharp edges when porting LangChain:

- **`ConversationBufferMemory` is not `@deuz-sdk/core/memory`.** In-conversation trimming is `compaction` (and it only runs inside the agentic loop — a silent no-op on a single-turn call); cross-session facts are the `memory:` option. Porting the first onto the second buys an LLM call per turn and no benefit.
- **`rerank` is `identityReranker` by default** — it sorts by existing score and slices. There is no cross-encoder in the box; supply your own `Reranker` if the chain relied on one.
- Callbacks that mutated state are not portable: `deps.observer` is read-only reporting. Anything that has to *change* the run is `prepareStep`, a guardrail, or `verifyStep`.

---

## 3. LangGraph → the agentic loop

**Concept mapping.** LangGraph's model is an explicit graph over a state object; Deuz's is one loop whose behaviour you shape with hooks. Most graphs whose only job was "call the model, run the tools, repeat" become a single call with `maxSteps`.

| LangGraph | `@deuz-sdk/core` |
| --- | --- |
| `StateGraph` + `addNode` / `addEdge` for a tool-calling agent | one `generateText` / `streamChat` call with `tools` + `maxSteps` |
| `ToolNode` / `tools_condition` | built in — the loop executes tools, feeds results back, self-heals a thrown `execute` into an `is_error` `tool_result` |
| per-node prompt / model / tool swap | `prepareStep(ctx) => { messages?, activeTools?, toolChoice?, model? }` |
| conditional edge back to the agent node | `doneWhen(ctx) => boolean` — reject a premature finish and re-drive (budget: `falseFinishGuard`) |
| conditional edge to a validation node | `verifyStep(ctx) => { ok, feedback?, retry? }` — bounded by `maxVerifyAttempts` |
| conditional edge to `END` | `stopWhen: [stepCountIs(n), hasToolCall(name), totalTokensExceed(n), costExceeds(usd), durationExceeds(ms)]`, OR-ed with `maxSteps` |
| a guard node that refuses input / blocks a tool / censors output | `guardrails: { onInput, onToolCall, onOutput }` returning `pass` / `block` / `rewrite` |
| `MemorySaver` / `SqliteSaver` / `PostgresSaver` checkpointer | `session: { store, runId }` + a `SessionStore` from `createSqliteStores` / `createPostgresStores` / `createRedisStores` (or `createInMemorySessionStore`) |
| `thread_id`, `graph.get_state` / `update_state` after a crash | `chat: { store, chatId, scope }` for the conversation, `session.runId` for the run, then `resumeFromCheckpoint(store, runId, options)` (`@deuz-sdk/core/durable`) |
| `interrupt()` + `Command(resume=…)` | `needsApproval` on the tool, then `pendingApprovals` / `tool-approval-request` parts, then `approvalResponses` on the resuming call |
| `Send(...)` map-reduce; best-of-N / self-consistency | `parallelAgents({ model, tasks, concurrency })`, `bestOfN({ n, generate, score })`, `selfConsistency` (`@deuz-sdk/core/autonomy`) |
| supervisor (delegate, get an answer back) | `agentTool(def)` or `agent.asTool()` — a nested loop returning its final text |
| swarm / handoff (the other agent takes over) | `handoff({ name: agent }, { maxHandoffs })` — mints `transfer_to_<name>` tools; system prompt, tools and model become the target's and the history travels |
| planning nodes / task-list state | `planTasks`, `createTaskList`, `setTaskStatus`, `nextPendingTask` (`/autonomy`) |
| LangGraph Platform threads, run store, background runs | `@deuz-sdk/core/runtime` (`createRunManager`, `createInMemoryRunStore`, `createSteeringController`; `createFileRunStore` and `pollStaleRuns` on `/runtime/node`) + `@deuz-sdk/core/durable` |

The graph a port usually starts from — an agent node, a tool node, a conditional edge and a checkpointer:

```ts no-verify
// LangGraph — the thing being replaced
const graph = new StateGraph(MessagesAnnotation)
  .addNode('agent', callModel)
  .addNode('tools', new ToolNode([search]))
  .addEdge('__start__', 'agent')
  .addConditionalEdges('agent', toolsCondition)
  .addEdge('tools', 'agent')
  .compile({ checkpointer: new SqliteSaver(db) });
```

All of it is one call. `prepareStep` is the per-node swap, `doneWhen` / `verifyStep` are the conditional edges back, `session` is the checkpointer:

```ts
import { generateText, tool, stepCountIs } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createSqliteStores } from '@deuz-sdk/core/stores/sqlite';
import { promptInjectionGuardrail } from '@deuz-sdk/core/guardrails';
import { z } from 'zod';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const stores = createSqliteStores({ path: './agent.db' }); // was: SqliteSaver

const search = tool({
  description: 'Search the knowledge base',
  parameters: z.object({ query: z.string() }),
  execute: async (args) => ({ hits: [args.query] }),
});

declare const runId: string;
declare const userId: string;

const res = await generateText({
  model: anthropic('claude-opus-4-8'),
  instructions: 'Research the question, then answer it. End your final answer with DONE.',
  prompt: 'Which of our SKUs shipped late last quarter?',
  tools: { search },
  maxSteps: 12, // the loop the graph used to draw
  stopWhen: [stepCountIs(12)], // was: the conditional edge to END
  prepareStep: ({ stepIndex }) => (stepIndex === 0 ? { activeTools: ['search'] } : undefined),
  doneWhen: ({ text }) => text.includes('DONE'), // was: the "are we finished?" edge
  verifyStep: ({ text }) =>
    text.length > 40 ? { ok: true } : { ok: false, feedback: 'Too short — cite the SKUs.' },
  guardrails: { onInput: promptInjectionGuardrail() }, // was: a guard node
  session: { store: stores.sessions, runId }, // checkpoint at every step boundary
  runtimeContext: { userId }, // travels to every tool, hook and guardrail
});

console.log(res.text, res.providerMetadata?.deuz?.stoppedBy);
```

Human-in-the-loop. `interrupt()` becomes a gated tool plus a resumed call — the run breaks, you persist nothing extra (the checkpoint already has it), and you come back with verdicts:

```ts
import { generateText, tool, type ToolApprovalResponse } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createInMemorySessionStore, resumeFromCheckpoint } from '@deuz-sdk/core/durable';
import { z } from 'zod';

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');
const sessions = createInMemorySessionStore();
const refund = tool({
  description: 'Refund an invoice',
  parameters: z.object({ invoiceId: z.string() }),
  needsApproval: true, // was: interrupt() before the side effect
  execute: async (args) => ({ refunded: args.invoiceId }),
});
const call = { model, tools: { refund }, maxSteps: 6 };

const first = await generateText({
  ...call,
  prompt: 'Refund invoice INV-42.',
  session: { store: sessions, runId: 'r1' },
});

// The loop BROKE here: `first.pendingApprovals` holds the calls awaiting a verdict.
declare const askAHuman: (toolName: string) => Promise<boolean>;
const verdicts: ToolApprovalResponse[] = [];
for (const p of first.pendingApprovals ?? []) {
  verdicts.push({ approvalId: p.approvalId, approved: await askAHuman(p.toolName) });
}

// Resume — positional (store, runId, options), NOT a single options object.
const done = await resumeFromCheckpoint(sessions, 'r1', { ...call, approvalResponses: verdicts });
console.log(done.text);
```

Fan-out (`Send` + a reducer node), sample-and-select, and the supervisor/swarm split — none of which needs a graph:

```ts
import { agentTool, generateText, handoff } from '@deuz-sdk/core';
import { createAgent } from '@deuz-sdk/core/agent';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { bestOfN, parallelAgents } from '@deuz-sdk/core/autonomy';

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');

// map: one independent agent per task, concurrency-capped, usage summed.
const tasks = ['section A', 'section B', 'section C'];
const fan = await parallelAgents({ model, tasks, concurrency: 3, system: 'Summarize it.' });
// reduce: fold the branches yourself — `fan.results` is a plain array, in task order.
const joined = fan.results.map((r) => r.text).join('\n');
const merged = await generateText({ model, prompt: `Merge these:\n${joined}` });
// sample-and-select, where the graph would have looped a scoring node.
const gen = async () => (await generateText({ model, prompt: 'Name the release.' })).text;
const picked = await bestOfN<string>({ n: 3, generate: gen, score: (c) => -c.length }); // higher wins

// SUPERVISOR: delegate and come BACK — the parent keeps the run.
const researcher = agentTool({ name: 'researcher', description: 'Research it', model, maxSteps: 8 });
// SWARM: transfer the run — the target's instructions, tools and model take over
// and the whole history travels with it.
const billing = createAgent({ name: 'billing', model, instructions: 'You handle refunds.' });

const res = await generateText({
  model,
  instructions: 'You are the front desk.',
  prompt: 'I was double charged — and what did we ship in March?',
  tools: { researcher, ...handoff({ billing }, { maxHandoffs: 3 }) },
  maxSteps: 10,
});
console.log(merged.text, picked.best, res.text);
```

Sharp edges when porting LangGraph:

- **A gated tool call with no verdict on resume is DENIED**, not left pending. Send a verdict for every `approvalId`; unknown ids are ignored (replay-safe). Client-mode approval inside a sub-agent is unsupported — pass `approveToolCall` on the outermost call instead.
- **Sub-agents do not inherit `guardrails`** (`agentTool` forwards `runtimeContext`, the approver and the signal — not the hooks). A `handoff` *does* keep them, because it changes the active agent, not the run.
- **Only agentic calls checkpoint** (a single-turn call has no step boundaries), and **nothing finishes unless someone drains the stream**: on `streamChat`, checkpoints, persistence and `onFinish` run off the lazy pump — `after(() => result.consume?.())` on Next.js, `ctx.waitUntil(...)` on Workers.
- **`stopWhen` does not change `finishReason`** — read `providerMetadata.deuz.stoppedBy` (also `'guardrail:input'` / `'guardrail:output'` / `'false-finish'` / `'budget.usd'`).
- **`costExceeds` needs `deps.priceProvider`** (`createPriceProvider(PRICES_2026)`); without one it warns once and then never fires. After a handoff, cost is still priced against the root model — bound such a run with `budget.tokens` too.

---

## 4. LlamaIndex, and the tracing vendors

**Concept mapping.** LlamaIndex's index/query-engine stack maps onto `@deuz-sdk/core/rag` plus one ordinary call — there is no `ServiceContext` and no `Settings` global, because core reads no globals at all.

| LlamaIndex | `@deuz-sdk/core` |
| --- | --- |
| `SimpleDirectoryReader` / `PDFReader`; `SentenceSplitter` | `parse` + `createParserRegistry` (`/rag`), `defaultNodeParserRegistry` / `pdfParser` / `docxParser` / `xlsxParser` (`/rag/node`, Node only); `chunkRecursive`, `chunkFixed`, `chunkBlocks` |
| `VectorStoreIndex.fromDocuments` / `index.asRetriever()` | `indexChunks(chunks, { embedder, store })` / `retrieve(query, { embedder, store, reranker? }, { topK, topN })` |
| `index.asQueryEngine().query(q)` | `retrieve(...)` then `generateText({ prompt })` — you own the prompt |
| hybrid / fusion retrieval; source attribution | `hybridRetrieve`, `createBm25Index`, `reciprocalRankFusion`; `citationsFromHits(hits)` → canonical `citation` parts |
| `Settings.llm` / `ServiceContext` | nothing global — pass `model`, or pre-bind with `createClient({ apiKeys, deps })` |
| agent runners (`FunctionCallingAgent`) | `tools` + `maxSteps`, or `createAgent` |

Observability vendors map to the same seam, not to a hosted service:

| LangSmith / Langfuse / LlamaTrace | `@deuz-sdk/core` |
| --- | --- |
| `LANGCHAIN_TRACING_V2` env auto-instrumentation | nothing ambient — `deps.observer` and/or `deps.tracer`, passed explicitly |
| a hosted trace UI | `createMemoryObserver` / `createJsonlObserver` + `summarizeRun` + `renderRunReport` (one self-contained HTML file) |
| OTLP export to a vendor | `createOtelTracer()` **or** `createOtelObserver()` — pick one, both together double-span the run |
| callback handlers | `createCallbackObserver(fn)`, composed with `composeObservers` / `filterObserver` |
| token-cost dashboards | `createPriceProvider(PRICES_2026)` + `priceUsage` + `cacheSavings` (`@deuz-sdk/core/pricing`) |

```ts
import { createClient, createPriceProvider, PRICES_2026 } from '@deuz-sdk/core';
import { composeObservers, createMemoryObserver, summarizeRun } from '@deuz-sdk/core/observe';
import { createOtelTracer, otelReady } from '@deuz-sdk/core/otel';

const memory = createMemoryObserver({ maxEvents: 5_000 });
const tracer = createOtelTracer(); // gen-ai conventions; @opentelemetry/api is a lazy peer
await otelReady(tracer); // surfaces a missing peer at startup instead of emitting nothing

export const ai = createClient({
  deps: {
    observer: composeObservers(memory),
    tracer,
    priceProvider: createPriceProvider(PRICES_2026), // costExceeds / budget.usd need this
    // The default logger is a NO-OP — without one, dropped settings are silent.
    logger: { debug() {}, info() {}, warn: console.warn, error: console.error },
  },
});
export const lastRun = () => summarizeRun(memory.latestRun() ?? []);
```

With no observer and a no-op tracer the observation runtime is never created — do not wire one "just in case" in a hot path. Content capture is opt-in (`ObservationOptions`) and always redacted; keys never reach a log, error, span or wire frame.

---

## Deep dive

- [/docs/migration/from-vercel-ai-sdk](/docs/migration/from-vercel-ai-sdk) — the full AI SDK mapping in prose, with before/after code for every surface.
- [/docs/reference/whats-new-2-0](/docs/reference/whats-new-2-0) — what 2.0 added, and the honest "known limits" list that corrects older "absent" claims.
- [/docs/agents/tool-loop](/docs/agents/tool-loop), [/docs/agents/durable-runtime](/docs/agents/durable-runtime) — the loop a `StateGraph` collapses into; checkpoints, suspend and resume.
- [/docs/agents/handoffs](/docs/agents/handoffs), [/docs/agents/subagents](/docs/agents/subagents) — swarm versus supervisor.
- [/docs/agents/guardrails](/docs/agents/guardrails), [/docs/agents/client-tools](/docs/agents/client-tools) — guard nodes, and the approval round-trip that replaces `interrupt()`.
- [/docs/modules/rag](/docs/modules/rag), [/docs/modules/memory](/docs/modules/memory), [/docs/modules/compaction](/docs/modules/compaction) — retrieval and citations; long-term memory versus in-conversation trimming.
- [/docs/modules/stores](/docs/modules/stores), [/docs/modules/autonomy](/docs/modules/autonomy), [/docs/modules/observability](/docs/modules/observability), [/docs/modules/request-validation](/docs/modules/request-validation) — the store packs; `parallelAgents` / `bestOfN` / task lists; observers and the OTel bridge; the gate every ported chat route needs.
