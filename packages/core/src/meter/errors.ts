/**
 * deuz meter (2.5): its typed configuration error, and the error responses it
 * answers with, shaped like the upstream provider's own error JSON so a
 * harness shows them as it would show the provider's. Edge-safe.
 */
import type { MeterUpstreamKind } from './types';

/** `invalid_options`: options the meter cannot run with. `listen_failed`: the Node proxy could not bind its address. */
export type MeterErrorCode = 'invalid_options' | 'listen_failed';

/** Thrown by `createMeterHandler`, `declaredReceipt` and `createMeterProxy` (options, bind failures). */
export class MeterError extends Error {
  readonly name = 'MeterError';

  constructor(
    readonly code: MeterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** @internal Why the meter answered on its own. */
export type MeterReplyKind =
  | 'budget_exceeded'
  | 'unpriced_model'
  | 'unmetered_route'
  | 'request_too_large'
  | 'invalid_request'
  | 'upstream_unreachable'
  | 'budget_unavailable';

const STATUS: Record<MeterReplyKind, number> = {
  budget_exceeded: 402,
  unpriced_model: 402,
  unmetered_route: 404,
  request_too_large: 413,
  invalid_request: 400,
  upstream_unreachable: 502,
  budget_unavailable: 503,
};

// Anthropic's documented error types; 402 is its `billing_error`.
const ANTHROPIC_TYPE: Record<MeterReplyKind, string> = {
  budget_exceeded: 'billing_error',
  unpriced_model: 'billing_error',
  unmetered_route: 'not_found_error',
  request_too_large: 'request_too_large',
  invalid_request: 'invalid_request_error',
  upstream_unreachable: 'api_error',
  budget_unavailable: 'api_error',
};

// OpenAI's `{ error: { message, type, param, code } }`; `insufficient_quota`
// is the code clients already treat as "out of money, do not retry".
const OPENAI_TYPE: Record<MeterReplyKind, { type: string; code: string }> = {
  budget_exceeded: { type: 'insufficient_quota', code: 'insufficient_quota' },
  unpriced_model: { type: 'insufficient_quota', code: 'insufficient_quota' },
  unmetered_route: { type: 'invalid_request_error', code: 'unmetered_route' },
  request_too_large: { type: 'invalid_request_error', code: 'request_too_large' },
  invalid_request: { type: 'invalid_request_error', code: 'invalid_request' },
  upstream_unreachable: { type: 'server_error', code: 'upstream_unreachable' },
  budget_unavailable: { type: 'server_error', code: 'budget_unavailable' },
};

/** @internal A provider-shaped error response from the meter itself. */
export function meterReply(
  kind: MeterUpstreamKind,
  reason: MeterReplyKind,
  message: string,
): Response {
  const text = `deuz meter: ${message}`;
  const body =
    kind === 'anthropic'
      ? { type: 'error', error: { type: ANTHROPIC_TYPE[reason], message: text } }
      : {
          error: {
            message: text,
            type: OPENAI_TYPE[reason].type,
            param: null,
            code: OPENAI_TYPE[reason].code,
          },
        };
  return new Response(JSON.stringify(body), {
    status: STATUS[reason],
    headers: { 'content-type': 'application/json', 'x-deuz-meter': reason },
  });
}
