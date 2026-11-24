<!-- verified: 2026-11-24 against @deuz-sdk/core@2.5.0 · api-contract sha256:cd3d4f48e5a3
     sources: packages/core/src/{tool-search,meter,acp,harness}/*.ts, packages/core/src/errors.ts,
     packages/{cli,ai-sdk-provider,mcp-ledger}/src/*.ts, packages/*/package.json, packages/core/CHANGELOG.md (2.5.0),
     docs/content/docs/modules/{tool-search,meter,acp,harness,cli,ai-sdk-provider,mcp-ledger}.mdx,
     docs/content/docs/reference/{whats-new-2-5,known-gaps,support-matrix}.mdx -->

# Distribution (2.5): tool search, the meter, the deuz CLI, harnesses, ACP, the AI SDK provider, the MCP ledger

**Load when:** a large tool catalog should stay out of the model's context; Claude Code, Codex or any Anthropic/OpenAI client you did not write must spend against a persistent budget; a coding harness should run as a budgeted sub-agent whose permission requests your code decides; a Deuz agent should appear in Zed or a JetBrains IDE (ACP), or your code should drive an ACP agent; existing Vercel AI SDK code needs a Deuz budget without a port; an MCP client (Claude Desktop, Cursor) should get memory, a spend ledger and receipts with no code. The MCP server's new resources, prompts, catalog and tasks are in `references/interop.md`.

2.5 is additive: nothing here runs until you import it, existing calls send the same provider requests, and core still has no runtime dependency and no new optional peer.

| You want to | Use | Entry | Runtime | Stability |
| --- | --- | --- | --- | --- |
| Hide a big catalog behind one search tool that respects budget and policy | `createToolSearch`, `search.apply(options)` | `@deuz-sdk/core/tool-search` | Edge-safe | stable |
| Charge traffic you do not write (a harness, a client) to a `BudgetStore`, 402 at the ceiling | `createMeterHandler` (fetch handler), `declaredReceipt` | `@deuz-sdk/core/meter` | Edge-safe | stable |
| The same meter as a local HTTP proxy; JSONL receipts | `createMeterProxy`, `createJsonlReceiptSink` | `@deuz-sdk/core/meter/node` | Node only | stable |
| Start the meter, or serve an agent to an editor, from a terminal | `deuz meter`, `deuz acp` | `@deuz-sdk/cli` | Node 22 (22.13 for `--store`) | preview |
| Run Claude Code / Codex / Gemini CLI / OpenCode as a budgeted sub-agent | `runHarness`, `harnessTool` | `@deuz-sdk/core/harness/node` | Node only | preview |
| The harness run over a connection you open; the permission policy on its own | `runAcpHarness`, `evaluateHarnessPolicy`, `HARNESS_PRESETS` | `@deuz-sdk/core/harness` | Edge-safe | preview |
| Serve a native agent to an ACP editor, or drive an ACP agent | `serveAcpAgent`, `connectAcpAgent` | `@deuz-sdk/core/acp` | Edge-safe | preview |
| The same over stdio; spawn an ACP agent as a child | `serveAcpAgentStdio`, `spawnAcpAgent` | `@deuz-sdk/core/acp/stdio` | Node only | preview |
| Keep Vercel AI SDK 7 code, add a Deuz budget, fail-over and breaker | `deuz(model, options)`, `deuzMiddleware(options)` | `@deuz-sdk/ai-sdk-provider` | Node 22; `ai@7`, `@ai-sdk/provider@4` | stable |
| Memory, an advisory spend ledger and receipts for any MCP client | `npx @deuz-sdk/mcp-ledger`, or `createMcpLedger` | `@deuz-sdk/mcp-ledger` | Node 22.13 (`node:sqlite`) | stable |
| An error class without loading the root entry | `DeuzError`, `isDeuzError`, … | `@deuz-sdk/core/errors` | Edge-safe | stable |

The three packages start at 2.5.0 and need `@deuz-sdk/core` 2.5. They keep their own dependencies out of core: `@deuz-sdk/ai-sdk-provider` peers on `@ai-sdk/provider` ^4 (and you install `ai@7`), `@deuz-sdk/mcp-ledger` depends on `@modelcontextprotocol/server`.

## What was verified live, and what was not

As of 2026-11-24 (Windows 11, Node 26.13.0):

- **Claude Code** (2.1.331, claude.ai subscription login, model `haiku`) behind the built `deuz meter`: traffic measured, priced at API rates and receipted with no credential in the receipt; at a ceiling below one request's estimate Claude Code showed `API Error: 402 deuz meter: …` and exited 1 after one request, without retrying. Through `runHarness('claude-code')` (`@agentclientprotocol/claude-agent-acp` 0.110.1) with the current preset: the session ran in mode `default`, the edit permission request arrived and a deny-writes policy refused it (the file was not written), and measured and declared cost agreed ($0.011074 against $0.01107382, `consistent`).
- **Codex** on a ChatGPT login reaches the meter only through a custom Codex model provider whose upstream is `https://chatgpt.com/backend-api/codex`; `deuz meter -- codex` alone meters nothing (Codex ignores `OPENAI_BASE_URL` in that mode). The backend streams `/responses` with no `content-type`; the meter now reads a 2xx reply to a `stream: true` request as SSE unless it says JSON, so that traffic is measured. That fix is covered by a unit test and was not re-run live. Codex retries a 402 five times before exiting. API-key mode was not tried.
- **ACP** passed a conformance run in both directions against the official `@agentclientprotocol/sdk` 2.9.1 and its bundled schema, including the built `deuz acp`. No real editor (Zed, JetBrains) has run it.
- **Not live:** Gemini CLI and OpenCode presets (documentation only), tool search (no real model was asked to search), the AI SDK provider (`ai` 7's mock models only), the MCP ledger (in-process tests plus one real stdio child run; never inside Claude Desktop or Cursor).

Before depending on anything marked not live-verified, make one real call with a small budget.

## Tool search

`createToolSearch` puts a catalog behind one `tool_search` tool over a dependency-free BM25 index. Tools the execution policy would refuse are never returned (only counted under `withheld`); tools whose estimated cost does not fit the remaining budget are left out (`overBudget: 'exclude'`, the default) or labelled; approval-gated and expensive tools are labelled. `search.apply(options)` uses the loops' existing `prepareStep` → `activeTools` seam, so it works in `generateText`, `streamChat` and native `runAgent` (V3 included) alike.

```ts
import { generateText } from '@deuz-sdk/core';
import type { ToolSet } from '@deuz-sdk/core';
import { createToolSearch } from '@deuz-sdk/core/tool-search';
import { createMockModel } from '@deuz-sdk/core/testing';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });

const catalog: ToolSet = {
  send_email: {
    description: 'Send an email message to a recipient.',
    parameters: object({ to: { type: 'string', description: 'Recipient address' } }),
    execute: async () => 'sent',
  },
  render_video: {
    description: 'Render a video clip from a script.',
    parameters: object({ script: { type: 'string' } }),
    execute: async () => 'video.mp4',
  },
  get_time: { description: 'Current time.', parameters: object({}), execute: async () => 'noon' },
};

const search = createToolSearch({ tools: catalog, alwaysLoaded: ['get_time'] });

const model = createMockModel({
  responses: [
    { toolCalls: [{ toolName: 'tool_search', args: { query: 'send an email' } }] },
    { toolCalls: [{ toolName: 'send_email', args: { to: 'bob@example.com' } }] },
    { text: 'Mail sent.' },
  ],
});

// Step 1 offers only tool_search and get_time; step 2 adds send_email; render_video is never sent.
const result = await generateText(search.apply({ model, prompt: 'Mail Bob.', maxSteps: 5 }));
console.log(result.text); // 'Mail sent.'
```

- **What `apply` changes:** `tools` (yours + catalog + search tool), `prepareStep` (yours runs first, then narrows `activeTools`; with nothing left the step gets only the search tool and `toolChoice: 'none'`), and, with `enforce` on (the default), an `onToolCall` guardrail named `'tool-search'`. Everything else keeps its own type (`ToolSearchApplied<O, T>`), so `checkpointVersion: 3` still selects the V3 `runAgent` overload.
- **Enforcement** refuses a deferred tool the model never surfaced (including one called in the same turn as the search that finds it) and any tool the step never offered, such as a hidden tool from the call's `mcp` entries. It lets through a sub-agent's calls and every call after a handoff.
- **Budget:** `budget.remaining` (a value or a function) and the call's execution context; the tighter wins per dimension. `remainingFromBudgetStore(store, scopes, now)` reads a persistent store (a windowed scope needs `now`), `remainingFromExecution(execution)` an execution context. Attach per-tool cost and keywords with `meta` or `withSearchMeta(tool, { cost: { usd }, keywords })`; a tool with no estimate is never excluded.
- **Policy:** `policy` is intersected with the run's own; when an execution policy has `allowedTools`, list `'tool_search'` (`TOOL_SEARCH_NAME`) in it or the loop refuses the search itself.
- **Without a model:** `await search.search('send email', { limit: 3 })` or `searchTools(query, options)`. The query `select:a,b` loads by exact name (filters still apply).
- **Limits:** lexical only (no embeddings, no prefix/fuzzy match: add `keywords`); not evaluated against a real model; budget filtering happens at search time, a surfaced tool stays loaded, and a result pruned by compaction is recomputed without the budget filter; MCP tools from `mcp` entries are not indexed (list them yourself into `tools`, or name them in `alwaysLoaded`); the catalog is fixed at creation; durable resume with search active is reasoned, not tested.

## The meter

Point a harness's or client's base URL at the meter and each request is admitted against a `BudgetStore` on a conservative estimate, forwarded (streams byte for byte), settled with the usage the provider reported (priced with the adapters' own usage mappers), and recorded as one receipt with no prompt, response or credential in it. At the ceiling it answers **402 in the provider's own error JSON** (`billing_error` / `insufficient_quota`) and nothing is forwarded. It routes Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and any OpenAI-compatible base URL.

```ts
import { createJsonlReceiptSink, createMeterProxy } from '@deuz-sdk/core/meter/node';
import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';

const proxy = createMeterProxy({
  budget: {
    store: createSqliteBudgetStore({ path: '.deuz/budget.sqlite' }),
    scopes: [{ key: 'dev:me', limits: { usd: 20 }, window: { ms: 86_400_000 } }], // $20 per rolling day
  },
  receipts: createJsonlReceiptSink({ path: '.deuz/meter.jsonl' }),
  onWarning: (warning) => console.error('meter:', warning),
});

const { url } = await proxy.listen({ port: 8787 }); // binds 127.0.0.1 by default: keep it on loopback
console.error(`ANTHROPIC_BASE_URL=${url} claude`);
```

- `createMeterHandler(options)` is the same meter as a fetch-style handler (`meter.fetch(request)` never rejects; `meter.flush()` waits for every settlement and receipt). `createMeterProxy` adds `host`/`port`; `proxy.close()` drains, `proxy.stats()` returns running totals.
- `scopes` may be a function of the request (route, model, protocol, headers with credentials stripped). Admission is all-or-none across scopes; the same store and keys can be shared with your app, native agents and `@deuz-sdk/ai-sdk-provider` for one ceiling.
- **Settlement:** `'measured'` when final usage arrived; `'released'` for a non-2xx or unreachable upstream; `'estimate'` (fail-closed, `usage-missing` warning) for a disconnect or a stream without usage; `'held'` when the store failed to settle (reconcile with `BudgetStore.sweep`).
- **Routing:** metered POSTs end in `/messages`, `/chat/completions` or `/responses`; `count_tokens`, `/responses/input_tokens` and non-POSTs pass through unmetered; any other billable POST (batches, embeddings, `/responses/compact`) is refused with 404 unless `unmeteredRoutes: 'forward'`. Add an OpenAI-compatible host with `upstreams: [...DEFAULT_METER_UPSTREAMS, { provider, kind: 'openai', baseUrl, mount }]`.
- `declaredReceipt(input, options)` builds a receipt with `source: 'declared'` for a cost an agent reported about itself; it charges no budget.
- **Limits:** a ceiling can be overshot by up to one request per request in flight (admission is on the estimate); the default estimate is pessimistic (3 chars per token, the dearest prompt rate, a 32,000-token output cap when the request sets none; it ran 4 to 130 times the measured cost for Claude Code, so roughly the last $0.07 of a budget is refused early with `haiku`), tune it with `estimate`; `injectStreamUsage` (on) adds a final Chat Completions chunk with empty `choices`; subscription traffic is priced at API rates; responses are decoded, so `content-encoding` is not relayed.

## The deuz CLI (preview)

```bash
npx @deuz-sdk/cli meter --budget-usd 5 -- claude          # run Claude Code behind a $5 meter
deuz meter --budget-usd 20 --window day --store ~/.deuz/budget.sqlite -- claude
deuz meter --budget-usd 50 --receipts ~/.deuz/meter.jsonl  # no command: serve on 127.0.0.1:8787, log each request
npx @deuz-sdk/cli acp ./agent.js --budget-usd 10 --window day --store ~/.deuz/budget.sqlite
```

- `deuz meter -- <command>` sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` (`…/v1`) and `DEUZ_METER_URL` for the command, passes stdio through, prints a spend summary to stderr and exits with the command's code. It refuses to start (exit 2) while `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` already point elsewhere unless `--anthropic-upstream`/`--openai-upstream` say where that traffic goes, and while any `CLAUDE_CODE_USE_*` provider switch is on (for every wrapped command, with no override flag; settings files are not read).
- Flags shared by both commands: `--budget-usd`, `--budget-tokens`, `--window` (`lifetime`, `day`, `week`, `month`, `12h`, `7d`, …; always rolling), `--key`, `--store` (SQLite; Node 22.13). With `--store`, each run leaves one released zero-amount probe record.
- Codex on a ChatGPT login needs the custom-provider recipe:

```bash
deuz meter --port 8787 --openai-upstream https://chatgpt.com/backend-api/codex -- \
  codex exec -c model_provider="deuzmeter" \
  -c 'model_providers.deuzmeter={name="deuz meter",base_url="http://127.0.0.1:8787",wire_api="responses",requires_openai_auth=true,supports_websockets=false}' \
  "reply with the single word OK"
```

- `deuz acp <module>` serves the module's default export (or `--export <name>`) with `serveAcpAgentStdio`; `--footer` appends a plain-text cost line. `agent` defaults to the CLI's own `streamAgent`/`resumeStreamAgent` and `store` to an in-memory run store; if your module imports its own copy of core, export `agent` and `store` yourself.

```ts no-verify
// agent.ts — `defineAcpAgent` only types the export
import { defineAcpAgent } from '@deuz-sdk/cli';
import { anthropic } from '@deuz-sdk/core/anthropic';

export default defineAcpAgent({
  info: { name: 'my-agent', version: '1.0.0' },
  run: { model: anthropic('claude-opus-5-5'), instructions: 'You are a careful coding agent.', maxSteps: 20 },
});
```

In code, `runCli` from `@deuz-sdk/cli` runs the CLI in process and resolves the exit code (`DeuzCliError` codes: `usage`, `budget_conflict`, `store_unavailable`, `module_*`). Zed (`agent_servers` in `settings.json`) and JetBrains (`~/.jetbrains/acp.json`, full path to `npx`) registrations follow those editors' docs and have not been tried.

## Harnesses as sub-agents (preview)

`runHarness` starts a meter bound to your budget, points the harness's base URL variables at it, spawns the harness over ACP, opens one session in `cwd` and sends one prompt. It decides each permission request (policy, then `onPermission`, then `approveToolCall`, then `fallback: 'deny'`), cancels the turn at the first budget 402, and reports measured and declared cost side by side.

```ts
import { runHarness } from '@deuz-sdk/core/harness/node';
import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';

const result = await runHarness({
  harness: 'claude-code',
  prompt: 'Run the tests and fix what fails.',
  cwd: '/work/repo',
  budget: {
    store: createSqliteBudgetStore({ path: '.deuz/budget.sqlite' }),
    scopes: [{ key: 'harness:ci', limits: { usd: 2 } }],
  },
  policy: {
    rules: [
      { decision: 'deny', paths: ['**/.env', '**/.env.*'], name: 'no-secrets' },
      { decision: 'allow', kinds: ['read', 'search', 'edit'], paths: ['**'] },
    ],
  },
});

console.log(result.stopReason, result.text);
console.log(result.cost.measured?.usd, result.cost.declared?.usd, result.cost.comparison.status);
console.log(result.toolCalls); // { observed, decided, allowed, denied, observedOnly }
```

| Preset | Launch | Metered | Status |
| --- | --- | --- | --- |
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp` | Anthropic Messages via `ANTHROPIC_BASE_URL`; each session opened with `allowDangerouslySkipPermissions: false` and switched to mode `default`, where Claude Code asks before each tool call | `verifiedLive: true` |
| `codex` | `npx -y @agentclientprotocol/codex-acp` | OpenAI Responses over HTTP through a `deuz-meter` Codex model provider in `CODEX_CONFIG`; a ChatGPT login also needs `meter: { upstreams: [{ provider: 'openai', kind: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex', mount: '/v1' }] }` | `verifiedLive: false` |
| `gemini-cli` | `gemini --acp` | nothing: declared cost only, no ceiling; a `budget` is refused unless `allowUnmetered: true` | documentation only |
| `opencode` | `opencode acp` | Anthropic and OpenAI providers via `OPENCODE_CONFIG_CONTENT` (replaces yours) | documentation only |

- **Deuz decides only what the harness asks.** A harness in an auto-accept mode asks nothing, and a call it never reports is invisible: read `toolCalls.decided` against `toolCalls.observedOnly`. The budget is the hard limit; the policy is as strong as the harness's own prompting.
- **Policy:** rules by `kinds` and glob `paths`, first match wins; an allow needs every location to match (and at least one), a deny needs any; deny globs are case-insensitive. `runHarness` resolves real paths (symlinks, junctions, 8.3 names) before the policy sees them; `runAcpHarness` does not unless you pass `resolvePath`. `evaluateHarnessPolicy(policy, { kind, paths }, cwd)` tests a policy on its own.
- **Refusals before start (`TypeError`):** a `budget` while a provider switch in `unmeteredEnv` (for Claude Code `CLAUDE_CODE_PROVIDER_SWITCHES`, such as `CLAUDE_CODE_USE_BEDROCK`) is on in the environment or `env`; a `budget` with a shared meter or `meter: false`; a `budget` on Gemini CLI. A gateway URL in your environment is not followed: set `meter.upstreams`.
- **Cost:** `cost.comparison.status` is `consistent`, `diverged` (beyond both $0.001 and 10% by default; `divergence` overrides), `undeclared` (Codex sends no declared cost), `unmeasured` or `unavailable`. Declared cost is recorded and compared, never charged.
- `signer` (an `ApprovalSigner`) HMAC-signs each decision record: an audit attestation, not a resumable approval.

As a tool, `harnessTool` gives the model `{ prompt }` and returns `text`, `stopReason`, `measuredUsd`, `declaredUsd`, `costStatus`, `budgetExhausted`, `toolCalls`; each call spawns a fresh harness:

```ts
import { generateText } from '@deuz-sdk/core';
import type { LanguageModel } from '@deuz-sdk/core';
import { createInMemoryBudgetStore } from '@deuz-sdk/core/agent';
import { createApprovalSigner } from '@deuz-sdk/core/durable';
import { harnessTool } from '@deuz-sdk/core/harness/node';

declare const model: LanguageModel;
declare const repo: string;
const store = createInMemoryBudgetStore();

const result = await generateText({
  model,
  prompt: 'CI is red on main. Get it green.',
  tools: {
    coder: harnessTool({
      harness: 'claude-code',
      cwd: repo,
      budget: { store, scopes: [{ key: 'harness:claude', limits: { usd: 3 } }] },
      policy: { rules: [{ decision: 'allow', kinds: ['read', 'search'], paths: ['**'] }] },
    }),
  },
  // Decides the harness's permission requests the policy left open (mid-turn, synchronously).
  approveToolCall: async (call) => call.toolName === 'claude-code.edit',
  approvalSigner: createApprovalSigner({ secret: process.env.APPROVAL_SECRET! }),
  maxSteps: 4,
});
console.log(result.text);
```

Mid-turn permission requests cannot suspend and resume (the child holds an open ACP request): they go to `policy`, `onPermission`, then the parent's server-mode `approveToolCall`. Native `runAgent` tools pass no approver, so there only the policy and callback decide. Gating the delegation itself with `needsApproval` uses the parent's full signed flow.

**Limits:** only the Claude Code preset is verified live; settings files are not read (they can set provider switches or `ANTHROPIC_BASE_URL` and route around the meter); a shared meter (`meter: proxy`) gives approximate totals, no per-run receipts and no live cancel; Windows shell launches do not escape arguments and the `taskkill /T /F` tree kill has no automated test.

## ACP (preview)

`@deuz-sdk/core/acp` speaks Agent Client Protocol version 1 (schema 1.34.1) with a hand-written, dependency-free JSON-RPC layer. Serve side: each prompt is one `streamAgent` run; text, reasoning, tool calls, the plan and `usage_update` (cumulative USD) stream to the editor; a `needsApproval` tool becomes `session/request_permission`, answered through the run's own HMAC-signed token, which the editor never sees.

```ts
import type { ToolSet } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import {
  createInMemoryAgentRunStore,
  createInMemoryBudgetStore,
  resumeStreamAgent,
  streamAgent,
} from '@deuz-sdk/core/agent';
import { serveAcpAgentStdio } from '@deuz-sdk/core/acp/stdio';
import { createApprovalSigner } from '@deuz-sdk/core/durable';

declare const tools: ToolSet; // mark risky tools needsApproval

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
// stdout is the protocol: fail on stderr before serving, and never console.log.
const approvalSecret = process.env.APPROVAL_SECRET;
if (!approvalSecret) throw new Error('APPROVAL_SECRET is not set: it signs tool approvals.');

await serveAcpAgentStdio({
  agent: { streamAgent, resumeStreamAgent }, // injected, so /acp does not bundle the engine
  store: createInMemoryAgentRunStore(),
  run: { model: anthropic('claude-sonnet-5-5'), instructions: 'A careful coding agent.', tools, maxSteps: 20 },
  approvalSigner: createApprovalSigner({ secret: approvalSecret }),
  budget: { store: createInMemoryBudgetStore(), scopes: [{ key: 'user:me', limits: { usd: 5 } }] },
  budgetFooter: true, // a plain-text cost line: stock editors show none of the _meta fields
  clientFsTools: true,
});
```

Client side, `connectAcpAgent({ transport, onPermissionRequest })` (or `spawnAcpAgent` from `@deuz-sdk/core/acp/stdio` to start the agent as a child process) opens sessions and returns a typed turn:

```ts
import { spawnAcpAgent } from '@deuz-sdk/core/acp/stdio';

const harness = await spawnAcpAgent({
  command: 'npx',
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  shell: process.platform === 'win32',
  onPermissionRequest: (request) => {
    const reject = request.options.find((option) => option.kind === 'reject_once');
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  },
});
const session = await harness.newSession({ cwd: process.cwd() });
const { stopReason, text, cost } = await session.prompt('List the TODOs in src/.').result;
console.log(stopReason, text, cost); // cost is declared by the agent, not measured
await harness.close();
```

For a metered, policy-checked harness run use `runHarness` instead; `runAcpHarness` from `@deuz-sdk/core/harness` is that run over a connection you open (pass its `hooks` into `connectAcpAgent`).

- Budget: `budget: { store, scopes, turn? }` admits each turn against persistent scopes; the editor sees `usage_update.cost`, the optional footer, and `_meta` under `io.github.deuz-ai` (`ACP_DEUZ_META`) plus the `_io.github.deuz-ai/budget` extension request (`ACP_DEUZ_BUDGET_METHOD`). `budget` and `run.execution` together are rejected.
- "Always" answers are remembered per session and tool; they survive connections only with a `sessions` store (`createInMemoryAcpSessionStore()` is one, and enables `session/load`). A run's server-side `approveToolCall` bypasses the editor.
- **Limits:** not tried in a real editor (how one renders the cost or footer is unknown); version 1 only, with no `session/list`, `session/close`, `session/resume`, `session/set_mode`, terminals or elicitation; audio prompts are refused; `write_text_file` sends no diff; sessions are in memory unless you pass a store; the Windows tree kill has no automated test.

## The AI SDK provider

For code that stays on the Vercel AI SDK. `deuz(model, options)` (from `@deuz-sdk/ai-sdk-provider`) wraps an AI SDK 7 `LanguageModelV4`: each call checks the breaker, reserves against a Deuz budget (in process, or a persistent `BudgetStore` shared across processes), calls the model, settles reported usage and emits a cost receipt; it fails over to `fallbackModels` before the first content byte. At the ceiling it throws `DeuzBudgetError` (`isRetryable: false`, so the AI SDK does not retry it).

```ts no-verify
import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { deuz, DeuzBudgetError } from '@deuz-sdk/ai-sdk-provider';
import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';

// In process: counts calls through this wrapped value only.
const model = deuz(openai('gpt-5-mini'), { budget: { usd: 5 }, fallbackModels: [anthropic('claude-haiku-4-5')] });
const { text } = await generateText({ model, prompt: 'Summarise the ticket.' });
console.log(model.ledger.totals());

// Persistent and shared: wrap per request to bind per-user scopes.
const store = createSqliteBudgetStore({ path: './budgets.sqlite' });
const perUser = deuz(anthropic('claude-sonnet-4-5'), {
  budget: { store, scopes: [{ key: 'user:42', limits: { usd: 2 }, window: { ms: 86_400_000 } }] },
  onCost: (receipt) => console.log(receipt.priceKey, receipt.usd, receipt.source),
});
try {
  await generateText({ model: perUser, prompt: 'Hello' });
} catch (error) {
  if (DeuzBudgetError.isInstance(error) && error.code === 'budget_exceeded') console.warn('budget reached');
  else throw error;
}
```

- `deuzMiddleware(options)` gives the budget, breaker and receipts to `wrapLanguageModel` (which also upgrades AI SDK 5/6 models); it has no fail-over. `deuz()` throws `DeuzUnsupportedModelError` for a model whose `specificationVersion` is not `'v4'`.
- Azure deployment names and other custom ids need `priceKey`. Unpriced models follow `budget.unknownPrice` (`'warn'` runs and counts tokens only; `'reject'` refuses under a USD bound).
- **Limits:** AI SDK 7 only for `deuz()`; admission by character estimate with output reserved at `maxOutputTokens` or 4,096, so a ceiling can be overshot by up to one call; a stream that ends before `finish` keeps its estimate charged; tested with the AI SDK's mock models only.

## The MCP ledger

`npx @deuz-sdk/mcp-ledger` is a ready-made stdio MCP server (optional loopback HTTP with `--http`, port 3741) serving nine tools: `memory_remember`, `memory_recall`, `memory_revise`, `memory_forget`, `memory_history`, `budget_status`, `budget_record_spend`, `receipt_record`, `receipt_list`. Memory is Deuz versioned memory with lexical search and no API key; the budget is a ledger the model reports to; receipts go to an append-only, hash-chained log. Everything sits in three SQLite files in one directory (`--data-dir` / `DEUZ_LEDGER_DIR`).

```json
{
  "mcpServers": {
    "deuz-ledger": {
      "command": "npx",
      "args": ["-y", "@deuz-sdk/mcp-ledger", "--budget-usd", "20", "--window", "month"]
    }
  }
}
```

To serve it yourself, `createMcpLedger` from `@deuz-sdk/mcp-ledger` returns `server` (a `DeuzMcpServer`), `tools`, `memory`, `budget`, `receipts` and `close()`:

```ts no-verify
import { createMcpLedger } from '@deuz-sdk/mcp-ledger';
import { serveMcpStdio } from '@deuz-sdk/core/mcp/server/stdio';

const ledger = createMcpLedger({ dataDir: '/var/lib/my-app/ledger', budget: { usd: 50, window: '7d' }, namespace: 'team-a' });
await serveMcpStdio(ledger.server); // or route HTTP requests to ledger.server.fetch
```

**The budget is advisory:** `budget_status` always reports `enforcement: 'advisory'`, and a model that never calls `budget_record_spend` is not stopped. To enforce a ceiling, put the meter in front of the provider API. Other limits: memory search is lexical and `memory_remember` never reconciles a reworded fact; receipts record what the model reported, and the hash chain detects later edits but does not prevent a rewrite; HTTP mode has no authentication beyond loopback and Host/Origin checks; never run inside Claude Desktop or Cursor.

## `@deuz-sdk/core/errors`

Every core error class (`DeuzError`, `isDeuzError`, `BreakerOpenError`, `RateLimitError`, `InvalidRequestError`, …) without loading the root entry, plus the five the root does not export: `ContextBudgetExceededError`, `RevisionConflictError`, `OperationConflictError`, `EmbeddingMismatchError`, `UnsupportedStoreError`. They are the same class objects as on their home entries, so `instanceof` works across them.

## Sharp edges

- Keep the meter on loopback: it relays the caller's own credentials. `createMeterProxy` defaults to `127.0.0.1`.
- A harness that runs in an auto-accept mode bypasses your policy entirely; only the meter's ceiling still holds.
- A stdio ACP agent or MCP ledger that writes to stdout corrupts the protocol (the CLI redirects `console.log` while serving; your own `serveAcpAgentStdio` script does not).
- Tool search hides `mcp:` tools unless named in `alwaysLoaded`; with `enforce` on, a guessed hidden name is refused.
- ACP's and the AI SDK provider's client-side cost is what the agent or model declared/estimated; only the meter measures provider traffic.
- Not in 2.5: a TUI, a daemon or control server, WebRTC realtime, a plugin lifecycle, a durable agent mailbox, a worktree integrator, LSP, provider-hosted tool search (`defer_loading`), and MCP tasks in the client.

## Deep dive

- [/docs/reference/whats-new-2-5](/docs/reference/whats-new-2-5) — the release, stability, upgrade notes and every known limit.
- [/docs/modules/tool-search](/docs/modules/tool-search), [/docs/modules/meter](/docs/modules/meter), [/docs/modules/cli](/docs/modules/cli), [/docs/modules/harness](/docs/modules/harness), [/docs/modules/acp](/docs/modules/acp).
- [/docs/modules/ai-sdk-provider](/docs/modules/ai-sdk-provider), [/docs/modules/mcp-ledger](/docs/modules/mcp-ledger).
- [/docs/reference/support-matrix](/docs/reference/support-matrix) — what each 2.5 surface was tested against; [/docs/reference/known-gaps](/docs/reference/known-gaps) — where Deuz is behind.
