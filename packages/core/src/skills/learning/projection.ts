/**
 * The source projection of a skill proposal (2.4, spec §2.6): what the
 * proposal model may read of a verified run. Never the raw transcript:
 *
 * - the run's user-facing turns only: its 2.3 transcript without the turns the
 *   SDK wrote (`transcript.internal`), or, for a run without one, its history
 *   without the SDK's fixed finalization, output-repair and default verifier
 *   turns;
 * - no system message (host instructions, recall), no reasoning part (plain,
 *   encrypted or redacted), no provider metadata, no image, no compiled
 *   context block and no compaction summary;
 * - no raw tool result: a result is projected as `omitted` unless the host
 *   supplies a summary for its tool call.
 *
 * Each kept piece is a numbered item (`S1`, `S2`, ...) that a method step can
 * cite: its message (`<runId>:<index>`, the index into the transcript or the
 * history), its tool call and model step when known, and the digest of its
 * projected content. Pure and edge-safe.
 */
import type { AgentRunEnvelope, AgentToolReceipt } from '../../types/agent-run';
import type { AgentRunEnvelopeV3 } from '../../types/agent-run-v3';
import type { Message, Part } from '../../types/message';
import { isContextMessage } from '../../context/render';
import { canonicalJson, sha256Digest, type Sha256Digest } from '../../internal/digest';

/** What a projected item is. */
export type ProjectedItemKind = 'task' | 'user' | 'assistant' | 'tool-call' | 'tool-result';

/** One citable piece of the projection. */
export interface ProjectedItem {
  /** `S1`, `S2`, ... in transcript order. */
  id: string;
  kind: ProjectedItemKind;
  /** The projected content, exactly as the model reads it after the item's id. */
  content: string;
  /** `<runId>:<index>`: the message's index in the transcript (or the history). */
  messageId: string;
  toolCallId?: string;
  toolName?: string;
  /** The run's model step, when a tool receipt records it. */
  modelStep?: number;
  /** `sha256:<hex>` of `content`. */
  digest: Sha256Digest;
}

/** A run's projection: its items, the text sent to the model and its digest. */
export interface SourceProjection {
  items: ProjectedItem[];
  /** One line per item (`[S1] task: ...`); continuation lines are indented. */
  text: string;
  /** `sha256:<hex>` of `text`. */
  digest: Sha256Digest;
  /** The tools the run used: called, and answered without an error. Sorted. */
  usedTools: string[];
}

export interface ProjectRunOptions {
  /** Host summaries of chosen tool results, by tool call id. */
  toolSummaries?: Readonly<Record<string, string>>;
}

/** The compaction layer's summary marker (`inference/compaction.ts` SUMMARY_SENTINEL). */
const SUMMARY_SENTINEL = '[Earlier conversation summarized]';
/** The SDK's finalization turn (`agent-run.ts` FINALIZE_PROMPT). */
const FINALIZE_PROMPT =
  'Now provide the final output in the required format, based on the work above.';
/** The SDK's output-repair turn: `The final output failed validation: <why>. Return ...`. */
const REPAIR_PREFIX = 'The final output failed validation: ';
const REPAIR_SUFFIX = 'Return a corrected final output.';
/** The default verifier feedback turn. */
const DEFAULT_FEEDBACK = 'The output was rejected. Produce a corrected final answer.';

type Run = AgentRunEnvelope | AgentRunEnvelopeV3;

/** The turns to project, by their index in the record they come from. */
function sourceTurns(run: Run): { message: Message; index: number; input: boolean }[] {
  const transcript = run.transcript;
  if (transcript) {
    const internal = new Set(transcript.internal);
    return transcript.messages
      .map((message, index) => ({ message, index, input: index < transcript.input }))
      .filter(({ index }) => !internal.has(index));
  }
  // Without a transcript the history is all there is: the input is what comes
  // before the first assistant turn, and the SDK's own fixed turns are known.
  const firstAssistant = run.messages.findIndex((message) => message.role === 'assistant');
  return run.messages
    .map((message, index) => ({
      message,
      index,
      input: firstAssistant === -1 || index < firstAssistant,
    }))
    .filter(({ message }) => !sdkTurn(message));
}

function sdkTurn(message: Message): boolean {
  if (message.role !== 'user') return false;
  const text = textOf(message).trim();
  return (
    text === FINALIZE_PROMPT ||
    text === DEFAULT_FEEDBACK ||
    (text.startsWith(REPAIR_PREFIX) && text.endsWith(REPAIR_SUFFIX))
  );
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** The text parts the projection keeps: no summary, no compiled context block. */
function keptText(message: Message): string {
  const parts: Part[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  return parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .filter(
      (part) =>
        !part.text.startsWith(SUMMARY_SENTINEL) &&
        !isContextMessage({ role: 'user', content: [part] }),
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function inputJson(input: unknown): string {
  try {
    return canonicalJson(input ?? {});
  } catch {
    return JSON.stringify(input) ?? String(input);
  }
}

/** Each tool call id's receipts, oldest model step first (provider ids can repeat). */
function receiptsById(run: Run): Map<string, AgentToolReceipt[]> {
  const byId = new Map<string, AgentToolReceipt[]>();
  for (const receipt of Object.values(run.toolResults ?? {})) {
    const list = byId.get(receipt.toolCallId) ?? [];
    list.push(receipt);
    byId.set(receipt.toolCallId, list);
  }
  for (const list of byId.values()) list.sort((a, b) => (a.modelStep ?? 0) - (b.modelStep ?? 0));
  return byId;
}

/** Builds the projection of a run (it does not check eligibility or size). */
export async function projectRun(
  run: Run,
  options: ProjectRunOptions = {},
): Promise<SourceProjection> {
  const summaries = options.toolSummaries ?? {};
  const receipts = receiptsById(run);
  const seen = new Map<string, number>();
  /** The latest call of each id: its tool name and model step. */
  const calls = new Map<string, { name: string; modelStep?: number }>();
  const used = new Set<string>();
  const drafts: Omit<ProjectedItem, 'id' | 'digest'>[] = [];

  for (const { message, index, input } of sourceTurns(run)) {
    const messageId = `${run.runId}:${index}`;
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const text = keptText(message);
      const kind = input ? 'task' : 'user';
      if (text) drafts.push({ kind, content: `${kind}: ${text}`, messageId });
      continue;
    }
    if (typeof message.content === 'string') {
      // A string tool message is a raw result: never projected.
      if (message.role === 'assistant' && message.content.trim())
        drafts.push({
          kind: 'assistant',
          content: `assistant: ${message.content.trim()}`,
          messageId,
        });
      continue;
    }
    if (message.role === 'assistant') {
      const toolUses = message.content.filter(
        (part): part is Extract<Part, { type: 'tool_use' }> => part.type === 'tool_use',
      );
      let step: number | undefined;
      for (const part of toolUses) {
        const occurrence = seen.get(part.id) ?? 0;
        seen.set(part.id, occurrence + 1);
        const modelStep = receipts.get(part.id)?.[occurrence]?.modelStep;
        calls.set(part.id, { name: part.name, ...(modelStep !== undefined ? { modelStep } : {}) });
        step ??= modelStep;
      }
      const text = keptText(message);
      if (text)
        drafts.push({
          kind: 'assistant',
          content: `assistant: ${text}`,
          messageId,
          ...(step !== undefined ? { modelStep: step } : {}),
        });
      for (const part of toolUses) {
        const call = calls.get(part.id)!;
        drafts.push({
          kind: 'tool-call',
          content: `tool call ${part.name} (${part.id}): ${inputJson(part.input)}`,
          messageId,
          toolCallId: part.id,
          toolName: part.name,
          ...(call.modelStep !== undefined ? { modelStep: call.modelStep } : {}),
        });
      }
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'tool_result') continue;
      const call = calls.get(part.toolUseId);
      const name = call?.name ?? 'unknown';
      if (call && part.isError !== true) used.add(call.name);
      const summary = summaries[part.toolUseId];
      const body = typeof summary === 'string' && summary.trim() ? summary.trim() : 'omitted';
      drafts.push({
        kind: 'tool-result',
        content: `tool result ${name} (${part.toolUseId}): ${part.isError ? 'error, ' : ''}${body}`,
        messageId,
        toolCallId: part.toolUseId,
        toolName: name,
        ...(call?.modelStep !== undefined ? { modelStep: call.modelStep } : {}),
      });
    }
  }

  const items: ProjectedItem[] = [];
  for (const [position, draft] of drafts.entries())
    items.push({ id: `S${position + 1}`, ...draft, digest: await sha256Digest(draft.content) });
  const text = items.map(line).join('\n');
  return { items, text, digest: await sha256Digest(text), usedTools: [...used].sort() };
}

/** `[S1] task: ...`, with continuation lines indented so no line can pose as an item. */
function line(item: ProjectedItem): string {
  return `[${item.id}] ${item.content.replace(/\r?\n/g, '\n    ')}`;
}
