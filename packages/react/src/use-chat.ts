/**
 * useChat — the React binding over `@deuz-sdk/core/chat` + the Deuz UI wire.
 *
 * THIN by contract: every chat-state transformation is a core call
 * (`createAssistantTurn`/`applyUIPart`/`assistantMessageFromTurn`/
 * `clientToolResultMessage`/`uiFromMessages`/`dropTrailingAssistant`/
 * `branchBeforeUserMessage`). This hook only owns React state, the fetch
 * round-trips, and abort wiring. Supersedes the frozen `@deuz-sdk/core/react`.
 */
import { useCallback, useRef, useState } from 'react';
import type { Message, ToolApprovalRequest, ToolApprovalResponse } from '@deuz-sdk/core';
import {
  applyUIPart,
  assistantMessageFromTurn,
  branchBeforeUserMessage,
  clientToolResultMessage,
  createAssistantTurn,
  dropTrailingAssistant,
  uiFromMessages,
} from '@deuz-sdk/core/chat';
import type { AssistantTurnState, UIMessage } from '@deuz-sdk/core/chat';
import { connectDeuzStream, readDeuzStream } from '@deuz-sdk/core/ui';

/**
 * Fold one wire part via the core reducer. Trivial glue on top: core 1.7.0's
 * `applyUIPart` drops the `token` field of a `tool-approval-request` when it
 * builds the approval entry — re-attach it so verdicts can echo it (D4).
 */
function foldPart(
  turn: AssistantTurnState,
  part: Parameters<typeof applyUIPart>[1],
): AssistantTurnState {
  const next = applyUIPart(turn, part);
  if (part.type === 'tool-approval-request' && part.token !== undefined) {
    return {
      ...next,
      approvals: next.approvals.map((a) =>
        a.approvalId === part.approvalId && a.token === undefined ? { ...a, token: part.token } : a,
      ),
    };
  }
  return next;
}

/** Local id fallback — this package is not edge-lint-constrained. */
const defaultGenerateId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `deuz-ui-${Math.random().toString(36).slice(2)}`;

/** Live cumulative USD cost, from the wire's `cost` parts (last one wins). */
export interface UseChatCost {
  costUsd: number;
  cacheSavingsUsd?: number;
}

/** The server's budget guardrail tripped (`budget-exceeded` part). */
export interface UseChatBudgetExceeded {
  kind: 'usd' | 'tokens';
  limit: number;
  value: number;
}

export interface UseChatResumeOptions {
  /**
   * Resume endpoint (see core's `resumeDeuzStreamResponse`): a GET URL or a
   * factory returning the `Response` for a given cursor. Do NOT point it at
   * the generating POST route — that would re-run the model.
   */
  endpoint: string | ((ctx: { lastEventId?: string }) => Response | Promise<Response>);
  /** Cursor to resume from (e.g. persisted across a page reload). */
  lastEventId?: string;
}

export interface UseChatOptions {
  /** Endpoint serving `toDeuzStreamResponse` output. */
  api: string;
  /** Seed canonical history (e.g. restored from a ChatStore) — rendered via `uiFromMessages`. */
  initialMessages?: Message[];
  headers?: Record<string, string>;
  /** Extra fields merged into every request body. */
  body?: Record<string, unknown>;
  /** Chat identity — merged into every request body (server-side ChatStore persistence). */
  chatId?: string;
  /** Enables `reconnect()` against a resume endpoint (wire v2, `connectDeuzStream`). */
  resume?: UseChatResumeOptions;
  /** Id source for UI messages/turns. Default: `crypto.randomUUID` (with a fallback). */
  generateId?: () => string;
  /**
   * Client-tool executor: called for every streamed tool call the SERVER did
   * not execute. The return value is appended as its tool_result and the chat
   * auto-continues; a throw self-heals as an is_error result.
   */
  onToolCall?: (call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => Promise<unknown> | unknown;
  onError?: (error: Error) => void;
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface UseChatResult {
  messages: UIMessage[];
  status: 'idle' | 'streaming' | 'error';
  error: Error | undefined;
  /** Gated tool calls awaiting verdicts — the chat is PAUSED while non-empty. */
  pendingApprovals: ToolApprovalRequest[];
  /** Live cumulative cost from the wire's `cost` parts (last one wins). */
  cost?: UseChatCost;
  /** Set when the server's budget guardrail tripped this turn. */
  budgetExceeded?: UseChatBudgetExceeded;
  /** This turn's app-defined `data-{name}` parts, in arrival order. */
  dataParts: Array<{ name: string; payload: unknown }>;
  /** This turn's RAG citations. */
  citations: AssistantTurnState['citations'];
  sendMessage: (text: string) => Promise<void>;
  /** Abort the in-flight stream (not an error). */
  stop: () => void;
  /** Drop the trailing assistant/tool turns (core `dropTrailingAssistant`) and re-run. */
  regenerate: () => Promise<void>;
  /** Cut history before `messageId` (core `branchBeforeUserMessage`) and send `text`. */
  editAndResend: (messageId: string, text: string) => Promise<void>;
  /**
   * Record one verdict (the request's signed `token` is auto-preserved). Once
   * EVERY pending approval has a verdict, the chat auto-resumes with
   * `approvalResponses` in the request body.
   */
  addToolApprovalResponse: (response: ToolApprovalResponse) => Promise<void>;
  /**
   * Re-read the stream from `resume.endpoint` via `connectDeuzStream` and fold
   * the parts into the current turn. No-op unless `options.resume` is set.
   */
  reconnect: () => Promise<void>;
}

export function useChat(options: UseChatOptions): UseChatResult {
  const genId = options.generateId ?? defaultGenerateId;
  const [messages, setMessages] = useState<UIMessage[]>(() =>
    uiFromMessages(options.initialMessages ?? [], genId),
  );
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<Error | undefined>(undefined);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const [cost, setCost] = useState<UseChatCost | undefined>(undefined);
  const [budgetExceeded, setBudgetExceeded] = useState<UseChatBudgetExceeded | undefined>(
    undefined,
  );
  const [dataParts, setDataParts] = useState<Array<{ name: string; payload: unknown }>>([]);
  const [citations, setCitations] = useState<AssistantTurnState['citations']>([]);

  const uiRef = useRef<UIMessage[]>(messages);
  const canonicalRef = useRef<Message[]>(
    options.initialMessages ? [...options.initialMessages] : [],
  );
  /** The in-flight turn — kept across a drop so `reconnect()` can continue it. */
  const turnRef = useRef<AssistantTurnState | undefined>(undefined);
  const approvalsRef = useRef<ToolApprovalRequest[]>([]);
  const verdictsRef = useRef<ToolApprovalResponse[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string | undefined>(options.resume?.lastEventId);

  const pushMessage = useCallback((message: UIMessage): void => {
    uiRef.current = [...uiRef.current, message];
    setMessages(uiRef.current);
  }, []);

  /** Sync ALL turn-derived React state (the turn's message is the trailing UI element). */
  const syncTurn = useCallback((turn: AssistantTurnState): void => {
    uiRef.current = [...uiRef.current.slice(0, -1), turn.message];
    setMessages(uiRef.current);
    if (turn.costUsd !== undefined) {
      setCost({
        costUsd: turn.costUsd,
        ...(turn.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: turn.cacheSavingsUsd } : {}),
      });
    }
    setBudgetExceeded(turn.budgetExceeded);
    setDataParts(turn.dataParts);
    setCitations(turn.citations);
  }, []);

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (approvalResponses?: ToolApprovalResponse[]): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('streaming');
      setError(undefined);
      try {
        // One iteration per model round; client-tool results loop back in.
        for (;;) {
          const doFetch = options.fetch ?? fetch;
          const res = await doFetch(options.api, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...options.headers },
            body: JSON.stringify({
              messages: canonicalRef.current,
              ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
              ...(approvalResponses?.length ? { approvalResponses } : {}),
              ...options.body,
            }),
            signal: controller.signal,
          });
          approvalResponses = undefined; // consumed by the first round only

          let turn = createAssistantTurn(genId());
          turnRef.current = turn;
          pushMessage(turn.message);
          syncTurn(turn); // resets this-turn state (dataParts/citations/budget)

          for await (const part of readDeuzStream(res)) {
            turn = foldPart(turn, part);
            turnRef.current = turn;
            syncTurn(turn);
          }
          if (turn.error !== undefined) throw new Error(turn.error);

          // Append the canonical assistant turn (client-tools reconstruction).
          canonicalRef.current = [...canonicalRef.current, assistantMessageFromTurn(turn)];
          turnRef.current = undefined;

          // Approval pause: verdicts arrive via addToolApprovalResponse.
          if (turn.approvals.length > 0) {
            approvalsRef.current = turn.approvals;
            verdictsRef.current = [];
            setPendingApprovals(turn.approvals);
            return;
          }

          // Client-tool auto-round-trip: everything the server didn't execute.
          const toolCalls = turn.message.toolCalls ?? [];
          const serverResults = new Set(turn.serverResults);
          const clientPending = toolCalls.filter((t) => !serverResults.has(t.toolCallId));
          if (clientPending.length === 0 || !options.onToolCall) return;
          const results: Array<{ toolCallId: string; result: unknown; isError?: boolean }> = [];
          for (const call of clientPending) {
            try {
              const out = await options.onToolCall({
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              });
              results.push({ toolCallId: call.toolCallId, result: out });
              turn = applyUIPart(turn, {
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: out,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              results.push({ toolCallId: call.toolCallId, result: message, isError: true });
              turn = applyUIPart(turn, {
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: message,
                isError: true,
              });
            }
            syncTurn(turn);
          }
          canonicalRef.current = [...canonicalRef.current, clientToolResultMessage(results)];
          // loop → next round POSTs the extended history
        }
      } catch (err) {
        if (controller.signal.aborted) return; // user abort — not an error
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus('error');
        options.onError?.(e);
        return;
      } finally {
        setStatus((s) => (s === 'error' ? s : 'idle'));
      }
    },
    [
      options.api,
      options.fetch,
      options.headers,
      options.body,
      options.chatId,
      options.generateId,
      options.onToolCall,
      options.onError,
      pushMessage,
      syncTurn,
    ],
  );

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      canonicalRef.current = [...canonicalRef.current, { role: 'user', content: text }];
      pushMessage({ id: genId(), role: 'user', content: text });
      approvalsRef.current = [];
      verdictsRef.current = [];
      setPendingApprovals([]);
      await run();
    },
    [run, pushMessage, options.generateId],
  );

  const regenerate = useCallback(async (): Promise<void> => {
    const cut = dropTrailingAssistant({ ui: uiRef.current, canonical: canonicalRef.current });
    uiRef.current = cut.ui;
    canonicalRef.current = cut.canonical;
    setMessages(cut.ui);
    approvalsRef.current = [];
    verdictsRef.current = [];
    setPendingApprovals([]);
    await run();
  }, [run]);

  const editAndResend = useCallback(
    async (messageId: string, text: string): Promise<void> => {
      const cut = branchBeforeUserMessage(
        { ui: uiRef.current, canonical: canonicalRef.current },
        messageId,
      );
      if (!cut) return; // not a user message — nothing to branch
      uiRef.current = cut.ui;
      canonicalRef.current = cut.canonical;
      setMessages(cut.ui);
      approvalsRef.current = [];
      verdictsRef.current = [];
      setPendingApprovals([]);
      await sendMessage(text);
    },
    [sendMessage],
  );

  const addToolApprovalResponse = useCallback(
    async (response: ToolApprovalResponse): Promise<void> => {
      // Preserve the request's signed token unless the caller set one.
      const request = approvalsRef.current.find((p) => p.approvalId === response.approvalId);
      const verdict =
        response.token === undefined && request?.token !== undefined
          ? { ...response, token: request.token }
          : response;
      verdictsRef.current = [
        ...verdictsRef.current.filter((v) => v.approvalId !== verdict.approvalId),
        verdict,
      ];
      const verdicts = verdictsRef.current;
      const allSettled = approvalsRef.current.every((p) =>
        verdicts.some((v) => v.approvalId === p.approvalId),
      );
      if (!allSettled) return;
      approvalsRef.current = [];
      verdictsRef.current = [];
      setPendingApprovals([]);
      await run(verdicts);
    },
    [run],
  );

  const reconnect = useCallback(async (): Promise<void> => {
    const resume = options.resume;
    if (!resume) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('streaming');
    setError(undefined);
    try {
      const cursor = lastEventIdRef.current;
      let turn: AssistantTurnState;
      if (turnRef.current && cursor !== undefined) {
        turn = turnRef.current; // continue in place — replay dedupes by seq upstream
      } else {
        // No cursor → full replay rebuilds the turn from the start; it lands in
        // the trailing slot (replacing a partial turn if one is on screen).
        turn = createAssistantTurn(genId());
        if (!turnRef.current) pushMessage(turn.message);
      }
      turnRef.current = turn;
      const parts = connectDeuzStream(resume.endpoint, {
        ...(cursor !== undefined ? { lastEventId: cursor } : {}),
        onCursor: (id) => {
          lastEventIdRef.current = id;
        },
        signal: controller.signal,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
      for await (const part of parts) {
        turn = foldPart(turn, part);
        turnRef.current = turn;
        syncTurn(turn);
      }
      if (turn.error !== undefined) throw new Error(turn.error);
      canonicalRef.current = [...canonicalRef.current, assistantMessageFromTurn(turn)];
      turnRef.current = undefined;
      if (turn.approvals.length > 0) {
        approvalsRef.current = turn.approvals;
        verdictsRef.current = [];
        setPendingApprovals(turn.approvals);
      }
    } catch (err) {
      if (controller.signal.aborted) return; // user abort — not an error
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setStatus('error');
      options.onError?.(e);
      return;
    } finally {
      setStatus((s) => (s === 'error' ? s : 'idle'));
    }
  }, [
    options.resume,
    options.fetch,
    options.headers,
    options.generateId,
    options.onError,
    pushMessage,
    syncTurn,
  ]);

  return {
    messages,
    status,
    error,
    pendingApprovals,
    ...(cost !== undefined ? { cost } : {}),
    ...(budgetExceeded !== undefined ? { budgetExceeded } : {}),
    dataParts,
    citations,
    sendMessage,
    stop,
    regenerate,
    editAndResend,
    addToolApprovalResponse,
    reconnect,
  };
}
