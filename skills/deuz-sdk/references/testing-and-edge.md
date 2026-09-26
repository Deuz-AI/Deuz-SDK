<!-- verified: 2026-09-26 against @deuz-sdk/core@2.2.0 · api-contract sha256:c025621e10fd
     sources: packages/core/src/testing.ts, src/types/{config,deps,methods,stream,tool}.ts, src/internal/resolve-call.ts,
     src/core/resilience.ts, src/inference/tool-loop.ts, src/{openai,anthropic}.ts, tooling/check-runtime-compat.mjs,
     packages/core/test/{testing,tool-loop}.test.ts, docs/content/docs/advanced/edge.mdx,
     docs/content/docs/reference/compatibility.mdx, docs/content/docs/core/{dependencies,stream-chat}.mdx,
     skills/deuz-sdk/rules/pitfalls.md -->

# Testing your AI code, and deploying to the edge

**Load when:** writing tests for code that calls a model, faking a provider deterministically, scripting a tool loop or an approval pause, scoring a prompt change with an eval, or shipping a route to Cloudflare Workers, Vercel Edge, Deno or Bun.

## Part 1 — Testing

Four rules before any code:

1. **A unit test never reaches a provider.** Core reads no environment variable, so a test that forgets to inject a fake fails with `AuthenticationError` rather than silently billing you — but a machine that *has* `OPENAI_API_KEY` exported plus a factory that reads it will happily dial out. Build test models with `createMockModel`, or with a provider factory carrying `apiKey: 'test'` **and** an injected `fetch`.
2. **Assert on stream parts and result fields, never on the model's prose.** `parts.map((p) => p.type)`, `res.steps`, `res.usage.totalTokens`, `res.pendingApprovals`, `providerMetadata.deuz.stoppedBy` are all deterministic; the words are not.
3. **`@deuz-sdk/core/testing` is deterministic and edge-safe** — no timers, no ambient randomness, no logging — so the same tests run under Node, `@cloudflare/vitest-pool-workers`, Deno or Bun. It ships no `describe`/`expect`: bring your runner, and wrap the examples below (which use a local `assert` to stay runner-agnostic) in your own `it(...)`.

### Pick the fake that matches what you are testing

| What you are testing | Fake | Why this one |
| --- | --- | --- |
| tool loops, `maxSteps`, `stopWhen`, approvals, agents, handoffs, guardrails | `createMockModel` | drives the REAL adapter + loop over synthesized OpenAI Chat Completions SSE, zero network |
| what the SDK actually put on the wire (URL, headers, body), retries, HTTP error mapping | `mockFetch` / `mockFetchSequence` + `sseResponse` / `sseEvents` | you own the `Response` and every recorded request |
| timeouts, retry backoff, generated ids | `deps.clock`, `deps.generateId` | core never calls an ambient timer or `crypto.randomUUID` |
| legacy cost stops, `budget.usd`, `cost` parts | `deps.priceProvider` | legacy `costExceeds`/`budget.usd` are inert without one; native bounded USD admission requires pricing or an explicit estimate |
| warnings and degradations | `deps.logger` | the default logger is a **no-op**; `deps.logger.warn` is the complete channel |
| embeddings, image/speech/video | factory `fetch` on that provider | `createMockModel` returns a `LanguageModel`; `embed` only accepts an `EmbeddingModel` |

Injection precedence that bites in tests: **factory `fetch` wins over `deps.fetch`.** A model built with `createOpenAI({ fetch })` ignores a later `deps: { fetch }`. `createMockModel` attaches a factory `fetch`, so you cannot intercept a mock model's requests with `deps.fetch` — script the turns instead.

### `createMockModel` — the whole contract

Returns a `LanguageModel` `{ provider: 'mock', modelId: 'mock-model', surface: 'chat_completions' }` with `apiKey: 'mock'` and `baseURL: 'https://mock.invalid/v1'` already attached — **no key needed and the URL is never dialed.** One `MockResponse` is consumed per model invocation; **the last entry repeats forever**, so a one-entry script that calls a tool is an infinite tool caller — always bound it with `maxSteps` (and, if you like, `stopWhen: stepCountIs(n)`).

| Field | Type | Default / behaviour |
| --- | --- | --- |
| `MockResponse.text` | `string` | emitted as exactly **two** `text-delta` chunks (halved), so consumers see real incremental deltas |
| `MockResponse.toolCalls` | `MockToolCall[]` | `{ toolName, args, id? }`; `args` is JSON-stringified onto the wire, so `execute` receives it re-parsed |
| `MockResponse.usage` | `Partial<Usage>` | merged over 10 input / 5 output tokens; `cacheWriteTokens` / `cacheWrite1hTokens` have no Chat Completions wire form and are **ignored** |
| `MockResponse.finishReason` | `FinishReason` | `'tool_calls'` when `toolCalls` is non-empty, else `'stop'`; `'error'` / `'aborted'` have no wire form and clamp to `'stop'` |
| `MockToolCall.id` | `string` | omitted → `call_1`, `call_2`, … counting up across the model instance's lifetime — never crypto, so ids are assertable |

An empty `responses: []` yields empty turns (no text, finish `'stop'`, default usage).

```ts
import { generateText, stepCountIs } from '@deuz-sdk/core';
import type { JSONSchema, ToolSet } from '@deuz-sdk/core';
import { createMockModel } from '@deuz-sdk/core/testing';

declare function assert(ok: boolean, what: string): void; // (ok) => { if (!ok) throw … }

const cityParams: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

export async function loopExecutesToolAndFeedsResultBack(): Promise<void> {
  const seen: unknown[] = [];
  const tools: ToolSet = {
    getWeather: {
      parameters: cityParams,
      execute: async (args) => {
        seen.push(args);
        return { tempC: 22 };
      },
    },
  };

  const model = createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'getWeather', args: { city: 'Paris' } }] }, // step 1
      { text: 'Sunny in Paris.', usage: { inputTokens: 20, outputTokens: 6 } }, // step 2
    ],
  });

  const res = await generateText({
    model,
    prompt: 'weather in Paris?',
    tools,
    maxSteps: 5, // without this the call stops at finishReason 'tool_calls'
    stopWhen: stepCountIs(3), // belt and braces: the last scripted turn repeats
  });

  assert(seen.length === 1, 'tool executed exactly once');
  assert(JSON.stringify(seen[0]) === '{"city":"Paris"}', 'args parsed off the wire');
  assert(res.steps?.length === 2, 'two model turns');
  assert(res.steps?.[0]?.toolCalls[0]?.toolCallId === 'call_1', 'deterministic tool-call id');
  assert(res.text === 'Sunny in Paris.', 'final text');
  assert(res.usage.totalTokens === 41, '15 default + 26 scripted, summed across steps');
}
```

### Assert on stream parts, not on prose

`fullStream` is the canonical `StreamPart` union and is where every loop event is visible: `step-start`, `step-finish`, `tool-call`, `tool-result`, `tool-state`, `tool-approval-request`, `handoff`, `guardrail`, `compaction`, `cost`, `budget-exceeded`, `verify`, `false-finish`, `warning`, `error`, `finish`. The union is **open** — filter for what you assert, never `switch` exhaustively.

```ts
import { streamChat } from '@deuz-sdk/core';
import type { JSONSchema, StreamPart, ToolSet } from '@deuz-sdk/core';
import { createMockModel } from '@deuz-sdk/core/testing';

declare function assert(ok: boolean, what: string): void;
declare const cityParams: JSONSchema;

export async function streamEmitsTheLoopEvents(): Promise<void> {
  const tools: ToolSet = {
    getWeather: { parameters: cityParams, execute: async () => ({ tempC: 22 }) },
  };
  const model = createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'getWeather', args: { city: 'Paris' } }] },
      { text: 'Sunny in Paris.' },
    ],
  });

  // G2: streamChat returns synchronously and never throws. Do NOT await it.
  const result = streamChat({ model, prompt: 'weather?', tools, maxSteps: 5 });

  const parts: StreamPart[] = [];
  for await (const part of result.fullStream) parts.push(part); // try/catch goes HERE
  const types = parts.map((p) => p.type);

  assert(types.includes('tool-call'), 'the loop issued the call');
  assert(types.includes('tool-result'), 'the loop executed it and fed the result back');
  assert(types.filter((t) => t === 'step-start').length === 2, 'two loop steps');
  assert(types[types.length - 1] === 'finish', 'finish is always terminal');
  assert((await result.usage).totalTokens > 0, 'usage resolves after the stream ends');
}
```

Failure-path assertions: on `fullStream` an error arrives as `{ type: 'error', error }` and the stream then ends; on `textStream` the `for await` **throws** at that point; `usage` / `finishReason` **reject**; `warnings` never rejects. A `try`/`catch` around the `streamChat(...)` call itself catches nothing.

### Wire-level fakes

| Helper | Signature | Notes |
| --- | --- | --- |
| `sseResponse` | `(chunks: string[], init?: ResponseInit) => Response` | status 200 + `content-type: text/event-stream`; `init` is spread last, so `{ status: 429 }` overrides it |
| `sseEvents` | `({ event?, data, id? })[] => string` | formats `event:` / `id:` / `data:` blocks; non-string `data` is JSON-stringified |
| `mockFetch` | `(response: Response \| (() => Response)) => { fetch, calls }` | **pass a factory** if the fetch may be called twice — a `Response` body is a one-shot stream |
| `mockFetchSequence` | `((() => Response)[]) => { fetch, calls }` | one entry per call, last repeats; the retry path consumes entries |

`calls` is `{ url: string; init?: RequestInit }[]`, recorded before the response is produced — that is where you assert the request the SDK built.

Retries default to `maxRetries: 2` (three attempts) with jittered backoff scheduled on `deps.clock`, so an error-path test either sets `maxRetries: 0` or injects a clock that fires short timers immediately — never real `setTimeout`.

```ts
import { generateText } from '@deuz-sdk/core';
import type { Clock } from '@deuz-sdk/core';
import { createOpenAI } from '@deuz-sdk/core/openai';
import { mockFetchSequence, sseEvents, sseResponse } from '@deuz-sdk/core/testing';

declare function assert(ok: boolean, what: string): void;

const TURN = sseEvents([
  { data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } } },
  { data: '[DONE]' },
]);

// Fire retry backoff at once; leave the long ttft/total budgets unfired.
const fastClock: Clock = {
  now: () => 0,
  setTimeout: (fn, ms) => {
    if (ms < 60_000) fn();
    return () => {};
  },
};

export async function retriesA429ThenAssertsTheRequest(): Promise<void> {
  const { fetch, calls } = mockFetchSequence([
    () => sseResponse(['{"error":{"message":"slow down"}}'], { status: 429 }),
    () => sseResponse([TURN]),
  ]);

  const res = await generateText({
    model: createOpenAI({ apiKey: 'test', fetch })('gpt-5.2'),
    instructions: 'Be terse.',
    prompt: 'hi',
    maxRetries: 1,
    deps: { clock: fastClock },
  });

  assert(calls.length === 2, 'one retry after the 429');
  assert(String(calls[1]?.url).endsWith('/chat/completions'), 'wire route');
  const body = JSON.parse(String(calls[1]?.init?.body)) as { messages: { role: string }[] };
  assert(body.messages[0]?.role === 'system', 'instructions ride the wire system channel');
  assert(res.text === 'ok', 'normalized text');
}
```

### Testing an approval pause and a resume

Client-mode approval = a tool with `needsApproval` and **no** `approveToolCall`. The loop breaks *before* executing anything in that batch: `generateText` returns `pendingApprovals: ToolApprovalRequest[]`, `streamChat` emits a `tool-approval-request` part per gated call and then `finish`. Resume by calling again with the pending assistant turn in the history plus `approvalResponses`.

Legacy sharp edges to pin in the test (native resume keeps missing verdicts suspended; see `references/native-execution.md`): a pending call with **no matching verdict is DENIED**, not left pending; unknown `approvalId`s are ignored (replay-safe); a denied call gets an `is_error` tool_result and the loop continues; under `approvalSigner` an approval must echo the request's `token` or it is denied.

```ts
import { generateText } from '@deuz-sdk/core';
import type { JSONSchema, Message, ToolApprovalResponse, ToolSet } from '@deuz-sdk/core';
import { createMockModel } from '@deuz-sdk/core/testing';

declare function assert(ok: boolean, what: string): void;

export async function pausesForApprovalThenResumes(): Promise<void> {
  let deploys = 0;
  const tools: ToolSet = {
    deploy: {
      parameters: { type: 'object', properties: { env: { type: 'string' } } } as JSONSchema,
      needsApproval: true,
      execute: async () => {
        deploys += 1;
        return { ok: true };
      },
    },
  };

  // One model instance across both legs: leg 1 consumes turn 1, leg 2 turn 2.
  const model = createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'deploy', args: { env: 'prod' } }] },
      { text: 'Deployed to prod.' },
    ],
  });
  const history: Message[] = [{ role: 'user', content: 'ship it' }];

  const paused = await generateText({ model, messages: history, tools, maxSteps: 5 });
  assert(deploys === 0, 'gated tool did NOT run');
  assert(paused.pendingApprovals?.length === 1, 'one pending approval');
  assert(paused.pendingApprovals?.[0]?.toolName === 'deploy', 'named the gated tool');

  const verdicts: ToolApprovalResponse[] = (paused.pendingApprovals ?? []).map((req) => ({
    approvalId: req.approvalId,
    approved: true,
    token: req.token, // required to approve when approvalSigner is set; undefined otherwise
  }));

  const resumed = await generateText({
    model,
    // response.messages carries the assistant turn holding the unanswered tool_use.
    messages: [...history, ...paused.response.messages],
    tools,
    approvalResponses: verdicts,
    maxSteps: 5,
  });

  assert(deploys === 1, 'approved call executed on the resume leg');
  assert(resumed.text === 'Deployed to prod.', 'loop continued to a final answer');
}
```

For a durable pause (`session: { store, runId }`), the same break also writes a `'suspended'` checkpoint carrying `pendingApprovals`; resume with `resumeFromCheckpoint` / `resumeStreamFromCheckpoint` (`@deuz-sdk/core/durable`) instead of rebuilding the history yourself, and assert the persisted checkpoint through `createInMemorySessionStore`.

### Evals: `runEval` and `runGradedEval`

Both are sequential and deterministic (no timers, no logging) and neither judges anything — you supply `check`. For an LLM judge, call `generateObject` inside a `check`.

| | `runEval(cases, run)` | `runGradedEval(cases, run)` |
| --- | --- | --- |
| Case shape | `EvalCase<I, O>`: `{ name, input, expected?, check? }` | `GradedCase<I>`: `{ name, input, subtasks }` |
| Pass rule | custom `check` wins → else `JSON.stringify` deep-equal vs `expected` → else passes if `run` returns | weighted share of `subtasks` that passed (`weight` default 1; 0/negative/NaN fall back to 1) |
| `run` throws | case fails, message on `EvalCaseResult.error` | case scores 0, message on `error`, subtasks never run |
| `check` throws | case fails, message captured | reported as `failures: ['label: message']`, never crashes the suite |
| No subtasks | n/a | scores **0** with `error: 'no subtasks'`, and `run` is not invoked |
| Report | `{ score: passed/total, total, passed, results }` | `{ score, results }` — `score` is the plain **mean of case scores** |
| Empty `cases` | `score: 0` | `score: 0` |

Use `runGradedEval` when comparing two prompts: binary grading collapses the ranking, because "4 of 5 subtasks done" and "0 of 5" both read as one failure.

```ts
import { runGradedEval } from '@deuz-sdk/core/testing';
import type { GradedCase } from '@deuz-sdk/core/testing';

declare const summarize: (input: string) => Promise<{ title: string; bullets: string[] }>;

export async function gradeSummaries(): Promise<number> {
  const cases: GradedCase<string>[] = [
    {
      name: 'release-note',
      input: 'we shipped x, y and z',
      subtasks: [
        { name: 'titled', weight: 2, check: (o) => (o as { title: string }).title !== '' },
        { name: 'three bullets', check: (o) => (o as { bullets: string[] }).bullets.length === 3 },
      ],
    },
  ];
  const report = await runGradedEval(cases, summarize);
  return report.score; // 0..1
}
```

### Other determinism knobs

`deps.generateId` pins request ids, tool-call fallback ids **and retry jitter** (backoff derives from it). `deps.clock` pins timeouts and backoff. `resolveDependencies(partial)` returns the same `ResolvedDependencies` the inference layer builds, if you want to assert defaults. `deps.observer` (`createMemoryObserver` from `@deuz-sdk/core/observe`) gives a full typed event log to assert a run's shape without touching the stream — await `result.observation?.settled` first.

## Part 2 — Edge and other runtimes

### What "edge-safe" buys you

The core touches only APIs that exist in every modern JS runtime: `fetch`, Web Streams, `TextEncoder`/`TextDecoder`, WebCrypto, timers, `atob`/`btoa`. There are no `node:*` imports, no `Buffer`, no `process` — including no `process.env`. Everything stateful is a `Dependencies` seam with a Web-API default: `deps.clock` instead of ambient `Date.now`/`setTimeout`, `deps.generateId` instead of `crypto.randomUUID`, `deps.logger` instead of `console`. The same build ships to Node 22+, Cloudflare Workers, Vercel Edge, Deno, Bun and the browser; every release bundles root, `/edge`, provider, native `/agent`, `/swarm`, `/ops`, `/evolve` and `/schedule` consumers with esbuild's browser platform and fails if the graph reaches a Node-only module.

Consequence you must design for: **you read the key, core never does.** Pass it to the factory (`createAnthropic({ apiKey })`), to `createClient({ apiKeys })`, or resolve it per call with `deps.keyProvider` (async and refreshing — the Vertex OAuth case).

### The `@deuz-sdk/core/edge` subpath

A curated re-export subset with a contractual promise: nothing Node-only can ever be in it, so a bundler failure is a build error rather than a 3 a.m. production throw. It carries `streamChat`, `generateText`, `generateObject`, `streamObject` (no `embed`/`embedMany`), `tool`, `agentTool`, `createAgent`, `handoff`, the stop conditions (`stepCountIs`, `hasToolCall`, `totalTokensExceed`, `costExceeds`), the request gate and chat engine (`validateChatRequest`, `parseDeuzChatRequest`, `uiFromMessages`, `applyUIPart`, `createInMemoryChatStore`, …), durable resume (`resumeFromCheckpoint`, `resumeStreamFromCheckpoint`, `resumeDeuzChatResponse`, `createInMemorySessionStore`, `createApprovalSigner`), observation (`createMemoryObserver`, `createCallbackObserver`, `composeObservers`, `filterObserver`, `summarizeRun`) and the OTel bridge, the guardrail built-ins (`promptInjectionGuardrail`, `maxOutputLength`, `maxToolResultLength`), the hosted search tools, and every canonical type.

Deliberately **not** on `/edge`, though each is itself edge-safe — import from its own subpath: the provider factories (`@deuz-sdk/core/anthropic`, …), `embed`/`embedMany` and the error subclasses (`RateLimitError`, `TimeoutError`, …) from the root, `toDeuzStreamResponse` and friends from `@deuz-sdk/core/ui`, plus the native APIs on `@deuz-sdk/core/agent`, `@deuz-sdk/core/swarm`, and (2.2) `@deuz-sdk/core/ops`, `@deuz-sdk/core/evolve`, `@deuz-sdk/core/schedule`, then `@deuz-sdk/core/pricing`, `@deuz-sdk/core/middleware`, `@deuz-sdk/core/rag`, `@deuz-sdk/core/memory`, `@deuz-sdk/core/skills`, `@deuz-sdk/core/mcp`, `@deuz-sdk/core/guardrails`, `@deuz-sdk/core/image`, `@deuz-sdk/core/speech`, `@deuz-sdk/core/transcription`, `@deuz-sdk/core/video`. The root entry is edge-safe too; `/edge` is the narrower locked promise.

### The complete list of Node-only subpaths

These twenty reach the filesystem, a database driver, a child process, or a Node-only peer. Never import them from an edge runtime. Their `node:*` imports are **lazy**, so the module often imports fine and throws at the first call — a Worker bundle can build and fail in production (Cloudflare's bundler fails earlier when `nodejs_compat` is off). The two injected-client store packs still import a Node-only module path even when you hand them a client; the seams (`RedisClientLike`, `PgClientLike`) are plain objects, so an HTTP-driver-backed store reaches the edge only when the implementation lives in **your** module.

| Node-only subpath | Needs | Edge-safe counterpart |
| --- | --- | --- |
| `@deuz-sdk/core/rag/node` | `unpdf` / `mammoth` / `xlsx` peers | `@deuz-sdk/core/rag` (text, markdown, CSV parse in core) |
| `@deuz-sdk/core/skills/node` | `node:fs/promises`, `node:path` | `@deuz-sdk/core/skills` + `staticSkillSource` / `fetchSkillSource` |
| `@deuz-sdk/core/memory/markdown` | `node:fs/promises`, `node:path` | `@deuz-sdk/core/memory` + `createInMemoryMemoryStore` |
| `@deuz-sdk/core/chat/node` | `node:fs/promises` | `createInMemoryChatStore`, or your own `ChatStore` |
| `@deuz-sdk/core/observe/node` | `node:fs/promises` (JSONL) | `createMemoryObserver` / `createCallbackObserver` |
| `@deuz-sdk/core/runtime/node` | `node:fs/promises` | `createInMemoryRunStore` (`@deuz-sdk/core/runtime`) |
| `@deuz-sdk/core/workspace/node` | `node:fs/promises` | `createInMemoryWorkspace` (`@deuz-sdk/core/workspace`) |
| `@deuz-sdk/core/compute/node` | child process | none — implement the `ComputeSandbox` seam against a remote sandbox |
| `@deuz-sdk/core/browser/node` | `playwright` | none — implement the `BrowserController` seam against a remote browser |
| `@deuz-sdk/core/mcp/stdio` | child process + `@modelcontextprotocol/sdk` | `@deuz-sdk/core/mcp` (HTTP / SSE transport) |
| `@deuz-sdk/core/mcp/node` | `node:fs` (0600 token file), `node:http` (loopback redirect) | `inMemoryTokenStore`, or your own `TokenStore` |
| `@deuz-sdk/core/vertex/node` | Application Default Credentials | `createServiceAccountKeyProvider` (`@deuz-sdk/core/vertex`, edge-safe JWT signing) |
| `@deuz-sdk/core/swarm/sqlite` | `node:sqlite` (or an injected database) | `createInMemorySwarmStore` or your own atomic `SwarmStore` |
| `@deuz-sdk/core/swarm/postgres` (2.2) | an injected `PgClientLike` | `createInMemorySwarmStore` or your own atomic `SwarmStore` |
| `@deuz-sdk/core/ops/sqlite` (2.2) | `node:sqlite` (or an injected database) | `createInMemoryLeaseProvider` (`/ops`), `createInMemoryAgentRunStore`, `createInMemoryBudgetStore` (`/agent`) |
| `@deuz-sdk/core/ops/postgres` (2.2) | an injected `PgClientLike` | the same in-memory implementations, or your own seams |
| `@deuz-sdk/core/evolve/sqlite` (2.2) | `node:sqlite` (or an injected database) | `createInMemoryPopulationStore` (`/evolve`) |
| `@deuz-sdk/core/stores/sqlite` | `node:sqlite` (or an injected `SqliteDatabaseLike`) | implement the four store seams yourself |
| `@deuz-sdk/core/stores/redis` | `redis` peer (or an injected `RedisClientLike`) | implement `RedisClientLike` over an HTTP driver, in your own module |
| `@deuz-sdk/core/stores/postgres` | `pg` peer (or an injected `PgClientLike`) | implement `PgClientLike` over an HTTP driver, in your own module |

### Per-runtime notes

Core needs nothing injected anywhere that provides `fetch` and Web Streams. What changes per runtime is where the key comes from and how you keep terminal effects alive.

| Runtime | Read the key | Terminal effects (`consume`) |
| --- | --- | --- |
| Cloudflare Workers | the `env` binding, 2nd arg of `fetch(request, env, ctx)` — there is no `process.env` | `ctx.waitUntil(result.consume?.() ?? Promise.resolve())` |
| Vercel Edge / Next.js edge route | `process.env.X!` (inlined at build); set `export const runtime = 'edge'` | `after(() => result.consume?.())` from `next/server` |
| Vercel Edge, non-Next | `process.env.X!` | `waitUntil(...)` from `@vercel/functions` |
| Deno / Deno Deploy | `Deno.env.get('X')`; import via `npm:` specifiers | no post-response hook — start the drain **before** returning (`void result.consume?.()`), or drain inline before you send a buffered body |
| Bun | `process.env.X`; the Node-only subpaths also work | long-lived server: `void result.consume?.()` is enough |
| Node 22+ | `process.env.X` | `void result.consume?.()`, or `await` it in a background task |

`consume()` takes its own subscription, is memoized, and never rejects — call it alongside a normal iteration safely, and always write `result.consume?.()` with the optional call. Without it, a client that disconnects means the run never reaches its terminal boundary: **no chat persistence, no checkpoint, no `onFinish`, no memory extraction.** Also settle `result.memory` and `await result.observation?.settled` on serverless before the isolate dies.

```ts
import { streamChat, validateChatRequest } from '@deuz-sdk/core/edge';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';

interface Env {
  ANTHROPIC_API_KEY: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    // Never destructure messages out of the body — it is attacker-controlled.
    const parsed = validateChatRequest(await request.json());
    if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

    const result = streamChat({
      model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-4-8'),
      instructions: 'You are a helpful assistant.',
      messages: parsed.request.messages,
      signal: request.signal,
    });

    const response = toDeuzStreamResponse(result);
    ctx.waitUntil(result.consume?.() ?? Promise.resolve()); // drain even if the client leaves
    return response;
  },
};
```

The Vercel Edge shape is the identical route with `export const runtime = 'edge'`, `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })`, and `after(() => result.consume?.())` from `next/server` in place of `ctx.waitUntil`.

### Edge gotchas that look like SDK bugs

- **`await streamChat(...)`** — it returns synchronously (G2). Awaiting it in a Worker handler wraps the result in a resolved promise and confuses nothing; `try`/`catch` around it still catches nothing. Put the guard around the `for await`.
- **A store pack imported "just for types"** — use `import type` for `SqliteStores`, `PgClientLike`, `RedisClientLike`; a value import drags the Node-only module into the edge graph.
- **MCP over stdio in a Worker** — impossible by construction; use `mcp: [{ url }]` (HTTP/SSE) and, for cross-call reuse, `deps.mcpPool` built with `createMcpPool()`.
- **RAG PDFs at the edge** — `@deuz-sdk/core/rag` parses text/markdown/CSV only. Parse binaries in a Node job and store the chunks, or send the document natively with `toNativeDocumentPart`.
- **Local model servers** (`createOllama`, `createLMStudio` from `@deuz-sdk/core/providers`) are edge-safe code but point at `localhost` — a Worker cannot reach your laptop.

## Deep dive

- [/docs/advanced/edge](/docs/advanced/edge) — the Web-APIs-only contract, the `/edge` guarantee, Node-only subpaths, per-runtime notes and a full Worker example.
- [/docs/reference/compatibility](/docs/reference/compatibility) — supported runtimes, ESM/CJS targets, custom `baseURL` rules, and the local `verify:runtime` / `verify:package` gates.
- [/docs/core/dependencies](/docs/core/dependencies) — the `Dependencies` seam, G1 key precedence, and the deterministic-test recipes (`clock`, `generateId`, custom `fetch`).
- [/docs/core/stream-chat](/docs/core/stream-chat) — the lazy pump, the never-throw contract, and `consume()` in full.
- [/docs/agents/tool-loop](/docs/agents/tool-loop) — the approval gate, client vs server mode, and what a resume leg replays.
- [/docs/agents/durable-runtime](/docs/agents/durable-runtime) — checkpoints, suspended runs, and signed approvals to assert against.
