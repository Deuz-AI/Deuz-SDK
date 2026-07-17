---
'@deuz-sdk/core': minor
---

Mid-conversation cross-provider failover (D6) — possible in-library ONLY because the whole history is canonical; the next provider receives the identical request the failed one got:

- **`fallbackModels: [model2, model3]`** on `streamChat`/`generateText` (or the composable **`withFallback`** middleware): when the primary fails BEFORE its first content byte — network error, timeout, 5xx/529 after retries, or an OPEN circuit breaker — the call hops to the next model. Streaming semantics stay strict: after the first content part, mid-stream errors remain final. The winner carries `providerMetadata.deuz.failedOver = { from, to, reason }`; `onFallback` gives telemetry per hop.
- **The circuit breaker is now real** — the long-dormant `deps.breakerStore` seam is wired into the inference pump: `BREAKER_THRESHOLD` consecutive provider-health failures per `provider:model` open it for `BREAKER_COOLDOWN_MS`; open = instant `BreakerOpenError` (new, exported) with zero network — which failover treats as an immediate hop signal. First byte resets it. Per-client store (G11) preserved.
- Deterministic acceptance goldens: provider-A 529 → provider-B completes with the same canonical history across DIFFERENT wires (Anthropic → OpenAI); breaker opens/fails fast/resets; post-first-content errors never hop. AI SDK tracks this as open feature request vercel/ai#9950 — automatic failover exists only in their hosted Gateway.
- Final deliberate 1.7 bundle ceilings (core 120 kB raw / 37 kB gzip, edge 110/34) — durable×resumable pulled the wire serializer into the edge surface by design.
