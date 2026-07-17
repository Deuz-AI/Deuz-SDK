---
'@deuz-sdk/core': minor
---

Typed data parts, tool state machine, and built-in RAG citations on wire v2 (P3):

- **`createDeuzStream(result)`** — returns `{ response, writeData(name, payload), close() }`: the server injects typed `data-{name}` parts (chart payloads, progress markers, citations) into the SAME SSE response the model streams over — ordered, seq-numbered, journaled to the `StreamStateStore`, replayable like every other part.
- **Streaming validation (opt-in)** — declare `dataSchemas: { chart: mySchema }` (any Standard Schema: zod/valibot/arktype) and payloads are validated as they stream; invalid ones are dropped with a redacted `error` part while the stream keeps going. Vercel's `validateUIMessages` is a manual after-the-fact call — Deuz validates on the wire.
- **Tool state machine** — the streaming loop now emits a `tool-state` part at every lifecycle transition (`input-streaming → input-complete → awaiting-approval | executing → complete | error`), so UIs render live tool status without re-deriving it from part ordering.
- **Built-in citations** — `citationsFromHits(hits)` (`./rag`) maps retrieve/rerank results to canonical `citation` parts (`chunkIndex` stays aligned with `hybridRetrieve`'s stable `Chunk.index`).
- All three part families are v2-only: a negotiated-v1 client never sees them (byte-compat preserved).
