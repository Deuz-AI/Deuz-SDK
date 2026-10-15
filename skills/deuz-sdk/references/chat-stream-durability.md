<!-- verified: 2026-10-15 against @deuz-sdk/core@2.3.0 · api-contract sha256:99750a8aa5fa
     sources: packages/core/src/types/{chat-conditional,stream-durable}.ts, packages/core/src/{chat-conditional,stream-durable,ui,chat,chat-request,durable}.ts,
     packages/core/src/internal/capabilities.ts, packages/core/src/node/{chat-conditional-sqlite,chat-conditional-postgres,
     stream-state-sqlite,stream-state-postgres,stream-state-redis}.ts, packages/react/src/{use-chat,chat-snapshot,index}.ts,
     .changeset/{2-4-l7a,2-4-l7b,2-4-l7c,2-4-w0d,2-4-w0e,2-4-fd}.md, docs/content/docs/modules/{chat-durability,transcript-search}.mdx (lane D1) -->

# Chat and stream continuity: conditional chats, transcript search, durable streams, chat snapshots (2.4)

**Load when:** two writers can update one chat (a late run projection must never overwrite a newer chat or bring a deleted one back); past conversations should be searchable within a user's scope; a streamed answer must survive the producer or client dropping with no gap and no repeated frame; or a React chat must restore after a reload with the same message ids, its turn in progress, and its pending approvals or client tools. The 2.3 wire, `StreamStateStore` journaling and `useChat` basics are in `references/streaming-ui.md`.

Everything is opt-in; a 2.3 client and a 2.3 route keep byte-identical behaviour. Docs: `/docs/modules/chat-durability` and `/docs/modules/transcript-search` (2.4).

| Need | Use |
| --- | --- |
| Compare-and-set chat writes, tombstoned deletes | `ConditionalChatStore`: `createInMemoryConditionalChatStore` (`/chat`), `createSqliteConditionalChatStore` (`/stores/sqlite`), `createPostgresConditionalChatStore` (`/stores/postgres`) + `updateConditionalChat` |
| Lexical search over past messages, scope-checked | `TranscriptIndex`: `createInMemoryTranscriptIndex` (`/chat`), or `store.transcript` of the SQL conditional stores; `indexChat` backfills |
| Persist every frame before it is sent | `toDeuzStreamResponse(result, { streamId, durable })` (also `toDeuzObjectStreamResponse`, `toDeuzAgentStreamResponse`, `createDeuzStream`) over a `DurableStreamStateStore` |
| Tell a 2.4 client what the route supports | `capabilities: { request, announce }` on the stream response and on `resumeDeuzStreamResponse` |
| Restore a chat in React | `useChat({ initialSnapshot })`, `exportSnapshot()`, `capabilities` (`@deuz-sdk/react`) |

## A durable, id-stable chat route

```ts
// app/api/chat/route.ts
import { after } from 'next/server';
import { streamChat } from '@deuz-sdk/core';
import type { LanguageModel } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createSqliteDurableStreamStateStore } from '@deuz-sdk/core/stores/sqlite';
import { DEUZ_CAPABILITY, resumeDeuzStreamResponse, toDeuzStreamResponse } from '@deuz-sdk/core/ui';

declare const model: LanguageModel;

const streams = createSqliteDurableStreamStateStore({ path: './streams.db' });
const ops = createSqliteOpsStore({ path: './ops.db' }); // ops.leases: the producer lease

export async function POST(req: Request): Promise<Response> {
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
  const id = parsed.request.rest.streamId; // unvalidated: check it yourself
  const streamId = typeof id === 'string' ? id : crypto.randomUUID();

  // No `signal: req.signal`: a durable producer keeps committing after the client leaves.
  const result = streamChat({ model, messages: parsed.request.messages });
  const response = toDeuzStreamResponse(result, {
    streamId,
    messageId: crypto.randomUUID(), // store this as the assistant message's id
    durable: { store: streams, lease: { provider: ops.leases } },
    capabilities: { request: req, announce: [DEUZ_CAPABILITY.messageIds, DEUZ_CAPABILITY.chatSnapshot] },
  });
  after(() => result.consume?.());
  return response;
}

// app/api/chat/[id]/stream/route.ts — the resume GET route, keyed by streamId
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return resumeDeuzStreamResponse(streams, id, {
    lastEventId: req.headers.get('last-event-id'),
    capabilities: { request: req }, // 'durable-stream' is announced for a durable store
  });
}
```

```tsx
'use client';
import type { ReactElement } from 'react';
import { useChat } from '@deuz-sdk/react';
import type { ChatSnapshotV1 } from '@deuz-sdk/react';

declare const saved: ChatSnapshotV1 | undefined; // JSON.parse of an earlier exportSnapshot(), or built from a ChatRecord
declare function persist(snapshot: ChatSnapshotV1): void;

export function Chat({ streamId }: { streamId: string }): ReactElement {
  const chat = useChat({
    api: '/api/chat',
    body: { streamId },
    initialSnapshot: saved, // read once at mount; wins over initialMessages
    resume: { endpoint: `/api/chat/${streamId}/stream`, auto: true },
  });
  return (
    <div>
      {chat.messages.map((m) => (
        <p key={m.id}>{m.content}</p> // ids are the stored ids, so keys survive a reload
      ))}
      <button onClick={() => persist(chat.exportSnapshot())}>Save</button>
      <small>{chat.capabilities?.join(', ')}</small>
    </div>
  );
}
```

## Conditional chat stores

- **Revisions.** 1 for a new chat, plus one per committed write. `readChat(id)` → `{ status: 'found', record }` (with `revision`) | `{ status: 'missing' }` | `{ status: 'deleted', tombstone }`. `writeChat(record, { expectedRevision })` writes only at that revision (0: the chat must not exist and must not be a tombstone), else `{ status: 'conflict', current }` and nothing is written.
- **Tombstones are final.** `tombstoneChat(id, { expectedRevision })` and `deleteChat(id)` replace the chat by a tombstone and drop it from the index; a later `writeChat` conflicts, `saveChat` throws `RevisionConflictError`, `deleteChat` is a no-op. Deleting a chat that was never written leaves a tombstone too. `pruneTombstones(before)` deletes old tombstones (the id can then be reused); the SDK never prunes on its own.
- **Legacy methods still work:** `saveChat` is last-writer-wins at stored revision + 1 but never over a tombstone; `loadChat` omits missing or deleted chats; `listChats(scope?)` lists live chats, newest first. `isConditionalChatStore(store)` tells the kinds apart.
- **`updateConditionalChat(store, chatId, merge, { attempts = 3 })`**: `merge(current, attempt)` returns the record to write or `undefined`; it runs again against the newly stored chat on each conflict (so it must have no side effects), then throws `RevisionConflictError` (`subsystem: 'chat'`). A tombstone with a returned record throws at once.
- **Native runs with a conditional `chat.store`** write their projection with `writeChat` at the revision they read; on a conflict they re-read and decide again (3 attempts, then the chat state is `failed` and a later save or `reconcileAgentRun` repairs it). A tombstone makes the projection `superseded` with a `chat` warning. Other stores keep the 2.3 behaviour.
- **SQL stores** keep new tables (`deuz_chat_conditional*`, `deuz_chat_transcript*`) with their own `deuz_chat_conditional_schema` version table and update the transcript index in the same transaction; they never touch `deuz_chats`, `PRAGMA user_version` or the legacy migrate versions. SQLite writes are `BEGIN IMMEDIATE` (safe across processes); PostgreSQL needs a pool with `connect()` (or opens its own from `connectionString`) and takes a per-chat advisory lock. Moving legacy rows is manual: copy them with `writeChat(record, { expectedRevision: 0 })` after stopping legacy writers on those scopes.
- **Message ids (H7).** `ChatRecord.messageIds` (native runs write `<runId>:<n>`) survive every conditional store. Render a stored chat with `uiFromMessages(record.messages, generateId, { messageIds: record.messageIds })`; `generateId` only covers a missing, empty or repeated id. A transcript hit's `messageId` and a memory source's `messageId` are the same ids the UI renders.

## Transcript search

`index.search(scope, query, { limit = 10, around = 0, chatIds?, before?, after?, signal? })` returns `TranscriptHit[]` (`chatId`, `messageId`, `index`, `message`, `score` — the best hit scores 1 — and `around` neighbours when asked), best first.

- Lexical only in 2.4 (no embeddings). A message matches when it holds **any** query term; terms are runs of letters and digits, case and diacritics folded (`İzmir` = `izmir`), at most 32 per query. Whole-word matching in memory, FTS5 and PostgreSQL (`simple` config, terms inside hosts, emails and paths included); substring matching in the SQLite LIKE fallback.
- Indexed: string content, text parts and string tool results; system messages, reasoning, tool inputs, images and structured tool results are not. Of a message over 256 KiB (UTF-8) only the first 256 KiB's terms are indexed.
- **Scope:** every field set in `scope` must match; an empty scope matches every chat, so always pass at least `userId`. `before` / `after` compare the time a message id was first indexed (strict).
- `resolveSource(scope, ref)` resolves a memory `MemorySourceRef` (`chatId` + `messageId`) to its message under the same scope check, or `undefined`. `indexChat(index, record)` backfills a chat saved through a legacy store (a missing id becomes `<chatId>:<index>`); the SQL stores skip a tombstoned chat. No span is emitted for chat writes or searches. The context compiler reads an index as a source (`references/context-working-memory.md`).

## Durable streams (preview)

`durable: { store, lease: { provider, owner?, ttlMs? = 30000 }, batch?: { maxDelayMs? = 20, maxBytes? = 16384 }, deps? }` (`DurableStreamOptions`, `DEFAULT_DURABLE_STREAM_BATCH`). `streamId` is required; `store`, if also set, must be the same object. A misconfiguration throws a `TypeError` when the response is built.

- **Persist before publish.** The producer holds the lease `stream:<streamId>` (renewed every `ttlMs / 3`, released at the end) and its token fences the store. Frames are committed in batches (first of 20 ms or 16 KiB) and a batch reaches the wire only after it committed; the last batch, with the `done` sentinel, commits before `[DONE]`. Transient `writeData` parts keep their order and are never journaled. A client that reconnects to `resumeDeuzStreamResponse` over the same store gets every committed frame once, in order.
- **Fails closed.** When another producer holds the lease, a newer producer fenced it, the stored log moved past it, the lease was lost or the store threw, the response sends one `error` frame (no event id, no `[DONE]`), stops reading its source and hands a thrown store or lease error to `onStoreError` only. A producer that throws ends its journal and releases its lease.
- **Stores** (each is also a `StreamStateStore`, parts kept as JSON text so a replay sends the live bytes): `createInMemoryDurableStreamStateStore({ deps? })` (`/ui`), `createSqliteDurableStreamStateStore({ path | database, wal?, clock? })` (`/stores/sqlite`), `createPostgresDurableStreamStateStore({ pool | connectionString, schema? })` (`/stores/postgres`), `createRedisDurableStreamStateStore({ client | url, prefix? = 'deuz' })` (`/stores/redis`, Redis 7+; the only 2.4 store on Redis). SQL stores use their own `deuz_stream_state_schema` version table.
- **Retention:** `store.prune({ terminalBefore })` deletes finished streams (last record the `done` sentinel) whose last open, commit or append is older than the cutoff, on the store's clock; 24 h is a good default. A pruned stream forgets its fence. Keep a lease provider's prune cutoff longer than any producer pause.
- **Continuation legs.** `resumeDeuzChatResponse({ ..., durable })` (`/durable`) runs the continuation leg durably (`durable.store` must be its `streamStateStore`): it is refused while a quiet producer still holds the lease and continues gapless once a crashed producer's lease lapsed.
- **Spans:** `deuz.stream.batch` (frames, bytes, commit ms) and `deuz.stream.fenced` (fencing token) through `durable.deps.observer`; never content.
- **Behaviour change for the legacy `store`:** a store that cannot report its last seq no longer makes a response renumber from 0 over stored frames — that response is not journaled, `onStoreError` fires, and a v2 client gets a `warning` part of type `'stream-store-error'`; the first failed append stops journaling the leg the same way. Such a response cannot be resumed: use `durable` when it must be.

## The capability handshake

- **Server.** Only when the request's `x-deuz-capabilities` header lists something does the response announce what it supports: in the same response header (sorted, `', '`-joined) and in a first `{ type: 'capabilities' }` frame (no event id, never journaled, not on wire v1). `durable-stream` is added for a durable response, or on the resume endpoint for a durable store; `announce` adds the rest (`DEUZ_CAPABILITY.messageIds`, `.chatSnapshot`; `'conditional-chat'` is server-only). Announced strings must be lower-case tokens (`TypeError`). `DEUZ_CAPABILITIES_HEADER`, `formatDeuzCapabilities` and `parseDeuzCapabilities(request | response | headers)` are in `/ui`.
- **Client (`@deuz-sdk/react`).** `useChat` sends `x-deuz-capabilities: chat-snapshot-v1, durable-stream, message-ids` on every POST and resume read (a function `resume.endpoint` receives it as `ctx.capabilities`), exposes what was announced as `capabilities`, and uses a feature only once announced: `message-ids` skips a replayed message the history already holds; `chat-snapshot-v1` adds `messageIds` aligned with `messages` to request bodies (`parsed.request.rest.messageIds` on the server: store them as `ChatRecord.messageIds`); `durable-stream` continues a POST read that dropped from `resume.endpoint` instead of ending in `status: 'error'`.
- **CORS (behaviour change):** a cross-origin chat API whose preflight lists allowed headers must add `x-deuz-capabilities`, or the app sets `capabilityHandshake: false` (no header, announcements ignored: exactly the 2.3 requests). Expose the response header with `Access-Control-Expose-Headers`, or the hook reads the first frame instead.

## React chat snapshots

`ChatSnapshotV1` (`@deuz-sdk/react`, plain data for `JSON.stringify`): `version: 1`, `messages`, `messageIds?`, `cursor?`, `turn?` (the streaming turn), `pendingApprovals?`, `pendingToolCalls?`, `gate?` (`ChatSnapshotGateV1`: verdicts and results already given, a native run's `runId` and client calls), `capabilities?`.

- `useChat({ initialSnapshot })` restores messages under their stored ids, the turn in progress as the last bubble, the cursor (it beats `resume.lastEventId`), pending approvals and parked client calls with what was already answered, and the recorded capabilities. `reconnect()` or `resume.auto` continues the restored turn from the cursor, every frame once; without `resume` the restored turn is sealed. A version other than 1, or a malformed array field, throws a `TypeError`.
- A stored chat restores as `{ version: 1, messages: record.messages, messageIds: record.messageIds }` — this also works against a 2.3 core (the hook applies the ids itself).
- `exportSnapshot()` reads the latest state, not the last render; `messageIds` holds the id each message renders under (the stream's start `messageId` for an assistant turn).
- **`@deuz-sdk/core/react` is deprecated** (2.4) in favour of `@deuz-sdk/react` and will be removed in 3.0; it has none of this, and a development build warns once.

## Deep dive

- `/docs/modules/chat-durability` and `/docs/modules/transcript-search` (2.4).
- [/docs/modules/ui-streaming](/docs/modules/ui-streaming), [/docs/modules/react-hooks](/docs/modules/react-hooks), [/docs/modules/chat-persistence](/docs/modules/chat-persistence).
- [/docs/agents/unbreakable-chatbot](/docs/agents/unbreakable-chatbot) — `resumeDeuzChatResponse` and durable checkpoints.
