/**
 * `@deuz-sdk/core/a2a` (2.3): the Agent2Agent (A2A) protocol, v1.0.0.
 *
 * - `createA2AClient` talks to an A2A agent over the JSON-RPC or the
 *   HTTP+JSON binding.
 *
 * Edge-safe (Web APIs only), zero dependencies. NOT LIVE-VERIFIED against
 * third-party agents: the wire was derived from `@a2a-js/sdk` 1.3.0 and is
 * tested in-process against it, in both directions. gRPC and A2A 0.3 are not
 * supported.
 */
export { createA2AClient } from './client';
export { A2AError } from './errors';
export type { A2AErrorKind, A2AErrorOptions } from './errors';
export type { A2AErrorReason } from './protocol';
export type * from './types';
