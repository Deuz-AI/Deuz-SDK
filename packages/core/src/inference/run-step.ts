import type { CommonCallOptions } from '../types/config';
import type { CallWarning, StopDetails } from '../types/methods';
import type { Message, Part } from '../types/message';
import type { ReasoningDeltaPart, TextDeltaPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import { runStream, type InternalRunOptions } from '../core/inference';

type ToolUsePart = Extract<Part, { type: 'tool_use' }>;

/**
 * The finish-reason gate (2.3, F16): a turn the provider refused
 * (`content_filter`) or cut off (`length`) never dispatches its `tool_use` parts.
 * Their arguments may be truncated JSON, and acting on a refused turn executes
 * work the provider declined to produce. Both loops consult this BEFORE any
 * guardrail, approval or execution, and neither re-drives such a turn through
 * `doneWhen` or `verifyStep`.
 */
export function blocksToolDispatch(finishReason: FinishReason): boolean {
  return finishReason === 'content_filter' || finishReason === 'length';
}

/**
 * Read the provider's stop explanation off a finish part's `providerMetadata`
 * (2.3). Anthropic sends `stop_details` with a refusal; other providers send
 * nothing comparable today, so this returns `undefined` for them.
 */
export function stopDetailsFrom(
  providerMetadata: Record<string, unknown> | undefined,
): StopDetails | undefined {
  const anthropic = providerMetadata?.anthropic;
  const raw =
    anthropic && typeof anthropic === 'object'
      ? (anthropic as { stop_details?: unknown }).stop_details
      : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const { type, category, explanation } = raw as Record<string, unknown>;
  if (typeof type !== 'string') return undefined;
  return {
    type,
    ...(typeof category === 'string' || category === null ? { category } : {}),
    ...(typeof explanation === 'string' || explanation === null ? { explanation } : {}),
  };
}

/** Per-tool streamed-argument accumulator (id → name + concatenated JSON fragments + provider meta). */
export type ToolArgMap = Map<
  string,
  { name?: string; args: string; meta?: Record<string, unknown> }
>;

/** Opaque encrypted reasoning payloads (OpenAI Responses); signature carries the item id. */
export type EncryptedReasoning = { text: string; signature?: string }[];

/** A streamed tool call → its canonical `tool_use` part (arguments parsed once, here). */
function toolUsePart(
  id: string,
  entry: { name?: string; args: string; meta?: Record<string, unknown> },
) {
  let input: unknown;
  try {
    input = entry.args ? JSON.parse(entry.args) : {};
  } catch {
    input = entry.args;
  }
  const part: ToolUsePart = {
    type: 'tool_use',
    id,
    name: entry.name ?? '',
    input,
    ...(entry.meta ? { providerMetadata: entry.meta } : {}),
  };
  return part;
}

/**
 * Assemble the assistant turn (reasoning-first, then text, then tool_use) from
 * accumulated state — the 2.2 shape, which merges a turn's reasoning into one
 * part. The loops use {@link createTurnContent}, which keeps every block; this
 * stays for callers that accumulate merged reasoning themselves.
 */
export function assembleAssistant(
  text: string,
  reasoningText: string,
  reasoningSignature: string | undefined,
  toolArgs: ToolArgMap,
  toolOrder: string[],
  encryptedReasoning?: EncryptedReasoning,
): { assistantMessage: Message; toolUseParts: ToolUsePart[] } {
  const content: Part[] = [];
  for (const er of encryptedReasoning ?? []) {
    content.push({
      type: 'reasoning',
      text: er.text,
      encrypted: true,
      ...(er.signature ? { signature: er.signature } : {}),
    });
  }
  if (reasoningText) {
    content.push({
      type: 'reasoning',
      text: reasoningText,
      ...(reasoningSignature ? { signature: reasoningSignature } : {}),
    });
  }
  if (text) content.push({ type: 'text', text });

  const toolUseParts: ToolUsePart[] = [];
  for (const id of toolOrder) {
    const part = toolUsePart(id, toolArgs.get(id)!);
    content.push(part);
    toolUseParts.push(part);
  }
  return { assistantMessage: { role: 'assistant', content }, toolUseParts };
}

/** One element of a model turn, in the order it arrived. */
type Segment =
  | { kind: 'reasoning'; part: Extract<Part, { type: 'reasoning' }>; id?: string }
  | { kind: 'text'; text: string; providerMetadata?: Record<string, unknown> }
  | { kind: 'tool'; id: string };

/**
 * One model turn's content, recorded in ARRIVAL order (2.3, F21). Shared by
 * both loops, so a turn is assembled the same way whichever drove it.
 *
 * Every reasoning block becomes its own part and keeps its place:
 * - deltas extend a block only while they carry the same `id` and `source` and
 *   nothing else arrived in between, so two consecutive thinking blocks stay
 *   two blocks, each with its own signature (a merged block is a modified one);
 * - a block whose text is empty is kept when it is signed (Claude's default
 *   `display: 'omitted'` streams only the signature);
 * - encrypted and redacted payloads are always blocks of their own;
 * - blocks are placed where they arrived — thinking between two tool calls
 *   stays between them — and consecutive text deltas form one text part.
 */
export interface TurnContent {
  /** Record a text delta (an empty one with no round-trip data opens nothing). */
  text(part: TextDeltaPart): void;
  /** Record a reasoning delta. */
  reasoning(part: ReasoningDeltaPart): void;
  /** Record where a tool call first appeared. */
  tool(id: string): void;
  /** The turn's readable reasoning: every plain block's text, never opaque payloads. */
  readonly reasoningText: string;
  /** The last plain block's signature (the 2.2 single-signature view). */
  readonly reasoningSignature: string | undefined;
  /**
   * The assistant message, with a `tool_use` part for each id in `toolOrder`
   * (a refused or cut-off turn passes none). A turn with neither text nor a
   * tool call is EMPTY (`content: []`) whatever reasoning it carried: no wire
   * takes back a turn that is reasoning alone, so the loops do not store it.
   */
  assemble(
    toolArgs: ToolArgMap,
    toolOrder: string[],
  ): { assistantMessage: Message; toolUseParts: ToolUsePart[] };
}

export function createTurnContent(): TurnContent {
  const segments: Segment[] = [];
  let reasoningText = '';
  let reasoningSignature: string | undefined;
  return {
    text(part) {
      if (!part.text && !part.providerMetadata) return;
      const last = segments.at(-1);
      if (last?.kind === 'text') {
        last.text += part.text;
        if (part.providerMetadata) {
          last.providerMetadata = { ...last.providerMetadata, ...part.providerMetadata };
        }
        return;
      }
      segments.push({
        kind: 'text',
        text: part.text,
        ...(part.providerMetadata ? { providerMetadata: { ...part.providerMetadata } } : {}),
      });
    },
    reasoning(part) {
      const opaque = part.encrypted === true || part.redacted === true;
      const last = segments.at(-1);
      if (
        !opaque &&
        last?.kind === 'reasoning' &&
        !last.part.encrypted &&
        !last.part.redacted &&
        last.id === part.id &&
        last.part.source === part.source
      ) {
        last.part.text += part.text;
        if (part.signature) last.part.signature = part.signature;
      } else {
        segments.push({
          kind: 'reasoning',
          ...(part.id !== undefined ? { id: part.id } : {}),
          part: {
            type: 'reasoning',
            text: part.text,
            ...(part.signature ? { signature: part.signature } : {}),
            ...(part.encrypted ? { encrypted: true } : {}),
            ...(part.redacted ? { redacted: true } : {}),
            ...(part.source !== undefined ? { source: part.source } : {}),
          },
        });
      }
      if (opaque) return;
      reasoningText += part.text;
      if (part.signature) reasoningSignature = part.signature;
    },
    tool(id) {
      segments.push({ kind: 'tool', id });
    },
    get reasoningText() {
      return reasoningText;
    },
    get reasoningSignature() {
      return reasoningSignature;
    },
    assemble(toolArgs, toolOrder) {
      const dispatched = new Set(toolOrder);
      const placed = new Set<string>();
      const content: Part[] = [];
      const toolUseParts: ToolUsePart[] = [];
      const pushTool = (id: string): void => {
        const part = toolUsePart(id, toolArgs.get(id)!);
        content.push(part);
        toolUseParts.push(part);
        placed.add(id);
      };
      for (const segment of segments) {
        if (segment.kind === 'reasoning') {
          content.push({ ...segment.part });
        } else if (segment.kind === 'tool') {
          if (dispatched.has(segment.id) && !placed.has(segment.id)) pushTool(segment.id);
        } else if (segment.text) {
          const last = content.at(-1);
          // Text on both sides of a call that was not kept (a cut-off turn) is one run.
          if (last?.type === 'text') {
            last.text += segment.text;
            if (segment.providerMetadata) {
              last.providerMetadata = { ...last.providerMetadata, ...segment.providerMetadata };
            }
          } else {
            content.push({
              type: 'text',
              text: segment.text,
              ...(segment.providerMetadata ? { providerMetadata: segment.providerMetadata } : {}),
            });
          }
        }
      }
      // Calls the caller tracked without recording their position go last, in order.
      for (const id of toolOrder) if (!placed.has(id)) pushTool(id);
      const answered = content.some((p) => p.type === 'text' || p.type === 'tool_use');
      return {
        assistantMessage: { role: 'assistant', content: answered ? content : [] },
        toolUseParts,
      };
    },
  };
}

/** One model turn, buffered: text + reasoning + parsed tool_use parts. */
export interface OneStep {
  text: string;
  reasoningText: string;
  reasoningSignature?: string;
  toolUseParts: ToolUsePart[];
  usage: Usage;
  finishReason: FinishReason;
  /** The provider's stop explanation for this turn (2.3), e.g. a refusal's category. */
  stopDetails?: StopDetails;
  /** assistant turn in canonical order (reasoning, text, tool_use…). */
  assistantMessage: Message;
  /** Observation settlement passthrough (1.6.1) — root single-turn calls only. */
  observation?: { settled: Promise<void> };
  /**
   * Non-fatal notices this turn's pump collected (1.9). The buffered path reads
   * the awaited promise rather than the `warning` StreamPart: the switch below
   * has a `default: break`, and a promise that never rejects is the simpler
   * contract for a caller that is already awaiting the whole turn.
   */
  warnings?: CallWarning[];
}

/**
 * Buffer a single streaming turn into structured form. Shared by `generateText`
 * (single turn) and the agentic loop (one call per step). This is the Faz 1
 * `generate-text` accumulation, lifted verbatim so the loop reuses it.
 */
export async function runOneStep(
  options: CommonCallOptions,
  internal?: InternalRunOptions,
): Promise<OneStep> {
  const result = runStream(options, internal);

  let text = '';
  let messagePhase: string | undefined;
  let stopDetails: StopDetails | undefined;
  // Every reasoning block, text run and tool call in arrival order (2.3, F21).
  const turn = createTurnContent();
  const toolArgs: ToolArgMap = new Map();
  const toolOrder: string[] = [];
  /** Every `warning` part this turn's stream carried. */
  const streamed: CallWarning[] = [];

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'finish':
        // Responses `phase` rides finish providerMetadata → onto the assistant message.
        messagePhase = (part.providerMetadata?.openai as { phase?: string } | undefined)?.phase;
        stopDetails = stopDetailsFrom(part.providerMetadata);
        break;
      case 'warning':
        // A wire's own notice about the response (2.3: Anthropic's
        // input_transformations) never passed the call's sink. Record it in an
        // enclosing loop's sink (a no-op for a warning the sink streamed) and
        // on this step, so a result reports it like any other warning.
        internal?.warnings?.add(part.warning);
        streamed.push(part.warning);
        break;
      case 'text-delta':
        text += part.text;
        turn.text(part);
        break;
      case 'reasoning-delta':
        turn.reasoning(part);
        break;
      case 'tool-call-delta': {
        let entry = toolArgs.get(part.id);
        if (!entry) {
          entry = { name: part.name, args: '' };
          toolArgs.set(part.id, entry);
          toolOrder.push(part.id);
          turn.tool(part.id);
        }
        if (part.name && !entry.name) entry.name = part.name;
        if (part.providerMetadata) entry.meta = part.providerMetadata;
        entry.args += part.argsTextDelta;
        break;
      }
      case 'error':
        throw part.error;
      default:
        break;
    }
  }

  const usage = await result.usage;
  const finishReason = await result.finishReason;
  const { assistantMessage, toolUseParts } = turn.assemble(
    toolArgs,
    // A refused or cut-off turn keeps its text and reasoning, never its tool calls.
    blocksToolDispatch(finishReason) ? [] : toolOrder,
  );
  if (messagePhase) assistantMessage.providerMetadata = { openai: { phase: messagePhase } };

  // `warnings` never rejects by contract (core/inference.ts resolves it from
  // the pump's `finally`), so awaiting it here cannot fail the step.
  const listed = result.warnings ? await result.warnings : undefined;
  const warnings = listed || streamed.length > 0 ? withStreamed(listed ?? [], streamed) : undefined;

  return {
    text,
    reasoningText: turn.reasoningText,
    reasoningSignature: turn.reasoningSignature,
    toolUseParts,
    usage,
    finishReason,
    ...(stopDetails ? { stopDetails } : {}),
    assistantMessage,
    ...(result.observation ? { observation: result.observation } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

/** `listed` plus the streamed warnings it lacks, by the sink's own identity rule. */
function withStreamed(listed: CallWarning[], streamed: CallWarning[]): CallWarning[] {
  const key = (w: CallWarning): string => `${w.type} ${w.setting ?? ''} ${w.message}`;
  const known = new Set(listed.map(key));
  const out = [...listed];
  for (const warning of streamed) {
    if (known.has(key(warning))) continue;
    known.add(key(warning));
    out.push(warning);
  }
  return out;
}
