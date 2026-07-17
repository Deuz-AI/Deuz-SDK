---
'@deuz-sdk/core': minor
---

Chat persistence and the framework-agnostic chat engine (P2 + P6 core) — new `@deuz-sdk/core/chat` subpath:

- **`ChatStore`** — a two-method (`saveChat`/`loadChat`) persistence seam with mandatory scope (aligned with the memory scope model; `MemoryScope` gains `chatId`). Set `chat: { store, chatId, scope }` on any call and the loop auto-persists the FULL immutable history at terminal boundaries (completion, approval suspension, even mid-stream errors) — best-effort, a failing store never kills a run. Tool-less calls route through the loop too, so every chat shape persists uniformly. `createInMemoryChatStore()` ships in core; a JSONL file store ships at `./chat/node` (binary parts survive via the `$deuzBytes` codec — `serializeChatRecord`/`deserializeChatRecord` exported for custom adapters).
- **Pure chat engine** — the state logic `useChat` needs, extracted as pure functions: `applyUIPart` (the per-turn reducer folding wire parts into a render-friendly `UIMessage`, including 1.7's cost/budget/data/citation/tool-state parts), `assistantMessageFromTurn` + `clientToolResultMessage` (canonical reconstruction), and `uiFromMessages` (render a loaded chat).
- **Branching** — `dropTrailingAssistant` (regenerate) and `branchBeforeUserMessage` (edit-and-resend) cut the UI and canonical views together by user-turn ordinal; immutable history makes a branch a plain prefix. `ChatRecord.parentId` records fork lineage.
- Everything is edge-safe with zero runtime imports and re-exported from `./edge`.
