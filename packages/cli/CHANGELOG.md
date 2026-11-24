# @deuz-sdk/cli

## 2.5.0

### Minor Changes

- First release of the `deuz` command. `deuz meter --budget-usd 5 -- claude` runs a command behind the Deuz budget meter: it injects `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `DEUZ_METER_URL`, passes stdio through, exits with the child's code and prints a spend summary. It refuses to start the command (exit 2) when the environment already points `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` at another endpoint and no `--anthropic-upstream` or `--openai-upstream` flag says where that traffic goes, so a gateway key is never sent to the default provider. It also refuses (exit 2) while a Claude Code provider switch such as `CLAUDE_CODE_USE_BEDROCK` is on, naming the variable but never its value. Verified live on 2026-11-24 in front of Claude Code 2.1.331; `deuz acp` passed a conformance run against the official ACP SDK. Without a command, `deuz meter` serves the proxy on 127.0.0.1:8787, prints the environment lines for each harness and logs one line per request. `deuz acp ./agent.js` serves an agent module to ACP editors over stdio, with an optional cost footer. Both take a USD or token ceiling, a rolling window, a budget key and a SQLite store (`--store`, which needs Node 22.13 or later). `runCli(argv, io)` runs the same CLI in-process and returns the exit code.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @deuz-sdk/core@2.5.0
