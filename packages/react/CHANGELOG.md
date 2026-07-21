# @deuz-sdk/react

## 1.7.1

## 1.7.0

### Minor Changes

- 057ecf2: New package: **`@deuz-sdk/react`** — the React home for Deuz chat UIs (the `@deuz-sdk/core/react` subpath keeps working but is frozen; new features land here). A THIN adapter by design: every chat-state transformation is a call into `@deuz-sdk/core/chat`'s pure engine; this package only binds it to React state.
  - **`useChat` v2** — everything the legacy hook did (client-tool auto round-trips with self-healing, approval pause/auto-resume, stop) plus 1.7: `chatId`, `initialMessages` actually rendered (`uiFromMessages`), live `cost` state (`costUsd` + `cacheSavingsUsd`), `budgetExceeded`, `dataParts`, `citations`, `regenerate()` / `editAndResend(messageId, text)` via the core branch helpers, signed-approval flow (`addToolApprovalResponse` auto-echoes the request's HMAC `token`), and `reconnect()` over `connectDeuzStream` against a resume endpoint.
  - **`useObject`** — ported from the legacy surface.
  - **Headless components (zero styling)** — `ToolApprovalCard` (render-prop; verdicts always carry the signed token) and `CostBadge` (USD + cache savings).
  - Core patch: `applyUIPart` now preserves `token`/`agentPath` on collected approvals.
  - 20 jsdom tests; publint/attw green in all four resolution modes.
