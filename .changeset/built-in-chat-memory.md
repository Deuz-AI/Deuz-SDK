---
'@deuz-sdk/core': minor
---

Built-in cross-session chat memory (D1) — `memory: { seams, scope }` on any call wires the existing mem0-style pipeline straight into the chat loop, with no third-party service:

- **Recall** — before the first model step, relevant memories for the latest user message are retrieved and spliced into the system context (topK/header configurable, `recall: false` to disable). Best-effort: a failing store degrades to a bare call.
- **Extract** — after the run completes, the extract→reconcile→apply pass runs WITHOUT blocking the response; `result.memory` resolves with the applied mutations (never rejects — await it on serverless). Suspended/errored turns skip extraction.
- Scope is mandatory (`{ userId, chatId, … }`, mem0 rule) and consistent with `ChatStore` records. Absent option = zero extra work and byte-identical behavior.
- AI SDK has no built-in memory (`@ai-sdk/memory` does not exist; their docs point to Mem0/Letta or "build your own") — Deuz ships the whole loop in-library.
- Deliberate gzip budget raise for the 1.7 loop feature set (core 31 kB → 34 kB, edge 28 kB → 31 kB), with static named imports keeping the memory pull tree-shaken to the three pipeline functions.
