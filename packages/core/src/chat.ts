/**
 * chat.ts — framework-agnostic chat state engine (1.7, P2+P6).
 *
 * Everything a chat UI binding needs, as PURE functions over immutable data:
 * the render-friendly `UIMessage` shape, the per-turn reducer that folds Deuz
 * UI wire parts into it (`applyUIPart`), canonical-history reconstruction, and
 * the branch helpers behind regenerate / edit-and-resend. `@deuz-sdk/react`'s
 * hooks bind THIS module to React state — no business logic lives there.
 *
 * Persistence: the `ChatStore` seam (`saveChat`/`loadChat`, SessionStore
 * pattern) with an in-memory reference implementation; the agentic loops
 * auto-persist through `options.chat` (best-effort — a failing store logs and
 * never kills a run). A JSONL-backed Node store ships at `./chat/node`.
 */
import type { Message, Part, ToolUsePart, ToolResultPart } from './types/message';
import type { ToolApprovalRequest } from './types/tool';
import type { ToolRunState } from './types/stream';
import type { MemoryScope } from './memory';
import type { DeuzUIPart } from './ui';

export type { MemoryScope } from './memory';

// ===================================================================
// UI message model (the canonical home — ./react re-exports these)
// ===================================================================

export interface UIToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  /** 'call' = streamed; 'result' = executed (server or client); 'approval-requested' = awaiting a verdict. */
  state: 'call' | 'result' | 'approval-requested';
  /** Fine-grained lifecycle from `tool-state` parts (1.7 additive). */
  runState?: ToolRunState;
}

/** Render-friendly message. The canonical `Message[]` history is kept alongside for POSTing. */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: UIToolCall[];
}

// ===================================================================
// The per-turn reducer (pure): Deuz UI parts → assistant turn state
// ===================================================================

/** Everything one streamed assistant turn accumulates. Immutable — `applyUIPart` returns a new state. */
export interface AssistantTurnState {
  message: UIMessage;
  /** Gated calls awaiting verdicts (the chat pauses while non-empty). */
  approvals: ToolApprovalRequest[];
  /** toolCallIds the SERVER already executed — the rest are client tools. */
  serverResults: string[];
  /** Live cumulative cost, when the server streams `cost` parts (1.7). */
  costUsd?: number;
  cacheSavingsUsd?: number;
  /** Set when the server's `budget` guardrail tripped (1.7). */
  budgetExceeded?: { kind: 'usd' | 'tokens'; limit: number; value: number };
  /** App-defined `data-{name}` parts, in arrival order (1.7). */
  dataParts: Array<{ name: string; payload: unknown }>;
  /** RAG citations streamed with the answer (1.7). */
  citations: Array<Extract<DeuzUIPart, { type: 'citation' }>>;
  /** Redacted server error message, when the stream ended in an error part. */
  error?: string;
}

export function createAssistantTurn(id: string): AssistantTurnState {
  return {
    message: { id, role: 'assistant', content: '' },
    approvals: [],
    serverResults: [],
    dataParts: [],
    citations: [],
  };
}

function withToolCall(
  turn: AssistantTurnState,
  toolCallId: string,
  patch: (call: UIToolCall) => UIToolCall,
): AssistantTurnState {
  const toolCalls = (turn.message.toolCalls ?? []).map((c) =>
    c.toolCallId === toolCallId ? patch(c) : c,
  );
  return { ...turn, message: { ...turn.message, toolCalls } };
}

/**
 * Fold ONE Deuz UI wire part into the turn. Pure and total: unknown part
 * types are ignored (open-union rule), so newer servers never break older
 * clients. `error` parts are RECORDED, not thrown — the binding decides.
 */
export function applyUIPart(turn: AssistantTurnState, part: DeuzUIPart): AssistantTurnState {
  switch (part.type) {
    case 'start':
      return { ...turn, message: { ...turn.message, id: part.messageId } };
    case 'text-delta':
      return { ...turn, message: { ...turn.message, content: turn.message.content + part.text } };
    case 'reasoning-delta':
      return {
        ...turn,
        message: { ...turn.message, reasoning: (turn.message.reasoning ?? '') + part.text },
      };
    case 'tool-call': {
      const call: UIToolCall = {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        state: 'call',
      };
      return {
        ...turn,
        message: { ...turn.message, toolCalls: [...(turn.message.toolCalls ?? []), call] },
      };
    }
    case 'tool-result': {
      const next = withToolCall(turn, part.toolCallId, (c) => ({
        ...c,
        state: 'result',
        output: part.output,
        ...(part.isError ? { isError: true } : {}),
      }));
      return { ...next, serverResults: [...next.serverResults, part.toolCallId] };
    }
    case 'tool-approval-request': {
      const next = withToolCall(turn, part.toolCallId, (c) => ({
        ...c,
        state: 'approval-requested',
      }));
      return {
        ...next,
        approvals: [
          ...next.approvals,
          {
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          },
        ],
      };
    }
    case 'tool-state':
      return withToolCall(turn, part.toolCallId, (c) => ({ ...c, runState: part.state }));
    case 'cost':
      return {
        ...turn,
        costUsd: part.costUsd,
        ...(part.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: part.cacheSavingsUsd } : {}),
      };
    case 'budget-exceeded':
      return {
        ...turn,
        budgetExceeded: { kind: part.kind, limit: part.limit, value: part.value },
      };
    case 'citation':
      return { ...turn, citations: [...turn.citations, part] };
    case 'error':
      return { ...turn, error: part.message };
    default: {
      if (typeof part.type === 'string' && part.type.startsWith('data-')) {
        const dataPart = part as Extract<DeuzUIPart, { payload: unknown }>;
        return {
          ...turn,
          dataParts: [
            ...turn.dataParts,
            { name: dataPart.type.slice('data-'.length), payload: dataPart.payload },
          ],
        };
      }
      return turn; // additive union — ignore the rest
    }
  }
}

/**
 * Canonical assistant turn for the request history: text plus `tool_use`
 * parts, exactly as the wire streamed them (client-tools reconstruction).
 */
export function assistantMessageFromTurn(turn: AssistantTurnState): Message {
  const toolCalls = turn.message.toolCalls ?? [];
  const toolUses: ToolUsePart[] = toolCalls.map((t) => ({
    type: 'tool_use',
    id: t.toolCallId,
    name: t.toolName,
    input: t.input,
  }));
  const text = turn.message.content;
  const content: string | Part[] =
    toolUses.length > 0 ? [...(text ? [{ type: 'text' as const, text }] : []), ...toolUses] : text;
  return { role: 'assistant', content };
}

/** Canonical `role: 'tool'` message for client-executed tool results. */
export function clientToolResultMessage(
  results: Array<{ toolCallId: string; result: unknown; isError?: boolean }>,
): Message {
  const parts: ToolResultPart[] = results.map((r) => ({
    type: 'tool_result',
    toolUseId: r.toolCallId,
    result: r.result,
    ...(r.isError ? { isError: true } : {}),
  }));
  return { role: 'tool', content: parts };
}

// ===================================================================
// Canonical → UI projection + branch helpers (P6 core)
// ===================================================================

function textOf(content: string | Part[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Project a canonical history into render-friendly `UIMessage`s (e.g. a chat
 * loaded from a `ChatStore`). `tool` messages merge their results into the
 * preceding assistant turn; `system` messages are not rendered. `generateId`
 * supplies stable ids (inject `deps.generateId` or scripted ids in tests).
 */
export function uiFromMessages(messages: Message[], generateId: () => string): UIMessage[] {
  const ui: UIMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      ui.push({ id: generateId(), role: 'user', content: textOf(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = typeof message.content === 'string' ? [] : message.content;
      const reasoning = parts
        .filter((p): p is Extract<Part, { type: 'reasoning' }> => p.type === 'reasoning')
        .map((p) => p.text)
        .join('');
      const toolCalls: UIToolCall[] = parts
        .filter((p): p is ToolUsePart => p.type === 'tool_use')
        .map((p) => ({ toolCallId: p.id, toolName: p.name, input: p.input, state: 'call' }));
      ui.push({
        id: generateId(),
        role: 'assistant',
        content: textOf(message.content),
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    // role 'tool': fold results into the previous assistant turn.
    const previous = ui.at(-1);
    if (!previous || previous.role !== 'assistant' || !previous.toolCalls) continue;
    const results = (typeof message.content === 'string' ? [] : message.content).filter(
      (p): p is ToolResultPart => p.type === 'tool_result',
    );
    for (const r of results) {
      const call = previous.toolCalls.find((c) => c.toolCallId === r.toolUseId);
      if (call) {
        call.state = 'result';
        call.output = r.result;
        if (r.isError) call.isError = true;
      }
    }
  }
  return ui;
}

/** A UI + canonical history pair — the two views a chat binding maintains. */
export interface ChatHistory {
  ui: UIMessage[];
  canonical: Message[];
}

/**
 * Regenerate: drop the trailing assistant/tool turns from BOTH views so the
 * last user turn runs again. Immutable — returns new arrays (a prefix of an
 * immutable history is itself a valid history). No-op when nothing trails.
 */
export function dropTrailingAssistant(history: ChatHistory): ChatHistory {
  let canonicalEnd = history.canonical.length;
  while (canonicalEnd > 0 && history.canonical[canonicalEnd - 1]!.role !== 'user') canonicalEnd--;
  let uiEnd = history.ui.length;
  while (uiEnd > 0 && history.ui[uiEnd - 1]!.role !== 'user') uiEnd--;
  return { ui: history.ui.slice(0, uiEnd), canonical: history.canonical.slice(0, canonicalEnd) };
}

/**
 * Edit-and-resend: cut BOTH views to just BEFORE the user turn holding
 * `messageId` (identified in the UI view; the canonical cut uses the user-turn
 * ordinal, so assistant/tool interleaving can never skew the pairing).
 * Returns `undefined` when `messageId` is not a user message.
 */
export function branchBeforeUserMessage(
  history: ChatHistory,
  messageId: string,
): ChatHistory | undefined {
  const uiIndex = history.ui.findIndex((m) => m.id === messageId && m.role === 'user');
  if (uiIndex === -1) return undefined;
  const ordinal = history.ui.slice(0, uiIndex).filter((m) => m.role === 'user').length;
  let seen = 0;
  let canonicalIndex = history.canonical.length;
  for (let i = 0; i < history.canonical.length; i++) {
    if (history.canonical[i]!.role === 'user') {
      if (seen === ordinal) {
        canonicalIndex = i;
        break;
      }
      seen++;
    }
  }
  return {
    ui: history.ui.slice(0, uiIndex),
    canonical: history.canonical.slice(0, canonicalIndex),
  };
}

// ===================================================================
// ChatStore — the persistence seam (P2)
// ===================================================================

export interface ChatRecord {
  chatId: string;
  /** Ownership/tenancy — REQUIRED, aligned with the memory scope model. */
  scope: MemoryScope;
  /** Full immutable history (the loops never mutate prior arrays). */
  messages: Message[];
  /** Branch lineage (edit-and-resend can fork a chat; optional). */
  parentId?: string;
  /** `deps.clock.now()` at save time. */
  updatedAt: number;
}

/**
 * Chat persistence seam (SessionStore pattern: implement against any backend
 * — Supabase table, Redis, fs). The loops call `saveChat` at terminal
 * boundaries when `options.chat` is set; a throwing store logs via
 * `deps.logger.error` and never kills the run. `appendMessages` is an
 * OPTIONAL diff-append fast path — when absent, `saveChat` receives the full
 * history every time.
 */
export interface ChatStore {
  saveChat(record: ChatRecord): void | Promise<void>;
  loadChat(chatId: string): ChatRecord | undefined | Promise<ChatRecord | undefined>;
  /** Optional cleanup (the loops never call it). */
  deleteChat?(chatId: string): void | Promise<void>;
  /** Optional enumeration for pickers/tooling. */
  listChats?(scope?: MemoryScope): string[] | Promise<string[]>;
}

/** In-memory reference store (single runtime). Supabase/SQLite adapters: see docs. */
export function createInMemoryChatStore(): Required<ChatStore> {
  const chats = new Map<string, ChatRecord>();
  return {
    saveChat(record) {
      chats.set(record.chatId, { ...record, messages: [...record.messages] });
    },
    loadChat(chatId) {
      return chats.get(chatId);
    },
    deleteChat(chatId) {
      chats.delete(chatId);
    },
    listChats(scope) {
      if (!scope) return [...chats.keys()];
      const entries = Object.entries(scope).filter(([, v]) => v !== undefined);
      return [...chats.values()]
        .filter((c) => entries.every(([k, v]) => c.scope[k as keyof MemoryScope] === v))
        .map((c) => c.chatId);
    },
  };
}

/** Auto-persist wiring for a call: `options.chat` (see `CommonCallOptions`). */
export interface ChatPersistOptions {
  store: ChatStore;
  chatId: string;
  scope: MemoryScope;
  /** Fork lineage recorded on the saved record. */
  parentId?: string;
}

// ===================================================================
// Binary-safe JSON codec (mirrors the durable checkpoint convention)
// ===================================================================

const BYTES_TAG = '$deuzBytes';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * JSON-serialize a `ChatRecord` with binary message parts (images) preserved
 * via the same `{ "$deuzBytes": "<base64>" }` tag the durable checkpoint
 * codec uses. Store adapters that persist to text columns should use these.
 */
export function serializeChatRecord(record: ChatRecord): string {
  return JSON.stringify(record, (_key, value) =>
    value instanceof Uint8Array ? { [BYTES_TAG]: toBase64(value) } : value,
  );
}

export function deserializeChatRecord(json: string): ChatRecord {
  return JSON.parse(json, (_key, value) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)[BYTES_TAG] === 'string'
    ) {
      return fromBase64((value as Record<string, string>)[BYTES_TAG]!);
    }
    return value;
  }) as ChatRecord;
}
