/**
 * The untrusted-source policy of automatic extraction (2.4, spec §2.1): which
 * messages extraction may read, and the source each one becomes. By default
 * only user messages, host input (system messages) and the results of the
 * tools the host names in `trustedTools` (trust is declared by tool name
 * there; a tool has no trust flag of its own); external content (every other
 * tool: MCP, browser, web) only with `allowExternal`, stored with source kind
 * `'external'`; assistant turns only with `allowAssistant`. The kind comes
 * from the message and the host's policy, never from the model. The SDK's
 * own turns in a run or chat transcript (a memory recall block, a compaction
 * summary, a tool-set change notice) are never read under any policy: they
 * are neither host nor user input, and a recall block or summary can carry
 * external content. Edge-safe.
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
 * The markers of the SDK's own turns, read here without importing their
 * builders (`internal/stable-prefix.ts` pulls the model registry,
 * `inference/compaction.ts` the loop, and this entry stays small and
 * edge-safe). They are persisted in transcripts, so they do not change; the
 * extraction tests build their messages with the real builders.
 */
const SUMMARY_SENTINEL = '[Earlier conversation summarized]';

/**
 * A turn the SDK put into the transcript itself, no fact about the user under
 * any policy: a stable-prefix memory recall block (`recallMessage`), a
 * tool-set change notice (`toolSetChangeMessage`), both system messages
 * marked in `providerMetadata.deuz`, or a compaction summary (model-written
 * from whatever the window held), one user text part opening with the
 * summary sentinel (`isSummaryMessage`).
 */
function isSdkTurn(message: Message): boolean {
  if (message.role === 'system') {
    const deuz = message.providerMetadata?.deuz as
      | { memoryRecall?: unknown; toolChanges?: { remove?: unknown; add?: unknown } }
      | undefined;
    const changes = deuz?.toolChanges;
    return (
      deuz?.memoryRecall === true || (Array.isArray(changes?.remove) && Array.isArray(changes?.add))
    );
  }
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1)
    return false;
  const part = message.content[0]!;
  return part.type === 'text' && part.text.startsWith(SUMMARY_SENTINEL);
}

/**
 * The sources `messages` offer under `policy`, in message order. A message is
 * skipped, never read, when the policy does not allow it, and always when the
 * SDK injected it (see {@link isSdkTurn}).
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
    if (isSdkTurn(message)) continue;
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
