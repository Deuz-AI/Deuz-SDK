/**
 * `inference/handoff.ts` — agent HANDOFF (2.0): one run, several agents.
 *
 * The difference from {@link agentTool} (`inference/agent-tool.ts`) is the whole
 * point, and it is not a nuance:
 *
 * - **`agentTool` DELEGATES.** The sub-agent runs on a FRESH context
 *   (`{ system, prompt }`), in its own loop, and its answer comes back as a
 *   `tool_result`. The parent keeps driving; the conversation never leaves it.
 * - **`handoff` TRANSFERS.** The active agent CHANGES for the rest of the run:
 *   the system prompt, the tool set and the model become the target's, and the
 *   ENTIRE conversation history travels with it. There is no "coming back"
 *   unless the new agent transfers again (it can — including back).
 *
 * The mechanics live in the two loops (`loop-shared.ts` holds the shared half),
 * not here: this module only mints the `transfer_to_<name>` tools and tags them
 * with a hidden {@link HANDOFF_TARGET} symbol the loop reads. That tag is why the
 * interception is DETERMINISTIC — a transfer is decided by the loop before any
 * tool executes, never by a control-flow exception thrown out of an `execute`.
 *
 * ```ts
 * const agents = handoff({
 *   billing: { model: gpt5, instructions: 'You handle billing. Be precise.', tools: { refund } },
 *   support: supportAgent,                       // a createAgent() value works too
 * });
 *
 * await generateText({
 *   model: triageModel,
 *   instructions: 'Route the user to the right specialist.',
 *   messages,
 *   tools: { ...agents, search },
 *   maxSteps: 8,
 * });
 * ```
 *
 * Edge-safe: pure construction — no clock, no randomness, no I/O, no logging.
 */
import type { LanguageModel } from '../types/model';
import type { JSONSchema } from '../types/schema';
import type { Tool, ToolSet } from '../types/tool';
// TYPE-ONLY on purpose (fully erased under `verbatimModuleSyntax`): `agent.ts`
// reaches the loops through `generate.ts`, so a VALUE import here would close a
// real runtime cycle. A `DeuzAgent` is recognized STRUCTURALLY below instead.
import type { DeuzAgent } from '../agent';

/**
 * A handoff target described inline. The four fields are exactly the ones a
 * transfer can carry across: everything else about a run (deps, timeouts,
 * memory, session, guardrails, budgets) belongs to the RUN, not to the agent
 * driving it, and stays the caller's — a handoff must never silently re-point
 * transport or defenses mid-run.
 */
export interface HandoffAgentDef {
  /** The model that drives every step AFTER the transfer. */
  model: LanguageModel;
  /** Replaces the run's system message wholesale (absent = the system turn is removed). */
  instructions?: string;
  /** The target's own tools. It also keeps every OTHER transfer tool (never its own). */
  tools?: ToolSet;
  /** Label for logs/metadata; the record KEY is what names the transfer tool. */
  name?: string;
}

export interface HandoffOptions {
  /**
   * Hard cap on transfers per RUN (default {@link DEFAULT_MAX_HANDOFFS}). It is
   * a loop guard, not a policy: two agents that keep transferring to each other
   * would otherwise burn the whole budget on nothing but transfers. Reaching it
   * is SELF-HEALING — the call comes back as an `is_error` `tool_result` telling
   * the model to continue by itself, never a thrown run.
   */
  maxHandoffs?: number;
  /**
   * Sentence appended to each transfer tool's description (the model's only clue
   * about WHEN to transfer). Default: the target's `instructions`, which is the
   * one self-description a def carries.
   */
  describe?: (name: string) => string;
  /** Notified once per ACCEPTED transfer. Throws propagate (caller code, like `onStepFinish`). */
  onHandoff?: (info: { from?: string; to: string; reason?: string }) => void;
}

/** Default `maxHandoffs`: enough for a realistic triage chain, small enough to bound a loop. */
export const DEFAULT_MAX_HANDOFFS = 5;

/**
 * Hidden marker that turns an ordinary `Tool` into a transfer. Non-enumerable
 * (the `internal/config-symbol.ts` idiom), so it survives on the tool object
 * itself while staying invisible to `Object.keys`/`JSON.stringify`/`toEqual`
 * and to every wire builder.
 */
export const HANDOFF_TARGET: unique symbol = Symbol('deuz.handoffTarget');

/** What the loop reads off a transfer tool to perform the swap. */
export interface HandoffTargetMeta {
  /** The record key — the agent's identity in `HandoffPart.to`, metadata and checkpoints. */
  name: string;
  def: HandoffAgentDef;
  /** The options the whole `handoff()` group was built with (shared by every tool of it). */
  options: HandoffOptions;
}

/** `transfer_to_<name>` — the ONE derivation, shared by construction and resume lookup. */
export function handoffToolName(name: string): string {
  return `transfer_to_${name}`;
}

/**
 * The transfer tool's parameters. `reason` is OPTIONAL (no `required`): a model
 * that transfers without explaining itself must still produce a valid call —
 * failing argument validation would turn a routing decision into an error turn.
 */
const REASON_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'Why this agent should take over, in one sentence.',
    },
  },
  additionalProperties: false,
};

/** Read the handoff marker back off a tool (undefined for every ordinary tool). */
export function readHandoffTarget(tool: Tool): HandoffTargetMeta | undefined {
  return (tool as { [HANDOFF_TARGET]?: HandoffTargetMeta })[HANDOFF_TARGET];
}

/** A `DeuzAgent` carries its config on `.def`; an inline def carries `model` itself. */
function toAgentDef(entry: DeuzAgent | HandoffAgentDef): HandoffAgentDef {
  const source: HandoffAgentDef =
    'model' in entry ? entry : (entry.def as unknown as HandoffAgentDef);
  // Copy the four fields we actually transfer — never the whole AgentDef, which
  // would drag a `createAgent` value's deps/session/memory into the swap.
  return {
    model: source.model,
    ...(source.instructions !== undefined ? { instructions: source.instructions } : {}),
    ...(source.tools ? { tools: source.tools } : {}),
    ...(source.name !== undefined ? { name: source.name } : {}),
  };
}

/**
 * Build one `transfer_to_<name>` tool per entry.
 *
 * The returned tools are meant to be spread into the call's `tools` alongside
 * the root agent's own — the loop finds them by marker, so their position and
 * any `activeTools` filtering behave like any other tool's.
 *
 * ```ts
 * tools: { ...handoff({ billing, support }, { maxHandoffs: 3 }), search }
 * ```
 */
export function handoff(
  agents: Record<string, DeuzAgent | HandoffAgentDef>,
  options: HandoffOptions = {},
): ToolSet {
  const tools: ToolSet = {};
  for (const [name, entry] of Object.entries(agents)) {
    if (!name) {
      throw new TypeError('handoff: agent names must be non-empty strings.');
    }
    const def = toAgentDef(entry);
    if (!def.model) {
      throw new TypeError(`handoff: agent '${name}' has no model.`);
    }
    const detail = options.describe ? options.describe(name) : def.instructions;
    const meta: HandoffTargetMeta = { name, def, options };
    const tool: Tool = {
      description: `Transfer the conversation to the '${name}' agent.${detail ? ` ${detail}` : ''}`,
      parameters: REASON_SCHEMA,
      /**
       * DELIBERATELY unreachable. Both loops intercept a transfer BEFORE
       * `executeTools` runs, so this body never executes there. It exists for
       * two reasons that matter anyway:
       *
       * 1. A tool with no `execute` is a CLIENT tool — it would break the loop
       *    and hand the caller a round-trip it cannot answer.
       * 2. If a transfer tool ever reaches an older loop (or a direct
       *    `executeTools` call), the throw self-heals into an `is_error`
       *    `tool_result` that says exactly what went wrong, instead of silently
       *    doing nothing.
       */
      execute: () => {
        throw new Error(
          `handoff: '${handoffToolName(name)}' is intercepted by the agentic loop and must ` +
            `never execute. Reaching this means the call ran outside a handoff-aware loop.`,
        );
      },
    };
    Object.defineProperty(tool, HANDOFF_TARGET, {
      value: meta,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    tools[handoffToolName(name)] = tool;
  }
  return tools;
}
