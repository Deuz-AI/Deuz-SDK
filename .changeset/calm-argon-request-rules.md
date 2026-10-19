---
'@deuz-sdk/core': patch
---

Use level-based thinking for `gemini-4-argon` on the native Gemini API and Vertex paths. Clamp unsupported effort levels with warnings, omit deprecated sampling settings with warnings, and reject explicit cached context rather than silently changing the prompt. Output budgets and timeouts are unchanged. This does not add an Argon catalog row, long-decode continuation, or partial function-argument streaming.
