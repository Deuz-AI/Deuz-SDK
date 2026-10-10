import type { DeuzError } from '../errors';
import type { ModelSurface } from '../types/model';
import type { BatchCallContext } from './http';
import type { PreparedRequest } from './prepare';
import type { BatchJob, BatchProtocol, BatchState, BatchStatus } from './types';

/** What the provider said about one request of an ended batch. */
export type BatchOutcome =
  | { readonly id: string; readonly kind: 'reply'; readonly body: unknown }
  | {
      readonly id: string;
      readonly kind: 'error';
      readonly error: DeuzError;
      /** The HTTP status the provider gave the request, when it gave one. */
      readonly status?: number;
    }
  | { readonly id: string; readonly kind: 'cancelled' }
  | { readonly id: string; readonly kind: 'expired' };

/** A status read, with the provider's batch object that reading its results needs. */
export interface DriverStatus {
  readonly status: BatchStatus;
  readonly raw: unknown;
}

/** What a submission returns. */
export interface SubmittedBatch {
  readonly id: string;
  readonly expiresAt?: number;
  readonly endpoint?: BatchJob['endpoint'];
  readonly inputFileId?: string;
}

/**
 * A submission that failed. `mayExist` is false while nothing could have
 * created the batch (validation, an input upload); once the create call was
 * sent it is true, and the holds close by the create call's status: released
 * when the provider refused the request, kept as unknown otherwise.
 */
export class SubmitFailure extends Error {
  constructor(
    readonly error: unknown,
    readonly mayExist: boolean,
  ) {
    super('The batch could not be submitted.', { cause: error });
  }
}

/**
 * What an ended batch did with a request it reports no outcome for: never
 * attempted because the batch was cancelled or expired, never run because the
 * batch failed validation, or unknown.
 */
export type MissingOutcome = 'cancelled' | 'expired' | 'not-run' | 'unknown';

/** One provider batch API. */
export interface BatchDriver {
  readonly protocol: BatchProtocol;
  /** The most requests one batch takes, when the provider documents a limit. */
  readonly maxRequests?: number;
  /** Send the prepared requests as one batch; failures are a {@link SubmitFailure}. */
  submit(
    prepared: readonly PreparedRequest[],
    ctx: BatchCallContext,
    options: {
      readonly modelId: string;
      readonly surface: ModelSurface;
      readonly displayName?: string;
    },
  ): Promise<SubmittedBatch>;
  status(id: string, ctx: BatchCallContext): Promise<DriverStatus>;
  cancel(id: string, ctx: BatchCallContext): Promise<DriverStatus>;
  /** The outcomes an ended batch reports, in the provider's order. */
  outcomes(job: BatchJob, raw: unknown, ctx: BatchCallContext): AsyncIterable<BatchOutcome>;
  missing(state: BatchState): MissingOutcome;
}

/** Ended states: the provider has finished with every request. */
export const ENDED: ReadonlySet<BatchState> = new Set([
  'completed',
  'cancelled',
  'expired',
  'failed',
]);

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-negative safe integer, or `undefined`. */
export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** An RFC 3339 time as epoch milliseconds, or `undefined`. */
export const time = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Headers merged left to right; later wins, keys compared without case. */
export function mergeHeaders(
  ...sets: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const set of sets) {
    for (const [name, value] of Object.entries(set ?? {})) {
      const previous = names.get(name.toLowerCase());
      if (previous !== undefined) delete out[previous];
      names.set(name.toLowerCase(), name);
      out[name] = value;
    }
  }
  return out;
}
