---
'@deuz-sdk/core': minor
---

Real rerankers behind the `Reranker` seam: `createCohereReranker` (`./rag`, default `rerank-v4.0-pro`) and `createVoyageReranker` (`./voyage`, default `rerank-2.5`). They map provider indices back to the original chunks with the relevance score, follow the `deps.keyProvider` > `apiKey` and factory `fetch` > `deps.fetch` precedence, and raise the usual `DeuzError` classes. A fourth guardrail hook, `onToolResult`, runs after a tool returns and before the model sees its result (`pass`, `block` into an `is_error` result, or `rewrite`) in `generateText`, `streamChat` and native `runAgent`, where it guards the model-facing projection and leaves the receipt's raw result alone. Its verdicts report as `hook: 'tool-result'`, and `maxToolResultLength` ships on `./guardrails`. `fingerprintTools` and `detectToolDrift` on `./mcp` hash each tool's name, description and input schema (SHA-256) so a server that rewrites its tools after approval is caught.
