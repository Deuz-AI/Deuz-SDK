---
'@deuz-sdk/core': minor
---

v1.6.0 — Observable Runtime

Deuz-native versioned observation event protocol (`ObserveEvent`, `schemaVersion: 1`): model, agent-step, tool, approval, checkpoint, compaction and sub-agent lifecycle events, injected through the new `Dependencies.observer` seam. Local-first observers (`@deuz-sdk/core/observe`: memory / callback / composite / filter + `summarizeRun`), Node JSONL persistence (`@deuz-sdk/core/observe/node`), deterministic per-run sampling, privacy-first content capture (everything off by default; captured payloads always pass a `[REDACTED]` redaction profile), and async cost enrichment via the existing `priceProvider` seam. Zero runtime dependencies; no hosted service; no OpenTelemetry dependency.

The legacy tracer seam is now driven by the same events through a bridge that COMPLETES the documented `invoke → step → execute_tool` span hierarchy (previously only flat per-model-call `invoke` spans fired). Span names and attribute keys are unchanged; agentic loops now produce one `invoke` with step/tool children instead of N flat invokes.

Behavior fix: a tool-call-first response now clears the TTFT timer (previously only text/reasoning deltas did — a tool-first stream could falsely trip the 60s ttft timeout) and counts as first content in `model.first-content`.

Observers can never affect a run (isolated, never awaited); with no observer the hot path pays a single boolean branch and draws no ids. Bundle budgets were raised once, with measurement: core 86000→100000 raw bytes (measured 97.7KB fully instrumented), edge 76000→90000.
