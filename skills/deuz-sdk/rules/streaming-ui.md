# Streaming + UI wire

## streamChat semantics (the G2 rule)

```ts
function streamChat(options: StreamChatOptions): StreamChatResult
interface StreamChatResult {
  textStream: AsyncIterable<string>;     // text-only projection
  fullStream: AsyncIterable<StreamPart>; // canonical event stream
  usage: Promise<Usage>;
  finishReason: Promise<FinishReason>;
  consume?: (o?: { onError?: (e: unknown) => void }) => Promise<void>; // 1.9 — drain the pump
  warnings?: Promise<CallWarning[]>;     // 1.9 — real here; settles with usage, never rejects
  // plus optional runId / observation / memory / response
}
```

- **Synchronous return.** `streamChat` returns immediately and NEVER throws. Do not `await` it; do not make wrappers `async`.
- **Lazy pump.** The network request starts on first access of any output (`textStream` / `fullStream` / `usage` / `finishReason`). A `createBroadcaster` fans the single pump to multiple consumers — you can `await result.usage` first and still iterate the stream without losing data.
- **Errors surface on the stream, not as throws.** A failure becomes an `{ type: 'error', error }` part on `fullStream`, and `usage` / `finishReason` reject. Iterating `textStream` will throw when it hits the error. There is no try/catch around the `streamChat()` call itself.
- **Abort.** Pass `options.signal` (`abortSignal` is a deprecated 1.9 alias; `signal` wins if both are set). A user abort resolves `finishReason: 'aborted'` with partial usage (not an error). A `TimeoutError` IS a failure.
- **Retry.** Pre-first-byte only (`maxRetries`, default 2; exponential backoff + jitter, honors `Retry-After`). Once bytes stream, a mid-stream error is final.
- **`consume()` (1.9).** The lazy pump only advances while someone pulls, so if NOBODY iterates (client disconnected, result returned and dropped) the run never reaches its terminal boundary and `onFinish`, chat persistence, durable checkpoints and memory extraction never run. `after(() => res.consume?.())` / `ctx.waitUntil(res.consume?.())` drains it. It takes its own subscription (safe alongside iteration), is memoized, and NEVER rejects — failures go to `consume({ onError })`. Use `?.` — it is `undefined` on `fallbackModels` and `withFallback` paths.
- **`timeout` (1.9).** `{ ttftMs, totalMs, stepMs, toolMs }` or a bare number (= `totalMs`). Defaults ttft 60s / total 300s; step + tool unbounded. An explicit `0` DISABLES a layer. `stepMs` is enforced in the streaming loop only. `Tool.timeoutMs` overrides `toolMs` per tool and self-heals into an `is_error` result on expiry.
- **`warnings` (1.9) is real on `streamChat`.** `await result.warnings` settles with `usage`, NEVER rejects (a failed run resolves with what was collected), and `[]` means a clean call; each notice also arrives on `fullStream` as `{ type: 'warning', warning }`, AHEAD of the model's output (every warning site runs before the first byte). Deduped per call by `(type, setting, message)`, capped at 50 with a trailing `N further warning(s) omitted` entry, and every notice is also EXACTLY ONE `deps.logger.warn` line. Emitters today: `unknown-model` (unregistered slug → conservative fallback row), `unsupported-setting` for `temperature`/`topP` (a `samplingRestrictions` row on `anthropic`/`chat_completions`/`responses`, only for a value you PASSED) and for `effort` (no `reasoning` capability; `effort: 'none'` is silent), `unsupported-tool` (a hosted tool dropped on `chat_completions`; also `setting: 'activeTools'` from the streaming loop), `other` (a document dropped — `chat_completions` wire only). NOT populated on `generateText`/`generateObject`/`streamObject`, and a loop-routed `streamChat` reports only `activeTools` — see `pitfalls.md` #16. `wrapModel` and `fallbackModels` forward the underlying set.

```ts
const result = streamChat({ model, messages, signal: controller.signal });
try {
  for await (const t of result.textStream) write(t);
} catch (err) { /* mid-stream / transport error */ }
const reason = await result.finishReason; // 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'aborted'
```

## fullStream part types (`StreamPart`)

Open discriminated union — keep a `default` case (variants are additive).

```ts
| { type: 'text-delta'; text }
| { type: 'reasoning-delta'; text; signature? }
| { type: 'tool-call-delta'; id; name?; argsTextDelta; providerMetadata? }  // accumulate argsTextDelta as a string
| { type: 'source'; id; url?; title? }
| { type: 'finish'; usage; finishReason; providerMetadata? }          // providerMetadata.deuz.stoppedBy on a budget stop (1.4.0+)
| { type: 'error'; error: unknown }
| { type: 'step-start'; stepIndex }                                   // agentic loop
| { type: 'step-finish'; stepIndex; finishReason; usage }
| { type: 'tool-call'; toolCallId; toolName; input }                  // final parsed call
| { type: 'tool-result'; toolCallId; toolName; output; isError? }
| { type: 'tool-approval-request'; approvalId; toolCallId; toolName; input } // 1.3.0+: gated call awaits verdict
| { type: 'compaction'; layer; tokensBefore; tokensAfter }            // 1.4.0+: automatic compaction ran before this step
| { type: 'sub-agent'; agentPath: string[]; part: StreamPart }        // 1.4.0+: agentTool forwarding a nested loop's own StreamPart live (single-wrapped, not nested)
| { type: 'tool-state'; toolCallId; toolName?; state; denied?; deniedReason? } // denied 1.9: terminal 'error' caused by an approval REFUSAL, set by the streaming loop
| { type: 'data'; name; id?; payload }                                // id 1.9: client reconciles repeat writes of the same (name, id)
| { type: 'citation'; id; sourceId?; url?; title?; snippet?; chunkIndex?; score? }
| { type: 'cost'; costUsd; deltaUsd?; cacheSavingsUsd?; stepIndex? }  // needs deps.priceProvider
| { type: 'budget-exceeded'; kind; limit; value }                     // precedes the terminal finish
| { type: 'verify'; stepIndex; attempt; ok; willRetry; feedback? }     // 1.8; SERIALIZED TO THE UI WIRE since 1.9
| { type: 'plan-update'; goal?; tasks } | { type: 'activity'; message; level?; data?; agentPath? }
| { type: 'false-finish'; stepIndex; attempt; willRetry }              // 1.9: doneWhen rejected a natural completion; streaming loop only
| { type: 'warning'; warning: CallWarning }                           // 1.9: non-fatal notice; CallWarning.type is an OPEN union
```

## Deuz UI wire — `@deuz-sdk/core/ui`

This is OUR protocol, not a provider's. Server serializes canonical `fullStream` → versioned SSE; client reads it back.

```ts
// server
function toDeuzStreamResponse(result: StreamChatResult, options?: {
  messageId?: string; generateId?: () => string; headers?: Record<string,string>;
  wireVersion?: 'v1' | 'v2'; store?: StreamStateStore; streamId?: string;
  onStoreError?: (e: unknown) => void;
}): Response   // text/event-stream, header x-deuz-stream: v2 (v1 only if negotiated), terminator data: [DONE]

// server, frameless (1.9) — text/plain, no SSE. A mid-stream failure writes NOTHING
// (the body just truncates); use the SSE form when you must tell finished from died.
function toDeuzTextStreamResponse(result: StreamChatResult, options?: {
  headers?: Record<string,string>; includeReasoning?: boolean;
}): Response

// client
async function* readDeuzStream(response: Response, options?: {
  onHttpError?: 'error-part' | 'ignore';   // 1.9, default 'error-part'
}): AsyncGenerator<DeuzUIPart>
```

Since 1.9 a NON-2xx response yields exactly one `error` part instead of ending silently — before that a 500/401/429 rendered as a successful EMPTY assistant bubble. The body is never read (only `statusText`, truncated + redacted). `onHttpError: 'ignore'` restores the old silence; `useChat({ onHttpError })` forwards it.

`DeuzUIPart` mirrors `StreamPart` UI-framed: `start` (messageId), `text-delta`, `reasoning-delta`, `tool-input-delta` (`{ toolCallId, toolName?, delta }`), `tool-call`, `tool-result`, `tool-approval-request` (1.3.0+), `object-delta` (1.3.0+, from `toDeuzObjectStreamResponse` — each REPLACES the previous partial), `source`, `step-start`/`step-finish`, `finish`, `error` (`{ message }`, already secret-redacted), `compaction` (1.4.0+, `{ layer, tokensBefore, tokensAfter }`), `sub-agent` (1.4.0+, `{ agentPath, part }` — `part` is the nested loop's own `DeuzUIPart`, wrapped the same one level regardless of depth). `tool-approval-response` is declared client→server only — the verdict rides the NEXT request body as `approvalResponses`, it is never serialized by the server. Also on the wire, all v2-only, all journaled to the `StreamStateStore` and replayed on resume: `verify` (1.9 — `{ stepIndex, attempt, ok, willRetry, feedback? }`), `warning` (1.9 — `{ warning: { type, setting?, message } }`, `message` re-redacted by `toUIPart`), `false-finish` (1.9 — `{ stepIndex, attempt, willRetry }`), a data part's optional `id` (1.9), and `tool-state`'s optional `denied` / `deniedReason` (1.9, set by the streaming loop). Wire v1 output is unchanged in every byte — the new FIELDS ride carriers v1 already drops, and the two new PART types are v2-only (filtered recursively, so one inside a `sub-agent` frame is dropped too).

## React hooks — `@deuz-sdk/react` (1.7+; `@deuz-sdk/core/react` is frozen)

React is an OPTIONAL peer `^18 || ^19`; hooks are plain .ts (no JSX), SSR-safe (network only in callbacks).

```ts
const {
  messages, history, status, error,
  sendMessage, regenerate, editAndResend, stop,
  setHistory, setMessages, addToolResult, clearError,   // 1.9 writable state
  pendingApprovals, pendingToolCalls, addToolApprovalResponse,
  reconnect, usage, finishReason, steps, verifications, // 1.9 readouts
  warnings, falseFinishes, subAgents,                   // 1.9 readouts (optional; absent until first entry)
  cost, budgetExceeded, dataParts, citations, plan, activity,
} = useChat({ api: '/api/chat', onToolCall?, onData?, onError?, onHttpError?, headers?, body?,
              chatId?, initialMessages?, generateId?, throttleMs?, resume?, fetch? });

const { object, isLoading, error, submit, stop } =
  useObject<T>({ api: '/api/object', headers?, fetch?, throttleMs?, onHttpError? });
```

- `useChat` keeps TWO histories in ONE state cell: render-friendly `UIMessage[]` AND the canonical `Message[]` it POSTs. `history` exposes the pair (`{ ui, canonical }`) — persist `history.canonical`, not the UI view.
- `sendMessage(input: ChatInput)` takes `string | { text?, parts? }` (1.9). A bare string stays a plain string `content`, byte-identical to 1.8. `partsFromFiles(fileList)` feeds it from a file picker (images AND PDFs).
- Client tools: WITH `onToolCall` the hook executes, appends the result and re-POSTs automatically (a throw self-heals as is_error). WITHOUT it the round-trip PARKS — calls land in `pendingToolCalls`, `status` goes idle, and `addToolResult({ toolCallId, output })` answers them (unknown id = no-op).
- Approvals PAUSE the chat (`pendingApprovals` non-empty, no re-POST); `addToolApprovalResponse` resumes with `approvalResponses` once EVERY verdict arrived — the server settles gated calls, the client never fabricates their tool_results.
- `setHistory({ ui, canonical })` replaces both views; `setMessages` re-derives canonical via the LOSSY `canonicalFromUI` (system messages, `Message.providerMetadata`, UI-only state and — without ordered `parts` — attachments do not survive). Both DROP pending approvals and parked tool calls.
- `initialMessages` is read ONCE at mount and deliberately not re-adopted; `setHistory` is the escape hatch.
- `throttleMs` (default 0) coalesces commits on the trailing edge and ALWAYS flushes at a terminal boundary. `resume: { endpoint, auto?, cursor? }` — `auto` fires once per mounted hook and FAILS SILENTLY by design.
- Each message carries an optional ordered `parts` array (1.9). A renderer MUST handle `step-start` (`parts[0]` of a real streamed turn is normally one) and should skip `reasoning` parts flagged `encrypted`. `sub-agent` parts are deliberately NOT in it: they fold into `turn.subAgents` / `useChat().subAgents` instead — `Array<{ agentPath: string[]; afterPart: number; turn: AssistantTurnState }>`, one frame per path, each `frame.turn` a full turn folded by the same reducer. Render it with the SAME part component, indent by `agentPath.length`, splice at `afterPart` (the parent's ordered-element count at the handoff). `warning` and `false-finish` parts likewise fold into `turn.warnings` / `turn.falseFinishes`, also on `useChat`; all three channels are OPTIONAL and absent until the first entry.
- `useObject`: server route returns `toDeuzObjectStreamResponse(streamObject(...))`; each `object-delta` replaces `object` wholesale (`DeepPartial<T>`); `stop()` aborts without erroring.

```ts
for await (const part of readDeuzStream(res)) {
  if (part.type === 'text-delta') append(part.text);
}
```

## Next.js route (Edge or Node)

```ts
// app/api/chat/route.ts
import { after } from 'next/server';
import { streamChat } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

export async function POST(req: Request): Promise<Response> {
  // NEVER `const { messages } = await req.json()` — the body is attacker-controlled
  // and canonical Message[] includes role:'system'. Add { rejectToolResults: false }
  // when the route serves client tools (useChat's onToolCall POSTs role:'tool').
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

  const result = streamChat({
    model: createAnthropic({ apiKey: process.env.ANTHROPIC_KEY! })('claude-opus-4-8'),
    instructions: 'You are a helpful assistant.',
    messages: parsed.request.messages,
    signal: req.signal, // forwards client disconnect
  });
  const response = toDeuzStreamResponse(result, { generateId: () => crypto.randomUUID() });
  after(() => result.consume?.()); // terminal effects run even if the client leaves
  return response;
}
```

## Cloudflare Worker

Core is edge-safe (Web APIs only) — import from any subpath that is edge-safe (avoid `*/node`, `*/markdown`, `mcp/stdio`). Inject the key from `env`, never `process.env`.

```ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const parsed = validateChatRequest(await req.json());
    if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

    const result = streamChat({
      model: createOpenAI({ apiKey: env.OPENAI_KEY })('gpt-5.2'),
      messages: parsed.request.messages,
      signal: req.signal,
    });
    const response = toDeuzStreamResponse(result);
    ctx.waitUntil(result.consume?.() ?? Promise.resolve());
    return response;
  },
};
```

`validateChatRequest` is also on `@deuz-sdk/core/edge`.

Plain SSE without the Deuz framing: iterate `result.fullStream` yourself and build a `ReadableStream`. But prefer the wire so abort/retry/typed events keep working.
