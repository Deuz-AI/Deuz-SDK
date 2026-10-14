/**
 * The untrusted-source policy of automatic extraction (2.4, spec §2.1): which
 * messages extraction may read, and the source each one becomes. By default
 * only user messages, host input (system messages) and the results of tools
 * the host marked trusted; external content (unmarked tools: MCP, browser,
 * web) only with `allowExternal`, stored with source kind `'external'`;
 * assistant turns only with `allowAssistant`. The kind comes from the message
 * and the host's policy, never from the model. Edge-safe.
 */
import type { MemoryScope } from '../../memory';
import type { Message, Part, ToolResultPart } from '../../types/message';
import { invalid, textDigest } from './shared';
import type {
  MemoryExtractionInput,
  MemoryExtractionPolicy,
  MemorySourceKind,
  MemorySourceRef,
} from './types';

/** A source extraction read: its prompt tag and label, its text and its reference. */
export interface ReadSource {
  tag: string;
  label: string;
  text: string;
  ref: MemorySourceRef;
}

function textParts(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return '';
  }
}

/**
 * The sources `messages` offer under `policy`, in message order. A message is
 * skipped, never read, when the policy does not allow it.
 */
export async function readExtractionSources(
  messages: MemoryExtractionInput['messages'],
  policy: MemoryExtractionPolicy | undefined,
  scope: MemoryScope,
): Promise<ReadSource[]> {
  if (!Array.isArray(messages)) throw invalid('extract needs a messages array.');
  const trusted = new Set(policy?.trustedTools ?? []);
  // The tool behind each tool call id, from the assistant turns in the window.
  const toolNames = new Map<string, string>();
  for (const entry of messages) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) if (part.type === 'tool_use') toolNames.set(part.id, part.name);
  }

  const read: ReadSource[] = [];
  const add = async (
    kind: MemorySourceKind,
    label: string,
    text: string,
    entry: MemoryExtractionInput['messages'][number],
    tool?: { toolCallId: string; toolName?: string },
  ): Promise<void> => {
    if (!text.trim()) return;
    read.push({
      tag: `s${read.length}`,
      label,
      text,
      ref: {
        kind,
        ...(entry.runId !== undefined ? { runId: entry.runId } : {}),
        ...(scope.chatId !== undefined ? { chatId: scope.chatId } : {}),
        messageId: entry.id,
        ...(tool ? { toolCallId: tool.toolCallId } : {}),
        ...(tool?.toolName !== undefined ? { toolName: tool.toolName } : {}),
        digest: await textDigest(text),
      },
    });
  };

  for (const [index, entry] of messages.entries()) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id)
      throw invalid(`Extraction message ${index} needs a stable id.`);
    const message = entry.message;
    if (message === null || typeof message !== 'object' || message.content === undefined)
      throw invalid(`Extraction message ${index} needs a message.`);
    const text = textParts(message.content);
    if (message.role === 'user') await add('user', 'user', text, entry);
    else if (message.role === 'system') await add('host', 'host', text, entry);
    else if (message.role === 'assistant' && policy?.allowAssistant)
      await add('assistant', 'assistant', text, entry);

    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool_result') continue;
      const result = part as ToolResultPart;
      if (result.isError) continue;
      const toolName = entry.toolName ?? toolNames.get(result.toolUseId);
      const tool = {
        toolCallId: result.toolUseId,
        ...(toolName !== undefined ? { toolName } : {}),
      };
      if (toolName !== undefined && trusted.has(toolName))
        await add('tool', `tool ${toolName}`, resultText(result.result), entry, tool);
      else if (policy?.allowExternal)
        await add(
          'external',
          `external ${toolName ?? 'tool'}`,
          resultText(result.result),
          entry,
          tool,
        );
    }
  }
  return read;
}
