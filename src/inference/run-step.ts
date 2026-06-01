import type { CommonCallOptions } from '../types/config';
import type { Message, Part } from '../types/message';
import type { Usage, FinishReason } from '../types/usage';
import { runStream, type InternalRunOptions } from '../core/inference';

type ToolUsePart = Extract<Part, { type: 'tool_use' }>;

/** Per-tool streamed-argument accumulator (id → name + concatenated JSON fragments + provider meta). */
export type ToolArgMap = Map<
  string,
  { name?: string; args: string; meta?: Record<string, unknown> }
>;

/** Assemble the assistant turn (reasoning-first, then text, then tool_use) from accumulated state. */
export function assembleAssistant(
  text: string,
  reasoningText: string,
  reasoningSignature: string | undefined,
  toolArgs: ToolArgMap,
  toolOrder: string[],
): { assistantMessage: Message; toolUseParts: ToolUsePart[] } {
  const content: Part[] = [];
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
    const entry = toolArgs.get(id)!;
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
    content.push(part);
    toolUseParts.push(part);
  }
  return { assistantMessage: { role: 'assistant', content }, toolUseParts };
}

/** One model turn, buffered: text + reasoning + parsed tool_use parts. */
export interface OneStep {
  text: string;
  reasoningText: string;
  reasoningSignature?: string;
  toolUseParts: ToolUsePart[];
  usage: Usage;
  finishReason: FinishReason;
  /** assistant turn in canonical order (reasoning, text, tool_use…). */
  assistantMessage: Message;
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
  let reasoningText = '';
  let reasoningSignature: string | undefined;
  const toolArgs: ToolArgMap = new Map();
  const toolOrder: string[] = [];

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        text += part.text;
        break;
      case 'reasoning-delta':
        reasoningText += part.text;
        if (part.signature) reasoningSignature = part.signature;
        break;
      case 'tool-call-delta': {
        let entry = toolArgs.get(part.id);
        if (!entry) {
          entry = { name: part.name, args: '' };
          toolArgs.set(part.id, entry);
          toolOrder.push(part.id);
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
  const { assistantMessage, toolUseParts } = assembleAssistant(
    text,
    reasoningText,
    reasoningSignature,
    toolArgs,
    toolOrder,
  );

  return {
    text,
    reasoningText,
    reasoningSignature,
    toolUseParts,
    usage,
    finishReason,
    assistantMessage,
  };
}
