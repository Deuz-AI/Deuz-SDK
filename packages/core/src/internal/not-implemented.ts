/**
 * @internal What a 2.4 contract stub throws until its lane implements it (W0).
 * The W0 skeletons publish the final names and types of every 2.4 entry point
 * so the W1 lanes can build against them in parallel; a stub that is called
 * before its implementation lands fails loudly with this, never silently.
 * Nothing in a released build throws it. Edge-safe.
 */
import { DeuzError } from '../errors';

export class NotImplementedError extends DeuzError {
  readonly code = 'not_implemented';
  /** The entry point that was called, e.g. `'createMemorySession'`. */
  readonly feature: string;
  constructor(feature: string) {
    super(`${feature} is not implemented in this build.`);
    this.feature = feature;
  }
}

/** Throws `NotImplementedError` for `feature`. */
export function notImplemented(feature: string): never {
  throw new NotImplementedError(feature);
}
