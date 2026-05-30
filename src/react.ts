import { NotImplementedError } from './errors';

/**
 * React bindings (`useChat` / `useObject`). Stub for the locked subpath export;
 * real hooks arrive around publish time (Faz 6), consuming the UI stream wire.
 */
export function createUseChat(): never {
  throw new NotImplementedError('react hooks');
}
