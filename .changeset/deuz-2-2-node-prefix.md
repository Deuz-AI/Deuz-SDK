---
'@deuz-sdk/core': patch
---

SQLite stores that open a file path load `node:sqlite` again. The build no longer strips `node:` prefixes, which turned the lazy import into a lookup for a package named `sqlite`, and `verify:package` now fails any built file that loads a prefix-only built-in without it. The SQLite swarm store also waits for another process's write lock while it opens, and retries a failed open on the next call instead of caching the failure.
