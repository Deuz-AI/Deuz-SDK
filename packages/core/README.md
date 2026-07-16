# @deuz-sdk/core

Pure, web-first, multi-provider TypeScript AI SDK — Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex and OpenAI-compatible hosts, with zero runtime dependencies and a canonical streaming protocol of its own.

```bash
npm i @deuz-sdk/core
```

```ts
import { streamChat } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');
const result = streamChat({ model, messages: [{ role: 'user', content: 'Merhaba!' }] });
for await (const text of result.textStream) process.stdout.write(text);
```

- **Edge-safe core** — Web APIs only; everything stateful or non-deterministic is injected through one `Dependencies` seam.
- **Canonical stream** — every provider's SSE is normalized to one typed delta stream before anything else touches it; retries, timeouts, tool loops and the UI wire all build on it.
- **Agentic loop** — parallel tool execution, self-healing tool errors, durable checkpoints, HMAC-signed approvals, budget/stop conditions.
- **Batteries** — memory (mem0-style), RAG with hybrid retrieval, skills, MCP, structured output, middleware, pricing, observability.
- **React bindings** — [`@deuz-sdk/react`](https://www.npmjs.com/package/@deuz-sdk/react) (the `@deuz-sdk/core/react` subpath remains for compatibility).

Full documentation, architecture tour and provider matrix: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).
