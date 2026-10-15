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
          {m.parts
            ? m.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text}</span> : null))
            : m.content}
        </div>
      ))}
      <button disabled={status === 'streaming'} onClick={() => sendMessage({ text: 'Hello!' })}>
        Send
      </button>
    </>
  );
}
```

Thin adapter by design. Every chat-state transformation lives in `@deuz-sdk/core/chat` (pure reducers, branch helpers) and the Deuz UI wire in `@deuz-sdk/core/ui`; this package only binds them to React state, which is why a refresh, a network blip and a server crash all look the same to your component. `react` is a peer dependency (`^18 || ^19`), and so is `@deuz-sdk/core` (`^2.0.0`); native agent routes, `agent`, `stopDetails` and `outcome` need core 2.3, whose UI wire carries them. The legacy `@deuz-sdk/core/react` subpath still works but is frozen: it gets none of 2.3's fixes and no native agent routes. Since 2.4 it is deprecated and will be removed in 3.0; a development build warns once per page. New work lands here.

**New in 2.4.** `useChat({ initialSnapshot })` restores a chat from a `ChatSnapshotV1` (its messages under their stored ids, the cursor, a turn still streaming and the gates it was paused on), and `exportSnapshot()` returns one as plain data. The hook sends an `x-deuz-capabilities` request header and uses a feature only once the server announces it, listed in `capabilities`: with `message-ids` a replay renders nothing twice, with `chat-snapshot-v1` request bodies carry `messageIds`, and with `durable-stream` a POST read that drops continues from `resume.endpoint`. A cross-origin API whose preflight lists allowed headers must add `x-deuz-capabilities`, or set `capabilityHandshake: false` for exactly 2.3's requests. See [Snapshots and the handshake](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/react-hooks.mdx#snapshots-and-the-handshake-24), [Chat and stream durability](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/chat-durability.mdx) and [What's new in 2.4](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/reference/whats-new-2-4.mdx). The server side of the handshake and durable streams needs `@deuz-sdk/core` 2.4.

**New in 2.3.** `useChat` drives a [native agent route](#native-agent-routes-23) with no new option and reports the run as `agent`, the provider's explanation of a stop as `stopDetails`, and how each tool call ended as its `outcome`. Approvals and client tools work the same way on every path: a verdict counts only when it answers the open gate, a turn read back through `reconnect()` runs its client calls like a streamed one, and the history the hook posts answers every call the server ran or approved. [What 2.3 changed](#what-23-changed-in-usechat) lists each change; the [React hooks guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/react-hooks.mdx) has the details.

## `useChat(options)`

**Options**

| Option | Notes |
| --- | --- |
| `api` | Endpoint that returns a Deuz stream: `toDeuzStreamResponse` for a chat route, or `toDeuzAgentStreamResponse` for a native agent route (2.3). Required. |
| `initialMessages?` | Canonical `Message[]`, projected once at mount via `uiFromMessages`. |
| `headers?` / `body?` | Merged into every request. |
| `chatId?` | Sent with every request; the server side keys persistence on it. |
| `resume?` | `{ endpoint, lastEventId?, auto?, cursor? }` — enables `reconnect()`, and with `auto` reconnects on mount after a reload. |
| `throttleMs?` | Coalesce re-renders during a fast stream. |
| `onToolCall?` | Client-tool executor. The round-trip and its error self-healing are handled for you. Omit it to park client calls in `pendingToolCalls` and answer them with `addToolResult`. A result that lands after the chat moved on is dropped (2.3). |
| `onData?` | Custom `data` parts from the server. A native route's agent frames never reach it. |
| `onError?` / `onHttpError?` | `onHttpError: 'error-part'` (default) surfaces a non-2xx response on the stream instead of throwing. |
| `generateId?` / `fetch?` | Injection seams, same idea as core's. |

2.3 adds no option.

**State**

`messages` (`UIMessage[]`, ordered parts), `history` (`{ ui, canonical }`), `status`, `error`, `pendingApprovals`, `pendingToolCalls`, `cost`, `budgetExceeded`, `dataParts`, `citations`, `plan`, `activity`, `verifications`, `warnings`, `falseFinishes`, `subAgents`, `steps`, `usage`, `finishReason`, and since 2.3 `stopDetails` and `agent`.

- `stopDetails` — the provider's explanation of the turn's stop, from the wire's `finish`: with `finishReason: 'content_filter'`, a refusal's `category` and `explanation`. Absent when the provider explained nothing.
- `agent` — the native run behind the turn, on a route that serves `toDeuzAgentStreamResponse`: its `runId`, its `status` (`'running'`, `'suspended'`, `'completed'`, `'stopped'` or `'failed'`), the latest unvalidated `partial` draft while it runs, and the `output` the server validated, only once it is `completed`. A `stopped` run carries its `reason`. Absent on a chat route.
- Each `UIToolCall` in `messages` carries `outcome` since 2.3, from the latest `tool-state` or `tool-result` frame: `'tool-error'`, `'permission-denied'`, `'approval-denied'`, `'approval-pending'` or `'unknown-effect'`. It tells a guardrail block from an approver's no, which `denied` alone does not, and is absent while the call runs and after it succeeds.

Most of those exist because the agentic loop reports more than text: an approval it is waiting on, a plan it is following, a sub-agent it delegated to, the cost so far. Render what you need and ignore the rest.

**Methods**

- `sendMessage(input)` — `input` is a `ChatInput`: a string, or `{ text?, parts? }` with files as canonical parts. `partsFromFiles(files)`, exported next to the hook, turns picked files into those parts.
- `stop()`, `regenerate()`, `editAndResend(messageId, input)` — the last two branch history through core's `dropTrailingAssistant` / `branchBeforeUserMessage`.
- `addToolApprovalResponse(response)` — carries the request's signed token automatically, and resumes the run once every pending approval has a verdict. Since 2.3 a verdict that answers no approval in `pendingApprovals` (nothing pending, a double click, a stale card, another run's token) is a no-op that sends nothing.
- `addToolResult({ toolCallId, output, isError? })` — answers one parked client tool call; the chat continues once every call in `pendingToolCalls` has a result. A result for an id that is not parked is ignored.
- `setHistory(update)` / `setMessages(update)` — writable state for optimistic UI and hand-editing. Both drop the pending gates and, since 2.3, the in-memory resume cursor.
- `reconnect()` — re-attaches to an interrupted stream through `connectDeuzStream`.
- `clearError()`.

## Native agent routes (2.3)

`useChat` drives a route that serves a native run (`streamAgent` / `resumeStreamAgent` from `@deuz-sdk/core/agent`) through `toDeuzAgentStreamResponse` from `@deuz-sdk/core/ui`. Nothing is configured on the client. The run's terminal frame decides what it waits for: its approvals pause the chat, and its client calls (tools without `execute` on the server) run through `onToolCall` or park in `pendingToolCalls`. Once every approval has a verdict, the hook runs the client calls and resumes the run in one request, `{ messages, runId, approvalResponses?, clientToolResults? }`, because a native resume proceeds only with every verdict and every client result. `status` is `'streaming'` while those calls run, and `stop()` cancels the round.

```tsx
import { useChat } from '@deuz-sdk/react';

export function AgentChat() {
  const { messages, sendMessage, pendingApprovals, addToolApprovalResponse, agent, stopDetails } =
    useChat({
      api: '/api/agent', // serves toDeuzAgentStreamResponse(streamAgent(...))
      onToolCall: async ({ toolName }) => (toolName === 'locate' ? { city: 'Paris' } : null),
    });

  return (
    <>
      {messages.map((m) => (
        <p key={m.id}>{m.content}</p>
      ))}
      {pendingApprovals.map((request) => (
        <button
          key={request.approvalId}
          onClick={() => addToolApprovalResponse({ approvalId: request.approvalId, approved: true })}
        >
          Approve {request.toolName}
        </button>
      ))}
      {agent?.status === 'completed' ? <output>{JSON.stringify(agent.output)}</output> : null}
      {agent?.status === 'stopped' && agent.reason === 'refusal' ? (
        <p role="alert">Refused: {stopDetails?.category ?? 'no reason given'}</p>
      ) : null}
      <button onClick={() => sendMessage('Publish document 7.')}>Send</button>
    </>
  );
}
```

The route starts a run for a request without `runId` and resumes the stored run for one with it; take the run's scope from your authentication, never from the body. A chat route never sends an agent frame, so the hook never sends it `runId` or `clientToolResults`. The [React hooks guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/react-hooks.mdx) has a complete route.

## What 2.3 changed in `useChat`

- **Verdicts answer the open gate.** A verdict must name an `approvalId` in `pendingApprovals`, and a `token` on it must be that request's token. Anything else sends nothing and changes no state. A repeated `tool-approval-request` frame is one pending approval.
- **A reconnected turn settles like a streamed one.** A turn read back through `reconnect()` or `resume.auto` hands its unresolved client calls to `onToolCall` (and the chat continues with a POST) or parks them in `pendingToolCalls`. A replayed call runs at most once per mounted hook. Across a reload, only a result in the restored `history.canonical` shows that a call ran, so make such tools idempotent.
- **The history answers every call.** A call the server ran, or ran after an approval, is answered in `history.canonical` by a `role: 'tool'` message right after the assistant turn that made it, holding the result the wire carried, so the next request carries no open `tool_use`. `validateChatRequest` accepts these results with its defaults.
- **The cursor follows the POST read.** When a route passes `store` and `streamId`, the journal `id:` lines of the POST response move the in-memory resume cursor, so a `reconnect()` after a settled turn appends nothing twice. The persisted `resume.cursor` still moves on resume reads only.
- **Late client results are dropped.** An `onToolCall` result that lands after a new message, `regenerate`, `editAndResend`, `setHistory` or `setMessages` no longer joins the new exchange.
- **More of the turn arrives.** `stopDetails`, each tool call's `outcome`, and a Gemini thought signature on plain text, which the hook sends back with the history (not live-verified). Two responses that share a message id (a route without `messageId`) fill a bubble each.

## `useObject<T>(options)`

Streams `toDeuzObjectStreamResponse` output. Options: `api`, `headers?`, `onHttpError?`, `throttleMs?`, `fetch?`. Returns `object` (the latest `DeepPartial<T>`), `isLoading`, `error`, `submit(input)`, `stop()`.

## Headless components

Zero styling, both overridable.

- `ToolApprovalCard({ approval, onRespond, render? })` — approve/deny for one pending approval; the verdict always carries the request's signed token. `render` receives wired `approve()` / `deny(reason?)` callbacks.
- `CostBadge({ cost, format? })` — `$X.XXXX`, plus ` (saved $Y.YYYY)` when cache savings are positive.

## Re-exported types

`UIMessage`, `UIMessagePart`, `UIToolCall`, `AssistantTurnState`, `ChatHistory`, `ChatInput`, `DeuzUIPart`, `Message`, `ToolApprovalRequest`, `ToolApprovalResponse`.

The package's own types: `UseChatOptions`, `UseChatResult`, `UseChatCost`, `UseChatBudgetExceeded`, `UseChatResumeOptions`, `UseChatCursorStore`, `UseObjectOptions`, `UseObjectResult`, `ToolApprovalCardProps`, `CostBadgeProps`, and since 2.3 `UseChatAgent` and `UseChatStopDetails`, derived from the installed core's types.

Full SDK tour, architecture and the honest limitations list: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).
