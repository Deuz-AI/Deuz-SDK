---
'@deuz-sdk/core': patch
---

Refresh Gemini 3.8 Flash and add Gemini 4 Argon native model profiles from the official model cards. Distinguish documented single-stream output limits from omitted ordinary request caps and preserve explicit caller overrides. Bounded executions continue to reserve and send a cap, now using the documented limit; callers can pass a smaller maxOutputTokens. Long decode, timeouts, pricing and caller execution-budget limits are unchanged.
