/**
 * `@deuz-sdk/core/agent` (1.9, Sprint 4 · 4.1) — `createAgent`: define an agent
 * ONCE, as a reusable VALUE.
 *
 * `src/autonomy.ts:1-12` states the position this module does NOT overturn: "No
 * agent class and no new runtime: these build on `generateText` and the loop you
 * already have." What was missing was never a class — it was a value. Every call
 * site re-spread `{ model, instructions, tools, maxSteps, stopWhen, verifyStep,
 * approveToolCall, compaction, memory, … }` by hand, and they drifted.
 *
 * So this is a FREE-FUNCTION FACTORY returning a FROZEN PLAIN OBJECT of
 * closures, in the `createClient` idiom (`src/client.ts:36` freezes its config
 * the same way): no class, no `new`, no prototype, no inheritance — and no new
 * runtime. Every method is a one-line forward to the SAME free function you
 * would have called yourself: `agent.streamChat(o)` IS
 * `streamChat({ ...def, ...o })`. Nothing is orchestrated here, so every
 * invariant is inherited rather than re-implemented:
 *
 * - **G2** — `streamChat`/`streamObject` return SYNCHRONOUSLY and never throw;
 *   failures (including an invalid input shape) arrive as an `error` part with
 *   rejected `usage`/`finishReason`. NOTHING on those two paths is `async`.
 * - **G1** — keys/base URLs still resolve only in `internal/resolve-call.ts`;
 *   the def carries plain `CommonCallOptions` fields, no key handling of its own.
 * - The `prompt` XOR `messages` guard, the `instructions` fold and the per-call
 *   `capabilities` override all live at the CALL BOUNDARY (`src/generate.ts`).
 *   This module imports THAT barrel — never the `inference/*` implementations —
 *   so an agent call is canonicalized byte-for-byte like a hand-written one, and
 *   `agent.generateText({ prompt: 'hi' })` works with no help from here.
 *
 * ```ts
 * const support = createAgent({
 *   name: 'support',
 *   model: anthropic('claude-opus-4-8'),
 *   instructions: 'You are a terse support agent.',
 *   tools: { lookupOrder },
 *   maxSteps: 8,
 * });
 *
 * const res = support.streamChat({ prompt: 'where is order 12?' }); // sync (G2)
 * const strict = support.with({ temperature: 0 });                  // new agent
 * const asSubAgent = support.asTool();                              // via agentTool
 * ```
 *
 * ## The merge rule — ONE rule, no exceptions
 *
 * `{ ...def, ...options }`: a shallow, TOP-LEVEL spread. A key present in the
 * per-call options REPLACES the def's value WHOLE — including the four where a
 * reader might hope for something cleverer: `tools`, `providerOptions`, `deps`
 * and `stopWhen` arrays. An explicitly-`undefined` per-call value counts as
 * present and therefore UNSETS the def's field, which is how you make one
 * tool-less call with an otherwise-agentic agent (`{ tools: undefined }`).
 *
 * Why replace, and not a per-field deep merge:
 *
 * 1. Replace is strictly MORE EXPRESSIVE. `def` is public and frozen, so
 *    `deps: { ...agent.def.deps, observer }` opts INTO a merge whenever you want
 *    one — while a built-in merge can never be opted OUT of (you could not drop
 *    the def's `fetch` for a single call).
 * 2. It is the only rule that fits in one sentence. A rule you have to look up
 *    per field is not "predictable", and half-merging (deps yes, tools no) is
 *    exactly the drift this factory exists to remove.
 * 3. `createClient` merges `deps` one level because it pre-binds
 *    INFRASTRUCTURE — a shared circuit-breaker store must survive a per-call
 *    `deps` (G11). An agent def is a CALL TEMPLATE, not infrastructure, so it
 *    takes the plain spread.
 *
 * `with(overrides)` applies the same rule at definition time.
 *
 * Edge-safe: pure composition — no ambient clock, randomness or logging, and no
 * state on the object beyond the frozen def (deps come from the def or the call,
 * exactly as they do today).
 */
import { streamChat, generateText, generateObject, streamObject } from './generate';
import { agentTool } from './inference/agent-tool';
import type { CommonCallOptions } from './types/config';
import type { LanguageModel } from './types/model';
import type {
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamChatOptions,
  StreamChatResult,
  StreamObjectResult,
} from './types/methods';
import type { Tool } from './types/tool';

/**
 * A reusable agent definition: every `CommonCallOptions` field EXCEPT the three
 * that belong to a call rather than to an agent.
 *
 * `model` is re-declared as required. `messages`/`prompt` are omitted on purpose:
 * an agent is a template, not a conversation — the input arrives per call, which
 * is also what keeps `def` safely shareable across concurrent calls.
 */
export interface AgentDef extends Omit<CommonCallOptions, 'model' | 'messages' | 'prompt'> {
  /**
   * Label for observation/logging only. It never reaches a wire: it is stripped
   * from the forwarded call options, and its one functional use is
   * {@link DeuzAgent.asTool}, where it becomes the sub-agent's `agentPath`
   * segment (`agentTool`'s `name`).
   */
  readonly name?: string;
  model: LanguageModel;
}

/**
 * Per-call options for an agent method: any `CommonCallOptions` field, all
 * optional, shallow-spread OVER the def (see the module header).
 *
 * `prompt` and `messages` are both optional here, so `{ prompt: 'hi' }` and
 * `{ messages: [...] }` each typecheck — and the mutual exclusion stays a
 * RUNTIME check in `src/generate.ts`, exactly as it is for the free functions.
 * Mirroring their `PromptShorthand` overload would be dead weight: on a
 * `Partial<CommonCallOptions>` the canonical shape already accepts `{ prompt }`,
 * so a `messages?: never` overload could never be the one selected. One guard,
 * in one place.
 */
export type AgentCallOptions = Partial<CommonCallOptions>;

/** {@link AgentCallOptions} plus `generateObject`'s own fields (`schema` is required). */
export type AgentObjectCallOptions<T = unknown> = AgentCallOptions &
  Omit<GenerateObjectOptions<T>, keyof CommonCallOptions>;

/**
 * A frozen bundle of closures over one {@link AgentDef}. Deliberately NOT a
 * class: there is no `new`, no prototype and no inheritance — a variant is a new
 * frozen object from {@link DeuzAgent.with}, never a subclass.
 */
export interface DeuzAgent {
  /** The frozen definition. Spread it to opt into merging a field per call. */
  readonly def: Readonly<AgentDef>;
  generateText(options?: AgentCallOptions): Promise<GenerateTextResult>;
  /** SYNCHRONOUS (G2) — never `async`, never throws; failures ride `fullStream`. */
  streamChat(options?: AgentCallOptions): StreamChatResult;
  /**
   * Structured output from this agent's def.
   *
   * SHARP EDGE, inherited from the free function and NOT smoothed over here: a
   * structured-output call never enters the tool loop, so since 1.9 it REFUSES
   * the loop-only options instead of ignoring them in silence (`tools`,
   * `maxSteps > 1`, `stopWhen`, `verifyStep`, `memory`, `session`, … — see
   * `inference/object-shared.ts`). An agentic def therefore fails here by
   * design, and the merge rule is also the fix: an explicitly-`undefined`
   * per-call value UNSETS the def's field.
   *
   * ```ts
   * await support.generateObject({ schema, prompt, tools: undefined, maxSteps: undefined });
   * const extractor = support.with({ tools: undefined, maxSteps: undefined }); // or once, up front
   * ```
   *
   * Special-casing it here would mean silently dropping def fields on one method
   * only — a second merge rule, and the exact silence Sprint 1 removed.
   */
  generateObject<T = unknown>(options: AgentObjectCallOptions<T>): Promise<GenerateObjectResult<T>>;
  /** SYNCHRONOUS (G2), like the free `streamObject`. Same loop-option refusal as above. */
  streamObject<T = unknown>(options: AgentObjectCallOptions<T>): StreamObjectResult<T>;
  /**
   * This agent as a tool the parent loop can call — a sub-agent, built by the
   * EXISTING `agentTool` (`inference/agent-tool.ts`), which stays the single
   * implementation of sub-agent delegation.
   *
   * Only the def fields `AgentToolDef` can express cross the boundary: `model`,
   * `tools`, `instructions` (→ `system`), `maxSteps`, `stopWhen`, `compaction`
   * and `name`. Everything else on the def (sampling params, `verifyStep`,
   * `deps`, `timeout`, `memory`, …) is NOT forwarded — the sub-agent reuses the
   * PARENT's transport and approval flow by design. Omitted fields keep
   * `agentTool`'s own defaults (`maxSteps` 10, `maxDepth` 2).
   */
  asTool(options?: { name?: string; description?: string }): Tool;
  /**
   * Derive a variant: a NEW frozen agent from `{ ...def, ...overrides }`. The
   * original is untouched — nothing here mutates.
   */
  with(overrides: Partial<AgentDef>): DeuzAgent;
}

/**
 * Bundle an {@link AgentDef} into a frozen {@link DeuzAgent}.
 *
 * The def is COPIED before freezing (`createClient` does the same): the caller's
 * object stays mutable — freezing an argument is a surprising side effect — and
 * mutating it afterwards cannot change the agent's behaviour. `Object.freeze` is
 * shallow, again matching `createClient`: `def.tools` and `def.deps` are the
 * caller's own objects, not deep-frozen clones.
 */
export function createAgent(def: AgentDef): DeuzAgent {
  const frozen: Readonly<AgentDef> = Object.freeze({ ...def });

  /**
   * The merge rule, in one place: shallow spread, then drop the label. `name` is
   * not a `CommonCallOptions` field, so it must not travel into a call — the
   * `delete`-on-a-fresh-copy idiom is the same one `generate.ts` uses to strip
   * `prompt`/`instructions` once folded.
   */
  const toCall = <O extends CommonCallOptions>(options: Partial<O> | undefined): O => {
    const merged = { ...frozen, ...options } as unknown as O & { name?: string };
    delete merged.name;
    return merged;
  };

  return Object.freeze({
    def: frozen,
    generateText: (options?: AgentCallOptions) =>
      generateText(toCall<GenerateTextOptions>(options)),
    // NOT async, and no `await` anywhere on the way in or out: the free function
    // returns its `StreamChatResult` synchronously and reports failures on it
    // (G2). Wrapping it in a promise here would break every caller that reads
    // `runId` synchronously — and would swallow the error part.
    streamChat: (options?: AgentCallOptions) => streamChat(toCall<StreamChatOptions>(options)),
    generateObject: <T = unknown>(options: AgentObjectCallOptions<T>) =>
      generateObject(toCall<GenerateObjectOptions<T>>(options)),
    streamObject: <T = unknown>(options: AgentObjectCallOptions<T>) =>
      streamObject(toCall<GenerateObjectOptions<T>>(options)),
    asTool: (options?: { name?: string; description?: string }): Tool => {
      const name = options?.name ?? frozen.name ?? 'agent';
      // Conditional spreads, never explicit `undefined`: that is what lets
      // `agentTool` apply its OWN defaults (maxSteps 10, maxDepth 2) untouched.
      return agentTool({
        name,
        description: options?.description ?? `Delegate a task to the '${name}' agent.`,
        model: frozen.model,
        ...(frozen.tools ? { tools: frozen.tools } : {}),
        ...(frozen.instructions !== undefined ? { system: frozen.instructions } : {}),
        ...(frozen.maxSteps !== undefined ? { maxSteps: frozen.maxSteps } : {}),
        ...(frozen.stopWhen ? { stopWhen: frozen.stopWhen } : {}),
        ...(frozen.compaction ? { compaction: frozen.compaction } : {}),
      });
    },
    with: (overrides: Partial<AgentDef>) => createAgent({ ...frozen, ...overrides }),
  });
}
