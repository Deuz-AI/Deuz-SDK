# Deuz SDK examples

Twenty runnable apps, each its own npm workspace. Start from the repo root:

```sh
npm install
npm run build            # examples import @deuz-sdk/core by name, so build dist first
npm run dev -w @deuz-examples/07-native-agent          # 07–20 run without an API key
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
| [`13-headless`](./13-headless) | `@deuz-sdk/core/headless` (2.3 preview): `run` / `resume` / `inspect` / `doctor` with JSON reports and exit codes, runs kept in SQLite; `resume` answers an approval, a call whose effect is unknown (`--retry-call`, `--reconcile`) and a failure in transit (`--retry-failed`) | none |
| [`14-native-memory-chat`](./14-native-memory-chat) | a native run with `memory` (one recall, extraction once it completes), a `chat` projection and `fallbackModels`, then `reconcileAgentRun` repairing a failed chat write | none |
| [`15-native-ui-bridge`](./15-native-ui-bridge) | `toDeuzAgentStreamResponse` without a framework: `readDeuzStream`, `agentStateFromParts` and `applyUIPart` through an approval, a one-request `resumeStreamAgent` and the typed output, then a journal replay | none |
| [`16-goals-and-wakeups`](./16-goals-and-wakeups) | `@deuz-sdk/core/goal`: a goal woken by a schedule occurrence and a webhook event, each claimed once in SQLite, with one leased native run per wake supplying the evidence | none |
| [`17-realtime-offline`](./17-realtime-offline) | `@deuz-sdk/core/realtime` on a scripted OpenAI Realtime socket: audio in, a tool call bridged to a Deuz tool, a spoken answer, usage priced per modality | none |
| [`18-batch-offline`](./18-batch-offline) | `@deuz-sdk/core/batch` on a scripted Message Batches API: budget holds at submit, `wait` polling, per-result settlement at batch rates, an `unpriced-model` warning | none |
| [`19-mcp-server`](./19-mcp-server) | `createMcpServer`: Deuz tools and an agent served over MCP 2026-07-28 to the Deuz MCP client in process, with an elicitation approving a gated tool | none |
| [`20-a2a-agent`](./20-a2a-agent) | a native run served over A2A with `createA2AHandler` + `createA2AAgentExecutor`: an in-process client answers its approval and gets the typed result as an artifact | none |

Examples 01–06 call a real provider: each reads its API key from the environment **at the app layer** and passes it explicitly into the provider factory. Without the key, the Node examples exit with a message and the Next.js route answers `500 ANTHROPIC_API_KEY is not set.` Core never reads `process.env`; that is deliberate, and it is why the same code runs unchanged on Node, Deno, Bun, and the edge.

Examples 07–20 need no key and no network, and print each step as it happens. Most run on `createMockModel` from `@deuz-sdk/core/testing`, a scripted model; `17-realtime-offline` and `18-batch-offline` script the provider's wire instead (a WebSocket through `deps.webSocket`, and the model factory's `fetch`), so the real session and batch code runs against a stand-in, and in `14-native-memory-chat` the failing primary is an OpenAI model whose injected `fetch` answers 503 itself. A comment marked `REAL PROVIDER` in each `index.ts` of 07–12 and 14–20 shows the change that swaps in a real one; `13-headless` takes the model from its command line instead: `--model <id>` runs that Anthropic model with the key from `ANTHROPIC_API_KEY` (a set key alone selects `claude-opus-4-8`), and its `--mock` scenarios run only when neither is given. `19-mcp-server` depends on the v2 MCP SDK (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`), which `npm install` adds with the workspace.

The Node examples (all but `03-next-chat`, which runs `next dev`) run through Node's native TypeScript stripping (`node --experimental-strip-types index.ts`), so they need **Node ≥ 22.6** and no build step or bundler of their own. Examples 09–13 and 16 also use `node:sqlite`, which ships unflagged from **Node 22.13** and **23.4**. Examples 09–12 and 16 keep their database in a temporary directory that each deletes when it finishes; `13-headless` keeps its file between commands, so `run` and `resume` can be separate processes.
