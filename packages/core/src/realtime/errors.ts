import { DeuzError, type DeuzErrorJSON } from '../errors';

/**
 * What went wrong in a realtime session:
 *
 * - `connect-failed` — the socket could not be created (e.g. a browser asked to
 *   send an API key in a header).
 * - `connect-timeout` — the provider did not accept the session in time.
 * - `no-websocket` — the runtime has no global `WebSocket` and no
 *   `deps.webSocket` was given.
 * - `provider` — the provider reported an error event.
 * - `transport` — the socket reported a network failure.
 * - `closed` — the socket closed abnormally (`closeCode` says how).
 * - `not-connected` — a send on a session that is not open.
 * - `invalid-message` — a server frame that is not JSON.
 * - `tool` — `sendToolResult` for a call that is not waiting.
 */
export type RealtimeErrorKind =
  | 'connect-failed'
  | 'connect-timeout'
  | 'no-websocket'
  | 'provider'
  | 'transport'
  | 'closed'
  | 'not-connected'
  | 'invalid-message'
  | 'tool';

export interface RealtimeErrorOptions {
  kind: RealtimeErrorKind;
  message: string;
  provider?: string;
  /** The provider's own error code or type (`invalid_value`, …). */
  upstreamType?: string;
  /** The WebSocket close code, for `kind: 'closed'`. */
  closeCode?: number;
  cause?: unknown;
}

/** A realtime session failure. `kind` is the branch point; messages never carry credentials. */
export class RealtimeError extends DeuzError {
  readonly code = 'realtime_error';
  readonly kind: RealtimeErrorKind;
  readonly provider?: string;
  readonly upstreamType?: string;
  readonly closeCode?: number;

  constructor(options: RealtimeErrorOptions) {
    super(options.message, { cause: options.cause });
    this.kind = options.kind;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.upstreamType !== undefined) this.upstreamType = options.upstreamType;
    if (options.closeCode !== undefined) this.closeCode = options.closeCode;
  }

  override toJSON(): DeuzErrorJSON {
    const json = super.toJSON();
    return {
      ...json,
      details: {
        ...json.details,
        kind: this.kind,
        ...(this.closeCode !== undefined ? { closeCode: this.closeCode } : {}),
      },
    };
  }
}
