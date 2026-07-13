---
'@deuz-sdk/core': patch
---

Observability hardening — two security fixes plus small additive controls.

**Security fixes:**

- **Redaction final barrier.** The built-in observation redaction profile now also runs AFTER a custom `redact` hook (and after structural truncation), so a buggy or malicious redactor can no longer reintroduce secrets into events, and truncation can never split a secret into a decodable prefix. Hardened the JWT pattern to catch tokens embedded mid-string.
- **Composite observers: per-sink capture projection.** `composeObservers` children now each receive only what their OWN `capture` options allow — `captured*` fields are stripped, `error.message` is gated on that child's `capture.errorMessages`, and a child `redact` hook applies only to that child's view. *Behavior change:* a composed observer with no options no longer receives captured content from its siblings' opt-ins (it now matches a standalone observer's privacy defaults).

**Additive:**

- `result.observation?.settled` on `generateText` / `streamChat` / `embed` / `embedMany` results — await it before `observer.close()` to drain async `cost.calculated` enrichments.
- `createMemoryObserver({ maxBytes })` — total byte budget alongside `maxEvents`, evicting by the existing `overflow` strategy.
- `deps.tracerMode: 'legacy'` — opt back into the 1.5 flat span topology (one parent-less `invoke` per model call); default stays `'hierarchical'`.

**Notes:** `eventId` is now derived as `` `${executionId}:${sequence}` `` (one less id draw per event; the format was never part of the contract). Release workflow supports npm trusted publishing (OIDC) alongside `NPM_TOKEN`.
