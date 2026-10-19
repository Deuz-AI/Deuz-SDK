import type { Usage } from './usage';

/** Private server-side material for a completed native generation hop, not a UI part. */
export interface GoogleContinuationCheckpoint {
  provider: string;
  modelId: string;
  /** Version used by the captured request; capture does not enable continuation on it. */
  apiVersion: 'v1beta' | 'v1';
  /** Exact JSON request body, detached from the request; contains private conversation data. */
  request: Record<string, unknown>;
  continuationToken: string;
  finishReason: 'CONTINUATION' | 'MAX_TOKENS';
  /** This hop only. No cumulative accounting or automatic retry is implied. */
  usage: Usage;
}

/**
 * Opt-in server-side storage hook. Keep this material out of logs and browser responses.
 * The callback is awaited before completion; its signal retains caller/total deadlines.
 * It is not a replay API and does not checkpoint in-flight content or execute another hop.
 */
export type GoogleContinuationHandler = (
  checkpoint: GoogleContinuationCheckpoint,
  signal: AbortSignal,
) => void | Promise<void>;
