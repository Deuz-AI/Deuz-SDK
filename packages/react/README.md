# @deuz-sdk/react

React bindings for the [Deuz SDK](https://github.com/Deuz-AI/Deuz-SDK) — `useChat` / `useObject` and a couple of headless components on top of `@deuz-sdk/core`.

```bash
npm i @deuz-sdk/core @deuz-sdk/react
```

```tsx
import { useChat } from '@deuz-sdk/react';

export function Chat() {
  const { messages, sendMessage, status } = useChat({ api: '/api/chat' });

  return (
    <>
      {messages.map((m) => (
        <div key={m.id}>
          {m.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text}</span> : null))}
        </div>
      ))}
      <button disabled={status === 'streaming'} onClick={() => sendMessage({ text: 'Hello!' })}>
        Send
      </button>
    </>
  );
}
```

Thin adapter by design. Every chat-state transformation lives in `@deuz-sdk/core/chat` (pure reducers, branch helpers) and the Deuz UI wire in `@deuz-sdk/core/ui`; this package only binds them to React state, which is why a refresh, a network blip and a server crash all look the same to your component. `react` is a peer dependency (`^18 || ^19`). The legacy `@deuz-sdk/core/react` subpath still works but is frozen — new work lands here.

## `useChat(options)`

**Options**

| Option | Notes |
| --- | --- |
| `api` | Endpoint that returns a Deuz stream. Required. |
| `initialMessages?` | Canonical `Message[]`, projected once at mount via `uiFromMessages`. |
| `headers?` / `body?` | Merged into every request. |
| `chatId?` | Sent with every request; the server side keys persistence on it. |
| `resume?` | `{ endpoint, lastEventId?, auto?, cursor? }` — enables `reconnect()`, and with `auto` reconnects on mount after a reload. |
| `throttleMs?` | Coalesce re-renders during a fast stream. |
| `onToolCall?` | Client-tool executor. The round-trip and its error self-healing are handled for you. |
| `onData?` | Custom `data` parts from the server. |
| `onError?` / `onHttpError?` | `onHttpError: 'error-part'` (default) surfaces a non-2xx response on the stream instead of throwing. |
| `generateId?` / `fetch?` | Injection seams, same idea as core's. |

**State**

`messages` (`UIMessage[]`, ordered parts), `history` (`{ ui, canonical }`), `status`, `error`, `pendingApprovals`, `pendingToolCalls`, `cost`, `budgetExceeded`, `dataParts`, `citations`, `plan`, `activity`, `verifications`, `warnings`, `falseFinishes`, `subAgents`, `steps`, `usage`, `finishReason`.

Most of those exist because the agentic loop reports more than text: an approval it is waiting on, a plan it is following, a sub-agent it delegated to, the cost so far. Render what you need and ignore the rest.

**Methods**

- `sendMessage(input)` — `input` is a `ChatInput`: `{ text }`, files, or both.
- `stop()`, `regenerate()`, `editAndResend(messageId, input)` — the last two branch history through core's `dropTrailingAssistant` / `branchBeforeUserMessage`.
- `addToolApprovalResponse(response)` — carries the request's signed token automatically, and resumes the run once every pending approval has a verdict.
- `setHistory(update)` / `setMessages(update)` — writable state for optimistic UI and hand-editing.
- `reconnect()` — re-attaches to an interrupted stream through `connectDeuzStream`.
- `clearError()`.

## `useObject<T>(options)`

Streams `toDeuzObjectStreamResponse` output. Options: `api`, `headers?`, `fetch?`. Returns `object` (the latest `DeepPartial<T>`), `isLoading`, `error`, `submit(input)`, `stop()`.

## Headless components

Zero styling, both overridable.

- `ToolApprovalCard({ approval, onRespond, render? })` — approve/deny for one pending approval; the verdict always carries the request's signed token. `render` receives wired `approve()` / `deny(reason?)` callbacks.
- `CostBadge({ cost, format? })` — `$X.XXXX`, plus ` (saved $Y.YYYY)` when cache savings are positive.

## Re-exported types

`UIMessage`, `UIMessagePart`, `UIToolCall`, `AssistantTurnState`, `ChatHistory`, `ChatInput`, `DeuzUIPart`, `Message`, `ToolApprovalRequest`, `ToolApprovalResponse`.

Full SDK tour, architecture and the honest limitations list: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).
