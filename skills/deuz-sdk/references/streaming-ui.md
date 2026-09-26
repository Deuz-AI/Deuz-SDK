<!-- verified: 2026-09-20 against @deuz-sdk/core@2.2.0 · api-contract sha256:c301da6ab500
     sources: packages/core/src/ui.ts, packages/core/src/chat.ts, packages/core/src/chat-request.ts,
     packages/core/src/types/methods.ts, packages/core/src/types/tool.ts, packages/core/src/types/stream.ts,
     packages/react/src/index.ts, packages/react/src/use-chat.ts, packages/react/src/use-object.ts,
     packages/react/src/components.tsx, docs/content/docs/modules/ui-streaming.mdx,
     docs/content/docs/modules/react-hooks.mdx, docs/content/docs/modules/request-validation.mdx,
     docs/content/docs/modules/chat-persistence.mdx -->

# Streaming UI: the wire, the chat engine, the React hooks

**Load when:** building a chat route and the client that reads it — serializing `streamChat` to SSE, validating a client-supplied history, streaming server data parts, surviving a refresh mid-generation, rendering ordered `UIMessage.parts`, or wiring `useChat` / `useObject`.

Three layers, all in the box:

| Layer | Subpath | What it owns |
| --- | --- | --- |
| Wire | `@deuz-sdk/core/ui` | SSE serializers, the `DeuzUIPart` union, resumability, the client reader |
| Engine | `@deuz-sdk/core/chat` | `validateChatRequest`, the pure reducer, `UIMessage`, `ChatStore`, branching |
| Binding | `@deuz-sdk/react` | `useChat`, `useObject`, `ToolApprovalCard`, `CostBadge`, `partsFromFiles` |

The wire is **ours**, not the AI SDK's. A route emitting `toDeuzStreamResponse` and a client running `@ai-sdk/react`'s `useChat` will not talk; move the route and the client together. Everything in `/ui` and `/chat` is edge-safe (Web APIs only) and `validateChatRequest` plus the whole engine is re-exported from `@deuz-sdk/core/edge`.

## 1. The gate in front of every route

`validateChatRequest(body, options?)` is mandatory. Never write `const { messages } = await req.json()`: the body is attacker-controlled and canonical `Message[]` includes `role: 'system'`, so a client can overwrite the instructions your route thought it owned, forge a `tool_result` ("payment captured"), replay assistant turns, or send 50 000 messages.

It returns a discriminated result, never a throw: `{ ok: true; request }` where `request` is `{ messages, chatId?, approvalResponses?, rest }`, or `{ ok: false; issues: string[] }`.

| `ValidateChatOptions` | Default | Effect |
| --- | --- | --- |
| `rejectSystemRole` | `true` | Reject `role: 'system'` from the client. The live vector; opt out only in a local playground. |
| `rejectToolResults` | `true` | Reject client-authored `tool_result` parts **and** `role: 'tool'` turns (also caught inside a `user` turn). |
| `rejectAssistantTurns` | `false` | Regenerate / edit-and-resend legitimately replay assistant turns. |
| `maxMessages` | `1000` | Over the cap the body is rejected *without* walking the entries. |
| `maxTextBytes` | `100_000` | Per-message UTF-8 text budget (~25k tokens). Image/PDF payloads are excluded — cap raw body size at the edge. |

- **It never repairs.** Every failure is a rejection; a silently cleaned array would hide the attack. `issues` is non-empty whenever `ok` is `false`, capped at 20 entries plus an `N further issue(s) suppressed.` line, and only a bad role or part `type` is echoed — redacted first, then truncated to 32 chars.
- **`request.rest` is unvalidated passthrough** (this is where `useChat`'s `options.body` lands). Read the fields you know by name and validate them yourself; **never** spread it into call options — that hands a client `maxSteps`, `tools`, `deps`.
- **A route serving client tools needs `{ rejectToolResults: false }`**, because `useChat`'s round-trip POSTs a `role: 'tool'` message. Understand what that accepts: the validator cannot tell a real client result from a forged one. The real fix is server-side history (`chat: { store, chatId, scope }`) with the client's copy demoted to a rendering cache.
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

`consume()` is not optional hygiene. The pump is lazy: if nobody drains it — client disconnected, response returned and dropped — the run never reaches its terminal boundary and `chat` persistence, `session` checkpoints, `onFinish` and memory extraction silently never run. It takes its own subscription (safe alongside the serializer), is memoized, never rejects (failures go to `consume({ onError })`), and is `undefined` on the `fallbackModels` / `withFallback` paths — always `?.`.

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
    // A route serving CLIENT tools must allow the `role: 'tool'` turn useChat POSTs.
    const parsed = validateChatRequest(await req.json(), { rejectToolResults: false });
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

## 4. The four server serializers

| Function | Takes | Produces |
| --- | --- | --- |
| `toDeuzStreamResponse(result, options?)` | `StreamChatResult` | SSE `Response`, `text/event-stream; charset=utf-8`, `x-deuz-stream: <version>`, always `status: 200`, terminated by `data: [DONE]` |
| `toDeuzObjectStreamResponse(result, options?)` | `StreamObjectResult` | the same SSE shell carrying `object-delta` parts — what `useObject` reads |
| `toDeuzTextStreamResponse(result, options?)` | `StreamChatResult` | `text/plain; charset=utf-8`, **no framing** — `{ headers?, includeReasoning? }` |
| `createDeuzStream(result, options?)` | `StreamChatResult` | `DeuzStreamWriter` = `{ response, writeData(name, payload, opts?), close() }` |

`ToDeuzStreamOptions`, shared by the first three and by `createDeuzStream`: `messageId` (the id in the leading `start` part), `generateId` (used when `messageId` is absent — with neither, the id is the literal `'deuz-msg'`), `headers` (merged after the protocol headers), `wireVersion` (`'v1' | 'v2'`, default `'v2'`), `store` (a `StreamStateStore` to journal every event into), `streamId` (**required when `store` is set** — otherwise the call throws), `onStoreError` (append failures land here; journaling is best-effort and never kills the response).

`CreateDeuzStreamOptions` adds `dataSchemas?: Record<string, StandardSchemaV1>` — one Standard Schema per data-part name, validated *before* serialization; an invalid payload is dropped and a redacted `error` part (`data part 'chart' failed validation.`) rides instead while the stream continues.

Versions: `DEUZ_STREAM_VERSION` is `'v2'`, `DEUZ_STREAM_VERSIONS` is `['v1', 'v2']`, and `negotiateDeuzStreamVersion(source)` accepts a `Request`, `Headers`, the raw header string, or `null` — only an explicit `v1` downgrades. v2 adds an `id: <seq>` line per event (what makes resume possible) plus the v2-only part types; v1 output is byte-identical to pre-1.7 and drops v2-only parts recursively (one inside a `sub-agent` frame goes too).

**`toDeuzTextStreamResponse` has nowhere to put an error.** A mid-stream failure just closes the body — HTTP truncation is the only signal, exactly as for a dropped connection. Writing a message into the body would be indistinguishable from model output and would be persisted as if the model said it. Use the SSE form (or check `result.finishReason`) when you must tell finished from died.

## 5. Server-pushed data parts

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

## 6. Resumability: store, replay, reconnect

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

`ResumeDeuzStreamOptions`: `lastEventId` (`string | number | null`; replay starts *after* it — parsing is strict, a garbled value means "no cursor", never seq 0), `wireVersion` (default `'v2'` — serve v2, `connectDeuzStream` needs the ids), `pollIntervalMs` (250), `idleTimeoutMs` (30 000; the response then closes **without** `[DONE]`, which a reconnecting client treats as another drop), `clock`, `headers`.

Client side:

| Function | Use it for |
| --- | --- |
| `readDeuzStream(response, { onHttpError? })` | One `Response` → `AsyncGenerator<DeuzUIPart>`; stops at `[DONE]`, skips malformed lines. |
| `connectDeuzStream(source, options?)` | The same, plus auto-reconnect with `Last-Event-ID` and seq dedup — one gapless sequence. |

`onHttpError` defaults to `'error-part'`: a non-2xx response yields exactly one `error` part instead of ending silently (a 500/401/429 used to render as a *successful empty assistant bubble*). The body is never read — only `statusText`, truncated to 200 chars and secret-redacted. `'ignore'` restores the old silence; `useChat`/`useObject` forward the option verbatim.

`ConnectDeuzStreamOptions`: `fetch`, `headers`, `lastEventId`, `maxReconnects` (5 — the counter resets whenever an event arrives, so only *consecutive dead* reconnects exhaust it), `signal`, `clock`, `onCursor(lastEventId)` (persist it to survive a full page reload), `generateId` (jitter source). Point it at the **resume GET route** — never at the generating POST route, which would re-run the model. If the server sent events without ids (v1) it **throws** rather than silently duplicating every delivered part.

## 7. `DeuzUIPart` — what arrives on the wire

Discriminated on `type`, **open and additive**: always keep a `default` case. Parts marked v2 are dropped for a negotiated-v1 client.

| `type` | Fields |
| --- | --- |
| `start` | `messageId` — always first (not re-emitted on a continued leg) |
| `step-start` / `step-finish` | `step` / `step, finishReason, usage` |
| `text-delta` / `reasoning-delta` | `text` / `text, signature?` (no `encrypted` flag on the wire) |
| `tool-input-delta` | `toolCallId, toolName?, delta` — raw argument-JSON fragments |
| `tool-call` / `tool-result` | `toolCallId, toolName, input` / `+ output, isError?` |
| `tool-approval-request` | `approvalId, toolCallId, toolName, input, token?` — the loop broke, awaiting a verdict |
| `tool-approval-response` | **client→server only**; the verdict rides the next request body as `approvalResponses` |
| `object-delta` | `object` — each delta REPLACES the previous partial wholesale |
| `source` / `compaction` / `sub-agent` | `id,url?,title?` / `layer,tokensBefore,tokensAfter` / `agentPath, part` |
| `data-{name}` **v2** | `payload, id?` |
| `citation` **v2** | `id, sourceId?, url?, title?, snippet?, chunkIndex?, score?` |
| `tool-state` **v2** | `toolCallId, toolName?, state: ToolRunState, denied?, deniedReason?` |
| `cost` / `budget-exceeded` **v2** | `costUsd, deltaUsd?, cacheSavingsUsd?, stepIndex?` / `kind, limit, value` |
| `verify` / `false-finish` **v2** | `stepIndex, attempt, ok, willRetry, feedback?` / `stepIndex, attempt, willRetry` |
| `warning` **v2** | `warning: CallWarning` — `type` is an OPEN union; treat unknown as `'other'` |
| `plan-update` / `activity` **v2** | `goal?, tasks[]` / `message, level?, data?, agentPath?` |
| `finish` / `error` | `finishReason, usage` / `message` (already secret-redacted) |

`ToolRunState` = `input-streaming | input-complete | awaiting-approval | executing | complete | error`. A **denied** call is `state: 'error'` **plus** `denied: true` — not a seventh state, because consumers switch exhaustively. Branch on `state === 'error' && denied` to render "Declined" instead of "getWeather failed". `deniedReason` is the denier's own words, never invented (a verdict's `reason` verbatim, `No approval response.`, `No result provided for this client tool.`, or an `approvalSigner` token rejection); a server-mode `approveToolCall` returns a bare boolean, so its refusal carries `denied: true` with no reason. A tool that **threw** gains no denial fields — that is the distinction.

## 8. The pure chat engine (`@deuz-sdk/core/chat`)

Framework-agnostic, pure, total: new objects out, inputs untouched, unknown parts ignored, errors recorded rather than thrown. `@deuz-sdk/react` is a thin binding over exactly these.

| Function | Does |
| --- | --- |
| `createAssistantTurn(id)` | Fresh `AssistantTurnState`. |
| `applyUIPart(turn, part)` | Folds ONE `DeuzUIPart` in; returns a new state. |
| `sealAssistantTurn(turn)` | Every `'streaming'` text/reasoning element → `'done'`. Idempotent; returns the SAME object when there is nothing to seal. |
| `assistantMessageFromTurn(turn)` / `clientToolResultMessage(results)` | The canonical assistant `Message` (text + `tool_use`) and the `role: 'tool'` message for client-executed results. |
| `userMessageFromInput(input)` / `filesToImageParts(files)` | `ChatInput` (`string \| { text?, parts? }`) → canonical user `Message` (a bare string stays a plain string `content`); picked files → `ImagePart[]` (Web APIs only; images AND PDFs). |
| `uiFromMessages(messages, generateId)` | Canonical history → `UIMessage[]` with ordered `parts`; `tool` messages merge into the preceding assistant turn, `system` messages are not rendered. |
| `canonicalFromUI(ui)` | The inverse — **lossy**, see below. |
| `dropTrailingAssistant(history)` / `branchBeforeUserMessage(history, messageId)` | Regenerate: cut trailing assistant/tool turns from both views. Edit-and-resend: cut both views before that user turn (`undefined` if it is not a user message). |

`AssistantTurnState` = `{ message, approvals, serverResults, dataParts, citations, activity }` always, plus channels that stay **absent until their first entry**: `costUsd` / `cacheSavingsUsd`, `budgetExceeded`, `plan`, `verifications`, `warnings`, `falseFinishes`, `subAgents`, `usage`, `finishReason`, `steps`, `error`.

**`canonicalFromUI` is lossy on purpose.** With ordered `parts` present it preserves the interleave, `ImagePart` attachments, reasoning `signature`/`encrypted`/`redacted`, and `tool_use.providerMetadata` (Gemini's `thoughtSignature` — dropping it 400s the next request). It does **not** preserve `system` messages, message-level `providerMetadata`, consecutive text parts (they merge), or UI-only bookkeeping. Without `parts` it collapses to bucket order and attachments are gone entirely. So when you hold the real history, persist it: save `useChat().history.canonical`, never a round-trip through `canonicalFromUI`.

Persistence is the `ChatStore` seam — `saveChat(record)` / `loadChat(chatId)` (+ optional `deleteChat` / `listChats`), with `ChatRecord = { chatId, scope: MemoryScope, messages, parentId?, updatedAt }`. Set `chat: { store, chatId, scope, parentId? }` on any `streamChat`/`generateText` call and the loop persists the full immutable history at every terminal boundary (completion, approval suspension, mid-stream error). It is best-effort: a throwing `saveChat` logs and never kills the run. Setting `chat` routes even a tool-less call through the agentic loop, so `step-start` / `step-finish` parts start appearing — another reason to keep that `default` case. Reference stores: `createInMemoryChatStore()`, `createJsonlChatStore({ dir })` (`@deuz-sdk/core/chat/node`), `serializeChatRecord` / `deserializeChatRecord` for text columns (plain `JSON.stringify` decays `Uint8Array` parts). For production use a store pack — `createSqliteStores` / `createRedisStores` / `createPostgresStores`.

## 9. Rendering ordered parts

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
          case 'reasoning': // `encrypted` is an opaque provider payload, not text
            return part.encrypted ? null : <Thinking key={i} text={part.text} />;
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

A text/reasoning element is `'streaming'` only while it is the newest thing in the turn; opening anything else seals it, which is what makes a text delta arriving *after* a tool call a new paragraph. A `file` element carries the canonical `ImagePart.image` value verbatim, with `url` set only when it is already a renderable `data:` / `http(s):` src — for bytes, build one yourself.

**A sub-agent run is NOT in `parts`.** `applyUIPart` folds `sub-agent` parts into `turn.subAgents` (surfaced as `useChat().subAgents`): `Array<{ agentPath: string[]; afterPart: number; turn: AssistantTurnState }>`, one frame per path. `frame.turn` is a full turn folded by the same reducer re-entering itself, so render it with the **same** `<Turn>` component, indent by `agentPath.length`, and splice at `afterPart` (the parent's ordered-element count at the handoff). A 2nd-level sub-agent is a *sibling* frame with a two-segment path — the wire is single-wrapped, so no recursion is needed. It is kept out of the parent deliberately: folding it in would misattribute the child's prose and would put the child's `tool_use` into `assistantMessageFromTurn`'s output with no matching `tool_result`, which 400s the next request. Read `frame.turn.citations`, not `turn.citations`, for a child's sources.

## 10. `useChat`

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

`UseChatOptions`: `api` (required), `initialMessages`, `headers`, `body`, `chatId`, `resume`, `generateId`, `throttleMs`, `onToolCall`, `onData`, `onError`, `onHttpError`, `fetch`.

`UseChatResult`: `messages`, `history`, `status` (`'idle' | 'streaming' | 'error'`), `error`, `pendingApprovals`, `pendingToolCalls`, `cost?`, `budgetExceeded?`, `dataParts`, `citations`, `plan?`, `activity`, `verifications?`, `warnings?`, `falseFinishes?`, `subAgents?`, `steps?`, `usage?`, `finishReason?`, `sendMessage`, `stop`, `regenerate`, `editAndResend`, `setHistory`, `setMessages`, `addToolResult`, `clearError`, `addToolApprovalResponse`, `reconnect`.

- **Two histories, one commit.** `history` is `{ ui, canonical }` published in a single `setState`, so no render sees one a frame behind the other. Persist `history.canonical`.
- **`initialMessages` is read once at mount** and deliberately never re-adopted (apps pass inline literals). Switching chats or hydrating later is `setHistory`.
- **Client tools.** *With* `onToolCall` the hook executes, appends the result and re-POSTs automatically (a throw self-heals as `is_error`). *Without* it the round-trip **parks**: calls land in `pendingToolCalls`, `status` goes idle, and `addToolResult({ toolCallId, output })` answers them — the chat continues once *every* parked call is answered. A result for an id that is not parked is a no-op (an orphan `tool_result` 400s the next request).
- **Approvals pause the chat.** No re-POST while `pendingApprovals` is non-empty; `addToolApprovalResponse` resumes with `approvalResponses` once every verdict has arrived, and the request's signed `token` is auto-preserved. The **server** settles gated calls — the client never fabricates their `tool_result`.
- **`setMessages` re-derives canonical through the lossy `canonicalFromUI`**; `setHistory({ ui, canonical })` is the honest primitive. Both drop pending approvals and parked tool calls (they were anchored to the transcript you replaced) and neither resets the turn readouts.
- **`throttleMs`** (default `0`) coalesces commits on the trailing edge and **always** flushes at a terminal boundary, so the final text can never be lost. `cost` is cumulative across turns; everything else (`dataParts`, `citations`, `plan`, `activity`, `verifications`, `warnings`, `falseFinishes`, `subAgents`, `steps`, `usage`, `finishReason`) is turn-scoped.
- **`resume: { endpoint, auto?, lastEventId?, cursor? }`** points at the resume GET route. `auto` fires once per mounted hook (StrictMode-safe) and **fails silently by design** — a cold load against a 404 must not paint a permanent error; call `reconnect()` yourself when you want the failure surfaced. `cursor` is an injectable `{ load, save }` adapter, never hardcoded `localStorage`.
- A stream that dies with neither `finish` nor `error` leaves the tail `'streaming'` — that is the truth about a truncated turn. `stop()` and a stream ending without `finish` call `sealAssistantTurn`; read `finishReason === 'length'` to tell "cut off" from "complete".

## 11. `useObject`, and the components

`useObject<T>({ api, headers?, onHttpError?, throttleMs?, fetch? })` → `{ object, isLoading, error, submit, stop }`. `submit(input)` POSTs `{ input }` and clears the previous object immediately (never coalesced); each `object-delta` **replaces** `object` (`DeepPartial<T>` — every field optional at every depth, strings arrive truncated, so render defensively); `stop()` aborts without erroring. Its route is one line: read `{ input }` off the body, then `return toDeuzObjectStreamResponse(streamObject({ model, schema, prompt }))` — no loop options, `streamObject` is single-turn and raises `InvalidRequestError` if you pass any.

`ToolApprovalCard({ approval, onRespond, render? })` is headless: it always echoes the request's signed `token` on the verdict, and `render({ approval, approve, deny })` overrides the markup. `CostBadge({ cost, format? })` renders `$X.XXXX` (plus ` (saved $Y.YYYY)`) from `useChat().cost`, and returns `null` before the first `cost` part. `partsFromFiles(files)` is a null-tolerant wrapper over `filesToImageParts`.

## Sharp edges

- Nobody reading the stream = no persistence, no checkpoints, no `onFinish`. Always `after(() => result.consume?.())` / `ctx.waitUntil(result.consume?.() ?? Promise.resolve())`.
- Destructuring `messages` out of `req.json()` is the vulnerability this module exists to close. `rest` is not validated; never spread it.
- `store` without `streamId` **throws**. `connectDeuzStream` against a v1 stream **throws** (duplication is worse than a hard failure).
- Point `connectDeuzStream` / `resume.endpoint` at the resume **GET** route; the POST route would re-run the model.
- A renderer over `parts` must handle `step-start` (usually `parts[0]`), skip `encrypted` reasoning, and look `tool` elements up in `message.toolCalls`.
- `sub-agent` runs live in `turn.subAgents`, never in the parent's `parts` or buckets.
- Denials are `state: 'error'` + `denied`, not a new state. A thrown tool has no denial fields.
- `transient` data parts are invisible to a reconnecting client; the durable snapshot must be a normal write.
- `toDeuzTextStreamResponse` cannot report an error — the body just truncates.
- `streamObject` has no repair retry, so a bad final payload rejects `object` *and* the partial stream (`generateObject` retries once).

## Deep dive

- [/docs/modules/ui-streaming](/docs/modules/ui-streaming) — the wire in full: versions, journaling, Redis/Supabase `StreamStateStore` adapters, every part type.
- [/docs/modules/react-hooks](/docs/modules/react-hooks) — `useChat` / `useObject` option-by-option, parts rendering, resuming, throttling.
- [/docs/modules/request-validation](/docs/modules/request-validation) — `validateChatRequest`: threat model, defaults, what it deliberately does not do.
- [/docs/modules/chat-persistence](/docs/modules/chat-persistence) — `ChatStore`, the reducer, ordered parts, `canonicalFromUI`, branching.
- [/docs/agents/client-tools](/docs/agents/client-tools) — the client-tool and approval round-trips end to end.
- [/docs/agents/unbreakable-chatbot](/docs/agents/unbreakable-chatbot) — the wire log × durable checkpoints, and `resumeDeuzChatResponse`.
- [/docs/core/stream-chat](/docs/core/stream-chat) — the source `StreamChatResult`, `consume()`, timeouts, aborts.
- [/docs/core/files](/docs/core/files) — what `partsFromFiles` produces and how to render a `file` part back.
