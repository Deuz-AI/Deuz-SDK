---
'@deuz-sdk/core': minor
---

Add an opt-in server-side onContinuationCheckpoint callback for completed native CONTINUATION or MAX_TOKENS hops. It receives the detached request body, opaque token, API version and hop usage without auth headers, and is awaited under the caller and total timeout signals. The token and request are never put on public stream parts. CONTINUATION now reports an explicit incomplete-output warning. Automatic continuation, in-flight checkpointing, cross-process recovery and the Vertex v1beta1 transport remain unimplemented; defaults do not make extra requests or raise budgets.
