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
// TYPE-ONLY, and deliberately outward: `types/` already reaches into `../chat`,
// `../memory` and `../durable` above, so importing the capability row from the
// registry is consistent with the existing shape. `import type` is fully erased
// under `verbatimModuleSyntax`, so this adds NO runtime edge and NO cycle
// (`core/registry.ts` only imports `../types/model` + `../types/deps`).
import type { ModelCapabilities } from '../core/registry';

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
 * Context passed to `verifyStep` (1.8) when the agentic loop reaches a NATURAL
 * completion (the model produced final text with no pending tool calls).
 */
export interface VerifyStepContext {
  /** Index of the step that just completed. */
  stepIndex: number;
  /** 0-based verification attempt for this run (increments on each retry). */
  attempt: number;
  /** The model's final text for the completed step. */
  text: string;
  /** Effective model history at the completion boundary. */
  messages: Message[];
  /** Cumulative REAL usage so far (all steps, sub-agents included). */
  usage: Usage;
}

/**
 * A `verifyStep` verdict. `ok: true` accepts the answer; `ok: false` with
 * `retry !== false` feeds `feedback` back as a user turn and re-runs the loop
 * (bounded by `maxVerifyAttempts`). `retry: false` accepts an unverified answer
 * as-is (`providerMetadata.deuz.verified` is then `false`).
 */
export interface VerifyStepResult {
  ok: boolean;
  /** Fed back to the model as a user turn when the answer is rejected and a retry happens. */
  feedback?: string;
  /** Allow another attempt when `ok` is false. Default true (until `maxVerifyAttempts`). */
  retry?: boolean;
}

/**
 * Verifier hook (1.8): runs at every NATURAL completion of the agentic loop.
 * Return `undefined` to pass silently; a `VerifyStepResult` to accept or reject.
 * Rejections re-drive the loop with the feedback until `maxVerifyAttempts`.
 */
export type VerifyStep = (
  ctx: VerifyStepContext,
) => VerifyStepResult | undefined | Promise<VerifyStepResult | undefined>;

/**
 * Context passed to `doneWhen` (1.9, N2) at the SAME natural-completion boundary
 * `verifyStep` runs at (final text, no pending tool calls). Deliberately a
 * SUBSET of {@link VerifyStepContext}: it carries no `attempt`, because whether
 * the work is finished cannot depend on how many times the guard already
 * re-drove the loop.
 */
export interface DoneWhenContext {
  /** The model's final text for the completed step. */
  text: string;
  /** Effective model history at the completion boundary. */
  messages: Message[];
  /** Cumulative REAL usage so far (all steps, sub-agents included). */
  usage: Usage;
  /** Index of the step that just completed. */
  stepIndex: number;
}

/**
 * False-finish guard hook (1.9, N2). Return `false` to REJECT a natural
 * completion — the loop injects a short "keep working" user turn and re-drives.
 * See `doneWhen` on {@link CommonCallOptions} for the full contract.
 */
export type DoneWhen = (ctx: DoneWhenContext) => boolean | Promise<boolean>;

/**
 * Options common to every call. `signal` and `maxRetries` are locked NOW —
 * adding them later would be breaking even in 0.x. Sampling params are locked
 * too (full surface); adapters translate them to each wire in Faz 1.B.
 */
export interface CommonCallOptions {
  model: LanguageModel;
  messages: Message[];
  /**
   * Convenience for a single user turn (1.9 additive): `prompt: 'hi'` instead
   * of `messages: [{ role: 'user', content: 'hi' }]`. MUTUALLY EXCLUSIVE with
   * `messages` at runtime — supplying both is a caller error.
   *
   * NOTE on the surface: `messages` stays REQUIRED on this interface. Making it
   * optional here would be a locked-surface change (`test/surface.test-d.ts`
   * pins it, and every internal orchestrator reads `options.messages` without a
   * guard). The either/or is expressed in the CALL FUNCTIONS' overloads
   * (`src/generate.ts`), which accept `{ prompt }` XOR `{ messages }` and
   * normalize `prompt` into a one-element user turn before anything else runs.
   */
  prompt?: string;
  /**
   * System prompt (1.9 additive), kept STRUCTURALLY SEPARATE from the — possibly
   * untrusted — conversation history: it is prepended before `messages` rather
   * than being smuggled in as a history turn a prompt injection could imitate
   * or overwrite. Adapters place it on their wire's dedicated system channel.
   */
  instructions?: string;
  /** Cancellation — propagated to the underlying fetch. */
  signal?: AbortSignal;
  /**
   * Alias for {@link CommonCallOptions.signal}, purely for AI SDK migration
   * ergonomics (1.9 additive). If BOTH are set, `signal` wins.
   * @deprecated Use `signal`.
   */
  abortSignal?: AbortSignal;
  /** Per-request retry budget (pre-first-byte only). */
  maxRetries?: number;
  /**
   * Per-call timeout budget (1.9 additive). A bare `number` is shorthand for
   * `{ totalMs }`. The four layers are deliberately distinct scopes:
   *
   * - `ttftMs`  — PER MODEL CALL: time to the FIRST content byte. Cleared once
   *               a content delta arrives (a slow-but-alive stream is fine).
   * - `totalMs` — PER MODEL CALL: hard ceiling on that one whole response.
   * - `stepMs`  — ONE AGENTIC STEP end-to-end: the model call PLUS the tool
   *               executions that step triggered.
   * - `toolMs`  — ONE tool `execute` (per call, not per step). `Tool.timeoutMs`
   *               overrides it for an individual tool.
   *
   * Only the layers you set are overridden; the module defaults in
   * `src/core/timeout.ts` (`DEFAULT_TIMEOUTS`: ttft 60_000, total 300_000)
   * remain the fallback, and `stepMs`/`toolMs` are unbounded when unset.
   * Every timer is scheduled through `deps.clock` — never an ambient host timer
   * — so tests stay deterministic (edge-safe purity invariant).
   */
  timeout?: number | { totalMs?: number; ttftMs?: number; stepMs?: number; toolMs?: number };
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
  /**
   * Per-call override of the static registry row (1.9 additive), SHALLOW-MERGED
   * over the row `core/registry.ts` resolved for `model` — set only the fields
   * you know better.
   *
   * Why it exists: an unknown slug does not throw, it falls back to
   * `defaultRow(provider, surface)`, whose `maxOutput` is a deliberately
   * conservative 4_096. So a brand-new Together / Groq / OpenRouter slug is
   * SILENTLY TRUNCATED at 4096 output tokens; `reasoning: false` on the same
   * row also drops the canonical `effort`, and `structuredOutput: false` pushes
   * `generateObject` onto the 'tool' strategy. Passing
   * `capabilities: { maxOutput: 32_000, reasoning: true, structuredOutput: true }`
   * unblocks the model without waiting for a registry release.
   *
   * NOT a capability grant: `caps.tools` is not read by ANY adapter, so setting
   * it neither enables nor disables tool calling. This overrides what the SDK
   * BELIEVES about the model — it cannot change what the provider actually does.
   */
  capabilities?: Partial<ModelCapabilities>;

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
   * Verifier hook (1.8 additive): runs when the loop reaches a NATURAL
   * completion (final text, no pending tool calls). A rejection (`ok: false`)
   * injects `feedback` as a user turn and re-drives the loop — self-correcting
   * "verified generation" without an agent class. Streaming emits a `verify`
   * part per evaluation. Retries are bounded by `maxVerifyAttempts` (they are a
   * SEPARATE budget from `maxSteps`); the loop's `stopWhen`/`budget` still
   * apply. `providerMetadata.deuz.verified` records the final verdict.
   */
  verifyStep?: VerifyStep;
  /** Max verification attempts (initial + retries) before accepting as-is. Default 3. */
  maxVerifyAttempts?: number;
  /**
   * False-finish guard (1.9 additive, N2): consulted at every NATURAL completion
   * of the agentic loop — final text, no pending tool calls — i.e. exactly the
   * boundary `verifyStep` runs at. Return `false` to reject the finish: the loop
   * injects a short "the task is not finished" user turn and re-drives, so a
   * model that declares victory early keeps working instead of handing back
   * half-done work. In long-horizon agent evaluations that early declaration —
   * not bad reasoning — is the dominant failure, and `verifyStep` only catches it
   * if the caller writes a verifier; this is the primitive for "are we done?".
   *
   * ORDER — `doneWhen` is evaluated FIRST, and a rejection that re-drives
   * SHORT-CIRCUITS `verifyStep` for that round. It answers the narrower, cheaper
   * question (typically a local predicate over `text`/`messages`, no model call),
   * and there is nothing worth paying a verifier for in an answer the caller has
   * already called incomplete — the verdict would describe the wrong problem.
   * When `doneWhen` accepts, is absent, or has spent its budget, `verifyStep`
   * runs exactly as it did in 1.8.
   *
   * BUDGETS — re-drives are bounded by `falseFinishGuard`, a SEPARATE budget from
   * both `maxSteps` and `maxVerifyAttempts`; neither bleeds into the other.
   * `stopWhen`/`budget` keep bounding the run at the loop's regular step
   * boundaries (after tool execution), exactly as with a `verifyStep` retry.
   * When the budget is spent the answer is ACCEPTED as final and the run records
   * `providerMetadata.deuz.stoppedBy = 'false-finish'`; the streaming loop also
   * emits one `false-finish` part per rejection, before the terminal `finish`.
   *
   * A THROW PROPAGATES — it is caller code, like `prepareStep` and `verifyStep`
   * (all three hooks on this seam behave alike): buffered calls reject, streaming
   * surfaces an `error` part with rejected `usage`/`finishReason` (G2 — never a
   * synchronous throw). Degrading silently would leave the caller believing an
   * armed guard while it is a no-op, the worse failure for a reliability guard.
   *
   * Combining it with `createVerifier().asVerifyStep()` (`./autonomy`)? Pass that
   * verifier an explicit `goal`: a re-drive leaves the injected nudge as the
   * trailing user turn, which is not the task it should infer the goal from.
   */
  doneWhen?: DoneWhen;
  /**
   * Re-drive budget for `doneWhen` (1.9 additive). `true`/omitted = the default
   * TWO re-drives (at most three answers per run); `{ maxRetries: n }` sets it;
   * `false` — or `{ maxRetries: 0 }` — makes `doneWhen` OBSERVATION-ONLY: the
   * rejection is still reported (`false-finish` part + `stoppedBy` marker) but
   * the loop never re-drives. Mind the unit: `maxVerifyAttempts` counts ATTEMPTS
   * (initial + retries), this counts RETRIES. Inert on its own — the guard is
   * armed by `doneWhen`, and setting only this logs a warning. Counted per LEG
   * on a durable run (a resumed leg starts fresh), exactly like
   * `maxVerifyAttempts`.
   */
  falseFinishGuard?: boolean | { maxRetries?: number };
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
   * FULL raw immutable history into `chat.store` at terminal boundaries
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
  apiKeys?: Partial<
    Record<'anthropic' | 'openai' | 'xai' | 'google' | 'azure' | 'bedrock', string>
  >;
  baseUrls?: Partial<Record<string, string>>;
  deps?: Dependencies;
}
