/**
 * Edge-safe entry. Re-exports the Web-API-only subset (no node: imports) so
 * Next.js Edge / Cloudflare Workers / Deno can import a guaranteed-safe build.
 * Existence of this entry is itself the edge smoke test for the build.
 */
export { streamChat, generateText, generateObject } from './generate';
export { createClient, resolveDependencies } from './client';
export type { DeuzClient } from './client';
export { DeuzError, NotImplementedError } from './errors';
export type * from './types';
