/**
 * The model's working memory tools (2.4, spec §2.5): `<prefix>_read`,
 * `<prefix>_add` and `<prefix>_update`. Edge-safe.
 *
 * Every write is one patch with writer `'model'`, so the patch engine's rules
 * hold: no host-only change, no change to an item the host wrote, and what a
 * model adds is a proposal or an observation, never a verified fact. The
 * operation id is the tool name, the model step and the tool call id, so a
 * call replayed on resume is a `'duplicate'` (the tools declare `replay:
 * 'idempotent'`). A refusal is thrown, which the loop returns to the model as
 * a tool error. The tools persist nothing: the handle's owner (the native V3
 * run) checkpoints the snapshot with the tool's receipt.
 */
import { canonicalJson, sha256Digest } from '../../internal/digest';
import type { MemorySourceRef } from '../../memory/versioned/types';
import type { AgentTool, AgentToolContext, AgentToolSet } from '../../types/agent-run';
import type { Message } from '../../types/message';
import type {
  WorkingMemoryAttempt,
  WorkingMemoryList,
  WorkingMemoryOperation,
  WorkingMemoryRejection,
  WorkingMemorySnapshot,
  WorkingMemoryToolsOptions,
} from './types';

/** Write attempts against a snapshot that moved meanwhile, the first included. */
const WRITE_ATTEMPTS = 3;
/** Items or changes one call may carry. */
const MAX_BATCH = 16;
/** Provider tool names: letters, digits, `_` and `-`; the suffixes add at most 7 characters. */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,56}$/;

const KINDS = {
  observation: 'observations',
  hypothesis: 'hypotheses',
  decision: 'decisions',
  question: 'questions',
  attempt: 'attempts',
} as const satisfies Record<string, WorkingMemoryList>;
type ItemKind = keyof typeof KINDS;

const OUTCOMES: readonly WorkingMemoryAttempt['outcome'][] = [
  'in-progress',
  'succeeded',
  'failed',
  'abandoned',
];
const LISTS = Object.values(KINDS);

const REFUSALS: Record<WorkingMemoryRejection, string> = {
  forbidden:
    'forbidden: you can only change items you wrote; the goal, constraints and task list are the host’s',
  'unknown-id': 'there is no item with that id (read the working memory for the current ids)',
  'duplicate-id': 'an item with that id already exists',
  invalid: 'the change is malformed',
};

class WorkingMemoryToolError extends Error {
  override readonly name = 'WorkingMemoryToolError';
}

function refuse(message: string): never {
  throw new WorkingMemoryToolError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function batch(args: unknown, key: 'items' | 'changes'): Record<string, unknown>[] {
  const list = isObject(args) ? args[key] : undefined;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
    refuse(`Pass ${key} as a list of 1 to ${MAX_BATCH} entries.`);
  return list.map((entry, index) =>
    isObject(entry) ? entry : refuse(`${key}[${index}] must be an object.`),
  );
}

function text(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || !value.trim())
    refuse(`${where}: ${key} must be non-empty text.`);
  return value;
}

function optionalText(
  entry: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  return entry[key] === undefined ? undefined : text(entry, key, where);
}

function outcome(entry: Record<string, unknown>, where: string, fallback?: string) {
  const value = entry.outcome ?? fallback;
  if (!OUTCOMES.includes(value as WorkingMemoryAttempt['outcome']))
    refuse(`${where}: outcome must be one of ${OUTCOMES.join(', ')}.`);
  return value as WorkingMemoryAttempt['outcome'];
}

/** The digest a tool result is cited by: its canonical JSON, or its JSON text when it has none. */
async function resultDigest(result: unknown): Promise<MemorySourceRef['digest']> {
  let encoded: string;
  try {
    encoded = canonicalJson(result);
  } catch {
    encoded = JSON.stringify(result) ?? String(result);
  }
  return sha256Digest(encoded);
}

/** The sources of an item: each evidence id must name a tool result in the conversation. */
async function evidenceSources(
  value: unknown,
  messages: readonly Message[],
  where: string,
): Promise<MemorySourceRef[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id))
    refuse(`${where}: evidence must be a list of tool call ids.`);
  const sources: MemorySourceRef[] = [];
  for (const toolCallId of new Set(value as string[])) {
    let result: { found: boolean; value?: unknown } = { found: false };
    let toolName: string | undefined;
    for (const message of messages) {
      if (typeof message.content === 'string') continue;
      for (const part of message.content) {
        if (part.type === 'tool_use' && part.id === toolCallId) toolName = part.name;
        if (part.type === 'tool_result' && part.toolUseId === toolCallId)
          result = { found: true, value: part.result };
      }
    }
    if (!result.found)
      refuse(
        `${where}: no tool result with id ${JSON.stringify(toolCallId)} in this conversation.`,
      );
    sources.push({
      kind: 'tool',
      toolCallId,
      ...(toolName !== undefined ? { toolName } : {}),
      digest: await resultDigest(result.value),
    });
  }
  return sources;
}

/** The snapshot as the model reads it: no bookkeeping. */
function view(snapshot: WorkingMemorySnapshot) {
  const {
    kind: _kind,
    version: _version,
    scope: _scope,
    goalRef: _goalRef,
    applied: _applied,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = snapshot;
  return rest;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** See `workingMemoryTools`. */
export function createWorkingMemoryTools(options: WorkingMemoryToolsOptions): AgentToolSet {
  const memory = isObject(options) ? options.memory : undefined;
  if (
    !isObject(memory) ||
    typeof memory.current !== 'function' ||
    typeof memory.apply !== 'function'
  )
    throw new TypeError('workingMemoryTools needs { memory } with current() and apply().');
  const prefix = options.prefix ?? 'working_memory';
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix))
    throw new TypeError(
      'The working memory tool prefix may hold letters, digits, _ and - (at most 56).',
    );
  const owner = options.agentPath ?? [];
  if (!Array.isArray(owner) || owner.some((segment) => typeof segment !== 'string'))
    throw new TypeError('agentPath must be a list of agent names.');
  const name = (suffix: string) => `${prefix}_${suffix}`;

  /** Applies `operations` as the model; retries a lost revision race. */
  const write = async (
    toolName: string,
    context: AgentToolContext,
    operations: WorkingMemoryOperation[],
  ) => {
    // A sub-agent handed its parent's tools must not write the parent's memory.
    if (context.agentPath !== undefined && !samePath(context.agentPath, owner))
      refuse(
        'This working memory belongs to another agent: a sub-agent gets no shared writable working memory.',
      );
    const operationId = JSON.stringify([
      'working-memory',
      toolName,
      context.modelStep ?? null,
      context.toolCallId,
    ]);
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      const before = memory.current();
      const result = await memory.apply({
        operationId,
        expectedRevision: before.revision,
        writer: 'model',
        operations,
      });
      if (result.status === 'conflict') continue;
      if (result.status === 'duplicate')
        return { status: 'duplicate' as const, revision: result.snapshot.revision };
      if (result.status === 'rejected')
        refuse(
          `Working memory refused change ${result.operation + 1}: ${REFUSALS[result.reason]}.`,
        );
      return { before, after: result.snapshot };
    }
    return refuse('The working memory changed while writing; read it again and retry.');
  };

  const read: AgentTool = {
    description:
      'Read your working memory: the goal and constraints the host set, the task list and active task, ' +
      'and the observations, hypotheses, decisions, questions and attempts recorded so far.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    replay: 'idempotent',
    execute: () => view(memory.current()),
  };

  const add: AgentTool = {
    description:
      'Record items in your working memory: observations, hypotheses, decision proposals, open questions ' +
      'and attempts (with their outcome). Hypotheses and decisions stay proposals until the host confirms ' +
      'them. Cite tool results as evidence by their tool call ids.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: Object.keys(KINDS) },
              text: { type: 'string' },
              rationale: { type: 'string', description: 'Decisions only: why.' },
              outcome: {
                type: 'string',
                enum: OUTCOMES,
                description: 'Attempts only. Default in-progress.',
              },
              detail: { type: 'string', description: 'Attempts only: why it failed or stopped.' },
              evidence: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ids of the tool calls whose results support it (not for questions).',
              },
            },
            required: ['kind', 'text'],
          },
        },
      },
      required: ['items'],
    },
    replay: 'idempotent',
    async execute(args, context) {
      const items = batch(args, 'items');
      const operations: WorkingMemoryOperation[] = [];
      const lists: WorkingMemoryList[] = [];
      for (const [index, item] of items.entries()) {
        const where = `items[${index}]`;
        const kind = item.kind as ItemKind;
        if (!Object.hasOwn(KINDS, kind))
          refuse(`${where}: kind must be one of ${Object.keys(KINDS).join(', ')}.`);
        const itemText = text(item, 'text', where);
        if (kind === 'question' && item.evidence !== undefined)
          refuse(`${where}: a question takes no evidence.`);
        const sources = await evidenceSources(item.evidence, context.messages, where);
        const cited = sources !== undefined ? { sources } : {};
        lists.push(KINDS[kind]);
        if (kind === 'observation')
          operations.push({ op: 'add-observation', text: itemText, ...cited });
        else if (kind === 'hypothesis')
          operations.push({ op: 'add-hypothesis', text: itemText, ...cited });
        else if (kind === 'decision') {
          const rationale = optionalText(item, 'rationale', where);
          operations.push({
            op: 'add-decision',
            text: itemText,
            ...(rationale !== undefined ? { rationale } : {}),
            ...cited,
          });
        } else if (kind === 'question') operations.push({ op: 'add-question', text: itemText });
        else {
          const detail = optionalText(item, 'detail', where);
          operations.push({
            op: 'record-attempt',
            text: itemText,
            outcome: outcome(item, where, 'in-progress'),
            ...(detail !== undefined ? { detail } : {}),
            ...cited,
          });
        }
      }
      const written = await write(name('add'), context, operations);
      if ('status' in written) return written;
      // The ids the patch gave, in the order of the items.
      const fresh = new Map(
        LISTS.map((list) => {
          const known = new Set(written.before[list].map((item) => item.id));
          return [list, written.after[list].filter((item) => !known.has(item.id))] as const;
        }),
      );
      return {
        status: 'applied' as const,
        revision: written.after.revision,
        ids: lists.map((list) => fresh.get(list)!.shift()!.id),
      };
    },
  };

  const update: AgentTool = {
    description:
      'Change items you wrote in your working memory: answer or drop a question, set an attempt outcome, ' +
      'or remove an item. Items the host wrote cannot be changed.',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['answer', 'drop', 'attempt', 'remove'] },
              id: { type: 'string' },
              answer: { type: 'string', description: 'answer only.' },
              outcome: { type: 'string', enum: OUTCOMES, description: 'attempt only.' },
              detail: { type: 'string', description: 'attempt only.' },
              list: { type: 'string', enum: LISTS, description: 'remove only: the list it is in.' },
            },
            required: ['action', 'id'],
          },
        },
      },
      required: ['changes'],
    },
    replay: 'idempotent',
    async execute(args, context) {
      const operations = batch(args, 'changes').map((change, index): WorkingMemoryOperation => {
        const where = `changes[${index}]`;
        const id = text(change, 'id', where);
        switch (change.action) {
          case 'answer':
            return { op: 'answer-question', id, answer: text(change, 'answer', where) };
          case 'drop':
            return { op: 'drop-question', id };
          case 'attempt': {
            const detail = optionalText(change, 'detail', where);
            return {
              op: 'update-attempt',
              id,
              outcome: outcome(change, where),
              ...(detail !== undefined ? { detail } : {}),
            };
          }
          case 'remove':
            if (!LISTS.includes(change.list as WorkingMemoryList))
              refuse(`${where}: list must be one of ${LISTS.join(', ')}.`);
            return { op: 'remove', list: change.list as WorkingMemoryList, id };
          default:
            return refuse(`${where}: action must be answer, drop, attempt or remove.`);
        }
      });
      const written = await write(name('update'), context, operations);
      if ('status' in written) return written;
      return { status: 'applied' as const, revision: written.after.revision };
    },
  };

  return { [name('read')]: read, [name('add')]: add, [name('update')]: update };
}
