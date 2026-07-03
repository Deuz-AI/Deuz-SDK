# Streaming + UI wire

## streamChat semantics (the G2 rule)

```ts
function streamChat(options: StreamChatOptions): StreamChatResult
interface StreamChatResult {
  textStream: AsyncIterable<string>;     // text-only projection
  fullStream: AsyncIterable<StreamPart>; // canonical event stream
  usage: Promise<Usage>;
  finishReason: Promise<FinishReason>;
}
```

- **Synchronous return.** `streamChat` returns immediately and NEVER throws. Do not `await` it; do not make wrappers `async`.
- **Lazy pump.** The network request starts on first access of any output (`textStream` / `fullStream` / `usage` / `finishReason`). A `createBroadcaster` fans the single pump to multiple consumers — you can `await result.usage` first and still iterate the stream without losing data.
- **Errors surface on the stream, not as throws.** A failure becomes an `{ type: 'error', error }` part on `fullStream`, and `usage` / `finishReason` reject. Iterating `textStream` will throw when it hits the error. There is no try/catch around the `streamChat()` call itself.
- **Abort.** Pass `options.signal`. A user abort resolves `finishReason: 'aborted'` with partial usage (not an error). A `TimeoutError` IS a failure.
- **Retry.** Pre-first-byte only (`maxRetries`, default 2; exponential backoff + jitter, honors `Retry-After`). Once bytes stream, a mid-stream error is final.

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
| { type: 'finish'; usage; finishReason }
| { type: 'error'; error: unknown }
| { type: 'step-start'; stepIndex }                                   // agentic loop
| { type: 'step-finish'; stepIndex; finishReason; usage }
| { type: 'tool-call'; toolCallId; toolName; input }                  // final parsed call
| { type: 'tool-result'; toolCallId; toolName; output; isError? }
| { type: 'tool-approval-request'; approvalId; toolCallId; toolName; input } // 1.3.0+: gated call awaits verdict
```

## Deuz UI wire — `@deuz-sdk/core/ui`

This is OUR protocol, not a provider's. Server serializes canonical `fullStream` → versioned SSE; client reads it back.

```ts
// server
function toDeuzStreamResponse(result: StreamChatResult, options?: {
  messageId?: string; generateId?: () => string; headers?: Record<string,string>;
}): Response   // text/event-stream, header x-deuz-stream: v1, terminator data: [DONE]

// client
async function* readDeuzStream(response: Response): AsyncGenerator<DeuzUIPart>
```

`DeuzUIPart` mirrors `StreamPart` UI-framed: `start` (messageId), `text-delta`, `reasoning-delta`, `tool-input-delta` (`{ toolCallId, toolName?, delta }`), `tool-call`, `tool-result`, `tool-approval-request` (1.3.0+), `source`, `step-start`/`step-finish`, `finish`, `error` (`{ message }`, already secret-redacted). `tool-approval-response` is declared client→server only — the verdict rides the NEXT request body as `approvalResponses`, it is never serialized by the server.

```ts
for await (const part of readDeuzStream(res)) {
  if (part.type === 'text-delta') append(part.text);
}
```

## Next.js route (Edge or Node)

```ts
// app/api/chat/route.ts
import { streamChat } from '@deuz-sdk/core';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamChat({
    model: createAnthropic({ apiKey: process.env.ANTHROPIC_KEY! })('claude-opus-4-8'),
    messages,
    signal: req.signal, // forwards client disconnect
  });
  return toDeuzStreamResponse(result, { generateId: () => crypto.randomUUID() });
}
```

## Cloudflare Worker

Core is edge-safe (Web APIs only) — import from any subpath that is edge-safe (avoid `*/node`, `*/markdown`, `mcp/stdio`). Inject the key from `env`, never `process.env`.

```ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { messages } = await req.json();
    const result = streamChat({
      model: createOpenAI({ apiKey: env.OPENAI_KEY })('gpt-5.2'),
      messages,
      signal: req.signal,
    });
    return toDeuzStreamResponse(result);
  },
};
```

Plain SSE without the Deuz framing: iterate `result.fullStream` yourself and build a `ReadableStream`. But prefer the wire so abort/retry/typed events keep working.
