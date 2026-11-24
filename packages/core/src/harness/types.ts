/**
 * harness/types.ts — the public types of running an external coding harness
 * (Claude Code, Codex CLI, Gemini CLI, OpenCode) as a budgeted Deuz sub-agent
 * (2.5). Edge-safe: types only.
 */
import type { ApprovalSigner } from '../durable';
import type { AcpClientConnection, AcpPermissionHandler, AcpToolCallState } from '../acp/client';
import type {
  AcpContentBlock,
  AcpMcpServer,
  AcpMeta,
  AcpPermissionOption,
  AcpPlanEntry,
  AcpRequestPermissionRequest,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolKind,
} from '../acp/types';
import type { MeterReceipt, MeterReceiptSink } from '../meter/types';
import type { Clock, PriceProvider } from '../types/deps';
import type { Message } from '../types/message';
import type { ToolCall } from '../types/tool';

// --- Presets ------------------------------------------------------------------

/**
 * How far a preset's facts were confirmed. `'documented'`: the harness's own
 * documentation (or its adapter's README) states it. `'partial'`: part of it is
 * documented and the rest follows from a documented mechanism or a third-party
 * source; read `notes`. `'unconfirmed'`: no official documentation was found.
 * `'unsupported'`: Deuz cannot do it for this harness (see `notes`).
 */
export type HarnessVerification = 'documented' | 'partial' | 'unconfirmed' | 'unsupported';

/**
 * How to start one known harness as an ACP agent and point its model traffic
 * at the meter. `verification` says how far each fact is confirmed, and
 * whether the preset was run against the real harness (`verifiedLive`).
 */
export interface HarnessPreset {
  /** Stable label: receipts carry it as `acp:<name>`, tool calls as `<name>.<kind>`. */
  readonly name: string;
  /** The executable, e.g. `npx` or `gemini`. */
  readonly command: string;
  readonly args: readonly string[];
  /**
   * The command is an npm `.cmd` launcher on Windows, so it needs a shell
   * there. `runHarness` sets `shell: true` on win32 when this is true and the
   * caller did not choose.
   */
  readonly windowsShell: boolean;
  /**
   * The API family the harness speaks to its model, which decides whether the
   * meter can measure it: `'none'` means its traffic cannot pass the meter
   * (Gemini's own API), so only declared cost is available.
   */
  readonly meterable: 'anthropic' | 'openai' | 'anthropic+openai' | 'none';
  /**
   * The environment that points the harness's model traffic at a meter
   * listening on `meterUrl` (`http://127.0.0.1:<port>`, no trailing slash).
   * Empty for a harness the meter cannot measure.
   */
  env(meterUrl: string): Record<string, string>;
  /**
   * Environment variables that switch the harness to another model provider,
   * so its traffic goes around the meter (Claude Code's
   * `CLAUDE_CODE_USE_BEDROCK`, for example). With a budget, `runHarness`
   * refuses to start while one of them is set to a true value, unless
   * `allowUnmetered`.
   */
  readonly unmeteredEnv?: readonly string[];
  /**
   * The ACP session mode `runHarness` switches every session to
   * (`session/set_mode`) before the prompt, so the harness asks before its
   * tool calls. The run fails when the harness refuses the switch.
   */
  readonly sessionMode?: string;
  /** `_meta` sent with `session/new`. */
  readonly sessionMeta?: AcpMeta;
  /** What was confirmed, and from where. */
  readonly verification: {
    /** The ACP entry point (`command` + `args`). */
    readonly acpEntryPoint: HarnessVerification;
    /** That the variables `env` sets reroute the harness's model traffic. */
    readonly baseUrl: HarnessVerification;
    /**
     * True when Deuz ran the preset against the real harness on `checkedAt`
     * (`notes` says with which versions and what held). A live run spends the
     * user's own money, so most presets are documentation only.
     */
    readonly verifiedLive: boolean;
    /** When the documentation was read, or the live run made (ISO date). */
    readonly checkedAt: string;
    readonly sources: readonly string[];
    readonly notes: string;
  };
}

/** A harness that is not a preset: what to start and which environment carries the meter URL. */
export interface HarnessSpec {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly windowsShell?: boolean;
  /** Default: `ANTHROPIC_BASE_URL=<meterUrl>` and `OPENAI_BASE_URL=<meterUrl>/v1`. */
  env?(meterUrl: string): Record<string, string>;
  /**
   * See {@link HarnessPreset.unmeteredEnv}. Default: Claude Code's provider
   * switches, since the default `env` targets Anthropic-shaped harnesses.
   */
  readonly unmeteredEnv?: readonly string[];
  /** See {@link HarnessPreset.sessionMode}. */
  readonly sessionMode?: string;
  /** See {@link HarnessPreset.sessionMeta}. */
  readonly sessionMeta?: AcpMeta;
}

// --- Permissions --------------------------------------------------------------

/** What Deuz answered to one permission request. */
export type HarnessDecision = 'allow' | 'deny';

/**
 * One rule of a {@link HarnessPermissionPolicy}. A rule matches a request when
 * its `kinds` (if any) include the tool call's kind (`'other'` when the
 * harness sent none) and its `paths` (if any) match the call's locations:
 * an `allow` rule needs EVERY location to match one glob (and at least one
 * location), a `deny` rule needs ANY location to match. A relative glob is
 * resolved against the session's `cwd`, so `'**'` means "inside the
 * workspace". Globs: `**` any depth, `*` within a segment, `?` one character;
 * `\` is read as `/`, and `.`/`..` segments of a path are resolved first.
 * Case is ignored for Windows drive paths, and by a `deny` rule for every path.
 */
export interface HarnessPermissionRule {
  readonly decision: HarnessDecision;
  readonly kinds?: AcpToolKind | readonly AcpToolKind[];
  readonly paths?: readonly string[];
  /** A label recorded on the decisions this rule makes. */
  readonly name?: string;
}

/**
 * Allow or deny a harness's permission requests by tool kind and path. Rules
 * are tried in order and the first match decides. `default` decides when no
 * rule matches: `'ask'` (the default) hands the request on to the callback
 * and then the approver.
 */
export interface HarnessPermissionPolicy {
  readonly rules?: readonly HarnessPermissionRule[];
  readonly default?: HarnessDecision | 'ask';
}

/** A permission request as Deuz decides it: the ACP request plus what the harness reported about the call. */
export interface HarnessPermissionRequest {
  readonly harness: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly title?: string;
  /** From the request, else from the call's earlier `tool_call` update; `undefined` when the harness sent none. */
  readonly kind?: AcpToolKind;
  /** The call's locations, as the harness sent them. */
  readonly paths: readonly string[];
  /**
   * Each of `paths` with symlinks, junctions and Windows short (8.3) names
   * resolved to the real path, or `null` where it could not be resolved.
   * Present only when the run resolves paths (`resolvePath`).
   */
  readonly resolvedPaths?: readonly (string | null)[];
  /** The session's `cwd` resolved the same way; relative globs match `resolvedPaths` against it. */
  readonly resolvedCwd?: string;
  readonly rawInput?: unknown;
  readonly options: readonly AcpPermissionOption[];
  /** The ACP request as received. */
  readonly request: AcpRequestPermissionRequest;
}

/** A callback's verdict; `undefined` passes the request on to the approver. */
export type HarnessVerdict =
  | HarnessDecision
  | { readonly decision: HarnessDecision; readonly reason?: string }
  | undefined;

/** Who made a decision. */
export type HarnessDecider = 'policy' | 'callback' | 'approver' | 'fallback' | 'cancelled';

/** One permission request the harness sent and what Deuz answered. */
export interface HarnessDecisionRecord {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: AcpToolKind;
  readonly paths: readonly string[];
  /** See {@link HarnessPermissionRequest.resolvedPaths}. */
  readonly resolvedPaths?: readonly (string | null)[];
  readonly decision: HarnessDecision;
  readonly decidedBy: HarnessDecider;
  /** The policy rule's `name` (or `rules[<index>]`), when the policy decided. */
  readonly rule?: string;
  readonly reason?: string;
  /** The option sent back, or none when no option fit and the request was answered `cancelled`. */
  readonly optionId?: string;
  readonly at: number;
  /**
   * An HMAC token over this decision, from `signer` (in the tool form, the
   * parent run's `approvalSigner`): `signer.verify(token)` returns the
   * decision as a `ToolApprovalRequest` whose `input` holds
   * `{ decision, decidedBy, kind, paths }`. It attests that this host decided;
   * it is not a resumable approval.
   */
  readonly token?: string;
}

/** How permission requests are decided: policy, then callback, then approver, then `fallback`. */
export interface HarnessDecisionOptions {
  readonly policy?: HarnessPermissionPolicy;
  /** Asked when no policy rule matched (or `policy.default` is `'ask'`). */
  onPermission?(
    request: HarnessPermissionRequest,
    context: { signal: AbortSignal },
  ): HarnessVerdict | Promise<HarnessVerdict>;
  /**
   * Asked last, with the request as a `ToolCall` named `<harness>.<kind>` and
   * `args: { title, kind, paths, rawInput }`: the shape of a run's
   * server-mode `approveToolCall`, so a parent run's approver can be passed
   * straight in (the tool form does so by default). True allows.
   */
  approveToolCall?(call: ToolCall, context: { messages: Message[] }): boolean | Promise<boolean>;
  /** Decides when nobody else did. Default `'deny'`. */
  readonly fallback?: HarnessDecision;
  /** Signs each decision record (see {@link HarnessDecisionRecord.token}). */
  readonly signer?: ApprovalSigner;
  /** Bound into each signed decision as its `runId`. */
  readonly runId?: string;
}

// --- Measured cost link -------------------------------------------------------

/** What a meter measured for one harness run. */
export interface HarnessMeasured {
  /** Measured receipts, in delivery order; empty for a shared meter (`exact: false`). */
  readonly receipts: readonly MeterReceipt[];
  /** USD of the measured usage (priced models only). */
  readonly usd: number;
  /** What the budget was charged, estimates of unfinished requests included. */
  readonly chargedUsd: number;
  readonly tokens: number;
  /** Metered requests, refused ones included. */
  readonly requests: number;
  /** Requests the meter refused with 402 (budget ceiling or unpriced model). */
  readonly refused: number;
  /** The scope keys a refusal named. */
  readonly exhaustedKeys: readonly string[];
  /**
   * True when the meter served this run alone (its receipts are this run's).
   * False for a shared meter: the totals are the difference of its stats over
   * the run, which includes any other traffic it carried meanwhile.
   */
  readonly exact: boolean;
}

/** The seam between a harness run and the meter that measures it. */
export interface HarnessMeterLink {
  /** Called once, right before the prompt is sent. */
  start(): void;
  /** Called for every measured receipt as it lands, when the link can see receipts. */
  subscribe?(listener: (receipt: MeterReceipt) => void): () => void;
  /** Resolves once every request started so far is settled and its receipt delivered. */
  flush(): Promise<void>;
  read(): HarnessMeasured;
}

// --- Run ----------------------------------------------------------------------

/** Options of `runAcpHarness`: one prompt to a harness over any ACP connection. */
export interface RunAcpHarnessOptions extends HarnessDecisionOptions {
  /** The harness label (receipts: `acp:<name>`). */
  readonly name: string;
  /**
   * Open the connection, passing `hooks` into `connectAcpAgent` /
   * `spawnAcpAgent` options. Called once; the run closes the connection when
   * it ends unless `keepOpen`.
   */
  connect(hooks: {
    onPermissionRequest: AcpPermissionHandler;
    onSessionUpdate: (notification: AcpSessionNotification) => void;
    signal?: AbortSignal;
  }): Promise<AcpClientConnection>;
  readonly prompt: string | AcpContentBlock[];
  /** The session's working directory; relative policy globs resolve against it. */
  readonly cwd: string;
  readonly mcpServers?: AcpMcpServer[];
  /**
   * Resolve one absolute path (in `/` form) to its real path: symlinks,
   * junctions and Windows short (8.3) names resolved; `null` when it cannot
   * be. When given, the policy is evaluated on both the paths the harness
   * sent and their real paths: a deny on either form denies, and an allow
   * needs the real paths to be allowed. Without it (the default here, since
   * this function cannot touch a file system) the policy sees the paths as
   * given, so a link to a denied file can be allowed. `runHarness` passes a
   * Node resolver by default.
   */
  resolvePath?(path: string): Promise<string | null>;
  /**
   * Switch the new session to this ACP mode (`session/set_mode`) before the
   * prompt. The run rejects with an `AcpError` and sends no prompt when the
   * harness refuses. `runHarness` uses the preset's.
   */
  readonly sessionMode?: string;
  /** `_meta` sent with `session/new`. `runHarness` uses the preset's. */
  readonly sessionMeta?: AcpMeta;
  /**
   * Aborting cancels the turn (`session/cancel`); the result then has
   * `stopReason: 'cancelled'`. A harness that has not ended the turn 10 s
   * after the cancel (this one, or the budget's) is shut down: the connection
   * closes, a spawned harness is killed, and the run rejects with an
   * `AcpError` of kind `cancelled`.
   */
  readonly signal?: AbortSignal;
  onUpdate?(update: AcpSessionUpdate): void | Promise<void>;
  /** The meter that measures this run; omit when there is none. */
  readonly meter?: HarnessMeterLink;
  /**
   * At the first 402 for a budget ceiling: `'cancel'` (default) sends
   * `session/cancel` so the harness stops instead of retrying; `'continue'`
   * leaves the turn to the harness.
   */
  readonly onBudgetExhausted?: 'cancel' | 'continue';
  /** Where the declared receipts go (the measured ones go to the meter's own sinks). */
  readonly receipts?: MeterReceiptSink | readonly MeterReceiptSink[];
  /** Divergence thresholds; see {@link HarnessCostComparison}. */
  readonly divergence?: { readonly relative?: number; readonly absoluteUsd?: number };
  /** Keep the connection open after the run (the caller closes it). */
  readonly keepOpen?: boolean;
  readonly deps?: {
    readonly clock?: Clock;
    readonly generateId?: () => string;
    readonly priceProvider?: PriceProvider;
  };
}

/**
 * Measured against declared cost. `status`: `'consistent'` or `'diverged'`
 * when both exist; `'undeclared'` when the harness reported no USD cost;
 * `'unmeasured'` when no meter measured it; `'unavailable'` when neither.
 * They diverge when `|measured - declared|` exceeds both `absoluteUsd`
 * (default 0.001) and `relative` (default 0.1) of the larger one.
 */
export interface HarnessCostComparison {
  readonly status: 'consistent' | 'diverged' | 'undeclared' | 'unmeasured' | 'unavailable';
  readonly diverged: boolean;
  readonly measuredUsd?: number;
  readonly declaredUsd?: number;
  /** `measuredUsd - declaredUsd`, when both exist. */
  readonly deltaUsd?: number;
}

/**
 * Tool calls of the turn. A harness runs its tools itself and sends a
 * permission request only when IT chooses to; Deuz cannot stop a call it was
 * never asked about. `decided` counts the calls that went through a Deuz
 * decision, `observedOnly` the ones Deuz only saw reported (or not at all:
 * a harness that reports nothing is invisible here).
 */
export interface HarnessToolCallCounts {
  /** Distinct tool calls seen: reported in updates or asked about. */
  readonly observed: number;
  readonly decided: number;
  readonly allowed: number;
  readonly denied: number;
  readonly observedOnly: number;
}

/** What one harness prompt came to. */
export interface HarnessResult {
  readonly harness: string;
  readonly sessionId: string;
  /**
   * The session's mode at the end of the turn: the one the run set
   * (`sessionMode`), or the last one the harness reported in a
   * `current_mode_update`. Absent when neither happened. A value other than
   * the requested mode means the harness switched modes during the turn.
   */
  readonly sessionMode?: string;
  readonly stopReason: AcpStopReason;
  readonly text: string;
  readonly thought: string;
  readonly plan?: AcpPlanEntry[];
  readonly cost: {
    /** What the meter measured; absent when no meter took part. */
    readonly measured?: HarnessMeasured;
    /** What the harness reported over ACP (`usage_update.cost` growth over the turn). */
    readonly declared?: {
      readonly amount: number;
      readonly currency: string;
      readonly usd?: number;
    };
    readonly comparison: HarnessCostComparison;
  };
  /** Measured receipts, then the declared one (if the harness declared a cost). */
  readonly receipts: readonly MeterReceipt[];
  readonly budget: {
    /** The meter refused at least one request for a budget ceiling. */
    readonly exhausted: boolean;
    readonly refused: number;
    readonly exhaustedKeys: readonly string[];
  };
  readonly toolCalls: HarnessToolCallCounts;
  readonly decisions: readonly HarnessDecisionRecord[];
  /** Every tool call of the turn as the harness reported it. */
  readonly calls: readonly AcpToolCallState[];
  readonly startedAt: number;
  readonly durationMs: number;
}
