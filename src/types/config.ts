import type { LanguageModel } from './model';
import type { Message } from './message';
import type { Dependencies, UsageMeta, FinishMeta } from './deps';
import type { Usage } from './usage';
import type {
  ToolSet,
  ToolChoice,
  StopCondition,
  StepResult,
  ToolCall,
  ToolApprovalResponse,
} from './tool';

/** Opaque model id; capability-aware refinement arrives with the registry (Faz 1.A). */
export type ModelId = string;

/**
 * Options common to every call. `signal` and `maxRetries` are locked NOW —
 * adding them later would be breaking even in 0.x. Sampling params are locked
 * too (full surface); adapters translate them to each wire in Faz 1.B.
 */
export interface CommonCallOptions {
  model: LanguageModel;
  messages: Message[];
  /** Cancellation — propagated to the underlying fetch. */
  signal?: AbortSignal;
  /** Per-request retry budget (pre-first-byte only). */
  maxRetries?: number;
  headers?: Record<string, string>;
  /** Per-call infrastructure seam overrides. */
  deps?: Dependencies;
  onUsage?: (usage: Usage, meta: UsageMeta) => void;
  onFinish?: (meta: FinishMeta) => void;

  // Sampling parameters (full lock).
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  /** Canonical reasoning effort; each adapter maps to its own unit.
   *  'xhigh' (Anthropic 4.7+/OpenAI) and 'max' (Anthropic 5.x) clamp down
   *  on wires that lack them. */
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Free-form text vs. JSON mode (structured output uses generateObject). */
  responseFormat?: 'text' | 'json';
  /**
   * Per-provider escape hatch, keyed by the model's `provider` name. Top-level
   * request-body fields the SDK does not model (e.g. `{ openai: { service_tier:
   * 'flex' } }`, `{ anthropic: { fallbacks: […] } }`, `{ google: { cachedContent } }`).
   * NOTE: the key is the PROVIDER, not the wire — `openai` covers both Chat
   * Completions and Responses calls; Claude-on-Vertex still reads `anthropic`.
   * Canonical fields the adapter sets always win; shallow, top-level only.
   */
  providerOptions?: {
    anthropic?: Record<string, unknown>;
    openai?: Record<string, unknown>;
    google?: Record<string, unknown>;
    xai?: Record<string, unknown>;
  } & Record<string, Record<string, unknown>>;
  /**
   * One-flag prompt caching. Currently effective ONLY on Anthropic (models with
   * the `caching` capability): sends the top-level automatic `cache_control`
   * field — the API places the breakpoint on the last cacheable block and moves
   * it forward as the conversation grows. `'auto-1h'` uses the 1-hour TTL.
   * Other providers cache implicitly and ignore this. Anthropic edge cases: if
   * the last block already carries an explicit `cache_control` with the SAME
   * TTL this is a no-op; with a DIFFERENT TTL the API returns 400 — don't mix
   * this flag with hand-written breakpoints via `providerOptions`.
   */
  promptCaching?: 'auto' | 'auto-1h';

  // --- Agentic tools (Faz 2; additive). Omitting `tools` = single-turn (today). ---
  tools?: ToolSet;
  toolChoice?: ToolChoice;
  /** Max model turns in the agentic loop. Default 1 (single-turn). */
  maxSteps?: number;
  /** Stop predicate(s), OR-ed with `maxSteps`. */
  stopWhen?: StopCondition | StopCondition[];
  /** Max parallel tool executions per step. Default 5. */
  maxToolConcurrency?: number;
  onStepFinish?: (step: StepResult) => void;
  /**
   * Server-mode approval: awaited for every call whose tool triggers
   * `needsApproval`. Return false (or throw) to deny — the call becomes an
   * is_error tool_result ('Tool call denied.') and the loop continues; denials
   * do NOT count toward the runaway error guard. When OMITTED, calls needing
   * approval break the loop instead (client mode): streaming emits a
   * `tool-approval-request` part per pending call, `generateText` returns them
   * in `pendingApprovals`.
   */
  approveToolCall?: (call: ToolCall, ctx: { messages: Message[] }) => boolean | Promise<boolean>;
  /**
   * Resume after a client-mode approval break: verdicts for the pending calls
   * of the trailing assistant turn. Approved calls execute, denied ones become
   * is_error results, and the loop continues. Pending calls with no matching
   * response are DENIED by default (safe side); unknown `approvalId`s are
   * ignored (replay-safe).
   */
  approvalResponses?: ToolApprovalResponse[];
}

/** Shared client configuration; pre-binds api keys + deps for the convenience client. */
export interface ClientConfig {
  apiKeys?: Partial<Record<'anthropic' | 'openai' | 'xai' | 'google', string>>;
  baseUrls?: Partial<Record<string, string>>;
  deps?: Dependencies;
}
