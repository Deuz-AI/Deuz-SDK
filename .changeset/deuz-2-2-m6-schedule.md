---
'@deuz-sdk/core': minor
---

New edge-safe `@deuz-sdk/core/schedule` subpath for starting work from time and webhooks. `parseCron` reads five-field UTC cron (lists, ranges, steps, names, macros, the day-of-month/day-of-week OR rule) with `nextOccurrence`, `previousOccurrence` and `occurrencesBetween`. `createScheduler` runs due occurrences from a host cron trigger (`tick`) or an injected clock (`start`), dedupes each `${id}@${at}` key through a pluggable `claim`, follows a `catchUp` policy (`'latest'`, `'all'`, `'none'`) after downtime, and reports run errors per occurrence instead of throwing. `verifyGitHubWebhook`, `verifySlackRequest` (with a replay window) and `verifyHmacSignature` check signatures with WebCrypto and a constant-time comparison, and `handleSignal` turns a verified request into one dispatch, answering 401, 200 for duplicates or 202.
