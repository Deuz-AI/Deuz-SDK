---
'@deuz-sdk/core': patch
---

SQLite stores that open a file path load `node:sqlite` again. The build no longer strips `node:` prefixes, which turned the lazy import into a lookup for a package named `sqlite`, and `verify:package` now fails any built file that loads a prefix-only built-in without it. Every SQLite store (memory and chat, swarm, ops, evolve, budget) now sets a busy handler before it switches a file to WAL, so it waits for another process's lock while opening instead of failing at once, and a failed open is retried on the next call instead of being cached. An injected handle that already has a busy timeout keeps it.
