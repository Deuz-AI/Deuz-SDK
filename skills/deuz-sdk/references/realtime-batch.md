<!-- verified: 2026-10-15 against @deuz-sdk/core@2.3.0 · api-contract sha256:fb025f0c23e3
     sources: packages/core/src/realtime/{index,session,types,models,tokens,tools,usage,errors,websocket}.ts,
     packages/core/src/batch/{index,client,types,budget,store,errors,prepare,parse}.ts, packages/core/src/pricing.ts,
     docs/content/docs/modules/{realtime,batch,pricing,budgets}.mdx -->

# Realtime voice and provider batches

**Load when:** a live two-way voice conversation (microphone audio in, speech and a transcript out, tools called mid-conversation) with OpenAI Realtime or Gemini Live, minting a browser-safe token for it, or pricing it per modality; or sending many single-turn requests to a provider's batch API at batch rates, with a budget hold per request and jobs a new process can resume. Both are 2.3 and edge-safe, and both are the call shapes beyond the six functions of `references/core-calls.md`.

|  | Realtime (`@deuz-sdk/core/realtime`) | Batch (`@deuz-sdk/core/batch`) |
| --- | --- | --- |
| Shape | One long-lived WebSocket with a conversation on it | Submit now, read one result per request hours later |
| Providers | OpenAI Realtime, Gemini Live (Developer API) | OpenAI (Responses or Chat Completions), Anthropic Message Batches, Gemini batch mode |
| Tools | Yes: ordinary Deuz tools | No: single-turn requests only |
| Pricing | Per modality through `deps.priceProvider`; no realtime prices ship | The batch tier (`ModelPrice.batch`); Claude rows carded, OpenAI and Gemini not |
| Budget | None inside a session: watch `usage` and `close()` | One hold per request with an `execution` context |

**Neither is live-verified.** Both wires were derived from the providers' official SDK types (`openai` 7.32, `@anthropic-ai/sdk` 0.133, `@google/genai` 2.28) and tested offline against scripted stand-ins. Make one real call, or submit a small batch, before you rely on either; `providerOptions` and `sendRaw` (realtime) correct a field without waiting for a release.

## Realtime voice

`createRealtimeSession(options)` opens a session against a model from `createOpenAIRealtime(settings)(modelId)` or `createGeminiLive(settings)(modelId)` (settings: `apiKey`, `baseURL`, `headers`, `provider`; Gemini also `apiVersion` and `apiKeyLocation`). One normalized event model covers both wires. WebRTC (2.4), Vertex AI Live, OpenAI transcription-only sessions and SIP are not covered.

```ts
import { createOpenAIRealtime, createRealtimeSession } from '@deuz-sdk/core/realtime';
import { tool } from '@deuz-sdk/core';

declare const playback: { write(audio: Uint8Array): void; clear(): void };
declare const microphone: { on(event: 'data', listener: (chunk: Uint8Array) => void): void };

const session = createRealtimeSession({
  model: createOpenAIRealtime({ apiKey: process.env.OPENAI_API_KEY! })('gpt-realtime'),
  instructions: 'You are a friendly receptionist. Keep answers short.',
  voice: 'marin',
  inputTranscription: true, // also transcribe the caller
  tools: {
    book: tool({
      description: 'Book a table',
      parameters: { type: 'object', properties: { time: { type: 'string' } }, required: ['time'] },
      needsApproval: true, // asks approveToolCall; without one the call is denied
      execute: async (args) => ({ booked: (args as { time: string }).time }),
    }),
  },
  approveToolCall: async (call) => call.toolName === 'book',
});

session.on('audio-delta', (e) => playback.write(e.audio)); // PCM16, 24 kHz, mono
session.on('speech-started', () => playback.clear()); // the caller talks over the model: stop playing
session.on('output-transcript-done', (e) => console.log('agent:', e.transcript));
session.on('usage', (e) => console.log(e.tokens.audio, e.costUsd)); // costUsd needs a price
session.on('error', (e) => console.error(e.error.kind, e.fatal, e.error.message));

await session.connect(); // resolves on 'session-ready'
microphone.on('data', (chunk) => session.appendAudio(chunk));
```

- **Server auth** is a handshake header (`Authorization: Bearer` on OpenAI, `x-goog-api-key` on Gemini). The runtime's global `WebSocket` sends it in Node.js 22+ (and Bun, Deno 2.5+); `deps.keyProvider` wins over the factory key as everywhere.
- **The socket seam is `deps.webSocket`**: `(url, { protocols, headers }) => socket`, any object with `readyState`, `send(string)`, `close(code, reason)` and `addEventListener` for `open` / `message` / `error` / `close` — the `ws` package (`new WebSocket(url, protocols, { headers })`), or a scripted stand-in that makes a session testable offline. No `WebSocket` at all is `kind: 'no-websocket'`.
- **Events** (`session.on(type, listener)` or `'*'`, returning an unsubscribe; or `for await (const e of session.events())`, buffered from the call until `session-closed`): `session-ready`, `session-closed` (always last), `speech-started` / `speech-stopped`, `input-audio-committed`, `input-transcript-delta` / `-done`, `response-started`, `audio-delta` / `audio-done`, `output-transcript-delta` / `-done`, `text-delta` / `text-done`, `tool-call` / `tool-result`, `tool-call-cancelled`, `interrupted`, `response-done`, `usage`, `go-away` / `session-resumption` (Gemini), `warning`, `error` (`fatal: true` means the session is closing) and `raw` (with `rawEvents: true`). A throwing listener is logged, never fatal. On Gemini a transcript chunk can arrive after its turn's `response-done`, keeping that `responseId`.
- **Audio.** OpenAI takes and returns PCM16 at 24 kHz mono (G.711 through `providerOptions`); Gemini takes PCM16 at `inputSampleRate` (default 16 kHz, any rate resampled) and returns 24 kHz. `session.audioFormat` reports both. Turn detection is the provider's (server VAD) unless `turnDetection: 'manual'`: then end the turn with `commitAudio()` (and on OpenAI ask with `createResponse()`). `sendText(text, { respond? })` adds a user text turn.
- **Interruption.** Both providers cut a reply short when the user talks over it (`interrupted`: drop queued audio). On OpenAI `session.interrupt({ playedMs })` cancels the running response and truncates the assistant audio to what the user heard; Gemini has no client-side cancel, so it sends nothing there and warns once.
- **One answer at a time (OpenAI).** A `response.create` (from `sendText`, `createResponse()` or tool results) waits while a response runs; requests that pile up meanwhile become one.
- **Tools** are Deuz tools: validated, approval-gated (`approveToolCall`), timed out on `deps.clock`, and an error the model hears instead of a crash. A tool without `execute` is a client tool: answer it with `session.sendToolResult(toolCallId, result, { isError? })`. OpenAI runs only a **completed** response's calls (a cancelled or truncated one is `tool-call-cancelled`, `reason: 'response-not-completed'`); a Gemini `toolCallCancellation` aborts the tool's signal. `execute` gets `messages: []`, since the conversation lives on the provider. Provider-executed tools are dropped with an `unsupported-tool` warning.
- **Usage and pricing.** Every `usage` event carries `tokens` split by modality (`text`, `audio`, `image`, each `{ input, cachedInput, output }`) and the canonical `usage`. With `deps.priceProvider` each response is priced per modality under three keys: the model id (text), `audio:<model>` and `image:<model>`; `realtimePriceTable({ [model]: { text, audio, image? } })` builds those rows for `createPriceProvider({ table })`. **No realtime prices ship**: a response with an unpriced modality is unpriced as a whole (`costUsd` absent) and reported once per session as `unpriced-model`, and the session goes on. `session.usage` keeps running totals. There is no budget inside a session. OpenAI input transcription is billed separately.
- **Lifecycle.** A session is single-use: after `close()` or a failure, create a new one. `connect()` again while connecting shares the attempt. `connectTimeoutMs` (15 000) covers the token fetch too; `signal` closes the session. Failures are `RealtimeError` with a `kind`: `connect-failed`, `connect-timeout`, `no-websocket`, `provider` (non-fatal after `session-ready`), `transport`, `closed`, `not-connected`, `invalid-message`, `tool`. A missing credential is `AuthenticationError`. Messages never contain the key or token.

### Browser sessions: ephemeral tokens

A browser cannot set WebSocket headers and must never hold a key. Your server mints a short-lived token; the browser connects with it (`ephemeralToken`: a string, or a function run inside `connect()`).

```ts
// app/api/voice-token/route.ts (server)
import { createOpenAIClientSecret, createOpenAIRealtime } from '@deuz-sdk/core/realtime';

declare function requireUser(req: Request): Promise<{ id: string }>; // your auth: rejects anonymous callers

export async function POST(req: Request): Promise<Response> {
  await requireUser(req); // before minting: each token is a credential on your account
  const { token, expiresAt } = await createOpenAIClientSecret({
    model: createOpenAIRealtime({ apiKey: process.env.OPENAI_API_KEY! })('gpt-realtime'),
    instructions: 'You are a friendly receptionist.',
    expiresInSeconds: 120,
  });
  return Response.json({ token, expiresAt });
}
```

```ts
// voice-client.ts (browser)
import { createOpenAIRealtime, createRealtimeSession } from '@deuz-sdk/core/realtime';

const session = createRealtimeSession({
  model: createOpenAIRealtime()('gpt-realtime'), // no key in the browser
  ephemeralToken: async () => {
    const response = await fetch('/api/voice-token', { method: 'POST' });
    return ((await response.json()) as { token: string }).token;
  },
});
await session.connect();
```

**The token route spends your key.** Authenticate the caller before minting, and rate-limit the route per user: each token opens sessions billed to your account (on OpenAI its configuration is only a default the browser can change), and no budget applies inside a session.

`createOpenAIClientSecret` (`expiresInSeconds` 10–7200) attaches the configuration as a **default** the browser's own `session.update` can change. `createGeminiAuthToken` (`uses`, `expiresInSeconds`, `newSessionExpiresInSeconds`) **locks** it by default (`lockConfig: true`; `false`, or a list of setup field paths to lock only those). Both take the session configuration options (`instructions`, `voice`, `tools`, …) and resolve `{ token, expiresAt, raw }`; HTTP failures map onto the usual error taxonomy.

## Provider batches

`createBatchClient({ model, deps?, execution?, store?, holdMs?, headers?, capabilities? })` binds a client to one model (OpenAI and Gemini batches run on a single model). The model's factory supplies key, base URL, `fetch` and headers. Every request body is built by the model's own wire adapter with streaming off, so a batch request follows the request rules of `generateText` / `generateObject` (effort mapping, sampling restrictions, output caps, structured output, `store: false` on Responses). Vertex AI, Bedrock, Azure, Gemini's OpenAI-compatible endpoint and other OpenAI-compatible hosts are refused with `BatchError` kind `'unsupported'`.

This runs offline: a scripted stand-in for the Message Batches API sits in the model's `fetch`.

```ts
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createBatchClient } from '@deuz-sdk/core/batch';
import { createPriceProvider } from '@deuz-sdk/core/pricing';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let ids: string[] = [];
// Accepts the batch, ends it on the first status read and answers every request.
const scriptedAnthropic = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  if (init?.method === 'POST' && path === '/v1/messages/batches') {
    ids = (JSON.parse(String(init.body)) as { requests: { custom_id: string }[] }).requests.map((r) => r.custom_id);
    return json({ id: 'msgbatch_demo', processing_status: 'in_progress' });
  }
  if (path === '/v1/messages/batches/msgbatch_demo') {
    return json({
      id: 'msgbatch_demo',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: ids.length, errored: 0, canceled: 0, expired: 0 },
      results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_demo/results',
    });
  }
  const line = (id: string) => ({
    custom_id: id,
    result: {
      type: 'succeeded',
      message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: `Answer to ${id}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    },
  });
  return new Response(ids.map((id) => JSON.stringify(line(id))).join('\n'));
}) as typeof fetch;

const batch = createBatchClient({
  model: createAnthropic({ apiKey: 'offline', fetch: scriptedAnthropic })('claude-haiku-5-5'),
  deps: { priceProvider: createPriceProvider() },
});
const job = await batch.submit([
  { id: 'q1', prompt: 'What is a batch API?' },
  { id: 'q2', instructions: 'Answer in one line.', prompt: 'Why is it cheaper?' },
]);
await batch.wait(job, { intervalMs: 1_000 });
for await (const result of batch.results(job)) {
  console.log(result.id, result.status, result.text, result.costUsd); // q1 succeeded Answer to q1 0.000135
}
```

`0.000135` is 1,200 input and 300 output tokens at Claude Haiku 5.5's batch card ($0.05 / $0.25 per million, half its standard rates).

- **Requests** take an `id` (1–64 of letters, digits, `_`, `-`; unique; results carry it in any order), `prompt` or `messages`, `instructions`, the sampling options, `effort`, `responseFormat`, `providerOptions`, `promptCaching`, `executionEstimate`, and `schema` / `schemaName` / `schemaDescription` / `mode` for structured output. Tools, MCP and every other loop option are refused (`BatchError` kind `'invalid-request'`), as are an empty batch, a repeated id, both `prompt` and `messages`, and a batch over the provider's documented limit. What the wire drops or clamps is reported once in `job.warnings`.
- **The `BatchJob`** is plain JSON with no credential: `version`, the provider's batch `id`, `protocol`, `provider`, `modelId`, `surface`, `submittedAt`, `expiresAt?`, `holdUntil`, the `requests` with their holds, `scopeId?`, `warnings?` and, once every result was read, `closedAt`. Store it anywhere and hand it to another process.
- **Following it.** `status(job)` is one provider call: `state` is `pending`, `running`, `cancelling`, then `completed`, `cancelled`, `expired` or `failed` (`ended: true`), plus `counts` and the provider's own value; an unknown provider state reads as `running`. `wait(job, { intervalMs?, timeoutMs?, onStatus?, signal? })` polls on `deps.clock` (default every 60 s) and **polls again after a retryable provider error (429, 5xx) or a network failure**; `timeoutMs` ends it with kind `'timeout'`. `cancel(job)` asks the provider to stop; read the results to close the holds.
- **Lifecycle calls fail like model calls.** A call that fails before or while its answer arrives (DNS, a reset connection, a result file that breaks off) throws the retryable `NetworkError`; other failures keep the wire's typed error (`AuthenticationError`, `ModelNotFoundError`, …).
- **Results.** `results(job, { schemas? })` yields one `BatchResult` per request once the batch ended (before: kind `'not-ended'`); `collect(job)` gathers them. Each has `id`, `status` (`'succeeded'`, `'errored'`, `'cancelled'`, `'expired'`), `text`, `reasoning`, `object`, `finishReason`, `usage` (the 2.3 usage contract), `usageAvailable`, `costUsd` (batch tier), a typed per-request `error`, `stopDetails` and `providerMetadata`. A structured result that does not parse or validate stays `'succeeded'` (it was billed) and carries a `NoObjectGeneratedError`; there is no repair. The client keeps the submitted schemas in memory until the first read; a later read or a new process passes `schemas`.

### Pricing and budgets

Price lookups take a tier (`references/ops.md`): `priceProvider.priceUsage(model, usage, { tier: 'batch' })` prices a row's `ModelPrice.batch` card, a complete card of its own. The bundled table cards only the Claude rows Anthropic's Claude API reference lists (50% of standard, cache reads and writes included); OpenAI and Gemini rows have none, so their batch requests are unpriced until you add a card through `createPriceProvider({ table })`. A `PriceProvider` written before 2.3 ignores the tier and prices batches at standard rates.

With `execution` (a `createExecutionContext` from `@deuz-sdk/core/agent`, persistent admission included), every request reserves a **hold** at submit, before the provider sees anything:

- **One hold per request, all or none, in one ledger step**: each estimated as a native call is (prompt plus the output cap the wire sends) and priced on the batch tier, admitted against the budgets and the holds before it, so a batch of any size writes one ledger revision and one persisted snapshot. One refusal releases the holds admitted before it and nothing is sent. A model without a batch price runs under a USD budget with one `unpriced-model` warning on the job, or is refused before sending under `unknownPrice: 'reject'`.
- **Each result settles its hold before it is handed out**: with the usage when it succeeded; kept unknown when no usage was reported; released when the request was cancelled, expired or never ran, or was refused with 400, 401, 403, 404, 422 or 429; kept unknown for any other error. Settlement is idempotent in the ledger and in the `BudgetStore`, so an interrupted read starts over; a store that cannot take a settlement makes `results` throw at that request.
- **Holds last as long as the batch.** `holdMs` (default 25 hours: the 24-hour window plus an hour to read) sets `job.holdUntil`. A `BudgetStore` sweep must not close batch holds first: pick a `before` older than `holdMs`, or `'keep'` holds whose `requestId` contains `/batch/` (they are named `<scopeId>/batch/<job key>/<request id>`).

### Resuming after a restart

With `store` (a `BatchJobStore`: `put`, `get`, `list`, `delete`; `createMemoryBatchJobStore()` for tests), every submitted job is recorded, `pending()` lists the jobs whose results were not all read (oldest first), and a job is marked `closedAt` once every result was read. A store that fails to record an accepted job makes `submit` throw kind `'store'` with the handle on `error.job`.

```ts
import type { BatchClient } from '@deuz-sdk/core/batch';

declare const batch: BatchClient; // createBatchClient({ model, execution, store })
declare function save(result: { id: string; text: string }): Promise<void>;

// A worker that runs every few minutes:
for (const job of await batch.pending()) {
  if (!(await batch.status(job)).ended) continue;
  for await (const result of batch.results(job)) await save(result);
}
```

The holds settle through the client's execution context. A context restored from its snapshot already knows them. A **fresh context of the job's scope** records each hold again with the amounts the job recorded, without its own budget admission (the provider already ran the request), and counts it against its budgets from then on; the `BudgetStore` sees it as the same hold, so that context needs the same persistent scopes and limits, or a hold recorded with other amounts fails with `reservation_conflict` and the job must be read through a context restored from its snapshot. A client without an execution context refuses a job that has holds.

`BatchError` (`code: 'batch_error'`) kinds: `unsupported`, `invalid-request`, `invalid-job`, `not-ended`, `timeout`, `provider`, `store`.

## Sharp edges

- A browser session needs `ephemeralToken`; a browser asked to send the key header fails with `kind: 'connect-failed'`, and the key must never reach the client. The route that mints tokens must authenticate its caller: an open one lets anyone open sessions on your account.
- Realtime sessions are single-use and enforce no budget; batch has no tools.
- Realtime and OpenAI / Gemini batch requests are unpriced until you add rows: under a USD budget they warn and run, they are not refused (unless `unknownPrice: 'reject'`).
- Read a batch's results to settle its holds; a sweep that runs before `holdUntil` closes them at their estimate.
- A structured batch result can be `'succeeded'` and still carry a `NoObjectGeneratedError`: check `error` before reading `object`.
- Gemini Live has no client-side cancel: `interrupt()` sends nothing there; stop local playback yourself on `interrupted` or `speech-started`.

## Deep dive

- [/docs/modules/realtime](/docs/modules/realtime) — the offline scripted session, the event table, audio formats, tools, usage, configuration mapping per wire, errors.
- [/docs/modules/batch](/docs/modules/batch) — each provider's batch API, the job handle, result statuses, holds and their settlement table, resuming.
- [/docs/modules/pricing](/docs/modules/pricing) — tiers, `ModelPrice.batch`, `PRICE_ALIASES`.
