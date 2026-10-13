import { DeuzError, type DeuzErrorJSON } from '../errors';
import { REASON_WIRE, type A2AErrorReason } from './protocol';

/**
 * How an A2A call failed:
 *
 * - `protocol` — the agent answered with an A2A error; `reason` names it
 *   (`'TASK_NOT_FOUND'`, `'TASK_NOT_CANCELABLE'`, `'VERSION_NOT_SUPPORTED'`, …).
 *   This is also the kind an executor throws to answer a request with an error.
 * - `http` — a non-2xx response without an A2A error in it (a proxy, an auth
 *   layer); `statusCode` says which.
 * - `network` — the request never got a response (`fetch` threw).
 * - `invalid-response` — the response is not what the binding defines (not
 *   JSON, not JSON-RPC 2.0, the wrong request id, an unknown result shape).
 */
export type A2AErrorKind = 'protocol' | 'http' | 'network' | 'invalid-response';

export interface A2AErrorOptions {
  message: string;
  /** Default `'protocol'`. */
  kind?: A2AErrorKind;
  /**
   * The A2A reason. Default `'INTERNAL_ERROR'` for `protocol` errors. A
   * server may send a reason this module does not know; it is kept as sent.
   */
  reason?: A2AErrorReason | (string & {});
  /** The JSON-RPC error code. Default: the reason's code. */
  rpcCode?: number;
  /** The HTTP status of the response. */
  statusCode?: number;
  /** `google.rpc.ErrorInfo.metadata`. */
  metadata?: Record<string, string>;
  cause?: unknown;
}

/**
 * An A2A failure, on either side of the wire. The client throws it for every
 * failed call; an executor throws one with a `reason` to answer a request
 * with that A2A error. Only one the executor raises itself does that: an
 * `A2AError` a client call threw is another agent's answer, and fails the
 * task like any other error.
 */
export class A2AError extends DeuzError {
  readonly code = 'a2a_error';
  readonly kind: A2AErrorKind;
  /** Set for `protocol` errors. */
  readonly reason?: A2AErrorReason | (string & {});
  readonly rpcCode?: number;
  readonly statusCode?: number;
  readonly metadata?: Record<string, string>;

  constructor(options: A2AErrorOptions) {
    super(options.message, { cause: options.cause });
    this.kind = options.kind ?? 'protocol';
    const reason = options.reason ?? (this.kind === 'protocol' ? 'INTERNAL_ERROR' : undefined);
    if (reason !== undefined) this.reason = reason;
    const rpcCode =
      options.rpcCode ??
      (reason !== undefined ? REASON_WIRE[reason as A2AErrorReason]?.rpc : undefined);
    if (rpcCode !== undefined) this.rpcCode = rpcCode;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override toJSON(): DeuzErrorJSON {
    const json = super.toJSON();
    return {
      ...json,
      details: {
        ...json.details,
        kind: this.kind,
        ...(this.reason !== undefined ? { reason: this.reason } : {}),
        ...(this.rpcCode !== undefined ? { rpcCode: this.rpcCode } : {}),
      },
    };
  }
}

/** The errors `createA2AClient` decoded from another agent's answer (internal, not exported). */
const REMOTE = new WeakSet<A2AError>();

/** Brands an error decoded from another agent's answer. */
export function markRemote(error: A2AError): A2AError {
  REMOTE.add(error);
  return error;
}

/**
 * A `protocol` error raised in this process: the only kind a handler answers
 * a request with, so another agent's code, reason and metadata are never
 * sent on as this agent's own.
 */
export function isOwnProtocolError(error: unknown): error is A2AError {
  return error instanceof A2AError && error.kind === 'protocol' && !REMOTE.has(error);
}
