# Deuz SDK examples

Six runnable apps, each its own npm workspace. Start from the repo root:

```sh
npm install
npm run build            # examples import @deuz-sdk/core by name, so build dist first
export ANTHROPIC_API_KEY=sk-ant-…
npm run dev -w @deuz-examples/01-basic-stream
```

Or use the convenience script: `npm run example -- @deuz-examples/01-basic-stream`.

| Example | What it shows |
| --- | --- |
| [`01-basic-stream`](./01-basic-stream) | `streamChat` → `textStream` → `await usage` |
| [`02-tool-loop`](./02-tool-loop) | tools, `maxSteps`, a `budget` stop, and a self-healing tool error |
| [`03-next-chat`](./03-next-chat) | Next.js App Router: `toDeuzStreamResponse` + `useChat` + an approval card |
| [`04-structured-output`](./04-structured-output) | `generateObject` and `streamObject` from one zod schema |
| [`05-durable-resume`](./05-durable-resume) | a file `SessionStore`, a hard crash, `resumeFromCheckpoint` |
| [`06-autonomous-agent`](./06-autonomous-agent) | plan → delegate → run code → verify, with a live plan/activity feed |

Every example reads its API key from the environment **at the app layer** and passes it explicitly into the provider factory. Core never reads `process.env`; that is deliberate, and it is why the same code runs unchanged on Node, Deno, Bun, and the edge.

The Node examples run through Node's native TypeScript stripping (`node --experimental-strip-types index.ts`), so they need **Node ≥ 22.6** and no build step or bundler of their own.
