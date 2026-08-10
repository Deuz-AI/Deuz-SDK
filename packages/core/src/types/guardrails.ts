/**
 * types/guardrails.ts — the guardrail contract (2.0 additive).
 *
 * Three hooks around the agentic loop, each a plain function so the common case
 * is a one-liner and the built-ins (`promptInjectionGuardrail`,
 * `maxOutputLength` — `./guardrails`) are ordinary values:
 *
 * - `onInput`    runs ONCE at the start of a run, before any model call.
 * - `onToolCall` runs per tool call, BEFORE the approval gate.
 * - `onOutput`   runs at a natural completion, AFTER `doneWhen` + `verifyStep`.
 *
 * Every verdict is one of three actions — `pass` (or `undefined`, the same
 * thing), `block`, `rewrite` — so a guardrail can sanitize as well as refuse.
 * Rewrites CHAIN through the remaining guardrails of the same hook; the first
 * `block` short-circuits. A THROW propagates: a guardrail is caller code, and a
 * silently swallowed one would leave the caller believing a defense is armed
 * while it is inert — the worse failure mode for a safety control.
 *
 * All types are pure data/functions: no clock, no I/O, nothing to inject.
 */
import type { Message } from './message';
import type { ToolCall } from './tool';

/** What every guardrail hook sees. Hook-specific context extends this. */
export interface GuardrailBaseContext {
  /**
   * The call's opaque `runtimeContext` (2.0), forwarded untouched — the same
   * value tools, `prepareStep`, `verifyStep` and `doneWhen` receive, so a
   * guardrail can read the tenant/user/session a request belongs to without a
   * closure per call.
   */
  runtimeContext?: unknown;
  /** Effective model history at the moment the hook runs (immutable snapshot). */
  messages: Message[];
  /** Index of the step this hook is evaluating. Absent on the pre-run input hook. */
  stepIndex?: number;
  /** Sub-agent path of the evaluating loop (absent at the root). */
  agentPath?: string[];
}

/** Context for `onInput` — the run's starting history, before the first model call. */
export type InputGuardrailContext = GuardrailBaseContext;

/** Context for `onOutput` — adds the final text the loop is about to return. */
export interface OutputGuardrailContext extends GuardrailBaseContext {
  /** The model's final text for the completed step. */
  text: string;
}

/** Context for `onToolCall` — adds the accumulated, parsed call under review. */
export interface ToolCallGuardrailContext extends GuardrailBaseContext {
  /** The call as the model issued it (args already parsed). */
  toolCall: ToolCall;
}

/**
 * Input verdict. `block` ends the run BEFORE any model call
 * (`stoppedBy: 'guardrail:input'`, a graceful stop — not a throw);
 * `rewrite` replaces the history the run starts from.
 */
export type InputGuardrailResult =
  | { action: 'pass' }
  | { action: 'block'; reason?: string }
  | { action: 'rewrite'; messages: Message[] };

/**
 * Output verdict. `block` suppresses the model's text — `replacement` is
 * returned in its place when given (else the empty string); `rewrite` swaps in
 * sanitized text, and the appended assistant message is kept consistent with it
 * so persistence and `response.messages` never disagree with what the caller saw.
 */
export type OutputGuardrailResult =
  | { action: 'pass' }
  | { action: 'block'; reason?: string; replacement?: string }
  | { action: 'rewrite'; text: string };

/**
 * Tool-call verdict. `block` joins the loop's EXISTING denial machinery — the
 * call becomes an `is_error` `tool_result` the model can react to, and (like an
 * approval denial) it does not count toward the runaway-error guard;
 * `rewrite` substitutes the arguments passed to `execute`.
 */
export type ToolCallGuardrailResult =
  | { action: 'pass' }
  | { action: 'block'; reason?: string }
  | { action: 'rewrite'; args: unknown };

/**
 * A guardrail is a FUNCTION with an optional `name` — the name is what a
 * `guardrail` stream part and `providerMetadata.deuz.guardrails` report, so a
 * UI can say WHICH rule fired. Returning `undefined` means pass.
 */
export type InputGuardrail = { name?: string } & ((
  ctx: InputGuardrailContext,
) => InputGuardrailResult | undefined | Promise<InputGuardrailResult | undefined>);

export type OutputGuardrail = { name?: string } & ((
  ctx: OutputGuardrailContext,
) => OutputGuardrailResult | undefined | Promise<OutputGuardrailResult | undefined>);

export type ToolCallGuardrail = { name?: string } & ((
  ctx: ToolCallGuardrailContext,
) => ToolCallGuardrailResult | undefined | Promise<ToolCallGuardrailResult | undefined>);

/**
 * The `guardrails` option of a call. Each hook takes one guardrail or an
 * ordered array; within a hook they run in array order, rewrites chaining and
 * the first block short-circuiting.
 */
export interface Guardrails {
  onInput?: InputGuardrail | InputGuardrail[];
  onOutput?: OutputGuardrail | OutputGuardrail[];
  onToolCall?: ToolCallGuardrail | ToolCallGuardrail[];
}
