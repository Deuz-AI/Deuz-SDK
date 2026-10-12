<!-- verified: 2026-10-12 against @deuz-sdk/core@2.2.0 · api-contract sha256:3b9611faf697
     sources: packages/core/src/mcp/server.ts, packages/core/src/mcp/server-internals.ts,
     packages/core/src/node/mcp-server.ts, packages/core/src/a2a/{index,client,handler,runtime,protocol,errors,task-store,types}.ts,
     docs/content/docs/modules/{mcp-server,a2a}.mdx -->

# Serving and calling agents across processes: the MCP server and A2A

**Load when:** publishing your tools, native agent tools or whole agents to MCP clients (a desktop assistant, another framework's agent, a hosted host), serving an agent over the Agent2Agent (A2A) protocol, or calling another team's A2A agent. Both arrived in 2.3. *Consuming* MCP servers is `references/mcp.md`.

| You want to | Use | Subpath | Runtime |
| --- | --- | --- | --- |
| Publish tools or agents to MCP clients over HTTP | `createMcpServer`, then `server.fetch` | `@deuz-sdk/core/mcp/server` | Edge-safe; optional peer `@modelcontextprotocol/server` |
| The same server over stdin/stdout | `serveMcpStdio(server)` | `@deuz-sdk/core/mcp/server/stdio` | Node only |
| Serve an agent to A2A clients | `createA2AHandler({ card, executor })` | `@deuz-sdk/core/a2a` | Edge-safe, no dependencies |
| Call an A2A agent | `fetchAgentCard`, `createA2AClient` | `@deuz-sdk/core/a2a` | Edge-safe, no dependencies |

Pick MCP when the caller wants **tools** its own model decides when to call. Pick A2A when the caller hands off a **task** that runs on your side, can stop to ask for input, and produces artifacts. Neither handler authenticates anyone: put authentication, Origin/Host checks and CORS in front of it, and pass the identity you verified in.

## The MCP server

`createMcpServer(options)` publishes three kinds of entries under one definition and serves them two ways: `server.fetch(request, { authInfo? })` is a fetch-native Streamable HTTP handler (Workers, Deno, Bun, route handlers), and `serveMcpStdio(server)` serves the **same handle** over stdin/stdout. It answers MCP 2026-07-28 clients and, by default, 2025-era clients through a stateless fallback. It is built on the v2 SDK, an optional peer imported lazily: `npm i @modelcontextprotocol/server` (`^2.3.1`, Node 20+ or a fetch-native runtime).

```ts
import { tool } from '@deuz-sdk/core';
import { createMcpClient } from '@deuz-sdk/core/mcp';
import { createMcpServer } from '@deuz-sdk/core/mcp/server';
import { createMockModel } from '@deuz-sdk/core/testing';

const forecast = tool({
  description: 'Tomorrow’s forecast for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  execute: async (args) => ({ city: (args as { city: string }).city, highC: 24 }),
});

const server = createMcpServer({
  name: 'weather',
  version: '1.0.0',
  tools: { forecast },
  agents: {
    planner: {
      description: 'Plans a day around the weather.',
      agent: { model: createMockModel({ responses: [{ text: 'Pack light.' }] }) },
    },
  },
});
await server.ready(); // loads the peer and prepares every tool: a broken definition fails at startup

// No socket here: the client's fetch goes straight into the handler. In production the
// handler is a route, e.g. `export default { fetch: (req: Request) => server.fetch(req) }`.
const client = await createMcpClient({
  transport: {
    type: 'http',
    url: 'http://weather.local/mcp',
    fetch: (input, init) => server.fetch(new Request(input, init)),
  },
});
console.log(client.protocolVersion?.()); // '2026-07-28' (with the v2 client installed)
console.log(await client.callTool('forecast', { city: 'Izmir' })); // { city: 'Izmir', highC: 24 }
console.log(await client.callTool('planner', { prompt: 'A day in Izmir?' })); // 'Pack light.'
await client.close();
await server.close();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `name`, `version`, `instructions` | — / `'0.0.0'` / — | The server's identity, and how to use it (shown to the client's model). |
| `tools` | — | A `ToolSet`, served with the loop's semantics. Every tool needs an `execute`. |
| `agentTools`, `toolsContext` | — | A native `AgentToolSet` with native semantics: the tool context is validated, the result is validated (`outputSchema` / `validateResult`), and the client gets the `toModelOutput` projection. `toolsContext` is a record (validated once by `ready()`) or `(request) => record` per call. |
| `agents` | — | `{ [name]: { description, agent, needsApproval? } }`: each becomes a tool taking `{ prompt }`, one `runAgent` per call. `agent` is `runAgent` options without `messages` / `prompt`, or `(input, request) => options` per call (mint a fresh durable `session` there: a fixed `runId` makes concurrent calls collide). |
| `approve` | `'elicit'` | Who approves a `needsApproval` call: `'elicit'` asks the client's user through an MCP elicitation, a function `(request) => boolean` decides on the server. |
| `guardrails` | — | `{ onToolCall?, onToolResult? }`, the loop's tool guardrails, applied to every served call. |
| `runtimeContext` | — | `(request) => unknown` per call, e.g. a tenant read from `request.authInfo`. |
| `toolAnnotations` | — | MCP hints per tool name (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). |
| `legacy` | `'stateless'` | HTTP: serve 2025-era clients statelessly, or `'reject'` them (a 2026-07-28-only endpoint). |
| `responseMode` | `'auto'` | 2026-07-28 exchanges: JSON, upgraded to SSE when a call streams; or always `'sse'` / `'json'`. |
| `maxRequestBodySize`, `onError`, `clock` | 4 MiB / — / host | Body cap; out-of-band failures (reporting only); the time source for `Tool.timeoutMs`. |

Construction rejects what can never be served: a client tool (no `execute`), a provider-executed tool, one name used twice across `tools`, `agentTools` and `agents`, and an annotation for a name that is not served. Every callback receives `McpServerRequest`: `{ transport: 'http' | 'stdio', era: 'modern' | 'legacy', authInfo?, request? }`. `authInfo` is exactly what you passed to `server.fetch(request, { authInfo })`; it is never read from headers.

**What a served call runs**, in the loop's order, so a tool behaves the same whether a model called it in process or a client called it over MCP:

1. The SDK checks the arguments against the advertised schema. A raw JSON Schema is listed verbatim; a Standard Schema is listed as its JSON Schema and still transforms once, at step 4.
2. `guardrails.onToolCall`: `block` answers the loop's denial, `rewrite` swaps the arguments.
3. The approval gate, when `needsApproval` holds.
4. Validation exactly as the loop does it.
5. `execute`, with a `toolCallId` of `mcp-<request id>`, the request's abort signal (a client cancellation aborts it), `messages: []` and the `runtimeContext`. A throw, or a `Tool.timeoutMs` expiry, becomes an error result carrying the message.
6. `guardrails.onToolResult`, then the result: a string is one text block; a plain object travels as `structuredContent` plus its JSON text (so a Deuz client gets the object back); an array, number, boolean or `null` as JSON text; with an `outputSchema`, `structuredContent` the SDK validates. A throw, a timeout, a denial or a block is `isError: true` with the message. Only the message crosses the wire, never a stack, so keep secrets out of error messages.

**Approval.** A function `approve` is a server-side verdict, the counterpart of the loop's `approveToolCall` (`false` or a throw denies). `'elicit'` asks the client's user through a yes/no form elicitation: on a 2026-07-28 client that declared form elicitation, and on a 2025-era client over stdio. A 2025-era client over stateless HTTP has no session to ask on, and a client without form elicitation cannot be asked: both are **denied**. A call nobody can approve never runs. `'elicit'` takes the client's word for it; when the server must not, decide on the server from `authInfo`. There is no client-mode suspension: an MCP call cannot be resumed across requests.

**Agents as tools.** A `completed` run answers with its output (text, or the structured value when the run has an `output`). A `suspended` run (pending approvals or client tools) is an error result, since an MCP call cannot resume it: give the agent a server-side `approveToolCall`. A `stopped` run is an error result naming the reason, a `failed` one carries the run's error message. The call's abort signal is combined with any `signal` in the options, and the call's `runtimeContext` reaches the run unless the options set their own.

**stdio.** `serveMcpStdio(server, { legacy?, stdin?, stdout? })` (Node) prepares every tool before reading the first byte, so a broken definition rejects instead of half-starting; it resolves a handle whose `close()` stops serving. The opening exchange pins the connection to one era (`server/discover` or `initialize`); `legacy: 'reject'` refuses a 2025-era opening. It also takes the options object directly. **Never write to stdout** from a stdio server: every byte there is protocol, so log to stderr.

**Limits.** Tools only (no resources or prompts), a catalog fixed at construction (no `tools/list_changed`), `Tool.timeoutMs` but no call-level `timeout`, no usage reporting to the client (observe it with `deps.onUsage`), and no live verification against third-party hosts: the server is verified offline against the Deuz client on both SDK lines and the official v1 and v2 SDK clients, over HTTP and a real stdio child process.

## A2A: serving an agent

`@deuz-sdk/core/a2a` speaks Agent2Agent **1.0.0** over the JSON-RPC and HTTP+JSON bindings, in both directions, edge-safe and with no dependencies. `createA2AHandler({ card, executor })` is a fetch-style handler (`Request` in, `Response` out). It serves the agent card at `/.well-known/agent-card.json` (`cardPath` changes it) and every card interface with `protocolBinding` `'JSONRPC'` or `'HTTP+JSON'` and `protocolVersion: '1.0'` at **its URL's path** (the host is not matched). Every A2A request must carry `A2A-Version: 1.0`; one without it is read as 0.3 and refused, as the official SDK's server does. `SendStreamingMessage` and `SubscribeToTask` need `capabilities.streaming: true` on the card.

```ts
import { a2aText, createA2AClient, createA2AHandler, fetchAgentCard } from '@deuz-sdk/core/a2a';
import type { A2AAgentCard } from '@deuz-sdk/core/a2a';

const card: A2AAgentCard = {
  name: 'Weather',
  description: 'Forecasts for one city at a time.',
  version: '1.0.0',
  supportedInterfaces: [
    { url: 'https://weather.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'forecast', name: 'Forecast', description: 'Tomorrow, one city.', tags: ['weather'] }],
};

const handler = createA2AHandler({
  card,
  executor: async (ctx) => {
    if (!ctx.task) return ctx.requireInput('Which city?'); // ends the turn; the reply continues the task
    await ctx.working();
    await ctx.artifact({ name: 'forecast', parts: [{ text: `Sunny in ${a2aText(ctx.message)}.` }] });
    await ctx.complete();
  },
});

// No network here: the client's fetch goes straight into the handler.
const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  handler(new Request(input, init))) as typeof globalThis.fetch;
const client = createA2AClient({
  card: await fetchAgentCard('https://weather.example.com', { deps: { fetch } }),
  deps: { fetch },
});

const asked = await client.sendMessage('What is the weather tomorrow?');
console.log(asked.task?.status.state); // 'TASK_STATE_INPUT_REQUIRED'
const done = await client.sendMessage('Izmir', { taskId: asked.task!.id });
console.log(done.task?.status.state, a2aText(done.task?.artifacts?.[0])); // 'TASK_STATE_COMPLETED' 'Sunny in Izmir.'
```

**The executor runs one turn per incoming message**, through its context: `message`, `task` (`undefined` for a new interaction), `taskId`, `contextId`, `tenant`, `owner`, `request` (the full `SendMessage` params), `extensions`, `signal` (aborted when the task is canceled), `httpRequest`, and the updates `reply` (one message and no task: a new interaction only, before any update), `working`, `artifact(artifact, { append?, lastChunk? })`, `requireInput`, `requireAuth`, `complete`, `fail`, `reject` and `setStatus`. A message is a string, a list of parts or a draft.

- A new interaction gets its task at the first update; a stream sees the `task` snapshot first, then `statusUpdate` / `artifactUpdate` events.
- The turn ends at `reply`, at a terminal state, at `INPUT_REQUIRED`, or when `execute` settles; later updates are rejected. An executor that returns while the task is `SUBMITTED` or `WORKING` completes it; one that throws fails it, with the error's message as the status message, so throw messages that are safe to show.
- **Only an `A2AError` the executor raises itself answers a request.** Thrown before the task changed (`CONTENT_TYPE_NOT_SUPPORTED`, `INVALID_PARAMS`, …), it answers the request with that error and leaves the task as it was, and a refused follow-up message is taken back out of the task's history. An `A2AError` thrown by a `createA2AClient` call is another agent's answer: it fails the task like any other error (and answers `INTERNAL_ERROR` from `executor.cancel`). To pass a refusal on, rethrow `new A2AError({ reason, message })`.
- A new interaction whose executor neither replies nor updates answers `INVALID_AGENT_RESPONSE`; a follow-up turn with no update answers with the task as it waits.
- A message for a task that is still working, or already finished, is refused with `UNSUPPORTED_OPERATION`.
- `executor` may be `{ execute, cancel? }`. `CancelTask` asks `cancel` first (throw `new A2AError({ reason: 'TASK_NOT_CANCELABLE', … })` to refuse; anything else it throws answers `INTERNAL_ERROR` and leaves the task uncanceled), then cancels the task, ends its streams and aborts the running turn's `ctx.signal`. Do not wait for `execute` inside `cancel`.
- `SubscribeToTask` re-attaches: the stored snapshot, then the running turn's events. A client that disconnects does not stop the task. `ListTasks`, push-notification configs and the extended card answer as unsupported.

**Tasks, tenants and owners.** Tasks live in an `A2ATaskStore` (`{ load(taskId, scope), save(task, scope) }`, plain JSON; `createInMemoryA2ATaskStore()` by default, which lives as long as the process). The handler loads before every change and saves the whole task after it, under a per-task lock in one process. The scope is `{ tenant?, owner? }`: the A2A tenant of the request, and whatever `owner(request)` returns, which must be an identity you verified. **The handler does no ownership check of its own**, so a custom store must key every task by `scope.tenant`, `scope.owner` and the task id; one keyed by the id alone lets anyone who learns an id read, continue, cancel or subscribe to another caller's task. Without `owner`, every caller shares the tasks.

Errors follow the binding: a JSON-RPC error with the A2A code and a `google.rpc.ErrorInfo` detail, or an HTTP+JSON `google.rpc.Status` body with the binding's status.

**Backed by a model.** The executor is ordinary code: call `generateText`, a tool loop or `runAgent` inside it and pass `ctx.signal` along. A native-agent adapter for this executor is coming in 2.3 (tasks as native runs); until it lands in your installed version, drive the run from the executor yourself.

## A2A: calling an agent

`fetchAgentCard(url, { path?, deps? })` reads the card at the URL's origin (or the URL itself when it ends in `.json`). `createA2AClient({ card })` talks to the first `JSONRPC` or `HTTP+JSON` interface the card declares for A2A 1.x (`binding` picks one), with that interface's `tenant`; `createA2AClient({ url, binding? })` skips the card (default binding `'JSONRPC'`). Options: `headers` (static, or a function called per request for rotating credentials), `extensions` (sent as `A2A-Extensions`), `tenant`, and `deps` (`fetch`, `generateId`).

| Method | Returns |
| --- | --- |
| `sendMessage(message, options?)` | `{ task }` once the task is terminal or interrupted (at once with `configuration.returnImmediately`), or `{ message }` for a direct answer. |
| `sendStreamingMessage(message, options?)` | An async generator of events (exactly one of `task`, `message`, `statusUpdate`, `artifactUpdate`); it ends when the agent's turn does. |
| `getTask(taskId, { historyLength? })` / `cancelTask(taskId, { metadata? })` | The task. |
| `subscribeToTask(taskId)` | The snapshot, then the updates of the running turn. |

Send options are `taskId` (continue an `INPUT_REQUIRED` task), `contextId`, `configuration` (`acceptedOutputModes`, `historyLength`, `returnImmediately`), `metadata`, `signal` and per-call `headers`. Enum values a server sends as numbers come back named (`'TASK_STATE_WORKING'`). An aborted `signal` rejects with `AbortError` at once, even through a `fetch` that ignores signals. `a2aText(value)` joins the text parts of a message, an artifact or a list of parts (`''` for `undefined`).

Every failure is an `A2AError` (`code: 'a2a_error'`) with a `kind`: `'protocol'` (the agent answered with an A2A error: `reason`, `rpcCode`, `statusCode`, `metadata`), `'http'` (a non-2xx answer without one, such as a proxy or an auth layer: `statusCode`), `'network'` (no response, or a stream that broke off: `cause`), `'invalid-response'` (not what the binding defines). A card with no usable interface, or an unknown `binding`, throws `InvalidRequestError` when the client is created.

**Not covered:** gRPC, A2A 0.3, push notifications, `ListTasks`, the extended card, and verification of signed cards (a card's `signatures` are carried, not checked). Long silent turns get no keep-alive comments: report progress with `working(…)` before a proxy's idle timeout. **Not live-verified:** the wire was derived from `@a2a-js/sdk` 1.3.0 and is tested offline against it in both directions, not against third-party agents.

## Sharp edges

- Both handlers check the protocol, not the caller. Authenticate first; pass the verified identity as `server.fetch(request, { authInfo })` or through the A2A `owner` option.
- MCP `approve: 'elicit'` trusts the client's answer, and is denied outright where the client cannot be asked. A server facing clients it does not trust decides on the server.
- An MCP agent that suspends is an error to the caller: an MCP call has no resume.
- A stdio MCP server that writes to stdout corrupts its own protocol stream.
- An A2A executor's own `A2AError` is a refusal of the request; an `A2AError` from a nested `createA2AClient` call is a failure of the task. Rethrow deliberately.
- A custom `A2ATaskStore` keyed by task id alone breaks tenant and owner isolation.
- The default A2A task store is in memory: tasks vanish on restart and are not shared between instances.

## Deep dive

- [/docs/modules/mcp-server](/docs/modules/mcp-server) — every option, the served-call pipeline, approval per era, agents as tools, stdio, limits.
- [/docs/modules/a2a](/docs/modules/a2a) — the card as routing table, the executor and its turns, streaming, cancellation, task stores, errors per binding.
- [/docs/modules/mcp](/docs/modules/mcp) — the client side of MCP (`references/mcp.md`).
