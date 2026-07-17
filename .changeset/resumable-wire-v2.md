---
'@deuz-sdk/core': minor
---

Resumable UI wire v2 (P1): every SSE event now carries a monotonic `id: <seq>` line, making Deuz streams droppable and resumable with standard `Last-Event-ID` semantics — with no vendor, no Redis requirement, and zero new dependencies.

- **`StreamStateStore`** — a two-method (`append`/`read`) persistence seam on `@deuz-sdk/core/ui`; pass `{ store, streamId }` to `toDeuzStreamResponse`/`toDeuzObjectStreamResponse` and every emitted event is journaled with its seq (ordered, best-effort — a failing store never kills the response). `createInMemoryStreamStateStore()` ships as the reference implementation; Redis/Supabase adapters are a few lines (see docs).
- **`resumeDeuzStreamResponse(store, streamId, { lastEventId })`** — server helper that replays from the client's `Last-Event-ID` and keeps tailing a still-live stream, so a refreshed tab reconnects mid-generation and **any number of clients can follow the same stream live**.
- **`connectDeuzStream(source)`** — fault-tolerant client reader: reconnects with `Last-Event-ID` after a drop, deduplicates replayed events by seq, and yields one gapless part sequence. Object streams (`useObject`) are covered too.
- **Version negotiation** — wire v2 is additive; v1 clients keep working untouched. An explicit `x-deuz-stream: v1` request header (via `negotiateDeuzStreamVersion(request)`) produces byte-identical pre-1.7 output.
- `parseSSE` now surfaces `id:` lines (sticky, spec-correct); `sseEvents` test helper accepts `id`.
