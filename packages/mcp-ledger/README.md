# @deuz-sdk/mcp-ledger

A ready-made [MCP](https://modelcontextprotocol.io) server that gives Claude Desktop, Cursor, Goose or any other MCP client three things from the [Deuz SDK](https://github.com/Deuz-AI/Deuz-SDK):

- **Memory** that persists between conversations, with revisions you can inspect and a real `forget`.
- **A spend budget**: a ledger of money and tokens spent against a ceiling over a rolling window.
- **A receipt log** of actions with effects outside the conversation (a sent email, a changed file, a purchase). The log is append-only and hash-chained, so later edits can be detected.

Everything is stored in SQLite files in one directory on your machine. You need no API key and no embedding model, and you write no code.

> **What the budget is and is not.** An MCP server only learns what the model chooses to tell it. The budget here is a **record the model reports to**, not an enforced ceiling: if the model never calls `budget_record_spend`, or spends anyway after `budget_status` says it will not fit, nothing stops it. To enforce a ceiling, the spending has to go through something the model cannot skip. That is what the Deuz meter proxy is for: it sits in front of the provider API.

## Install

The server runs with `npx`, so you only need Node.js 22.13 or later.

### Claude Desktop

Open *Settings → Developer → Edit Config* (`claude_desktop_config.json`) and add:

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

Restart Claude Desktop. The tools appear under the tools icon.

### Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "deuz-ledger": {
      "command": "npx",
      "args": ["-y", "@deuz-sdk/mcp-ledger", "--budget-usd", "20"]
    }
  }
}
```

For a separate memory per project, add `"--namespace", "my-project"` to `args`.

### Goose and other clients

Any client that launches stdio servers can use the command `npx -y @deuz-sdk/mcp-ledger`. Clients that connect over HTTP can use `npx -y @deuz-sdk/mcp-ledger --http`, which serves Streamable HTTP at `http://127.0.0.1:3741/mcp`.

On Windows, if the client cannot find `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@deuz-sdk/mcp-ledger"]`.

## Tools

| Tool | What it does |
| --- | --- |
| `memory_remember` | Saves one fact. If the same fact is already saved, it returns the saved one instead of adding a duplicate. |
| `memory_recall` | Searches saved memories by words. An empty query lists the most recent ones. |
| `memory_revise` | Corrects a memory. The old wording stays in its history. |
| `memory_forget` | Permanently deletes a memory and all its revisions. |
| `memory_history` | Lists every revision of one memory. |
| `budget_status` | Shows how much was spent and how much is left in the window. Pass an estimate to get `fits: true/false`. |
| `budget_record_spend` | Records money or tokens spent. It is always recorded, even past the ceiling. A repeated `id` is counted once. |
| `receipt_record` | Logs an action and its outcome: `succeeded`, `failed` or `unknown`. A repeated `id` is recorded once. |
| `receipt_list` | Reads the log, newest first, with filters. `verify: true` checks the whole hash chain. |

The server also sends the client short instructions on when to use each group of tools. Whether the model follows them depends on the model and the client.

## Options

Each flag has an environment variable, which is handy in a client's `env` block. A flag overrides its variable.

| Flag | Environment | Default |
| --- | --- | --- |
| `--data-dir <path>` | `DEUZ_LEDGER_DIR` | see below |
| `--budget-usd <n>` | `DEUZ_LEDGER_BUDGET_USD` | no ceiling |
| `--budget-tokens <n>` | `DEUZ_LEDGER_BUDGET_TOKENS` | no ceiling |
| `--window <spec>` | `DEUZ_LEDGER_WINDOW` | `month` |
| `--namespace <name>` | `DEUZ_LEDGER_NAMESPACE` | `default` |
| `--http [port]` | | stdio; HTTP port 3741 |
| `--help`, `--version` | | |

`--window` takes `day`, `week`, `month`, `lifetime`, or a count with a unit (`12h`, `7d`, `2w`). Windows are **rolling**: `month` means the last 30 days from now, not the calendar month. Spend is stored with one-hour precision, so the start of a window may count up to one extra hour. The window and the ceiling are applied when the status is read, so changing either never loses history.

The default data directory is:

- Windows: `%LOCALAPPDATA%\deuz\mcp-ledger`
- macOS: `~/Library/Application Support/deuz/mcp-ledger`
- Linux: `$XDG_DATA_HOME/deuz/mcp-ledger`, or `~/.local/share/deuz/mcp-ledger`

It holds `memory.sqlite`, `budget.sqlite` and `receipts.sqlite`. Several clients can share one directory at the same time. A namespace separates memory only; budget and receipts are shared by every namespace in a directory.

## Limits

- **The budget is advisory.** See the note at the top. `budget_status` always reports `"enforcement": "advisory"`.
- **Receipts record what the model reports.** A receipt says the model reported an action, not that the action happened. The hash chain detects edits made to the file afterwards. It cannot stop someone who can write the file from rebuilding the chain from the edited receipt on.
- **Memory search is by words.** It uses SQLite FTS5 (or `LIKE` on a Node whose SQLite lacks FTS5), with no embeddings. A search for "car" does not find "automobile".
- **Forget removes the memory from the database tables and the search index.** SQLite can keep deleted bytes in free pages until the file is vacuumed. If that matters, run `VACUUM` on `memory.sqlite` while the server is stopped.
- **HTTP mode has no authentication.** It listens on 127.0.0.1 only and refuses requests whose `Host` or browser `Origin` is not loopback. Any program running on the same machine can still call it.
- Memories written through the tools are labelled `inferred`, because the model wrote them. A memory a host wrote as `asserted` through the programmatic API cannot be revised through the tools, but it can be forgotten.

## Embedding the server

```ts
import { createMcpLedger } from '@deuz-sdk/mcp-ledger';
import { serveMcpStdio } from '@deuz-sdk/core/mcp/server/stdio';

const ledger = createMcpLedger({
  dataDir: '/var/lib/my-app/ledger',
  budget: { usd: 50, window: '7d' },
  namespace: 'team-a',
});

await serveMcpStdio(ledger.server); // or route HTTP requests to ledger.server.fetch
// ledger.memory, ledger.budget and ledger.receipts are also available to your own code.
// ledger.tools is the same tool set as a Deuz ToolSet, for your own agent loop.
```

`serveMcpLedgerHttp(ledger.server, { port })` starts the same loopback HTTP listener the CLI uses.

## License

MIT
