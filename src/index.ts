/**
 * `@deuz/core` — pure, web-first, multi-provider AI SDK.
 * Public surface lock (1.0). Faz 0: types are final, methods are stubs that
 * throw NotImplementedError until Faz 1.
 */

// Canonical free functions.
export { streamChat, generateText, generateObject } from './generate';

// Optional convenience client + dependency resolution.
export { createClient, resolveDependencies } from './client';
export type { DeuzClient } from './client';

// Error taxonomy (base + Faz 0 stub; subclasses added in Faz 1.A, non-breaking).
export { DeuzError, NotImplementedError } from './errors';

// All canonical types (Message/Part/Usage/LanguageModel/CommonCallOptions/…).
export type * from './types';
