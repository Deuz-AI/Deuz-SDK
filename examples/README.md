# Deuz SDK examples

Twelve runnable apps, each its own npm workspace. Start from the repo root:

```sh
npm install
npm run build            # examples import @deuz-sdk/core by name, so build dist first
npm run dev -w @deuz-examples/07-native-agent          # 07–12 run without an API key
export ANTHROPIC_API_KEY=sk-ant-…
npm run dev -w @deuz-examples/01-basic-stream          # 01–06 call Anthropic
```

Or use the convenience script: `npm run example -- @deuz-examples/01-basic-stream`.

| Example | What it shows | API key |
| --- | --- | --- |
| [`01-basic-stream`](./01-basic-stream) | `streamChat` → `textStream` → `await usage` | `ANTHROPIC_API_KEY` |
| [`02-tool-loop`](./02-tool-loop) | tools, `maxSteps`, a `budget` stop, and a self-healing tool error | `ANTHROPIC_API_KEY` |
| [`03-next-chat`](./03-next-chat) | Next.js App Router: `toDeuzStreamResponse` + `useChat` + an approval card | `ANTHROPIC_API_KEY` |
| [`04-structured-output`](./04-structured-output) | `generateObject` and `streamObject` from one zod schema | `ANTHROPIC_API_KEY` |
| [`05-durable-resume`](./05-durable-resume) | a file `SessionStore`, a hard crash, `resumeFromCheckpoint` | `ANTHROPIC_API_KEY` |
| [`06-autonomous-agent`](./06-autonomous-agent) | plan → delegate → run code → verify, with a live plan/activity feed | `ANTHROPIC_API_KEY` |
| [`07-native-agent`](./07-native-agent) | native `runAgent`: a validated `output`, a verifier, and an approval that suspends and resumes | none |
| [`08-dynamic-swarm`](./08-dynamic-swarm) | `createSwarm` with runtime `spawn`, a group blackboard, and `createRounds` | none |
| [`09-durable-ops`](./09-durable-ops) | SQLite leases: `recover()` takes over a crashed executor's run, plus `requestCancel` and `drain` | none |
| [`10-evolve`](./10-evolve) | `evolve` with SEARCH/REPLACE diffs and an evaluator cascade on SQLite, then a zero-call `resumeEvolve` | none |
| [`11-schedules-and-signals`](./11-schedules-and-signals) | `createScheduler` with a durable SQLite claim, and `handleSignal` with `verifyHmacSignature` | none |
| [`12-persistent-budgets`](./12-persistent-budgets) | a per-user `createSqliteBudgetStore` scope shared by native runs and a swarm, until it denies | none |

Examples 01–06 call a real provider: each reads its API key from the environment **at the app layer** and passes it explicitly into the provider factory. Without the key, the Node examples exit with a message and the Next.js route answers `500 ANTHROPIC_API_KEY is not set.` Core never reads `process.env`; that is deliberate, and it is why the same code runs unchanged on Node, Deno, Bun, and the edge.

Examples 07–12 run on `createMockModel` from `@deuz-sdk/core/testing`, a scripted model that needs no key and no network, and print each step as it happens. A comment marked `REAL PROVIDER` in each `index.ts` shows the change that swaps in a real one.

The Node examples (all but `03-next-chat`, which runs `next dev`) run through Node's native TypeScript stripping (`node --experimental-strip-types index.ts`), so they need **Node ≥ 22.6** and no build step or bundler of their own. Examples 09–12 also use `node:sqlite`, which ships unflagged from **Node 22.13** and **23.4**; their database files live in a temporary directory that each example deletes when it finishes.
