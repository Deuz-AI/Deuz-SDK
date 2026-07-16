# @deuz-sdk/react

React bindings for the [Deuz SDK](https://github.com/Deuz-AI/Deuz-SDK) — `useChat` / `useObject` hooks and minimal headless chat components (`ToolApprovalCard`, `CostBadge`) on top of `@deuz-sdk/core`.

```bash
npm i @deuz-sdk/core @deuz-sdk/react
```

- Thin adapter: all chat/stream/business logic lives in `@deuz-sdk/core` (`@deuz-sdk/core/chat` + the Deuz UI wire); this package only binds it to React state.
- `react` is a peer dependency (`^18 || ^19`).
- The legacy `@deuz-sdk/core/react` subpath keeps working but is frozen; new features land here.

See the [main README](https://github.com/Deuz-AI/Deuz-SDK#readme) for the full SDK tour.
