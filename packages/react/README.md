# @deuz-sdk/react

React bindings for the [Deuz SDK](https://github.com/Deuz-AI/Deuz-SDK) — `useChat` / `useObject` hooks and minimal headless components on top of `@deuz-sdk/core`.

```bash
npm i @deuz-sdk/core @deuz-sdk/react
```

Thin adapter by design: every chat-state transformation lives in `@deuz-sdk/core/chat` (the pure reducer/branch helpers) and the Deuz UI wire (`@deuz-sdk/core/ui`); this package only binds them to React state. `react` is a peer dependency (`^18 || ^19`). The legacy `@deuz-sdk/core/react` subpath keeps working but is frozen; new features land here.

## API

### `useChat(options): UseChatResult`

Options: `api`, `initialMessages?` (rendered via `uiFromMessages`), `headers?`, `body?`, `chatId?` (merged into every request body), `resume?` (`{ endpoint, lastEventId? }` — enables `reconnect()`), `generateId?`, `onToolCall?` (client-tool executor, auto round-trip with self-healing errors), `onError?`, `fetch?`.

Result:

- State: `messages: UIMessage[]`, `status: 'idle' | 'streaming' | 'error'`, `error`, `pendingApprovals: ToolApprovalRequest[]`, `cost?: { costUsd, cacheSavingsUsd? }`, `budgetExceeded?: { kind, limit, value }`, `dataParts: { name, payload }[]`, `citations`.
- Methods: `sendMessage(text)`, `stop()`, `regenerate()` (core `dropTrailingAssistant`), `editAndResend(messageId, text)` (core `branchBeforeUserMessage`), `addToolApprovalResponse(response)` (auto-preserves the request's signed `token`; auto-resumes with `approvalResponses` once every pending approval has a verdict), `reconnect()` (reads the resume endpoint via `connectDeuzStream`).

### `useObject<T>(options): UseObjectResult<T>`

Streams `toDeuzObjectStreamResponse` output. Options: `api`, `headers?`, `fetch?`. Result: `object` (latest `DeepPartial<T>`), `isLoading`, `error`, `submit(input)`, `stop()`.

### Headless components (zero styling)

- `ToolApprovalCard({ approval, onRespond, render? })` — Approve/Deny for one pending approval; the verdict always carries the request's signed `token`. `render` overrides presentation and receives wired `approve()` / `deny(reason?)` callbacks.
- `CostBadge({ cost, format? })` — `$X.XXXX` plus ` (saved $Y.YYYY)` when cache savings are positive; `format` overrides.

### Re-exported core types

`UIMessage`, `UIToolCall`, `AssistantTurnState`, `ChatHistory`, `DeuzUIPart`, `Message`, `ToolApprovalRequest`, `ToolApprovalResponse`.

See the [main README](https://github.com/Deuz-AI/Deuz-SDK#readme) for the full SDK tour.
