---
'@deuz-sdk/core': patch
---

Repository restructured as an npm-workspaces monorepo: the package now lives in `packages/core` (published content unchanged — the pack file list is identical to 1.6.1) alongside a new `packages/react` skeleton for the upcoming `@deuz-sdk/react`. Tooling resolves hoisted dev CLIs; release pipeline publishes via `changeset publish`.
