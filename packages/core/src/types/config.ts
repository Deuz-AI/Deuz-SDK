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
import type { DurableSessionOptions } from './session';
import type { ChatPersistOptions } from '../chat';
import type { MemoryCallOptions } from '../memory';
import type { ApprovalSigner } from '../durable';

/** Opaque model id; capability-aware refinement arrives with the registry (Faz 1.A). */
export type ModelId = string;

/**
 * Per-step overrides returned by `prepareStep`. Every field is optional —
 * omit (or return `undefined`) to keep the current settings. `messages`
 * becomes the base history for this and all FOLLOWING steps; system-prompt
 * edits go through it too (rewrite the system-role message) — there is no
 * separate system field on this surface.
 */
export type CompactionLayer = 'prune-tool-results' | 'prune-reasoning' | 'summarize';

/**
 * Automatic layered context compaction policy for the agentic loop. Layers run
 * cheapest-first when the estimated context fill crosses `threshold`; the
 * summarize layer costs one extra model call. See `compaction` on
 * {@link CommonCallOptions}.
 */
export interface CompactionPolicy {
  /** Context-fill ratio (estimate/contextWindow) that triggers compaction. Default 0.92. */
  threshold?: number;
  /** Most-recent assistant turns that are untouchable. Default 4. */
  keepRecentSteps?: number;
  /** Layers to apply, in order. Default all three, cheapest first. */
  layers?: CompactionLayer[];
  /** Model used for the summarize layer. Default: the loop's own model. */
  summarizeModel?: LanguageModel;
}

/** `'auto'` = all defaults. */
export type CompactionOption = 'auto' | CompactionPolicy;

export interface PrepareStepResult {
  /** Becomes the base history for this and all following steps. */
  messages?: Message[];
  /** Restrict which tools are sent to the model THIS step (names of `tools` keys). */
  activeTools?: string[];
  /** Override the tool choice for THIS step only. */
  toolChoice?: ToolChoice;
  /** Swap the model for THIS step only (per-step routing; return it every step to persist). */
  model?: LanguageModel;
}

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
  /**
   * Conversation budget guardrail (1.7 additive): hard-stop the agentic loop
   * once cumulative cost reaches `usd` (needs `deps.priceProvider`) or real
   * token usage reaches `tokens`. Sugar over `costExceeds`/`totalTokensExceed`
   * with `stoppedBy` markers `budget.usd`/`budget.tokens`; the streaming loop
   * additionally emits a typed `budget-exceeded` part before `finish`.
   * Evaluated at step boundaries — an in-flight step always completes first.
   */
  budget?: { usd?: number; tokens?: number };
  /** Max parallel tool executions per step. Default 5. */
  maxToolConcurrency?: number;
  onStepFinish?: (step: StepResult) => void;
  /**
   * Pre-step hook: runs before EVERY model call of the loop (after automatic
   * compaction, so it sees — and has the last word on — the compacted
   * history). Return per-step overrides or `undefined` to keep settings.
   * A thrown error fails the call (it is caller code — never swallowed).
   */
  prepareStep?: (ctx: {
    stepIndex: number;
    messages: Message[];
    /** Cumulative REAL usage so far (all prior steps, sub-agents included). */
    usage: Usage;
  }) => PrepareStepResult | undefined | Promise<PrepareStepResult | undefined>;
  /**
   * Static tool filter: only these `tools` keys are sent to the model (all
   * steps). Unknown names log a warning and are ignored. `prepareStep`'s
   * `activeTools` overrides this per step. Execution/validation of results
   * for already-issued calls is never affected.
   */
  activeTools?: string[];
  /**
   * Advanced: the sub-agent path of this loop (set by `agentTool`, e.g.
   * `['researcher']`). Flows into every tool's `ToolExecuteContext.agentPath`
   * and usage metering. Root loops omit it.
   */
  agentPath?: string[];
  /**
   * Opt-in automatic context compaction for the agentic loop: `'auto'` for
   * defaults (trigger at 92% fill; prune old tool results → prune old
   * reasoning → summarize the oldest slice) or a {@link CompactionPolicy}.
   * Pruning is free; summarize costs one extra model call (its usage counts
   * toward the result and budget stops). History stays immutable — compaction
   * builds new arrays and NEVER alters what `response.messages` returns.
   * Off by default.
   */
  compaction?: CompactionOption;
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
  /**
   * Durable execution (1.5 additive): checkpoint the agentic loop at every
   * step boundary into `session.store`, so a crashed / suspended run can be
   * continued with `resumeFromCheckpoint`. Only agentic calls (with `tools`)
   * checkpoint — a single-turn call has no step boundaries. Store failures
   * log `deps.logger.error` and never kill the run.
   */
  session?: DurableSessionOptions;
  /**
   * Chat persistence (1.7 additive, P2): when set, the call auto-persists the
   * FULL immutable history into `chat.store` at terminal boundaries
   * (completion, suspension, and mid-stream error) under `chat.chatId` +
   * mandatory `chat.scope`. Store failures log `deps.logger.error` and never
   * kill the run. Setting this routes even tool-less calls through the loop
   * (step parts appear on the stream) so every chat shape persists uniformly.
   */
  chat?: ChatPersistOptions;
  /**
   * Built-in chat memory (1.7 additive, D1): recall before the first model
   * call, extract after the run (non-blocking; `result.memory` resolves with
   * the mutations). Setting this routes even tool-less calls through the loop.
   * See {@link MemoryCallOptions}.
   */
  memory?: MemoryCallOptions;
  /**
   * Cross-provider fail-over (1.7 additive, D6): when the primary model fails
   * before its first content byte (network/5xx/timeout after retries, or an
   * OPEN circuit breaker), the call hops to the next model with the IDENTICAL
   * canonical history. The winner marks
   * `providerMetadata.deuz.failedOver = { from, to, reason }`. Sugar over the
   * `withFallback` middleware (`./middleware`) — same semantics.
   */
  fallbackModels?: LanguageModel[];
  /**
   * Cryptographic approval trail (1.7 additive, D4): when set, every
   * client-mode `tool-approval-request` (streaming part, `pendingApprovals`,
   * and durable checkpoints) carries an HMAC-signed `token` bound to the
   * request (+ `runId` on durable calls). On resume, an APPROVED verdict must
   * echo a verifying token — forged/missing/mismatched tokens are DENIED.
   * Build with `createApprovalSigner` (`./durable`); the secret never leaves
   * the server.
   */
  approvalSigner?: ApprovalSigner;
  /** Max accepted age for approval tokens on resume (ms; default: unlimited). */
  approvalMaxAgeMs?: number;
}

/** Shared client configuration; pre-binds api keys + deps for the convenience client. */
export interface ClientConfig {
  apiKeys?: Partial<Record<'anthropic' | 'openai' | 'xai' | 'google', string>>;
  baseUrls?: Partial<Record<string, string>>;
  deps?: Dependencies;
}
