/**
 * Golden-replay helpers — the canonical implementations moved to `src/testing`
 * (the public `./testing` module, 1.6.0 M12). This file is a pure re-export
 * shim so every existing test keeps importing from './fixtures/sse' unchanged.
 */
export { sseResponse, sseEvents, mockFetch, mockFetchSequence } from '../../src/testing';
