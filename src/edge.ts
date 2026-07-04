/**
 * Edge-safe entry. Re-exports the Web-API-only subset (no node: imports) so
 * Next.js Edge / Cloudflare Workers / Deno can import a guaranteed-safe build.
 * Existence of this entry is itself the edge smoke test for the build.
 */
export { streamChat, generateText, generateObject, streamObject } from './generate';
export { stepCountIs, hasToolCall, totalTokensExceed, costExceeds } from './inference/stop';
export { anthropicWebSearch, openaiWebSearch, googleSearch } from './server-tools';
export { createClient, resolveDependencies } from './client';
export type { DeuzClient } from './client';
export { DeuzError, NotImplementedError, NoObjectGeneratedError } from './errors';
export type * from './types';
