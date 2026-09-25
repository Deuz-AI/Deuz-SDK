---
'@deuz-sdk/core': minor
---

Swarm accounting now grows with live work instead of history. A finished task's reservations fold into one ancestor aggregate (`BudgetLedger.compact`, ledger snapshot version 2), and a native run under a shared child context checkpoints only its own ledger slice. Event readers poll the optional `SwarmStore.head()` instead of reloading every task. Native tools can declare `replay: 'idempotent'` and read a stable `ctx.modelStep`. `timeout.chunkMs` fails a stream that stalls between parts with `TimeoutError` layer `'chunk'`.
