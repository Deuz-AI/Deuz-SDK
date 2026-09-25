---
'@deuz-sdk/core': minor
---

Swarms can grow at runtime. With `dynamic` limits, a finished task spawns more tasks — reducers through `context.spawn`, agent bindings from their validated output through `spawn(output)` — and the children commit atomically with the parent's terminal state, so a crash never duplicates or loses them. `onFailure` hooks commit compensation tasks with a failure, and `timeoutMs` fails an attempt that runs long as `SwarmTaskTimeout`. Dynamic runs are version 2 and need a store with the `'spawn'` capability; the memory and SQLite stores have it. The SQLite swarm store moves to schema 2 and upgrades a 2.1 file in place on first open.
