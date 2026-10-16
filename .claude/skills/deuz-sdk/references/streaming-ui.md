<!-- verified: 2026-10-16 against @deuz-sdk/core@2.4.0 · api-contract sha256:da3643f44edc
     sources: packages/core/src/ui.ts, packages/core/src/chat.ts, packages/core/src/chat-request.ts,
     packages/core/src/types/methods.ts, packages/core/src/types/tool.ts, packages/core/src/types/stream.ts,
     packages/react/src/index.ts, packages/react/src/use-chat.ts, packages/react/src/use-object.ts,
     packages/react/src/components.tsx, docs/content/docs/modules/ui-streaming.mdx,
     docs/content/docs/modules/react-hooks.mdx, docs/content/docs/modules/request-validation.mdx,
     docs/content/docs/modules/chat-persistence.mdx, docs/content/docs/modules/native-agents.mdx,
     packages/core/src/{stream-durable,internal/capabilities}.ts, packages/react/src/chat-snapshot.ts,
     .changeset/{2-4-l7b,2-4-l7c,2-4-w0d,2-4-w0e}.md -->

# Streaming UI: the wire, the chat engine, the React hooks

**Load when:** building a chat route and the client that reads it — serializing `streamChat` to SSE, serving a native agent run to a UI (2.3), validating a client-supplied history, streaming server data parts, surviving a refresh mid-generation, rendering ordered `UIMessage.parts`, or wiring `useChat` / `useObject`. Durable (persist-before-publish) streams, the capability handshake, chat snapshots and conditional chat stores (2.4) are in `references/chat-stream-durability.md`.

Three layers, all in the box:

| Layer | Subpath | What it owns |
| --- | --- | --- |
| Wire | `@deuz-sdk/core/ui` | SSE serializers (native agent runs included, 2.3), the `DeuzUIPart` union, resumability, the client reader |
| Engine | `@deuz-sdk/core/chat` | `validateChatRequest`, the pure reducer, `UIMessage`, `ChatStore`, branching |
| Binding | `@deuz-sdk/react` | `useChat`, `useObject`, `ToolApprovalCard`, `CostBadge`, `partsFromFiles` |

The wire is **ours**, not the AI SDK's. A route emitting `toDeuzStreamResponse` and a client running `@ai-sdk/react`'s `useChat` will not talk; move the route and the client together. Everything in `/ui` and `/chat` is edge-safe (Web APIs only) and `validateChatRequest` plus the whole engine is re-exported from `@deuz-sdk/core/edge`.

## 1. The gate in front of every route

`validateChatRequest(body, options?)` is mandatory. Never write `const { messages } = await req.json()`: the body is attacker-controlled and canonical `Message[]` includes `role: 'system'`, so a client can overwrite the instructions your route thought it owned, forge a `tool_result` ("payment captured"), replay assistant turns, or send 50 000 messages.

It returns a discriminated result, never a throw: `{ ok: true; request }` where `request` is `{ messages, chatId?, approvalResponses?, rest }`, or `{ ok: false; issues: string[] }`.

| `ValidateChatOptions` | Default | Effect |
| --- | --- | --- |
| `rejectSystemRole` | `true` | Reject `role: 'system'` from the client. The live vector; opt out only in a local playground. |
| `rejectToolResults` | `true` | Reject client-authored `tool_result` parts **and** `role: 'tool'` turns (also caught inside a `user` turn). Since 2.3 the default accepts one shape: a `role: 'tool'` message (or a run of them) right after an assistant turn, holding only `tool_result` parts that each answer a different call of that turn. `false` accepts every tool result. |
| `rejectAssistantTurns` | `false` | Regenerate / edit-and-resend legitimately replay assistant turns. |
| `maxMessages` | `1000` | Over the cap the body is rejected *without* walking the entries. |
| `maxTextBytes` | `100_000` | Per-message UTF-8 text budget (~25k tokens). Image/PDF payloads are excluded — cap raw body size at the edge. |
| `maxOpaqueReasoningBytes` | `1_000_000` | 2.3: per-message budget for `encrypted` / `redacted` reasoning payloads, counted apart from `maxTextBytes`. A flag counts as opaque only on its own family (`encrypted`: `source` absent or `'openai'`; `redacted`: absent or `'anthropic'`); any other flagged part counts as text. |
| `maxProviderMetadataBytes` | `1_000_000` | 2.3: per-message budget for round-trip data, the `providerMetadata` of the message and its parts (Gemini thought signatures) and every reasoning `signature`. |

- **It never repairs.** Every failure is a rejection; a silently cleaned array would hide the attack. `issues` is non-empty whenever `ok` is `false`, capped at 20 entries plus an `N further issue(s) suppressed.` line, and only a bad role or part `type` is echoed — redacted first, then truncated to 32 chars. Since 2.3 the byte walks count an object's keys as well as its values, so a `tool_use.input`, `tool_result.result` or `providerMetadata` cannot hide its volume in key names.
- **`request.rest` is unvalidated passthrough** (this is where `useChat`'s `options.body` lands, and a native route's `runId` and `clientToolResults`). Read the fields you know by name and validate them yourself; **never** spread it into call options — that hands a client `maxSteps`, `tools`, `deps`.
- **Client tools and approvals pass the defaults (2.3).** The history `useChat` posts after a client tool, an approval, or a server tool the leg ran pairs each `tool_result` with the assistant turn before it, which the default accepts; every other tool result is still rejected (no assistant turn before it, a call that turn did not make, a call answered twice, a tool message that also carries text, a `tool_result` in a `user` turn). Understand what an accepted result is: the validator cannot tell a real one from a forged one in that shape. The real fix is server-side history (`chat: { store, chatId, scope }`) with the client's copy demoted to a rendering cache.
- `parseDeuzChatRequest(body, options?)` is the throwing variant — it raises `InvalidRequestError` (already `statusCode: 400`, secret-safe `toJSON()`) for routes with one central `catch`.

## 2. The Next.js route

```ts
// app/api/chat/route.ts
import { after } from 'next/server';
import { streamChat } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function POST(req: Request): Promise<Response> {
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

  const result = streamChat({
    model: anthropic('claude-opus-4-8'),
    instructions: 'You are a helpful assistant.', // the ROUTE owns the system prompt
    messages: parsed.request.messages,
    ...(parsed.request.approvalResponses
      ? { approvalResponses: parsed.request.approvalResponses }
      : {}),
    signal: req.signal, // forwards client disconnect
  });

  const response = toDeuzStreamResponse(result, { generateId: () => crypto.randomUUID() });
  after(() => result.consume?.()); // terminal effects run even if the client leaves
  return response;
}
```

`consume()` is not optional hygiene. The pump is lazy: if nobody drains it — client disconnected, response returned and dropped — the run never reaches its terminal boundary and `chat` persistence, `session` checkpoints, `onFinish` and memory extraction silently never run. It takes its own subscription (safe alongside the serializer), is memoized, never rejects (failures go to `consume({ onError })`), and works on the `fallbackModels` / `withFallback` paths too; call it with `?.` because the type marks it optional.

## 3. The Cloudflare Worker variant

Read keys from `env`, never `process.env`; avoid `*/node`, `*/markdown`, `mcp/stdio`.

```ts
import { streamChat } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/edge';
import { createOpenAI } from '@deuz-sdk/core/openai';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';

interface Env { OPENAI_API_KEY: string }
interface Ctx { waitUntil(promise: Promise<unknown>): void }

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    // The defaults accept the client-tool round-trip useChat POSTs (2.3).
    const parsed = validateChatRequest(await req.json());
    if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

    const result = streamChat({
      model: createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-5.2'),
      messages: parsed.request.messages,
      signal: req.signal,
    });
    const response = toDeuzStreamResponse(result);
    ctx.waitUntil(result.consume?.() ?? Promise.resolve());
    return response;
  },
};
```

## 4. The server serializers

| Function | Takes | Produces |
| --- | --- | --- |
| `toDeuzStreamResponse(result, options?)` | `StreamChatResult` | SSE `Response`, `text/event-stream; charset=utf-8`, `x-deuz-stream: <version>`, always `status: 200`, terminated by `data: [DONE]` |
| `toDeuzObjectStreamResponse(result, options?)` | `StreamObjectResult` | the same SSE shell carrying `object-delta` parts — what `useObject` reads |
| `toDeuzTextStreamResponse(result, options?)` | `StreamChatResult` | `text/plain; charset=utf-8`, **no framing** — `{ headers?, includeReasoning? }`; reasoning never writes an `encrypted` or `redacted` payload |
| `createDeuzStream(result, options?)` | `StreamChatResult` | `DeuzStreamWriter` = `{ response, writeData(name, payload, opts?), close() }` |
| `toDeuzAgentStreamResponse(stream, options?)` | a native `AgentStream` (2.3) | the SSE shell plus `data-agent` frames — section 5 |

`ToDeuzStreamOptions`, shared by the first three and by `createDeuzStream`: `messageId` (the id in the leading `start` part), `generateId` (used when `messageId` is absent — with neither, the id is the literal `'deuz-msg'`), `headers` (merged after the protocol headers), `wireVersion` (`'v1' | 'v2'`, default `'v2'`), `store` (a `StreamStateStore` to journal every event into), `streamId` (**required when `store` or `durable` is set** — otherwise the call throws), `onStoreError` (store failures land here; legacy journaling is best-effort and never kills the response), `durable` (2.4 preview: commit every frame to a `DurableStreamStateStore` before sending it, one producer fenced by its lease; fails closed) and `capabilities` (2.4: `{ request, announce? }` for the capability handshake; a request without `x-deuz-capabilities` gets the 2.3 bytes). Both are in `references/chat-stream-durability.md`.

**Behaviour change (2.4) for the legacy `store`:** a store that cannot report its last seq no longer makes the response renumber from 0 over stored frames — that response is not journaled, `onStoreError` fires, and a v2 client gets a `warning` part of type `'stream-store-error'`; the first failed append stops journaling the leg the same way (once). Such a response cannot be resumed; use `durable` when it must be.

`CreateDeuzStreamOptions` adds `dataSchemas?: Record<string, StandardSchemaV1>` — one Standard Schema per data-part name, validated *before* serialization; an invalid payload is dropped and a redacted `error` part (`data part 'chart' failed validation.`) rides instead while the stream continues.

Versions: `DEUZ_STREAM_VERSION` is `'v2'`, `DEUZ_STREAM_VERSIONS` is `['v1', 'v2']`, and `negotiateDeuzStreamVersion(source)` accepts a `Request`, `Headers`, the raw header string, or `null` — only an explicit `v1` downgrades. v2 adds an `id: <seq>` line per event (what makes resume possible) plus the v2-only part types; v1 output has no id lines and drops v2-only parts recursively (one inside a `sub-agent` frame goes too). Optional fields added to v1 parts since (the 1.7 approval `token`, the 2.3 `reasoning-delta` block fields, `stopDetails`, `outcome`, `providerMetadata`) ride it too, so v1 reasoning frames are no longer byte-identical to pre-1.7 output.

**`toDeuzTextStreamResponse` has nowhere to put an error.** A mid-stream failure just closes the body — HTTP truncation is the only signal, exactly as for a dropped connection. Writing a message into the body would be indistinguishable from model output and would be persisted as if the model said it. Use the SSE form (or check `result.finishReason`) when you must tell finished from died.

## 5. Native agent runs: `toDeuzAgentStreamResponse` (2.3)

`toDeuzAgentStreamResponse(stream, options)` serializes a `streamAgent` or `resumeStreamAgent` run to the same wire. The run's parts go out as `toDeuzStreamResponse` frames them, and `data-agent` parts add what only a native run has: a `run` frame opening every leg (carrying the `runId` option), `phase` frames, the `partial` drafts and validated array `element`s of a structured output, and a terminal `result` frame with the run id, the status, the validated output (only when `completed`), the pending approvals and client calls of a suspension, the stop reason with its `stopDetails`, or the failure. The route starts a run for a request without `runId` and resumes it for one with it:

```ts
// app/api/agent/route.ts
import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '@deuz-sdk/core/agent';
import type { AgentToolSet } from '@deuz-sdk/core/agent';
import type { LanguageModel } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import {
  createInMemoryStreamStateStore,
  negotiateDeuzStreamVersion,
  toDeuzAgentStreamResponse,
} from '@deuz-sdk/core/ui';

declare const model: LanguageModel;
declare const tools: AgentToolSet; // some `needsApproval`, some without `execute` (client tools)
declare function tenantOf(req: Request): string; // from your auth, never from the body

const runs = createInMemoryAgentRunStore(); // a durable AgentRunStore in production
const streams = createInMemoryStreamStateStore({ maxStreams: 1000 });

export async function POST(req: Request): Promise<Response> {
  const parsed = validateChatRequest(await req.json()); // the defaults accept useChat's tool results
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
  const { rest, approvalResponses } = parsed.request;
  const scope = tenantOf(req);
  const resuming = typeof rest.runId === 'string';
  const runId = resuming ? (rest.runId as string) : crypto.randomUUID();
  if (resuming) {
    // Only this tenant's run, and only while it waits: a double submit gets a 409.
    const stored = await runs.load(runId);
    if (stored?.scope !== scope) return new Response('Unknown run', { status: 404 });
    if (stored.result?.status !== 'suspended') return new Response('Not waiting', { status: 409 });
  }
  const session = { store: runs, runId, scope };
  const stream = resuming
    ? resumeStreamAgent({
        model,
        tools,
        session,
        ...(approvalResponses ? { approvalResponses } : {}),
        // Unvalidated passthrough: check the entries' shape yourself in production.
        ...(Array.isArray(rest.clientToolResults)
          ? {
              clientToolResults: rest.clientToolResults as {
                toolCallId: string;
                output: unknown;
                isError?: boolean;
              }[],
            }
          : {}),
      })
    : streamAgent({ model, tools, session, messages: parsed.request.messages });
  return toDeuzAgentStreamResponse(stream, {
    runId,
    store: streams, // one journal per run: `seq` grows across every leg
    streamId: runId,
    wireVersion: negotiateDeuzStreamVersion(req),
  });
}
```

- **Every frame applies once.** Each frame's `seq` is its SSE event id. With `store` and `streamId` (one per run, such as the run id) the sequence grows across every leg and a client resumes after its cursor through `resumeDeuzStreamResponse`; a response without a store cannot be replayed. With a store, a leg's first frames go out once the run has emitted its first event; the serializer subscribes to the run's events before it returns.
- **One writer per stream.** A leg the run refuses before it begins (a second resume while it executes, a run id stored under another scope, an unknown run, invalid options) goes out on its own response only, with its failed result and error part but no event ids, and writes nothing to the journal.
- **Nothing private leaves the server**: no transcript, no raw `tool-output` results, no receipts, no accounting ledger; a failure's message is redacted and a failed run also ends with an `error` part. The frames are wire v2 parts on the existing `data-${string}` member of `DeuzUIPart`, so a client that negotiated v1 gets the plain chat stream.
- **On the client** `agentStateFromParts(parts, initial?)` folds the frames into a `DeuzAgentState`: `idle`, `running` (with the latest unvalidated `partial` draft), `completed` (with `output: T`), `suspended`, `stopped` (with `reason` and `stopDetails`) or `failed`. A frame applies only when its `seq` is above the state's, so a duplicate, an overlapping replay or an out-of-order frame never applies twice. `applyUIPart` folds the same frames into `AssistantTurnState.agent`; an app's own `data-agent` part that is no agent frame stays an ordinary data part. `useChat` drives such a route with no new option (section 11).

## 6. Server-pushed data parts

`writeData` injects typed `data-{name}` parts into the **same** response the model streams over — ordered, seq-numbered, journaled, replayable. Call it from anywhere while the run is live (a tool `execute`, a RAG pipeline, a progress reporter); writes after the stream ended are dropped.

```ts
// app/api/chat/route.ts
import { streamChat } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { createDeuzStream, createInMemoryStreamStateStore } from '@deuz-sdk/core/ui';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { z } from 'zod';

const store = createInMemoryStreamStateStore({ maxStreams: 1000 });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
declare function search(q: string): Promise<Array<{ title: string }>>;

export async function POST(req: Request): Promise<Response> {
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
  // `streamId` is not a validated field — read it off `rest` and check it yourself.
  const id = parsed.request.rest.streamId;
  const streamId = typeof id === 'string' ? id : crypto.randomUUID();

  const result = streamChat({ model: anthropic('claude-opus-4-8'), messages: parsed.request.messages });
  const stream = createDeuzStream(result, {
    store,
    streamId,
    dataSchemas: { hits: z.object({ titles: z.array(z.string()) }) },
  });
  stream.writeData('status', 'searching…', { id: 'search' }); // addressable
  void search('papers').then((rows) => {
    stream.writeData('status', `found ${rows.length}`, { id: 'search' }); // replaces in place
    stream.writeData('hits', { titles: rows.map((r) => r.title) });
  });
  void result.consume?.();
  return stream.response;
}
```

- **`id`** makes an entry addressable: the client (`applyUIPart`) replaces the earlier `(name, id)` entry **at its original position** in `dataParts` and in the message's ordered `parts`, so a live status widget is one row that does not jump to the bottom. The wire stays strictly append-only — every write is its own frame — because collapsing server-side would break the seq↔journal 1:1 the resume cursor rides on. Only a *string* id addresses an entry.
- **`transient: true`** emits on the wire but never journals and stays off-seq (no `id:` line), so it can never move a cursor past an unstored event. A reconnecting client does **not** receive the transient frames it missed — only write state you are happy to lose.
- `useChat({ onData })` fires once per raw frame, *before* reconciliation, so a caller still observes intermediate writes that `dataParts` collapses.

## 7. Resumability: store, replay, reconnect

```ts no-verify
interface StreamStateRecord { seq: number; part: DeuzUIPart | { type: 'done' } }
interface StreamStateStore {
  append(streamId: string, seq: number, part: StreamStateRecord['part']): void | Promise<void>;
  read(streamId: string, fromSeq?: number): AsyncIterable<StreamStateRecord>;
  lastSeq?(streamId: string): number | undefined | Promise<number | undefined>; // fast path
  delete?(streamId: string): void | Promise<void>;                             // never called by core
}
```

`read` returns what exists **now** with `seq > fromSeq`, in order — live tailing is the serializer's poll loop, so a KV/table adapter (Redis sorted set, a Postgres table) stays ~15 lines. `createInMemoryStreamStateStore({ maxStreams })` is the reference store; without `maxStreams` records are retained forever, so a long-lived server must set it or use a TTL-capable backend.

Journaling semantics that matter: parts are stored **before** they are enqueued (a part in flight during a disconnect still lands in the log); a vanished client no longer throttles anything — the serializer keeps draining at full speed; a terminal `done` record is appended when the source ends, errors, *or* suspends on an approval, and it is terminal only when nothing follows it, so continued legs (durable resume, approval legs) replay straight through.

Serve the replay from a **GET** route:

```ts
// app/api/stream/[id]/route.ts
import { resumeDeuzStreamResponse } from '@deuz-sdk/core/ui';
import type { StreamStateStore } from '@deuz-sdk/core/ui';

declare const streamStore: StreamStateStore;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return resumeDeuzStreamResponse(streamStore, id, { lastEventId: req.headers.get('last-event-id') });
}
```

`ResumeDeuzStreamOptions`: `lastEventId` (`string | number | null`; replay starts *after* it — parsing is strict, a garbled value means "no cursor", never seq 0), `wireVersion` (default `'v2'` — serve v2, `connectDeuzStream` needs the ids), `pollIntervalMs` (250), `idleTimeoutMs` (30 000; the response then closes **without** `[DONE]`, which a reconnecting client treats as another drop), `clock`, `headers`, `capabilities` (2.4; announces `durable-stream` when the store is a `DurableStreamStateStore`).

Client side:

| Function | Use it for |
| --- | --- |
| `readDeuzStream(response, { onHttpError?, onEventId? })` | One `Response` → `AsyncGenerator<DeuzUIPart>`; stops at `[DONE]`, skips malformed lines. `onEventId(id)` (2.3) gets each part's SSE event id right before the part is yielded (none for a transient part or on v1), so a client that also resumes knows how far a POST read got. |
| `connectDeuzStream(source, options?)` | The same, plus auto-reconnect with `Last-Event-ID` and seq dedup — one gapless sequence. |

`onHttpError` defaults to `'error-part'`: a non-2xx response yields exactly one `error` part instead of ending silently (a 500/401/429 used to render as a *successful empty assistant bubble*). The body is never read — only `statusText`, truncated to 200 chars and secret-redacted. `'ignore'` restores the old silence; `useChat`/`useObject` forward the option verbatim.

`ConnectDeuzStreamOptions`: `fetch`, `headers`, `lastEventId`, `maxReconnects` (5 — the counter resets whenever an event arrives, so only *consecutive dead* reconnects exhaust it), `signal`, `clock`, `onCursor(lastEventId)` (persist it to survive a full page reload), `generateId` (jitter source). Point it at the **resume GET route** — never at the generating POST route, which would re-run the model. If the server sent events without ids (v1) it **throws** rather than silently duplicating every delivered part.

## 8. `DeuzUIPart` — what arrives on the wire

Discriminated on `type`, **open and additive**: always keep a `default` case. Parts marked v2 are dropped for a negotiated-v1 client; the optional fields 2.3 added ride every wire version, and an older client ignores them.

| `type` | Fields |
| --- | --- |
| `start` | `messageId` — always first (not re-emitted on a continued leg) |
| `step-start` / `step-finish` | `step` / `step, finishReason, usage, stopDetails?` |
| `text-delta` | `text, providerMetadata?` — `providerMetadata` (2.3) is round-trip data such as a Gemini text signature, often on a final chunk whose `text` is empty; never display it |
| `reasoning-delta` | `text, signature?, id?, encrypted?, redacted?, source?, data?` — 2.3: deltas sharing an `id` build one block; an `encrypted` / `redacted` block's payload rides `data` and its `text` is empty, so a client that predates the fields shows nothing for it, and `applyUIPart` reads the payload back |
| `tool-input-delta` | `toolCallId, toolName?, delta` — raw argument-JSON fragments |
| `tool-call` / `tool-result` | `toolCallId, toolName, input, providerMetadata?` / `toolCallId, toolName, output, isError?, outcome?` — 2.3: the call's round-trip data (a Gemini function call's signature), echoed back with it; `outcome` is an error result's `ToolCallOutcome` |
| `tool-approval-request` | `approvalId, toolCallId, toolName, input, token?` — the loop broke, awaiting a verdict |
| `tool-approval-response` | **client→server only**; the verdict rides the next request body as `approvalResponses` |
| `object-delta` | `object` — each delta REPLACES the previous partial wholesale |
| `source` / `compaction` / `sub-agent` | `id,url?,title?` / `layer,tokensBefore,tokensAfter` / `agentPath, part` |
| `data-{name}` **v2** | `payload, id?` — a native run's `data-agent` frames (2.3, section 5) fold into `turn.agent`, not `dataParts` |
| `citation` **v2** | `id, sourceId?, url?, title?, snippet?, chunkIndex?, score?` |
| `tool-state` **v2** | `toolCallId, toolName?, state: ToolRunState, denied?, deniedReason?, outcome?` |
| `cost` / `budget-exceeded` **v2** | `costUsd, deltaUsd?, cacheSavingsUsd?, stepIndex?` / `kind, limit, value` |
| `verify` / `false-finish` **v2** | `stepIndex, attempt, ok, willRetry, feedback?` / `stepIndex, attempt, willRetry` |
| `warning` **v2** | `warning: CallWarning` — `type` is an OPEN union; treat unknown as `'other'` (2.4 adds `'stream-store-error'` among others) |
| `capabilities` **v2** | `capabilities: string[]` — 2.4: the first frame of a response that takes part in the capability handshake (no event id, never journaled); `useChat` consumes it and `applyUIPart` ignores it |
| `plan-update` / `activity` **v2** | `goal?, tasks[]` / `message, level?, data?, agentPath?` |
| `finish` / `error` | `finishReason, usage, stopDetails?` / `message` (already secret-redacted) — `stopDetails` (2.3) is the provider's explanation of an early stop, such as a refusal's category, secret-redacted |

`ToolRunState` = `input-streaming | input-complete | awaiting-approval | executing | complete | error`. A **denied** call is `state: 'error'` **plus** `denied: true` — not a seventh state, because consumers switch exhaustively. Branch on `state === 'error' && denied` to render "Declined" instead of "getWeather failed". `deniedReason` is the denier's own words, never invented (a verdict's `reason` verbatim, `No approval response.`, `No result provided for this client tool.`, or an `approvalSigner` token rejection); a server-mode `approveToolCall` returns a bare boolean, so its refusal carries `denied: true` with no reason. A tool that **threw** gains no denial fields — that is the distinction. Since 2.3 `outcome` names the cause outright: `'approval-denied'` (a verdict said no, or the resume carried none), `'permission-denied'` (an `onToolCall` guardrail, the execution policy, the handoff budget, or an `onToolResult` guardrail that withheld the output), `'tool-error'` (it threw, timed out, had invalid input, an unknown name or no executor), `'unknown-effect'` (an interrupted native receipt), and `'approval-pending'` on `awaiting-approval`. `applyUIPart` keeps the latest frame's on `UIToolCall.outcome`, so a call that waited and then ran carries none.

## 9. The pure chat engine (`@deuz-sdk/core/chat`)

Framework-agnostic, pure, total: new objects out, inputs untouched, unknown parts ignored, errors recorded rather than thrown. `@deuz-sdk/react` is a thin binding over exactly these.

| Function | Does |
| --- | --- |
| `createAssistantTurn(id)` | Fresh `AssistantTurnState`. |
| `applyUIPart(turn, part)` | Folds ONE `DeuzUIPart` in; returns a new state. |
| `sealAssistantTurn(turn)` | Every `'streaming'` text/reasoning element → `'done'`. Idempotent; returns the SAME object when there is nothing to seal. |
| `assistantMessageFromTurn(turn)` / `clientToolResultMessage(results)` | The canonical assistant `Message` and the `role: 'tool'` message for client-executed results. Since 2.3 the message follows the ordered `parts`: every reasoning block rides back unchanged and in place, text and `tool_use` where they came (a plain answer is still a string), and a card the turn knows only from a `tool-state` / `tool-result` frame (no `input`: an earlier leg's call, such as an approved one the resumed leg ran) is left out. |
| `userMessageFromInput(input)` / `filesToImageParts(files)` | `ChatInput` (`string \| { text?, parts? }`) → canonical user `Message` (a bare string stays a plain string `content`); picked files → `ImagePart[]` (Web APIs only; images AND PDFs). |
| `uiFromMessages(messages, generateId, { messageIds? })` | Canonical history → `UIMessage[]` with ordered `parts`; `tool` messages merge into the preceding assistant turn, `system` messages are not rendered. Pass `{ messageIds: record.messageIds }` (2.4) to keep a stored chat's ids; `generateId` covers a missing, empty or repeated one. |
| `canonicalFromUI(ui)` | The inverse — **lossy**, see below. |
| `dropTrailingAssistant(history)` / `branchBeforeUserMessage(history, messageId)` | Regenerate: cut trailing assistant/tool turns from both views. Edit-and-resend: cut both views before that user turn (`undefined` if it is not a user message). |

`AssistantTurnState` = `{ message, approvals, serverResults, dataParts, citations, activity }` always, plus channels that stay **absent until their first entry**: `costUsd` / `cacheSavingsUsd`, `budgetExceeded`, `plan`, `verifications`, `warnings`, `falseFinishes`, `subAgents`, `usage`, `finishReason`, `stopDetails` (2.3), `steps`, `error`, and `agent` (2.3: a native run's state, absent on a chat route).

**`canonicalFromUI` is lossy on purpose.** With ordered `parts` present it preserves the interleave, `ImagePart` attachments, reasoning `signature`/`encrypted`/`redacted`/`source` one part per block (2.3: a signed block with empty text too), a text part's `providerMetadata` (2.3), and `tool_use.providerMetadata` (Gemini's `thoughtSignature` — dropping it 400s the next request). A card without `input` (2.3) is not repeated in its turn: its result goes right after the call it answers, or is left out when no earlier turn holds that call. It does **not** preserve `system` messages, message-level `providerMetadata`, consecutive text parts (they merge), or UI-only bookkeeping. Without `parts` it collapses to bucket order and attachments are gone entirely. So when you hold the real history, persist it: save `useChat().history.canonical`, never a round-trip through `canonicalFromUI`.

Persistence is the `ChatStore` seam — `saveChat(record)` / `loadChat(chatId)` (+ optional `deleteChat` / `listChats`), with `ChatRecord = { chatId, scope: MemoryScope, messages, parentId?, updatedAt }`. Set `chat: { store, chatId, scope, parentId? }` on any `streamChat`/`generateText` call and the loop persists the full immutable history at every terminal boundary (completion, approval suspension, mid-stream error). It is best-effort: a throwing `saveChat` logs and never kills the run. Setting `chat` routes even a tool-less call through the agentic loop, so `step-start` / `step-finish` parts start appearing — another reason to keep that `default` case. Reference stores: `createInMemoryChatStore()`, `createJsonlChatStore({ dir })` (`@deuz-sdk/core/chat/node`), `serializeChatRecord` / `deserializeChatRecord` for text columns (plain `JSON.stringify` decays `Uint8Array` parts). For production use a store pack — `createSqliteStores` / `createRedisStores` / `createPostgresStores`.

## 10. Rendering ordered parts

`content` / `reasoning` / `toolCalls` are **buckets**: a think → search → "found 3 papers" → fetch → "here is the summary" turn flattens into one blob each, so a tool card cannot sit between the two sentences it belongs between. `UIMessage.parts` records arrival order, which *is* the interleave.

```tsx
import type { ReactElement } from 'react';
import type { UIMessage, UIToolCall } from '@deuz-sdk/react';

declare function Prose(p: { text: string; streaming: boolean }): ReactElement;
declare function Thinking(p: { text: string }): ReactElement;
declare function ToolCard(p: { call: UIToolCall }): ReactElement;
declare function StepDivider(p: { step: number }): ReactElement;
declare function Attachment(p: { mediaType: string; data: string | Uint8Array }): ReactElement;
declare function Source(p: { url?: string; title?: string }): ReactElement;
declare function Widget(p: { name: string; payload: unknown }): ReactElement;

export function Turn({ message }: { message: UIMessage }): ReactElement {
  // `parts` is OPTIONAL and absent until the first element — a pre-1.9 or
  // restored message legitimately has none. Fall back to the buckets.
  if (!message.parts) return <Prose text={message.content} streaming={false} />;
  return (
    <>
      {message.parts.map((part, i) => {
        switch (part.type) {
          case 'step-start': // parts[0] of a real streamed turn is normally one
            return <StepDivider key={i} step={part.step} />;
          case 'text':
            return <Prose key={i} text={part.text} streaming={part.state === 'streaming'} />;
          case 'reasoning': // `encrypted` / `redacted`: an opaque provider payload, not text
            return part.encrypted || part.redacted ? null : <Thinking key={i} text={part.text} />;
          case 'tool': {
            // A `tool` element is only { type, toolCallId } — a REFERENCE.
            const call = message.toolCalls?.find((c) => c.toolCallId === part.toolCallId);
            return call ? <ToolCard key={i} call={call} /> : null;
          }
          case 'file':
            return <Attachment key={i} mediaType={part.mediaType} data={part.data} />;
          case 'citation':
            return <Source key={i} url={part.url} title={part.title} />;
          case 'data':
            return <Widget key={i} name={part.name} payload={part.payload} />;
          default:
            return null; // open union — always keep a default
        }
      })}
    </>
  );
}
```

A text/reasoning element is `'streaming'` only while it is the newest thing in the turn; opening anything else seals it, which is what makes a text delta arriving *after* a tool call a new paragraph. Since 2.3 a streamed turn holds one `reasoning` element per provider block (two consecutive thinking blocks stay two), flagged `encrypted` / `redacted` blocks included, and the readable `message.reasoning` bucket leaves their payloads out. A `file` element carries the canonical `ImagePart.image` value verbatim, with `url` set only when it is already a renderable `data:` / `http(s):` src — for bytes, build one yourself.

**A sub-agent run is NOT in `parts`.** `applyUIPart` folds `sub-agent` parts into `turn.subAgents` (surfaced as `useChat().subAgents`): `Array<{ agentPath: string[]; afterPart: number; turn: AssistantTurnState }>`, one frame per path. `frame.turn` is a full turn folded by the same reducer re-entering itself, so render it with the **same** `<Turn>` component, indent by `agentPath.length`, and splice at `afterPart` (the parent's ordered-element count at the handoff). A 2nd-level sub-agent is a *sibling* frame with a two-segment path — the wire is single-wrapped, so no recursion is needed. It is kept out of the parent deliberately: folding it in would misattribute the child's prose and would put the child's `tool_use` into `assistantMessageFromTurn`'s output with no matching `tool_result`, which 400s the next request. Read `frame.turn.citations`, not `turn.citations`, for a child's sources.

## 11. `useChat`

```tsx
'use client';
import type { ReactElement } from 'react';
import { CostBadge, ToolApprovalCard, partsFromFiles, useChat } from '@deuz-sdk/react';
import type { UIMessage } from '@deuz-sdk/react';

declare function Turn(p: { message: UIMessage }): ReactElement;

export function Chat(): ReactElement {
  const { messages, status, error, sendMessage, stop, cost, finishReason,
    pendingApprovals, addToolApprovalResponse, pendingToolCalls, addToolResult,
  } = useChat({ api: '/api/chat', throttleMs: 50 });

  return (
    <div>
      {messages.map((m) => <Turn key={m.id} message={m} />)}
      {pendingApprovals.map((a) => (
        <ToolApprovalCard key={a.approvalId} approval={a} onRespond={addToolApprovalResponse} />
      ))}
      {pendingToolCalls.map((c) => (
        <button key={c.toolCallId} onClick={() => void addToolResult({ toolCallId: c.toolCallId, output: 'ok' })}>
          answer {c.toolName}
        </button>
      ))}
      <CostBadge cost={cost} />
      <input type="file" multiple onChange={async (e) => {
        const parts = await partsFromFiles(e.target.files); // media FIRST, then the question
        await sendMessage({ text: 'what is in these?', parts });
      }} />
      <button onClick={() => void sendMessage('hello')} disabled={status === 'streaming'}>Send</button>
      <button onClick={stop}>Stop</button>
      {error ? <p role="alert">{error.message}</p> : null}
      {finishReason === 'length' ? <p>The answer was cut off.</p> : null}
    </div>
  );
}
```

`UseChatOptions`: `api` (required), `initialMessages`, `initialSnapshot` (2.4), `headers`, `body`, `chatId`, `resume`, `generateId`, `throttleMs`, `onToolCall`, `onData`, `onError`, `onHttpError`, `fetch`, `capabilityHandshake` (2.4, default `true`).

`UseChatResult`: `messages`, `history`, `status` (`'idle' | 'streaming' | 'error'`), `error`, `pendingApprovals`, `pendingToolCalls`, `cost?`, `budgetExceeded?`, `dataParts`, `citations`, `plan?`, `activity`, `verifications?`, `warnings?`, `falseFinishes?`, `subAgents?`, `steps?`, `usage?`, `finishReason?`, `stopDetails?` (2.3), `agent?` (2.3), `capabilities?` (2.4), `sendMessage`, `stop`, `regenerate`, `editAndResend`, `setHistory`, `setMessages`, `addToolResult`, `clearError`, `addToolApprovalResponse`, `reconnect`, `exportSnapshot` (2.4).

- **Two histories, one commit.** `history` is `{ ui, canonical }` published in a single `setState`, so no render sees one a frame behind the other. Persist `history.canonical`.
- **`initialMessages` is read once at mount** and deliberately never re-adopted (apps pass inline literals). Switching chats or hydrating later is `setHistory`.
- **Client tools.** *With* `onToolCall` the hook executes, appends the result and re-POSTs automatically (a throw self-heals as `is_error`). *Without* it the round-trip **parks**: calls land in `pendingToolCalls`, `status` goes idle, and `addToolResult({ toolCallId, output })` answers them — the chat continues once *every* parked call is answered. A result for an id that is not parked is a no-op (an orphan `tool_result` 400s the next request). Since 2.3 an `onToolCall` result that lands after the chat moved on (a new message, `regenerate`, `editAndResend`, `setHistory` or `setMessages` while the call ran) is dropped, a call without `input` is never handed to `onToolCall`, and a result settles only the call that came before it, so with a provider that numbers its calls `tool_0`, `tool_1`, … a later call under the same id stays open.
- **Approvals pause the chat.** No re-POST while `pendingApprovals` is non-empty; `addToolApprovalResponse` resumes with `approvalResponses` once every verdict has arrived, and the request's signed `token` is auto-preserved. The **server** settles gated calls — the client never fabricates their `tool_result`. Since 2.3 a verdict counts only if it answers an approval in `pendingApprovals` (its `approvalId`, and the request's `token` when the verdict carries one, which binds it to the run that issued it); anything else (nothing pending, a double click, a stale card, another run's verdict) is a no-op, like `addToolResult`. A repeated `tool-approval-request` frame is one pending approval.
- **`setMessages` re-derives canonical through the lossy `canonicalFromUI`**; `setHistory({ ui, canonical })` is the honest primitive. Both drop pending approvals and parked tool calls (they were anchored to the transcript you replaced) and neither resets the turn readouts.
- **`throttleMs`** (default `0`) coalesces commits on the trailing edge and **always** flushes at a terminal boundary, so the final text can never be lost. `cost` is cumulative across turns; everything else (`dataParts`, `citations`, `plan`, `activity`, `verifications`, `warnings`, `falseFinishes`, `subAgents`, `steps`, `usage`, `finishReason`, `stopDetails`, `agent`) is turn-scoped.
- **`resume: { endpoint, auto?, lastEventId?, cursor? }`** points at the resume GET route. `auto` fires once per mounted hook (StrictMode-safe) and **fails silently by design** — a cold load against a 404 must not paint a permanent error; call `reconnect()` yourself when you want the failure surfaced. `cursor` is an injectable `{ load, save }` adapter, never hardcoded `localStorage`. Since 2.3 a resumed turn settles like a streamed one: its approvals pause the chat and its client calls reach `onToolCall` (the chat then re-POSTs) or park in `pendingToolCalls`. A replayed call is dispatched at most once per mounted hook (skipped when its result is in the replay or in `history.canonical`, or while parked or running); across a reload only a persisted `history.canonical` proves a call ran. A POST response that carries the journal's `id:` lines (a route with `store` and `streamId`) moves the in-memory cursor too, so a `reconnect()` after a settled turn resumes after it instead of appending the turn again; the persisted `cursor` still moves on resume reads only (a reload mid-turn replays the turn from its start), and `setHistory` / `setMessages` drop the in-memory cursor. A `stop()` during a resume read appends nothing; the next `reconnect()` continues from the cursor.
- **The history answers every call (2.3).** The hook adds the result of a call the server ran within a turn (the one the wire carried, which the model saw) to `history.canonical` as a `role: 'tool'` message right after the assistant turn, and after an approval it adds the approved call's result ahead of the resumed leg's turn, on a chat route and a native route alike. Before, the next request carried an open `tool_use`, which providers reject, and on a chat route an approval continuation ran the server call again. Two responses that name their message the same (a route without `messageId` starts every response with `'deuz-msg'`) each fill their own bubble.
- **A native agent route (2.3)** needs no new option: point `api` at a route serving `toDeuzAgentStreamResponse` (section 5). When a turn's `agent` state is `suspended`, the run's terminal frame is the authority on what it waits for: its approvals pause the chat, its client calls run through `onToolCall` or park in `pendingToolCalls`, and the hook resumes the run in **one** request with `runId`, `approvalResponses` and `clientToolResults`, because a native resume proceeds only with every verdict and every client result. The client calls run inside that round, so `status` is `'streaming'` while they run and `stop()` cancels it. Read `agent` (`runId`, `status`, the latest unvalidated `partial` while it runs, `output` only once `completed`) and `stopDetails`; tool cards carry `outcome`. Agent frames stay out of `onData` and `dataParts`. The hook imports no new core export, so with a core older than 2.3 it behaves as before.
- **`useChat` from `@deuz-sdk/core/react` is frozen at 2.2 and deprecated (2.4; removed in 3.0)**: it gets none of the 2.3 or 2.4 behaviour (no verdict matching, no resumed-turn settlement, no native route, no snapshots or capability handshake), drops approval tokens and the client calls of a chat without `onToolCall`, and a development build logs one console warning per page. Use `@deuz-sdk/react`.
- **2.4: snapshots and the capability handshake.** `useChat({ initialSnapshot })` restores a `ChatSnapshotV1` (messages under their stored ids, the turn in progress, the cursor, pending approvals and parked client calls) and `exportSnapshot()` captures one; a stored chat restores as `{ version: 1, messages: record.messages, messageIds: record.messageIds }`. Every POST and resume read sends `x-deuz-capabilities: chat-snapshot-v1, durable-stream, message-ids` (`capabilityHandshake: false` turns it off — needed when a cross-origin preflight lists allowed headers without it), the result's `capabilities` lists what the route announced, and a feature is used only once announced. Details, the server half and durable streams: `references/chat-stream-durability.md`.
- A stream that dies with neither `finish` nor `error` leaves the tail `'streaming'` — that is the truth about a truncated turn. `stop()` and a stream ending without `finish` call `sealAssistantTurn`; read `finishReason === 'length'` to tell "cut off" from "complete".

## 12. `useObject`, and the components

`useObject<T>({ api, headers?, onHttpError?, throttleMs?, fetch? })` → `{ object, isLoading, error, submit, stop }`. `submit(input)` POSTs `{ input }` and clears the previous object immediately (never coalesced); each `object-delta` **replaces** `object` (`DeepPartial<T>` — every field optional at every depth, strings arrive truncated, so render defensively); `stop()` aborts without erroring. Its route is one line: read `{ input }` off the body, then `return toDeuzObjectStreamResponse(streamObject({ model, schema, prompt }))` — no loop options, `streamObject` is single-turn and raises `InvalidRequestError` if you pass any.

`ToolApprovalCard({ approval, onRespond, render? })` is headless: it always echoes the request's signed `token` on the verdict, and `render({ approval, approve, deny })` overrides the markup. `CostBadge({ cost, format? })` renders `$X.XXXX` (plus ` (saved $Y.YYYY)`) from `useChat().cost`, and returns `null` before the first `cost` part. `partsFromFiles(files)` is a null-tolerant wrapper over `filesToImageParts`.

## Sharp edges

- Nobody reading the stream = no persistence, no checkpoints, no `onFinish`. Always `after(() => result.consume?.())` / `ctx.waitUntil(result.consume?.() ?? Promise.resolve())`.
- Destructuring `messages` out of `req.json()` is the vulnerability this module exists to close. `rest` is not validated; never spread it.
- `store` without `streamId` **throws**. `connectDeuzStream` against a v1 stream **throws** (duplication is worse than a hard failure).
- Point `connectDeuzStream` / `resume.endpoint` at the resume **GET** route; the POST route would re-run the model.
- A renderer over `parts` must handle `step-start` (usually `parts[0]`), skip `encrypted` and `redacted` reasoning (both arrive on streamed turns since 2.3), and look `tool` elements up in `message.toolCalls`.
- `sub-agent` runs live in `turn.subAgents`, never in the parent's `parts` or buckets.
- Denials are `state: 'error'` + `denied`, not a new state. A thrown tool has no denial fields.
- `transient` data parts are invisible to a reconnecting client; the durable snapshot must be a normal write.
- `toDeuzTextStreamResponse` cannot report an error — the body just truncates.
- `streamObject` has no repair retry, so a bad final payload rejects `object` *and* the partial stream (`generateObject` retries once).

## Deep dive

- [/docs/modules/ui-streaming](/docs/modules/ui-streaming) — the wire in full: versions, journaling, Redis/Supabase `StreamStateStore` adapters, every part type.
- [/docs/modules/react-hooks](/docs/modules/react-hooks) — `useChat` / `useObject` option-by-option, parts rendering, resuming, throttling.
- [/docs/modules/native-agents](/docs/modules/native-agents#native-agents-in-a-ui) — `toDeuzAgentStreamResponse`, `agentStateFromParts` and `useChat` on a native agent route (2.3).
- [/docs/modules/request-validation](/docs/modules/request-validation) — `validateChatRequest`: threat model, defaults, what it deliberately does not do.
- [/docs/modules/chat-persistence](/docs/modules/chat-persistence) — `ChatStore`, the reducer, ordered parts, `canonicalFromUI`, branching.
- [/docs/agents/client-tools](/docs/agents/client-tools) — the client-tool and approval round-trips end to end.
- [/docs/agents/unbreakable-chatbot](/docs/agents/unbreakable-chatbot) — the wire log × durable checkpoints, and `resumeDeuzChatResponse`.
- [/docs/core/stream-chat](/docs/core/stream-chat) — the source `StreamChatResult`, `consume()`, timeouts, aborts.
- [/docs/core/files](/docs/core/files) — what `partsFromFiles` produces and how to render a `file` part back.
