import packageJson from '../package.json' with { type: 'json' };

/** The version of `@deuz-sdk/cli`, as `deuz --version` prints it. */
export const CLI_VERSION: string = packageJson.version;

/** `deuz --help`. */
export const MAIN_HELP = `deuz ${CLI_VERSION}: the Deuz SDK command line

Usage: deuz <command> [options]

Commands:
  meter    Put a token/USD budget in front of a coding harness (Claude Code,
           Codex, any Anthropic or OpenAI client): a local proxy that answers
           402 at the ceiling and writes a receipt per request.
  acp      Serve a Deuz agent to an editor (Zed, JetBrains) over the Agent
           Client Protocol on stdio.

Options:
  -h, --help       Show help (also: deuz <command> --help)
  -v, --version    Show the version

Examples:
  deuz meter --budget-usd 5 -- claude
  deuz acp ./agent.js --budget-usd 10 --store ~/.deuz/budget.sqlite
`;

/** `deuz meter --help`. */
export const METER_HELP = `Usage:
  deuz meter [options]                  serve until Ctrl+C, log each request
  deuz meter [options] -- <command...>  run <command> through the meter

Starts a local budget proxy for Anthropic Messages and OpenAI Chat
Completions / Responses traffic. Each request is admitted against the budget
before it is forwarded, charged with the usage the provider reports, and
refused with 402 (in the provider's own error format) once the ceiling is
reached. With a command, the meter sets ANTHROPIC_BASE_URL, OPENAI_BASE_URL
and DEUZ_METER_URL for it, passes stdio through, prints a spend summary when it
exits, and exits with its exit code.

Budget:
  --budget-usd <n>          USD ceiling (alias --budget)
  --budget-tokens <n>       Token ceiling
  --window <spec>           lifetime (default), day, week, month (rolling 30d),
                            or a count with h, d or w (12h, 7d, 2w)
  --key <name>              Budget key (default deuz:meter, deuz:meter:<window>
                            for a windowed budget)
  --store <file>            SQLite file that keeps the budget across runs and
                            processes (default: in memory, for this run only)

Proxy:
  --port <n>                Port on 127.0.0.1 (default 8787; a free port when
                            running a command)
  --receipts <file>         Append one JSON receipt per request to this file
  --anthropic-upstream <url>  Default https://api.anthropic.com
  --openai-upstream <url>     Default https://api.openai.com
  --forward-unmetered       Forward billable routes the meter cannot price
                            (batches, embeddings...) uncharged instead of
                            refusing them with 404

  -h, --help                Show this help

Examples:
  deuz meter --budget-usd 5 -- claude
  deuz meter --budget-usd 20 --window day --store ~/.deuz/budget.sqlite -- codex
  deuz meter --budget-usd 5 --receipts meter.jsonl
`;

/** `deuz acp --help`. */
export const ACP_HELP = `Usage: deuz acp <module> [options] [-- <args for the module>]

Serves a Deuz agent over the Agent Client Protocol (version 1) on stdio, for
an editor to launch. <module> is a file path or a package name; its export
(default: the default export) is the options of serveAcpAgentStdio from
@deuz-sdk/core/acp/stdio, or a function returning them, called with
{ argv, cwd, env }. 'run' is required; 'agent' defaults to the native engine
and 'store' to an in-memory run store. stdout carries the protocol only:
every log line goes to stderr.

Options:
  --export <name>           The export to use (default: default)
  --footer                  Append a plain-text budget line to each reply
  --budget-usd <n>          USD ceiling for every turn (alias --budget)
  --budget-tokens <n>       Token ceiling
  --window <spec>           lifetime (default), day, week, month, 12h, 7d...
  --key <name>              Budget key (default deuz:acp, deuz:acp:<window>)
  --store <file>            SQLite file that keeps the budget across sessions
  -h, --help                Show this help

Example (Zed settings.json):
  "agent_servers": {
    "My Deuz agent": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@deuz-sdk/cli", "acp", "/abs/path/agent.js", "--budget-usd", "5"]
    }
  }
`;
