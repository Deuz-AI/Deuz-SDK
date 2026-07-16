/**
 * Typed error taxonomy. Every error extends `DeuzError` (the abstract base
 * locked in Faz 0), so retry / router / breaker logic can branch on `code` and
 * `isRetryable`. Errors deliberately DO NOT carry raw request headers/bodies and
 * never put a raw `Request`/`Headers` in `cause` — that would leak the API key.
 */
const DEUZ_ERROR_BRAND = Symbol.for('@deuz-sdk/core/DeuzError');

export interface DeuzErrorJSON {
  name: string;
  code: string;
  message: string;
  details?: Record<string, string | number | boolean>;
}

export abstract class DeuzError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
    Object.defineProperty(this, DEUZ_ERROR_BRAND, { value: true });
  }

  /** Secret-safe, stable shape for logs and JSON transports. `cause` is intentionally excluded. */
  toJSON(): DeuzErrorJSON {
    const details: Record<string, string | number | boolean> = {};
    const safeFields = [
      'statusCode',
      'isRetryable',
      'retryAfterMs',
      'provider',
      'requestId',
      'upstreamType',
      'layer',
      'toolName',
      'toolCallId',
      'modelId',
      'capability',
      'runId',
      'mime',
    ] as const;
    const self = this as unknown as Record<string, unknown>;
    for (const field of safeFields) {
      const value = self[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        details[field] = value;
      }
    }
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  }
}

/** Works across duplicate package copies/realms where `instanceof` is not reliable. */
export function isDeuzError(value: unknown): value is DeuzError {
  if (value instanceof DeuzError) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[DEUZ_ERROR_BRAND] === true &&
    typeof candidate.name === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string'
  );
}

export class NotImplementedError extends DeuzError {
  readonly code = 'not_implemented';

  constructor(feature: string) {
    super(`'${feature}' is not implemented yet.`);
  }
}

export interface APICallErrorOptions {
  message: string;
  /** HTTP status code from the upstream provider. */
  statusCode: number;
  /** Whether a retry could plausibly succeed (drives resilience/router). */
  isRetryable: boolean;
  /** Parsed `Retry-After` (ms), if the provider sent one. */
  retryAfterMs?: number;
  /** Provider id ('anthropic' | 'openai' | 'xai' | 'google'). */
  provider?: string;
  /** Upstream request id (e.g. Anthropic `request-id`) for support tickets. */
  requestId?: string;
  /** Provider's raw error type/code string, normalized for logging. */
  upstreamType?: string;
  cause?: unknown;
}

/**
 * A non-2xx HTTP response from a provider. Base class for the specific status
 * errors below; adapters map each wire's error envelope onto one of these.
 */
export class APICallError extends DeuzError {
  readonly code: string = 'api_call_error';
  readonly statusCode: number;
  readonly isRetryable: boolean;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly requestId?: string;
  readonly upstreamType?: string;

  constructor(options: APICallErrorOptions) {
    super(options.message, { cause: options.cause });
    this.statusCode = options.statusCode;
    this.isRetryable = options.isRetryable;
    this.retryAfterMs = options.retryAfterMs;
    this.provider = options.provider;
    this.requestId = options.requestId;
    this.upstreamType = options.upstreamType;
  }
}

/** A transport/DNS/TLS failure before an HTTP response exists. */
export class NetworkError extends APICallError {
  override readonly code = 'network_error';
  constructor(options: Omit<APICallErrorOptions, 'statusCode' | 'isRetryable'>) {
    super({ ...options, statusCode: 0, isRetryable: true });
  }
}

type SubErrorOptions = Omit<APICallErrorOptions, 'isRetryable' | 'statusCode'> &
  Partial<Pick<APICallErrorOptions, 'isRetryable' | 'statusCode'>>;

/** HTTP 429 — rate limited. Retryable (separate from 529 overload). */
export class RateLimitError extends APICallError {
  override readonly code = 'rate_limit';
  constructor(options: SubErrorOptions) {
    super({
      ...options,
      statusCode: options.statusCode ?? 429,
      isRetryable: options.isRetryable ?? true,
    });
  }
}

/** HTTP 529 — provider overloaded. Retryable, but on a SEPARATE backoff counter. */
export class OverloadedError extends APICallError {
  override readonly code = 'overloaded';
  constructor(options: SubErrorOptions) {
    super({
      ...options,
      statusCode: options.statusCode ?? 529,
      isRetryable: options.isRetryable ?? true,
    });
  }
}

/** HTTP 401/403 — bad/insufficient credentials. Never retried. */
export class AuthenticationError extends APICallError {
  override readonly code = 'authentication';
  constructor(options: SubErrorOptions) {
    super({
      ...options,
      statusCode: options.statusCode ?? 401,
      isRetryable: options.isRetryable ?? false,
    });
  }
}

/** HTTP 400/422 — malformed request. Never retried. */
export class InvalidRequestError extends APICallError {
  override readonly code = 'invalid_request';
  constructor(options: SubErrorOptions) {
    super({
      ...options,
      statusCode: options.statusCode ?? 400,
      isRetryable: options.isRetryable ?? false,
    });
  }
}

/** HTTP 404 — model/route not found. Never retried. */
export class ModelNotFoundError extends APICallError {
  override readonly code = 'model_not_found';
  constructor(options: SubErrorOptions) {
    super({
      ...options,
      statusCode: options.statusCode ?? 404,
      isRetryable: options.isRetryable ?? false,
    });
  }
}

/** Context window exceeded (provider-specific code). Never retried. */
export class ContextOverflowError extends APICallError {
  override readonly code = 'context_overflow';
  constructor(options: SubErrorOptions) {
    super({
      ...options,
      statusCode: options.statusCode ?? 400,
      isRetryable: options.isRetryable ?? false,
    });
  }
}

/** A timeout (connect / ttft / total layer). Pre-first-byte timeouts may retry. */
export class TimeoutError extends DeuzError {
  readonly code = 'timeout';
  readonly layer: 'connect' | 'ttft' | 'total';
  constructor(
    layer: 'connect' | 'ttft' | 'total',
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? `Request timed out (${layer}).`, options);
    this.layer = layer;
  }
}

/** Caller-initiated cancellation. Never retried, never falls back. */
export class AbortError extends DeuzError {
  readonly code = 'aborted';
  constructor(message = 'The operation was aborted.', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** `generateObject` could not produce a valid object after repair. */
export class NoObjectGeneratedError extends DeuzError {
  readonly code = 'no_object_generated';
  /** The raw model text that failed to parse/validate (model output, not secret). */
  readonly text?: string;
  constructor(message: string, options?: { text?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.text = options?.text;
  }
}

/**
 * A model/provider does not support a requested capability (Faz 3) — e.g. xAI
 * has no embeddings endpoint. Thrown BEFORE any network call so a bad model is
 * never silently routed to the wrong base URL. Never retried.
 */
export class UnsupportedCapabilityError extends DeuzError {
  readonly code = 'unsupported_capability';
  readonly provider: string;
  readonly capability: string;
  readonly modelId?: string;
  constructor(options: {
    provider: string;
    capability: string;
    modelId?: string;
    message?: string;
  }) {
    super(
      options.message ??
        `Provider '${options.provider}' does not support '${options.capability}'${
          options.modelId ? ` (model '${options.modelId}')` : ''
        }.`,
    );
    this.provider = options.provider;
    this.capability = options.capability;
    this.modelId = options.modelId;
  }
}

/** A tool function threw while executing (Faz 2 tool loop). */
export class ToolExecutionError extends DeuzError {
  readonly code = 'tool_execution';
  readonly toolName: string;
  readonly toolCallId?: string;
  constructor(
    toolName: string,
    options?: { toolCallId?: string; message?: string; cause?: unknown },
  ) {
    super(options?.message ?? `Tool '${toolName}' threw during execution.`, {
      cause: options?.cause,
    });
    this.toolName = toolName;
    this.toolCallId = options?.toolCallId;
  }
}
