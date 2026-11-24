# @deuz-sdk/mcp-ledger

## 2.5.0

### Minor Changes

- First release. `npx @deuz-sdk/mcp-ledger` is a ready-made MCP server (stdio, or loopback Streamable HTTP with `--http`) that gives any MCP client versioned memory (`memory_remember`, `memory_recall`, `memory_revise`, `memory_forget`, `memory_history`), a budget (`budget_status`, `budget_record_spend`) and a hash-chained receipt log (`receipt_record`, `receipt_list`). Everything is stored in SQLite files in one data directory (`--data-dir`, `DEUZ_LEDGER_DIR`, or a per-user default); it needs no model and no network. The budget is advisory: the server records and reports spend, but it cannot stop a client from spending. `createMcpLedger` embeds the same server in a host. Requires Node 22.13 or later (node:sqlite).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @deuz-sdk/core@2.5.0
