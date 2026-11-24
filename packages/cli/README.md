# @deuz-sdk/cli

The `deuz` command line for the [Deuz SDK](https://github.com/Deuz-AI/Deuz-SDK). It has two commands:

- **`deuz meter`** puts an enforced token/USD budget in front of a coding harness such as Claude Code or Codex, or in front of any Anthropic or OpenAI client. It runs a local proxy that charges each request to a persistent budget, refuses requests with `402` once the ceiling is reached, and can write a receipt for every request.
- **`deuz acp`** serves a Deuz agent to an editor (Zed, JetBrains IDEs) over the [Agent Client Protocol](https://agentclientprotocol.com) on stdio.

```sh
# Run Claude Code with a $5 ceiling
npx @deuz-sdk/cli meter --budget-usd 5 -- claude

# Serve your agent to an editor, with a $10/day budget that persists
npx @deuz-sdk/cli acp ./agent.js --budget-usd 10 --window day --store ~/.deuz/budget.sqlite
```

You need Node.js 22 or later. A persistent budget (`--store`) also needs `node:sqlite`, which ships in Node 22.13 and later. Install globally with `npm i -g @deuz-sdk/cli` to get a plain `deuz` command.

## deuz meter

```
deuz meter [options]                  serve until Ctrl+C, log each request
deuz meter [options] -- <command...>  run <command> through the meter
```

The meter is a local proxy for these APIs:

- Anthropic Messages (`POST …/messages`)
- OpenAI Chat Completions (`POST …/chat/completions`)
- OpenAI Responses (`POST …/responses`)

Each request goes through these steps:

1. **Admission.** The meter checks the request against the budget, using a deliberately pessimistic estimate.
2. **Forwarding.** If it fits, the request goes to the provider unchanged, with your own API key. Streams pass through chunk by chunk.
3. **Charging.** The budget is charged the usage the provider reports, priced with Deuz's price table.

Once the ceiling is reached, the meter answers `402` in the provider's own error format (`billing_error` for Anthropic, `insufficient_quota` for OpenAI). Nothing is forwarded.

**With a command after `--`**, the meter listens on a free port and starts the command with these variables set:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `OPENAI_BASE_URL` | `http://127.0.0.1:<port>/v1` |
| `DEUZ_METER_URL` | `http://127.0.0.1:<port>` |

If your environment already sets `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to another endpoint (a gateway, OpenRouter, a local server), the meter refuses to start the command unless `--anthropic-upstream` or `--openai-upstream` names where that traffic goes. Otherwise the harness's key for that endpoint would be sent to the default provider.

It also refuses to start the command (exit 2) while one of Claude Code's provider switches is on (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`), because Claude Code would then send its traffic to that provider instead of the meter. The values `''`, `0`, `false`, `no` and `off` count as off. The message names the variables, never their values; unset them for the command.

Standard input, output and error pass straight through, so a full-screen harness works as usual. When the command exits, the meter prints a spend summary to stderr and exits with the command's exit code. If the command cannot be found, it exits with 127.

Ctrl+C reaches the harness directly, so the meter never sends it a second one; the meter itself waits for the harness to exit. A `SIGTERM` or `SIGHUP` sent to the meter is forwarded to the harness.

On Windows, the meter finds the command on `PATH` using `PATHEXT`. A `.exe` runs directly. A `.cmd` or `.bat` shim, such as an npm-installed `claude.cmd` or `codex.cmd`, runs through `cmd.exe`, and every argument is quoted and escaped, so the shell never interprets it. `cmd.exe` cannot pass a line break, so an argument that contains one is refused for such a shim.

**Without a command**, the meter listens on `127.0.0.1:8787` and prints the variables to set for each harness: `export …` lines, or PowerShell and `cmd.exe` lines in a Windows shell. It then logs one line per request to stderr, with the request's cost and the budget left:

```
14:02:11 POST /v1/messages · claude-opus-5-5 · 200 completed · 2,000 tok · $0.0240 · $4.98 of $5.00 left
14:02:40 POST /v1/messages · claude-opus-5-5 · 402 refused · budget deuz:meter exhausted (usd) · $0.00 of $5.00 left
```

Press Ctrl+C to stop. The meter waits for requests in flight to finish; press Ctrl+C a second time to cut them off.

### Options

| Flag | Meaning |
| --- | --- |
| `--budget-usd <n>` (alias `--budget`) | USD ceiling. |
| `--budget-tokens <n>` | Token ceiling. It can be combined with `--budget-usd`; a request must fit both. |
| `--window <spec>` | `lifetime` (default), `day`, `week`, `month` (a rolling 30 days), or a count with `h`, `d` or `w` (`12h`, `7d`, `2w`). All windows are rolling. |
| `--key <name>` | The budget key. Default `deuz:meter`, or `deuz:meter:<window>` for a windowed budget. Processes that share a store and a key share one budget. |
| `--store <file>` | SQLite file that keeps the budget across runs and across processes running at the same time. Without it, the budget lives in memory and lasts for this run only. A leading `~` means your home directory. |
| `--port <n>` | Port on 127.0.0.1. Default 8787 without a command, a free port with one. |
| `--receipts <file>` | Append one JSON receipt per request to this file. A receipt has the model, the usage, the cost, the settlement and the refusal reason. Receipts never contain API keys, prompts or responses. |
| `--anthropic-upstream <url>` | Where Anthropic traffic goes. Default `https://api.anthropic.com`. |
| `--openai-upstream <url>` | Where OpenAI traffic goes. Default `https://api.openai.com`. Any OpenAI-compatible base URL works. |
| `--forward-unmetered` | Forward billable routes the meter cannot price (see the limits below) without charging them, instead of refusing them. |
| `-h`, `--help` | Show help. |

Without `--budget-usd` or `--budget-tokens`, the meter only measures. It still logs requests and writes receipts.

A store fixes a key's window the first time the key is used. If you run the same key with a different `--window`, the meter stops at startup with a message. Pass the original window, or a new `--key`. The default key already includes the window, so this only happens with an explicit `--key`.

### Examples

```sh
# A daily $20 budget that carries over between runs and covers every terminal using the same store
deuz meter --budget-usd 20 --window day --store ~/.deuz/budget.sqlite -- claude

# Codex in API-key mode (not verified live; a ChatGPT login ignores OPENAI_BASE_URL)
deuz meter --budget-usd 5 -- codex

# A shared meter for several tools, with receipts
deuz meter --budget-usd 50 --window week --store ~/.deuz/budget.sqlite --receipts ~/.deuz/meter.jsonl
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

### Limits

Read these before you rely on the ceiling.

- **The budget can be overshot by up to one request.** Streaming usage is only final when the response ends. Admission therefore checks the request's *estimate* against what is left, and the request is then charged its *measured* cost. If the measured cost exceeds the estimate, the budget ends up over its ceiling by that difference, and the next request is refused. With requests running in parallel at the ceiling, each one in flight can overshoot this way.
  - The estimate is deliberately pessimistic: the prompt is counted at 3 characters per token and priced at the model's dearest prompt rate, plus the request's output cap (32,000 tokens if it sets none), times the number of choices a Chat Completions request asks for (`n`). The last part of a small budget can therefore be refused early.
  - The estimate can still be too low for prompts heavy in CJK text, for large inline images or PDFs, and for hidden provider framing.
- **Unmetered routes are refused by default.** Only the three APIs above are metered. Token counting and non-POST requests pass through free.
  - Every other POST, for example batches, embeddings or Codex's `/responses/compact`, is refused with `404` so that no spend bypasses the budget.
  - `--forward-unmetered` sends those requests on without charging them. They still get a receipt.
- **Verified live with Claude Code; Codex only partly.** On 2026-11-24 (Windows 11, Node 26.13.0) `deuz meter -- claude -p …` with Claude Code 2.1.331 on a claude.ai subscription login measured, priced and receipted each request; the subscription's OAuth bearer passed through unchanged and never reached a receipt. At the ceiling Claude Code showed `API Error: 402 deuz meter: …` and exited 1 after one request, without retrying.
- **Codex with a ChatGPT login is not metered by `deuz meter -- codex`.** It ignores `OPENAI_BASE_URL` (0 requests reached the meter). A custom Codex model provider with `requires_openai_auth = true` and `supports_websockets = false`, plus `--openai-upstream https://chatgpt.com/backend-api/codex`, reaches the meter. The backend's replies carry no `content-type`; the meter reads a streamed reply without one as SSE and measures it, which a unit test covers but no live run has confirmed (the live run predates the fix and was charged its estimate). Codex retries a 402 five times before exiting. API-key mode was not tried. See the [meter docs](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/meter.mdx).
- **Subscription traffic is priced at API rates.** A claude.ai subscription or a ChatGPT plan is not billed per token; the meter reports what the same tokens would cost on the API.
- **For Claude Code the estimate ran 4 to 130 times the measured cost**, so roughly the last $0.07 of a budget is refused early with `haiku`.
- **Usage that never arrives is charged at the estimate.** This happens when a stream breaks, the client disconnects, or Chat Completions streams without usage. The charge is fail-closed. By default the meter adds `stream_options.include_usage` to streaming Chat Completions requests, so the client then receives one extra final chunk with empty `choices`.
- **Unpriced models** are admitted and charged tokens only. The log and the summary say so.
- The meter binds to 127.0.0.1 only. It relays your API keys to the provider unchanged and never logs or stores them.

## deuz acp

```
deuz acp <module> [options] [-- <args for the module>]
```

This command serves a Deuz agent over ACP (protocol version 1) on stdio, for an editor to launch. Inside the editor, the agent's turns stream into the chat panel. Tool calls that need approval show up as the editor's permission prompts, and each answer is checked against the run's own HMAC-signed approval token. The editor never sees the token. Spend is charged to the budget and shown as the session's cost.

Standard output is the protocol channel. Every log line goes to stderr, and while the agent is serving, `console.log`, `console.info`, `console.debug`, `console.dir` and `console.dirxml` are redirected to stderr as well, so a stray log cannot corrupt the protocol.

### The module

`<module>` is a file path, or a package name resolved from the current directory. Its default export, or the export named by `--export`, is one of:

- the options of `serveAcpAgentStdio` from `@deuz-sdk/core/acp/stdio`, without `stdin` and `stdout`;
- a function that returns those options (it may be async). It is called with `{ argv, cwd, env }`, where `argv` holds the arguments after `--`.

The options take these fields:

- `run` is required: the run options of each turn (`model`, `instructions`, `tools`, `maxSteps`…), or a function returning them.
- `agent` is optional. It defaults to `{ streamAgent, resumeStreamAgent }` from `@deuz-sdk/core/agent`.
- `store` is optional. It defaults to an in-memory run store.
- Every other option of `serveAcpAgentStdio` is accepted, for example `info`, `approvalSigner`, `sessions`, `toolKinds`, `clientFsTools` and `budget`.

```ts
// agent.ts
import { defineAcpAgent } from '@deuz-sdk/cli';
import { anthropic } from '@deuz-sdk/core/anthropic';

export default defineAcpAgent({
  info: { name: 'my-agent', version: '1.0.0' },
  run: {
    model: anthropic('claude-sonnet-4-5'),
    instructions: 'You are a careful coding agent.',
    maxSteps: 20,
  },
});
```

A `.ts` module runs directly on Node versions that strip types: 22.18 and later, or 23.6 and later. On older versions, compile the module to `.js` first.

If the module cannot be found, fails to load, lacks the export, or exports the wrong shape, the command exits with code 1 and prints a one-line message on stderr. For a missing export, the message lists the exports the module has.

### Options

| Flag | Meaning |
| --- | --- |
| `--export <name>` | The export to use. Default: `default`. |
| `--footer` | Append a plain-text line with the turn's cost, the session's cost and the budget left to each reply. Some editors show no cost field, so this line may be the only place the cost appears. |
| `--budget-usd <n>` (alias `--budget`) | USD ceiling for every turn. If the budget is exhausted, the turn ends with a reply that says so. |
| `--budget-tokens <n>` | Token ceiling. |
| `--window <spec>` | Same as for `deuz meter`. |
| `--key <name>` | Budget key. Default `deuz:acp`, or `deuz:acp:<window>` for a windowed budget. |
| `--store <file>` | SQLite file that keeps the budget across sessions and editor restarts. |
| `-h`, `--help` | Show help. |

The budget flags cannot be combined with a module that sets `budget` itself.

### Register it in Zed

Open the Agent Panel's settings, go to **External Agents**, and choose **Add Agent → Add Custom Agent**. Zed opens your `settings.json` at the `agent_servers` key. Add an entry like this:

```json
{
  "agent_servers": {
    "My Deuz agent": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@deuz-sdk/cli", "acp", "/absolute/path/to/agent.js", "--budget-usd", "10", "--store", "~/.deuz/budget.sqlite"],
      "env": { "ANTHROPIC_API_KEY": "…" }
    }
  }
}
```

To start a thread with the agent, use the agent selector in the Agent Panel. If you installed the CLI globally, use `"command": "deuz"` with `"args": ["acp", …]`. The format comes from [Zed's external agents documentation](https://zed.dev/docs/ai/external-agents).

### Register it in a JetBrains IDE

In the AI Chat tool window, open the **⋯** menu and choose **Add Custom Agent**. The IDE creates and opens `~/.jetbrains/acp.json`. Each key under `agent_servers` is the name shown in AI Chat:

```json
{
  "default_mcp_settings": {},
  "agent_servers": {
    "My Deuz agent": {
      "command": "/full/path/to/npx",
      "args": ["-y", "@deuz-sdk/cli", "acp", "/absolute/path/to/agent.js", "--budget-usd", "10"],
      "env": { "ANTHROPIC_API_KEY": "…" }
    }
  }
}
```

JetBrains asks for the full path to the executable. Find it with `which npx`, or with `where npx` on Windows, or use the full path of a globally installed `deuz`. If the agent does not appear in AI Chat, check that `acp.json` is valid JSON and restart the IDE. ACP agents are not supported under WSL. The format comes from [JetBrains' ACP documentation](https://www.jetbrains.com/help/ai-assistant/acp.html).

On Windows, if an editor cannot start `npx` directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@deuz-sdk/cli", "acp", …]`.

### Limits

- ACP protocol version 1 is implemented: sessions, prompts, cancel, permissions, `session/load` (only when the module passes a `sessions` store), and the client's MCP servers. Terminals, session modes, and `session/list` / `session/close` are not implemented.
- The budget, receipts and signed-approval flag also travel in `_meta` fields under `io.github.deuz-ai`, which stock editors do not display. What an editor shows is the standard session cost and, with `--footer`, the reply line. How Zed and JetBrains render these has not been checked.
- An editor can approve any tool call it is shown. Signed approvals guarantee that the answer belongs to this run and this call; they do not decide what is allowed.
- No editor has launched `deuz acp` yet. The Zed and JetBrains configurations above follow those editors' documentation and have not been tried; the command is tested against an ACP client over in-memory streams.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | A runtime failure, for example a store that cannot be opened, a budget key conflict, or a bad agent module. |
| 2 | An unknown command, an unknown flag or a bad flag value. A one-line hint is printed on stderr. |
| *n* | Under `deuz meter -- <command>`, the command's own exit code: 127 if it cannot be found, 126 if it cannot be executed, 128 + the signal number if it was killed by a signal. |

## Programmatic use

```ts
import { runCli } from '@deuz-sdk/cli';

const code = await runCli(['meter', '--budget-usd', '5', '--', 'claude'], {
  // All optional; the process's own are the defaults.
  stdin, stdout, stderr, env, cwd, platform, signals,
  untilStopped: () => stopSignal, // for the long-running modes
});
```

`runCli` returns the exit code and never calls `process.exit`.

## License

MIT
