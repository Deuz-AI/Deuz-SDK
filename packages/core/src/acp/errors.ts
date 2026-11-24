import { DeuzError, type DeuzErrorJSON } from '../errors';
import { ACP_ERROR_CODES } from './protocol';

/**
 * How an ACP call failed:
 *
 * - `rpc` — a JSON-RPC error: the peer answered a request with one (`rpcCode`
 *   and `data` are what it sent), or a handler throws one to answer with it.
 * - `closed` — the connection closed before the answer came, or a call was
 *   made on a closed connection.
 * - `cancelled` — the caller aborted the request (its `signal`); the peer was
 *   sent `$/cancel_request`.
 * - `protocol` — the peer broke the protocol: an answer that is not what the
 *   method defines, an unsupported protocol version.
 */
export type AcpErrorKind = 'rpc' | 'closed' | 'cancelled' | 'protocol';

export interface AcpErrorOptions {
  message: string;
  /** Default `'rpc'`. */
  kind?: AcpErrorKind;
  /** The JSON-RPC error code. Default `-32603` (internal error) for `rpc`. */
  rpcCode?: number;
  /** The JSON-RPC error's `data`. */
  data?: unknown;
  cause?: unknown;
}

/**
 * An ACP failure, on either side of the connection. Every client call rejects
 * with one; a request handler throws one with an `rpcCode` to answer with that
 * error (any other thrown error is answered as `-32603 Internal error`, its
 * message kept on this side). See {@link ACP_ERROR_CODES} for the codes.
 */
export class AcpError extends DeuzError {
  readonly code = 'acp_error';
  readonly kind: AcpErrorKind;
  readonly rpcCode?: number;
  readonly data?: unknown;

  constructor(options: AcpErrorOptions) {
    super(options.message, { cause: options.cause });
    this.kind = options.kind ?? 'rpc';
    const rpcCode =
      options.rpcCode ??
      (this.kind === 'rpc'
        ? ACP_ERROR_CODES.internalError
        : this.kind === 'cancelled'
          ? ACP_ERROR_CODES.requestCancelled
          : undefined);
    if (rpcCode !== undefined) this.rpcCode = rpcCode;
    if (options.data !== undefined) this.data = options.data;
  }

  override toJSON(): DeuzErrorJSON {
    const json = super.toJSON();
    return {
      ...json,
      details: {
        ...json.details,
        kind: this.kind,
        ...(this.rpcCode !== undefined ? { rpcCode: this.rpcCode } : {}),
      },
    };
  }
}

/** An `rpc` error with `-32602 Invalid params`. */
export function acpInvalidParams(message: string, data?: unknown): AcpError {
  return new AcpError({ message, rpcCode: ACP_ERROR_CODES.invalidParams, data });
}
