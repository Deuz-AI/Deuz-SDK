/**
 * Typed error taxonomy. Faz 0 ships only the base + the honest shell error.
 * The full taxonomy (APICallError, RateLimitError, OverloadedError,
 * AuthenticationError, InvalidRequestError, ModelNotFoundError,
 * ContextOverflowError, TimeoutError, AbortError, NoObjectGeneratedError,
 * ToolExecutionError) arrives in Faz 1.A — each extends DeuzError, which is
 * non-breaking.
 */
export abstract class DeuzError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotImplementedError extends DeuzError {
  readonly code = 'not_implemented';

  constructor(feature: string) {
    super(`'${feature}' is not implemented yet (Faz 0 shell).`);
  }
}
