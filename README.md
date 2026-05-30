# @deuz/core

> Pure, web-first, multi-provider TypeScript AI SDK — Anthropic, OpenAI, xAI Grok, Google Gemini.

`@deuz/core` is a from-scratch alternative to the Vercel AI SDK, built for the Deuz platform and published for everyone. It is **pure**: no Supabase, no credit logic, no env reading. Everything stateful (HTTP, clock, logging, metering, circuit-breaker) is injected through a single `deps` seam, so the same core runs unchanged in Node, Deno, Bun, and Edge runtimes.

> **Status: Faz 0 (scaffold).** The public surface is locked, but the methods are honest stubs — calling `streamChat` / `generateText` / `generateObject` throws `NotImplementedError` until the inference pipeline lands in Faz 1.

## Install

```bash
npm install @deuz/core
```

Requires **Node ≥ 22**. `zod` and `@modelcontextprotocol/sdk` are optional peer dependencies (only needed for schema validation / MCP).

## Quickstart (canonical: free functions)

```ts
import { streamChat } from '@deuz/core';
import { createAnthropic } from '@deuz/core/anthropic';

// API keys are injected — core never reads process.env.
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const res = await streamChat({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Selam!' }],
  signal: controller.signal,
  maxRetries: 2,
  onUsage: (usage) => console.log(usage.inputTokens, usage.outputTokens),
});

for await (const chunk of res.textStream) process.stdout.write(chunk);
```

### Optional convenience client

Pre-bind shared `deps` / keys so you don't repeat them on every call:

```ts
import { createClient } from '@deuz/core';
import { anthropic } from '@deuz/core/anthropic';

const deuz = createClient({ deps: { onUsage, breakerStore } });
await deuz.streamChat({ model: anthropic('claude-opus-4-8'), messages });
```

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@deuz/core` | Free functions, `createClient`, types, errors |
| `@deuz/core/anthropic` | Anthropic Messages provider |
| `@deuz/core/openai` | OpenAI (Chat Completions + Responses) |
| `@deuz/core/xai` | xAI Grok (OpenAI-compatible) |
| `@deuz/core/google` | Google Gemini (compat now, native later) |
| `@deuz/core/mcp` | MCP client (HTTP / SSE, edge-safe) |
| `@deuz/core/mcp/stdio` | MCP stdio transport (Node-only) |
| `@deuz/core/edge` | Guaranteed edge-safe subset |
| `@deuz/core/react` | React hooks (planned) |

## Edge-safety

Core uses only Web APIs (`fetch`, Web Streams, `TextDecoder`, WebCrypto). `node:*` builtins, `Buffer`, and direct `process` access are forbidden by lint in `src/` (the only Node-only module is `@deuz/core/mcp/stdio`).

## License

[MIT](./LICENSE) © 2026 U-C4N
