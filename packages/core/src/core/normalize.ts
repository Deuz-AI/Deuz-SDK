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
 * Split out system-role messages (text concatenated) from the rest. Adapters
 * that need a top-level system slot (Anthropic) use this; adapters that keep
 * system inline (OpenAI) may ignore it.
 */
export function extractSystem(messages: NormalizedMessage[]): {
  system?: string;
  rest: NormalizedMessage[];
} {
  const systemTexts: string[] = [];
  const rest: NormalizedMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      for (const p of m.content) if (p.type === 'text') systemTexts.push(p.text);
    } else {
      rest.push(m);
    }
  }
  return { system: systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined, rest };
}
