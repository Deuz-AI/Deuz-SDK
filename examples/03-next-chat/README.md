# 03 — Next.js chat

**Shows:** the full round-trip — an App Router route that serializes `streamChat` with `toDeuzStreamResponse`, `useChat` from `@deuz-sdk/react` reading that wire, and a `ToolApprovalCard` for a client-mode gated tool (`needsApproval: true` with no `approveToolCall`, so the loop pauses and the browser decides).

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/03-next-chat` and open <http://localhost:3000>. Ask it to `delete src/old.ts` to trigger the approval card. (`build:app` is the Next production build — it is deliberately not called `build` so the repo-root gate never tries to build a Next app.)

**Look at:** `app/api/chat/route.ts` — the key is read from the server environment and passed explicitly into `createAnthropic`, so it can never reach the client bundle; and `export const runtime = 'edge'` works because core is Web-API-only.
