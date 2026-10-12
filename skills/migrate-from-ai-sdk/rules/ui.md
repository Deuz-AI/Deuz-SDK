# The route and the client (port them together)

Deuz does not speak the AI SDK's UI message protocol. `toDeuzStreamResponse` emits SSE stamped `x-deuz-stream: v2`, read back by `readDeuzStream` / `connectDeuzStream` or by `useChat` from `@deuz-sdk/react`. You cannot mix halves.

## The route

```ts
// before — app/api/chat/route.ts
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const result = streamText({ model: anthropic('claude-sonnet-4-5'), messages: convertToModelMessages(messages) });
  return result.toUIMessageStreamResponse();
}
```

```ts
// after
import { streamChat } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function POST(req: Request): Promise<Response> {
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

  const result = streamChat({
    model: anthropic('claude-opus-4-8'),
    instructions: 'You are a helpful assistant.',
    messages: parsed.request.messages,
    signal: req.signal,
  });
  return toDeuzStreamResponse(result);
}
```

Two changes beyond the rename:

1. **No `convertToModelMessages`.** Deuz's `useChat` already holds the canonical `Message[]` alongside the render view and POSTs that, so the route reads it directly.
2. **`validateChatRequest` is not optional in practice.** The body is attacker-controlled and canonical `Message[]` includes `role: 'system'` — a client can overwrite the instructions the route thought it owned. It also rejects forged `tool_result` parts, forged assistant turns, and an oversized history. It NEVER repairs: every failure is a rejection.

### `validateChatRequest` defaults

| Option | Default | Effect |
| --- | --- | --- |
| `rejectSystemRole` | `true` | Reject `role: 'system'` — the live vector. |
| `rejectToolResults` | `true` | Reject `tool_result` parts and `role: 'tool'` turns (caught at part level too). Since 2.3 the default accepts one shape: a `role: 'tool'` message (or a run of them) right after an assistant turn, holding only `tool_result` parts that each answer a different call of that turn. `false` accepts every tool result. |
| `rejectAssistantTurns` | `false` | Regenerate / edit-and-resend legitimately replay them. |
| `maxMessages` | `1000` | Over the cap it rejects WITHOUT walking the entries. |
| `maxTextBytes` | `100_000` | Per message, UTF-8; image/PDF payloads excluded. Since 2.3 an object's keys count as well as its values. |
| `maxOpaqueReasoningBytes` | `1_000_000` | 2.3: per message, the payload of `encrypted` (OpenAI) and `redacted` (Anthropic) reasoning, counted apart from `maxTextBytes`. A flag counts as opaque only on its own family (`source` absent or matching); any other flagged part counts as text. |
| `maxProviderMetadataBytes` | `1_000_000` | 2.3: per message, provider round-trip data: the `providerMetadata` of the message and its parts (Gemini thought signatures) and every reasoning `signature`. |

**Client tools and approvals pass the defaults (2.3).** The history `useChat` posts after a client tool, an approval, or a server tool the leg ran pairs each `tool_result` with the assistant turn before it, which the default accepts, so a ported client-tool route needs no `rejectToolResults: false`. Every other tool result is still rejected. Understand what an accepted result is: the validator cannot tell a real client tool result from a forged one, because the same client authored the assistant turn it pairs with. The only real fix is server-side history (`ChatStore` + `chatId`) with the client's copy as a rendering cache.

`parsed.request` is `{ messages, chatId?, approvalResponses?, rest }`. `rest` is UNVALIDATED passthrough (`useChat`'s `options.body` lands there, and a native route's `runId` and `clientToolResults`) — read fields you know by name; never spread it into call options.

`parseDeuzChatRequest` is the throwing variant (`InvalidRequestError`, status 400).

### Terminal effects in a serverless route

```ts
const response = toDeuzStreamResponse(result);
after(() => result.consume?.());   // next/server; ctx.waitUntil(...) on Workers
return response;
```

Without it, a client that disconnects leaves nothing pulling the lazy pump, so chat persistence / checkpoints / `onFinish` never run. See `rules/streaming.md`.

## Other route serializers

| AI SDK | Deuz |
| --- | --- |
| `result.toTextStreamResponse()` | `toDeuzTextStreamResponse(result)` — `text/plain`, no framing. A mid-stream failure **truncates the body and writes nothing**; use the SSE form (or `result.finishReason`) when you need to tell "finished" from "died". |
| `createUIMessageStream` + `createUIMessageStreamResponse` + a `data-*` write | `createDeuzStream(result)` -> `{ response, writeData, close }` |
| — | `toDeuzObjectStreamResponse(streamObjectResult)` for `useObject` |
| — | `resumeDeuzStreamResponse(...)` — replay + live tail from a `StreamStateStore` |
| — | `toDeuzAgentStreamResponse(stream, { runId, store?, streamId? })` (2.3) — a native `streamAgent` / `resumeStreamAgent` run on the same wire, with `data-agent` frames for its state |

`writeData(name, payload, options?)` takes `{ id?, transient? }` since 1.9: `id` makes the entry addressable (the client reconciles repeat writes of the same `(name, id)` in place); `transient` emits on the wire but is not journaled and is off-seq — a reconnecting client will NOT receive transient frames it missed.

## The client reader

```ts
for await (const part of readDeuzStream(res)) {
  switch (part.type) {
    case 'text-delta': append(part.text); break;
    case 'tool-call':  showTool(part.toolName, part.input); break;
    case 'finish':     done(part.finishReason, part.usage); break;
    case 'error':      showError(part.message); break;   // already secret-redacted
    default: break;                                       // OPEN union — keep this
  }
}
```

A non-2xx response yields exactly ONE `error` part (1.9) instead of ending silently, so a failed route no longer renders as an empty assistant bubble. The body is deliberately not read; only `statusText` is echoed, truncated and redacted. Opt out with `readDeuzStream(res, { onHttpError: 'ignore' })`.

`connectDeuzStream(source, options?)` adds auto-reconnect with `Last-Event-ID` and seq dedup. Point it at a RESUME endpoint, never at the generating POST route (that would re-run the model).

## `useChat`

```tsx
import { useChat } from '@deuz-sdk/react';

const {
  messages, history, status, error,
  sendMessage, regenerate, editAndResend, stop,
  setHistory, setMessages, addToolResult, clearError,
  pendingApprovals, pendingToolCalls, addToolApprovalResponse,
  reconnect, usage, finishReason, steps, verifications,
  cost, budgetExceeded, dataParts, citations, plan, activity,
  stopDetails, agent, // 2.3: a refusal's explanation; a native run's state
} = useChat({ api: '/api/chat' });
```

Mapping:

| AI SDK | Deuz |
| --- | --- |
| `transport: new DefaultChatTransport({ api })` | `useChat({ api })` — no transport abstraction; `fetch` is injectable |
| `messages` (option) | `initialMessages` — **read once at mount**, deliberately not re-adopted when the prop changes. `setHistory` is the escape hatch. |
| `setMessages` | `setMessages` (re-derives canonical via the lossy `canonicalFromUI`) or `setHistory({ ui, canonical })` for both views |
| `addToolResult` | `addToolResult({ toolCallId, output, isError? })` |
| `resumeStream` | `resume: { endpoint, auto?, cursor? }` + `reconnect()` |
| `regenerate` / `stop` / `clearError` | same names (plus `editAndResend(messageId, input)`) |
| `onToolCall` / `onData` / `onError` | same names — `onData` gets the RAW frame, before reconciliation |
| `onFinish` | not a hook option; read `usage` / `finishReason` from the result, or use the server's `onFinish` |
| `sendMessage(text)` | `sendMessage(input: ChatInput)` — `string | { text?, parts? }` |
| `id` | `chatId` (merged into every request body) |

Deuz keeps **two** histories and publishes them in one commit: `messages` (render view) and `history.canonical` (what it POSTs). Persist `history.canonical`, not the UI view.

New knobs worth setting during a port: `throttleMs` (coalesce commits; terminal frames always flush) and `onHttpError`.

### Client tools: executor or parked

With `onToolCall`, the hook runs it, appends the `tool_result` and re-POSTs automatically. **Omit** `onToolCall` and the round-trip PARKS: calls land in `pendingToolCalls`, `status` goes idle, and `addToolResult` answers them from outside the hook (an unknown `toolCallId` is a no-op). Parking is new in 1.9 — before it, a turn with client tool calls and no executor abandoned the round-trip. Since 2.3 a turn read back through `reconnect()` settles the same way, a replayed call runs at most once per mounted hook, and an approval verdict that answers nothing in `pendingApprovals` (a double click, a stale card) is a no-op.

### A native agent route (2.3)

An AI SDK `ToolLoopAgent` behind a chat UI can become a native run with validated output: serve `streamAgent` (and `resumeStreamAgent` for a request carrying `runId`) through `toDeuzAgentStreamResponse`. `useChat` drives it with no new option: when the run suspends, its approvals and client calls go through the usual `pendingApprovals` / `onToolCall` / `pendingToolCalls`, and the hook resumes the run in one request with `runId`, `approvalResponses` and `clientToolResults`. Read the run's state from `agent` (`output` only once it `completed`). The companion `deuz-sdk` skill's `references/streaming-ui.md` has the route.

### Rendering: ordered `parts`

Both SDKs have `UIMessage.parts`, with **different members**, and Deuz's is **optional** — absent until the first element exists, so a message restored from pre-1.9 storage has none. Render `parts` when present, the buckets (`content` / `reasoning` / `toolCalls`) otherwise.

```tsx
{message.parts?.map((part, i) => {
  switch (part.type) {
    case 'step-start': return <Divider key={i} step={part.step} />;
    case 'text':       return <Prose key={i} text={part.text} streaming={part.state === 'streaming'} />;
    case 'reasoning':  return part.encrypted || part.redacted ? null : <Thinking key={i} text={part.text} />;
    case 'tool':       return <ToolCard key={i} call={byId(message.toolCalls, part.toolCallId)} />;
    case 'file':       return <Attachment key={i} mediaType={part.mediaType} data={part.data} url={part.url} />;
    case 'citation':   return <Source key={i} part={part} />;
    case 'data':       return <Widget key={i} name={part.name} payload={part.payload} />;
    default:           return null;
  }
})}
```

Three things a renderer MUST get right:

1. **`step-start` is normally `parts[0]`** of a real streamed turn (the streaming loop pushes one per iteration). Without a case for it, the very first element hits `default`.
2. **Skip `reasoning` parts flagged `encrypted` or `redacted`** — opaque provider payloads (OpenAI encrypted reasoning, Anthropic redacted thinking), not display text. Since 2.3 both flags appear on streamed turns too, one part per provider block.
3. **A `tool` element carries only `{ type, toolCallId }`** — look the call up in `message.toolCalls`. It is a reference, not a copy, because a call's state mutates over the turn's life.

`sub-agent` parts are **not** in this union, by design: `applyUIPart` folds them into `turn.subAgents` / `useChat().subAgents` instead — `Array<{ agentPath: string[]; afterPart: number; turn: AssistantTurnState }>`, one frame per path, each `frame.turn` a full turn folded by the same reducer. Render a frame with the SAME `parts` switch above, indent by `agentPath.length`, and splice it at `afterPart` (the parent's ordered-element count when the frame opened) to reproduce the real interleave. `warning` and `false-finish` parts likewise fold into `turn.warnings` / `turn.falseFinishes`, both on `useChat`; every one of these channels is optional and absent until its first entry.

### Multimodal input

```tsx
import { partsFromFiles } from '@deuz-sdk/react';
const parts = await partsFromFiles(e.target.files);      // images AND PDFs
await sendMessage({ text: 'what is in these?', parts });  // media FIRST, then the question
```

A bare string stays a plain string `content`, byte-identical to 1.8, so a prompt-cache prefix does not move. Web APIs only — no `FileReader`, no `Buffer`.

### Resume

```tsx
resume: {
  endpoint: `/api/stream/${streamId}`,   // resumeDeuzStreamResponse — NOT the POST route
  auto: true,
  cursor: { load: () => sessionStorage.getItem(k) ?? undefined, save: (id) => sessionStorage.setItem(k, id) },
}
```

`auto` fires once per mounted hook (StrictMode-safe) and **fails silently by design** — no `error`, no `onError`, because the user did not ask for it and a 404 on every cold load would paint a permanent error. `reconnect()` by hand keeps the loud semantics. A caught-up endpoint (immediate `[DONE]`) is a no-op.

## `useObject`

```tsx
const { object, isLoading, error, submit, stop } = useObject<Recipe>({
  api: '/api/recipe',
  throttleMs: 50,             // 1.9
  onHttpError: 'error-part',  // 1.9
});
```

Each `object-delta` REPLACES `object` wholesale (`DeepPartial<T>`), and string fields stream truncated — render defensively. `submit` clears the previous object immediately (never coalesced).

## No React equivalent

`useCompletion` does not exist. Use `useChat` against a single-turn route, or drive `readDeuzStream` directly. There are no Svelte / Vue / Angular bindings — the wire is plain SSE, so a binding is writable, but nothing ships.
