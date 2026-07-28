# Imports and package.json

## The rule that catches most mistakes

`@deuz-sdk/core` has **no barrel for feature modules**. The root export carries the call functions, the tool/part constructors, errors, stop conditions, middleware and pricing — everything else lives on its own subpath. Verify every import against `packages/core/package.json`'s `exports` before writing it.

```ts
// From the root '@deuz-sdk/core':
streamChat, generateText, generateObject, streamObject, embed, embedMany
tool, filePart, imagePart, getModelCapabilities, agentTool
stepCountIs, hasToolCall, totalTokensExceed, costExceeds, durationExceeds
createClient, resolveDependencies
wrapModel, logging, simpleCache, redactPII, promptInjectionGuard, withFallback
createPriceProvider, priceUsage, PRICES_2026
anthropicWebSearch, openaiWebSearch, googleSearch
DeuzError + the whole error hierarchy, and all types
```

Everything else needs a subpath:

| Need | Import from |
| --- | --- |
| UI wire (server + client) | `@deuz-sdk/core/ui` |
| chat engine, `validateChatRequest`, `ChatStore` | `@deuz-sdk/core/chat` |
| React hooks | `@deuz-sdk/react` (the package; `@deuz-sdk/core/react` is frozen) |
| `createAgent` | `@deuz-sdk/core/agent` |
| a provider | `@deuz-sdk/core/anthropic` · `/openai` · `/xai` · `/google` · `/vertex` · `/azure` · `/bedrock` · `/voyage` · `/yunwu` · `/providers` |
| middleware (also on root) | `@deuz-sdk/core/middleware` |
| MCP | `@deuz-sdk/core/mcp` (http/sse) · `/mcp/stdio` (Node) |
| durable runs, approval signing | `@deuz-sdk/core/durable` |
| observation | `@deuz-sdk/core/observe` · `/observe/node` |
| testing helpers | `@deuz-sdk/core/testing` |
| images | `@deuz-sdk/core/image` · `/midjourney` |
| memory / RAG / skills | `@deuz-sdk/core/memory` · `/rag` · `/skills` (+ `/memory/markdown`, `/rag/node`, `/skills/node` for Node) |
| provably edge-safe subset | `@deuz-sdk/core/edge` |

## Import-by-import

| Before | After |
| --- | --- |
| `import { streamText, generateText } from 'ai'` | `import { streamChat, generateText } from '@deuz-sdk/core'` |
| `import { tool } from 'ai'` | `import { tool } from '@deuz-sdk/core'` |
| `import { Output } from 'ai'` | `import { generateObject } from '@deuz-sdk/core'` |
| `import { isStepCount, hasToolCall } from 'ai'` | `import { stepCountIs, hasToolCall } from '@deuz-sdk/core'` |
| `import { ToolLoopAgent } from 'ai'` | `import { createAgent } from '@deuz-sdk/core/agent'` |
| `import { wrapLanguageModel } from 'ai'` | `import { wrapModel } from '@deuz-sdk/core'` |
| `import { createProviderRegistry } from 'ai'` | `import { createProviderRegistry } from '@deuz-sdk/core/providers'` |
| `import { createMCPClient } from 'ai'` | `import { createMcpClient } from '@deuz-sdk/core/mcp'` |
| `import { convertToModelMessages } from 'ai'` | delete it (see `rules/ui.md`) |
| `import { useChat, useObject } from '@ai-sdk/react'` | `import { useChat, useObject } from '@deuz-sdk/react'` |
| `import { MockLanguageModelV4 } from 'ai/test'` | `import { createMockModel } from '@deuz-sdk/core/testing'` |
| `import { anthropic } from '@ai-sdk/anthropic'` | `import { createAnthropic } from '@deuz-sdk/core/anthropic'` + pass `apiKey` |
| `import { openai } from '@ai-sdk/openai'` | `import { createOpenAI } from '@deuz-sdk/core/openai'` (or `createOpenAIResponses`) |
| `import { registerTelemetry } from 'ai'` + `@ai-sdk/otel` | no equivalent — `rules/telemetry.md` |

Note Deuz exports a lowercase no-key singleton per provider too (`anthropic`, `openai`, `google`, …) for use with `createClient({ apiKeys })` or `deps.keyProvider`. It is NOT the same as the AI SDK's env-reading singleton — it carries no key at all.

## package.json surgery

```jsonc
// remove
"ai": "…",
"@ai-sdk/anthropic": "…", "@ai-sdk/openai": "…", "@ai-sdk/react": "…", "@ai-sdk/otel": "…",

// add
"@deuz-sdk/core": "^1.9.0",
"@deuz-sdk/react": "^1.9.0",     // only if you use the hooks

// optional peers — install ONLY what you actually use
"zod": "…", "@standard-community/standard-json": "…",  // Standard Schema tool params + generateObject
"@modelcontextprotocol/sdk": "…",                       // MCP
"unpdf": "…", "mammoth": "…", "xlsx": "…"               // RAG PDF/DOCX/XLSX parsing (Node)
```

There is **one** provider package, not one per provider — every provider is a subpath. Raw JSON Schema needs no peer at all.

## Runtime shape

- **ESM + CJS.** Deuz ships both per subpath (AI SDK 7 is ESM-only), so a `require()` call site keeps working. Node >= 22 either way.
- **Edge.** Import from `@deuz-sdk/core/edge` for a build provably free of Node APIs. Avoid `*/node`, `/memory/markdown` and `/mcp/stdio` there.
- **`sideEffects: false`** and zero runtime deps, so tree-shaking is real.

## Keys

There is no env read inside the SDK. Precedence, highest first (the "G1" rule):

1. `deps.keyProvider` — `{ getKey(provider) }`, may be async/refreshing (use it for Vertex OAuth).
2. factory `apiKey` — `createOpenAI({ apiKey })`.
3. `createClient({ apiKeys: { openai: KEY } })` — lowest, and deliberately not wrapped as a keyProvider.

Otherwise the call throws `AuthenticationError`. A factory `fetch` wins over `deps.fetch`.

```ts
// Node / Next.js
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Cloudflare Worker — never process.env
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const openai = createOpenAI({ apiKey: env.OPENAI_KEY });
    // …
  },
};
```
