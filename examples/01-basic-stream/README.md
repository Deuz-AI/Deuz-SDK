# 01 — Basic stream

**Shows:** `streamChat` → `textStream` → `await usage`, and that the API key is read from the environment by the *app* and passed explicitly into `createAnthropic` (core never reads `process.env`).

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/01-basic-stream -- "your question"` (Node ≥ 22.6 — the script uses native TypeScript stripping).

**Look at:** `index.ts` — `streamChat` is called without `await` and without a `try`; failures come back as an `error` part and rejected promises, never a synchronous throw.
