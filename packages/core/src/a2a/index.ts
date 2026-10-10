/**
 * `@deuz-sdk/core/a2a` (2.3): the Agent2Agent (A2A) protocol, v1.0.0.
 *
 * - `fetchAgentCard` reads an agent's card; `createA2AClient` talks to the
 *   agent over the JSON-RPC or the HTTP+JSON binding.
 * - `createA2AHandler` serves an agent: `Request` in, `Response` out, with a
 *   task store (`createInMemoryA2ATaskStore` by default) and an executor that
 *   drives each task.
 *
 * Edge-safe (Web APIs only), zero dependencies. NOT LIVE-VERIFIED against
 * third-party agents: the wire was derived from `@a2a-js/sdk` 1.3.0 and is
 * tested in-process against it, in both directions. gRPC and A2A 0.3 are not
 * supported.
 */
export { createA2AClient, fetchAgentCard } from './client';
export { createA2AHandler } from './handler';
export { createInMemoryA2ATaskStore } from './task-store';
export { A2AError } from './errors';
export type { A2AErrorKind, A2AErrorOptions } from './errors';
export { a2aText } from './protocol';
export type { A2AErrorReason } from './protocol';
export type * from './types';
