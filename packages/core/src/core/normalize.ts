import type { Message, Part, Role } from '../types/message';
import { InvalidRequestError } from '../errors';

// ===================================================================
// Input shape (1.9): `prompt` / `instructions` → canonical `Message[]`
//
// This is the FIRST stage of the canonical line, running before
// `normalizeMessages` and `extractSystem` below: it decides WHAT the turns are,
// they decide what each turn looks like on the wire. The array produced here is
// indistinguishable from a hand-written one — that is the whole contract, and it
// is why the shorthand is resolved once at the call boundary
// (`src/generate.ts`) instead of being special-cased in four adapters.
// ===================================================================

/**
 * The input-shape slice of a call's options. `CommonCallOptions` satisfies it
 * structurally (its `messages` is required, which is assignable to optional).
 */
export interface CallInput {
  messages?: Message[];
  prompt?: string;
  instructions?: string;
}

/** A `prompt` that actually asks for something (an empty string is no turn at all). */
function hasPrompt(input: CallInput): boolean {
  return typeof input.prompt === 'string' && input.prompt.length > 0;
}

/**
 * Validate the `messages` XOR `prompt` pair. RETURNS the error instead of
 * throwing — `streamChat`/`streamObject` must return synchronously (G2), so only
 * the async entry points may turn it into a throw. Same split as Sprint 1's
 * object-call guard (`inference/object-shared.ts`).
 *
 * `messages: []` is deliberately asymmetric: alone it is left ALONE (an empty
 * history reaches the transport exactly as it did in 1.8 — changing that is not
 * this item's job), but it never CONFLICTS with `prompt`, because a generic
 * wrapper that always spreads `messages: []` is not asking for turns (same
 * "empty collection asks for nothing" rule as `object-shared.isRequested`).
 */
export function inputShapeError(input: CallInput, fn: string): InvalidRequestError | undefined {
  const promptGiven = hasPrompt(input);
  const messagesGiven = Array.isArray(input.messages);
  if (promptGiven && messagesGiven && input.messages!.length > 0) {
    return new InvalidRequestError({
      message:
        `${fn}: pass EITHER \`prompt\` (a single user turn) OR \`messages\` (the full ` +
        "history) — not both. `prompt: 'hi'` is exactly `messages: [{ role: 'user', " +
        "content: 'hi' }]`; build the array yourself when you need more turns.",
    });
  }
  if (!promptGiven && !messagesGiven) {
    return new InvalidRequestError({
      message:
        `${fn}: no input. Pass \`prompt: 'hello'\` for a single user turn, or ` +
        "`messages: [{ role: 'user', content: 'hello' }]` for a full history.",
    });
  }
  return undefined;
}

/**
 * Resolve the canonical `Message[]` for a call: `prompt` becomes one user turn,
 * `instructions` is prepended as the leading system turn. Assumes
 * {@link inputShapeError} already passed (it is the guard, this is the builder).
 *
 * PRECEDENCE — `instructions` goes FIRST and an in-history system message is
 * PRESERVED after it. Three reasons: (1) `extractSystem` concatenates system
 * text in array order, so first position means the developer's framing leads the
 * prompt the model sees; (2) `instructions` arrives on its own structural field
 * while `messages` may be a replayed / user-supplied transcript, so the trusted
 * text must not be reorderable or droppable by history content; (3) preserving
 * the in-history one keeps `instructions` purely additive — no caller loses a
 * system message by adopting the shorthand.
 *
 * The fold is IDEMPOTENT for the round-trip case: when the first turn is already
 * a system message with exactly this text, no second copy is prepended. Without
 * that, `chat` persistence (which stores this folded history) plus the same
 * `instructions` on the next call would duplicate the system prompt on every
 * turn.
 */
export function resolveInputMessages(input: CallInput): Message[] {
  const base = hasPrompt(input)
    ? [{ role: 'user', content: input.prompt! } as Message]
    : (input.messages ?? []);
  const instructions = input.instructions;
  if (instructions === undefined || instructions.length === 0) return base;
  const first = base[0];
  if (first && first.role === 'system' && first.content === instructions) return base;
  // NEW array — never mutate the caller's (immutable-history invariant).
  return [{ role: 'system', content: instructions }, ...base];
}

/**
 * Canonical message normalization: coerce `string` content to `TextPart[]`,
 * preserve author order. Image parts pass through; adapters serialize them
 * per-wire (Faz 2 vision support).
 */
export interface NormalizedMessage {
  role: Role;
  content: Part[];
  /** Message-level provider round-trip metadata (e.g. `{ openai: { phase } }`). */
  providerMetadata?: Record<string, unknown>;
}

export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: normalizeContent(m.content),
    ...(m.providerMetadata ? { providerMetadata: m.providerMetadata } : {}),
  }));
}

function normalizeContent(content: string | Part[]): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

/**
 * Split the top-level system slot from the rest, for the wires that have one
 * (Anthropic `system`, Responses `instructions`, Gemini `systemInstruction`).
 *
 * The slot is the LEADING run of system messages (2.3, F22): a system message
 * after the first non-system message is a MID-CONVERSATION system message, and
 * where it goes is the wire's call:
 *
 * - `inPlace: true` keeps it in `rest` at its position (Claude 5.x, OpenAI
 *   Responses). Claude 5.x binds its thinking to the transcript prefix, so a
 *   system message appended mid-run must not rewrite the top-level slot.
 * - the default folds its text into the slot after the leading run's, in array
 *   order: the 2.2 behaviour, for the wires without a mid-conversation system
 *   role (Gemini) or where it is not known to be accepted (older Claude).
 *
 * A system message without text (2.3: the carrier of a tool-set change, see
 * `internal/stable-prefix.ts`) contributes nothing to the slot; in place it
 * stays in `rest` for the wire that can render it.
 */
export function extractSystem(
  messages: NormalizedMessage[],
  options: { inPlace?: boolean } = {},
): {
  system?: string;
  rest: NormalizedMessage[];
} {
  const systemTexts: string[] = [];
  const rest: NormalizedMessage[] = [];
  let leading = true;
  for (const m of messages) {
    if (m.role !== 'system') {
      leading = false;
      rest.push(m);
    } else if (leading || !options.inPlace) {
      for (const p of m.content) if (p.type === 'text') systemTexts.push(p.text);
    } else {
      rest.push(m);
    }
  }
  return { system: systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined, rest };
}
