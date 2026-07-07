/**
 * `./durable` — vendorless durable agent execution (1.5). A `SessionStore`
 * seam + step-boundary `AgentCheckpoint`s (saved by both agentic loops when a
 * call carries `session`), resume entry points that re-drive the existing
 * loops with the stored history + settle-on-resume mechanism, a binary-safe
 * JSON codec for persistent stores, and WebCrypto HMAC-SHA256 signed approval
 * tokens. Edge-safe: Web APIs only, all non-determinism injected.
 */
import type { Message } from './types/message';
import type { CommonCallOptions } from './types/config';
import type { GenerateTextResult, StreamChatResult } from './types/methods';
import type { AgentCheckpoint, SessionStore } from './types/session';
import type { ToolApprovalRequest } from './types/tool';
import type { Clock } from './types/deps';
import { DeuzError } from './errors';
import { runToolLoop } from './inference/tool-loop';
import { runStreamToolLoop } from './inference/stream-tool-loop';

export type { AgentCheckpoint, SessionStore, CheckpointStatus } from './types/session';

/** `resumeFromCheckpoint` was asked for a runId the store does not know. */
export class CheckpointNotFoundError extends DeuzError {
  readonly code = 'checkpoint_not_found';
  readonly runId: string;
  constructor(runId: string) {
    super(`No checkpoint found for runId '${runId}'.`);
    this.runId = runId;
  }
}

/** In-memory `SessionStore` (default for tests/dev; latest save wins per runId). */
export function createInMemorySessionStore(): SessionStore {
  const runs = new Map<string, AgentCheckpoint>();
  return {
    save(checkpoint) {
      runs.set(checkpoint.runId, checkpoint);
    },
    load(runId) {
      return runs.get(runId);
    },
    delete(runId) {
      runs.delete(runId);
    },
    list() {
      return [...runs.keys()];
    },
  };
}

// --- Serialization codec (binary-part-safe) ---------------------------------

const BYTES_TAG = '$deuzBytes';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Serialize a checkpoint to a JSON string. `Uint8Array` values anywhere in the
 * message tree (e.g. raw image parts) are tagged and base64-encoded so the
 * round-trip restores REAL `Uint8Array`s — plain `JSON.stringify` would decay
 * them into `{ "0": 1, "1": 2, … }` objects the adapters cannot send.
 * `$deuzBytes` is a reserved key: an exact `{ "$deuzBytes": "<base64>" }`
 * object inside user/tool data would round-trip as bytes.
 */
export function serializeCheckpoint(checkpoint: AgentCheckpoint): string {
  return JSON.stringify(checkpoint, function (this: unknown, key: string, value: unknown) {
    // Read the PRE-toJSON value off the holder: Node's Buffer is a Uint8Array
    // subclass whose own `toJSON` runs BEFORE any replacer sees the value, so
    // checking `value` alone would silently miss (and corrupt) Buffer parts.
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Uint8Array) return { [BYTES_TAG]: bytesToBase64(raw) };
    return value;
  });
}

/** Reverse of `serializeCheckpoint` — restores tagged `Uint8Array` values. */
export function deserializeCheckpoint(json: string): AgentCheckpoint {
  return JSON.parse(json, (_key, value: unknown) => {
    // Only the codec's own exact shape converts: a single-key object whose
    // value decodes as base64. Anything else — including tool payloads that
    // merely contain the reserved key with a garbled value — stays plain data
    // instead of corrupting the checkpoint or throwing out of resume.
    if (
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)[BYTES_TAG] === 'string'
    ) {
      try {
        return base64ToBytes((value as Record<string, string>)[BYTES_TAG]!);
      } catch {
        return value; // not our encoding — leave it as data
      }
    }
    return value;
  }) as AgentCheckpoint;
}

// --- Resume ------------------------------------------------------------------

/**
 * Options for a resume call: everything but `messages` (the checkpoint's
 * history IS the messages) and `session` (derived from `store` + `runId`).
 */
export type ResumeOptions = Omit<CommonCallOptions, 'messages' | 'session'>;

async function loadCheckpoint(store: SessionStore, runId: string): Promise<AgentCheckpoint> {
  const checkpoint = await store.load(runId);
  if (!checkpoint) throw new CheckpointNotFoundError(runId);
  return checkpoint;
}

function toResumeCall(checkpoint: AgentCheckpoint, store: SessionStore, options: ResumeOptions) {
  return {
    ...options,
    // The stored history is immutable — copy so the loop's rebasing never
    // shares an array with the stored snapshot.
    messages: [...checkpoint.messages] as Message[],
    session: { store, runId: checkpoint.runId },
    // Resuming WITHOUT verdicts must still answer the pending calls: an empty
    // array activates settle-on-resume, which default-DENIES gated calls
    // (safe side) instead of resending an unanswered tool_use to the provider.
    approvalResponses: options.approvalResponses ?? [],
  };
}

/**
 * Continue a checkpointed run (suspended on an approval / client tool, or
 * crashed mid-step) with the buffered loop. The existing settle-on-resume
 * mechanism answers the trailing pending tool_use ids from
 * `options.approvalResponses`; a mid-step crash re-runs the interrupted step
 * (the checkpoint is the last completed boundary — the honest recovery unit).
 * Usage and step indices continue cumulatively across legs.
 */
export async function resumeFromCheckpoint(
  store: SessionStore,
  runId: string,
  options: ResumeOptions,
): Promise<GenerateTextResult> {
  const checkpoint = await loadCheckpoint(store, runId);
  return runToolLoop(toResumeCall(checkpoint, store, options), {
    resumeFrom: { stepIndex: checkpoint.stepIndex, usage: checkpoint.usage },
  });
}

/**
 * Streaming twin of `resumeFromCheckpoint`. Returns synchronously (G2): the
 * checkpoint loads inside the lazy pump, and an unknown runId surfaces as an
 * `error` part + rejected `usage`/`finishReason` — never a synchronous throw.
 */
export function resumeStreamFromCheckpoint(
  store: SessionStore,
  runId: string,
  options: ResumeOptions,
): StreamChatResult {
  const result = runStreamToolLoop(
    {
      ...options,
      messages: [],
      session: { store, runId },
      // Same safe-side contract as `resumeFromCheckpoint`: no verdicts still
      // settles (default-deny) instead of leaving tool_use ids unanswered.
      approvalResponses: options.approvalResponses ?? [],
    },
    {
      resumeLoad: async () => {
        const checkpoint = await loadCheckpoint(store, runId);
        return {
          messages: [...checkpoint.messages] as Message[],
          resumeFrom: { stepIndex: checkpoint.stepIndex, usage: checkpoint.usage },
        };
      },
    },
  );
  return result;
}

// --- HMAC-signed approvals (WebCrypto, edge-safe) -----------------------------

/** The signed payload: the approval request + run binding + issue time. */
export interface SignedApprovalPayload extends ToolApprovalRequest {
  runId?: string;
  issuedAt: number;
}

export interface CreateApprovalSignerOptions {
  /** Shared HMAC secret (server-side only — never ship it to a client). */
  secret: string;
  /** Time source for `issuedAt` / `maxAgeMs` (injectable for determinism). Default: `Date.now`. */
  clock?: Clock;
}

export interface ApprovalSigner {
  /** Sign an approval request (+ optional run binding) into a `v1.<payload>.<mac>` token. */
  sign(request: ToolApprovalRequest, context?: { runId?: string }): Promise<string>;
  /**
   * Verify a token: returns the payload when the MAC matches (and the token is
   * younger than `maxAgeMs`, when given) — else `null`. Never throws on
   * malformed input: a forged/garbled token is a verdict of `null`, not a crash.
   */
  verify(token: string, options?: { maxAgeMs?: number }): Promise<SignedApprovalPayload | null>;
}

// Loop-based encoder (bytesToBase64) — an argument-spread String.fromCharCode
// overflows the call stack on ~100KB+ payloads (e.g. a write-file approval
// carrying the file body), and edge runtimes have even smaller stacks.
const b64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (text: string): Uint8Array => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
};

/**
 * HMAC-SHA256 approval signer over WebCrypto (`crypto.subtle` — edge-safe,
 * deterministic given the injected clock). Sign the pending approval on the
 * server before showing it to a user; verify the returned verdict on resume so
 * a forged or replayed `approvalId` cannot authorize a different tool call.
 * (`ToolApprovalRequest.approvalId` was kept distinct from `toolCallId` in 1.3
 * exactly for this scheme — the id contract is unchanged.)
 */
export function createApprovalSigner(options: CreateApprovalSignerOptions): ApprovalSigner {
  if (!options.secret) {
    // An empty HMAC secret is a security footgun AND rejects importKey — fail
    // loudly at construction instead of surfacing later inside sign/verify.
    throw new TypeError('createApprovalSigner: `secret` must be a non-empty string.');
  }
  const encoder = new TextEncoder();
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(options.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  // The key imports eagerly; without this no-op handler a rejecting importKey
  // would fire as an UNHANDLED rejection before sign/verify ever await it.
  void keyPromise.catch(() => undefined);
  const now = (): number =>
    options.clock ? options.clock.now() : /* default wall clock */ jsNow();

  return {
    async sign(request, context) {
      const payload: SignedApprovalPayload = {
        ...request,
        ...(context?.runId !== undefined ? { runId: context.runId } : {}),
        issuedAt: now(),
      };
      const body = b64url(encoder.encode(JSON.stringify(payload)));
      const key = await keyPromise;
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, encoder.encode(`v1.${body}`)),
      );
      return `v1.${body}.${b64url(mac)}`;
    },
    async verify(token, verifyOptions) {
      try {
        // Strict shape: exactly three segments. Trailing garbage must not
        // produce a second distinct string that verifies as the same approval.
        const segments = token.split('.');
        if (segments.length !== 3) return null;
        const [version, body, mac] = segments;
        if (version !== 'v1' || !body || !mac) return null;
        const key = await keyPromise;
        const ok = await crypto.subtle.verify(
          'HMAC',
          key,
          b64urlDecode(mac) as unknown as ArrayBuffer,
          encoder.encode(`v1.${body}`),
        );
        if (!ok) return null;
        const payload = JSON.parse(
          new TextDecoder().decode(b64urlDecode(body)),
        ) as SignedApprovalPayload;
        if (typeof payload.issuedAt !== 'number') return null;
        const maxAgeMs = verifyOptions?.maxAgeMs;
        if (maxAgeMs !== undefined && now() - payload.issuedAt >= maxAgeMs) return null;
        return payload;
      } catch {
        return null; // malformed base64/JSON — a bad token, not an exception
      }
    },
  };
}

// The one sanctioned wall-clock fallback in this module: used only when the
// caller injects no clock (mirrors resolve-deps' defaultClock exception).
// eslint-disable-next-line no-restricted-syntax -- default wall clock when no Clock is injected
const jsNow = (): number => Date.now();
