import type { Message, Part, Role } from '../types/message';

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
