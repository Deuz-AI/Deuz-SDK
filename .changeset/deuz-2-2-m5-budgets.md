---
'@deuz-sdk/core': minor
---

Budgets can outlive a run. Execution contexts and ledgers take `admission: { store, scopes, warnAtPercent, onWarning }`: after local admission, every model call is admitted all-or-nothing by a shared `BudgetStore` against persistent scopes such as `user:42` or `org:acme`, with optional rolling windows. Swarms take the same `admission` option for every task's model calls. Settlement and release are mirrored, unknown usage keeps the hold, and requests are idempotent by request ID. Stores: `createInMemoryBudgetStore`, `createSqliteBudgetStore` (`BEGIN IMMEDIATE`) and `createPostgresBudgetStore` (one locking statement per change, database time for windows). Snapshots that record persistent scopes are version 2 and cannot be restored without the store.
