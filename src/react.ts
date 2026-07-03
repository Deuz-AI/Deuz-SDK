/**
 * React bindings over the Deuz UI wire (`readDeuzStream`). Plain hooks — no
 * JSX, no framework coupling; React is an OPTIONAL peer (^18 || ^19). SSR-safe:
 * network only runs inside user-triggered callbacks, never at render time.
 * Edge-lint applies here — ids come from a module counter, not crypto.
 */
import { useCallback, useRef, useState } from 'react';
import type { DeepPartial } from './types/methods';
import type { Message, Part } from './types/message';
import type { ToolApprovalRequest, ToolApprovalResponse } from './types/tool';
import { readDeuzStream } from './ui';

/** Instance-local id source — `crypto.randomUUID()` is banned by the edge lint. */
let nextUiId = 0;
const genId = (): string => `deuz-ui-${nextUiId++}`;

// --- useObject ---

export interface UseObjectOptions {
  /** Endpoint serving `toDeuzObjectStreamResponse` output. */
  api: string;
  headers?: Record<string, string>;
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface UseObjectResult<T> {
  /** Latest partial (each `object-delta` replaces it wholesale). */
  object: DeepPartial<T> | undefined;
  isLoading: boolean;
  error: Error | undefined;
  /** POSTs `{ input }` to `api` and streams partials into `object`. */
  submit: (input: unknown) => Promise<void>;
  /** Abort the in-flight stream (not an error). */
  stop: () => void;
}

export function useObject<T = unknown>(options: UseObjectOptions): UseObjectResult<T> {
  const [object, setObject] = useState<DeepPartial<T> | undefined>(undefined);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const submit = useCallback(
    async (input: unknown): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(undefined);
      setObject(undefined);
      try {
        const doFetch = options.fetch ?? fetch;
        const res = await doFetch(options.api, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        });
        for await (const part of readDeuzStream(res)) {
          if (part.type === 'object-delta') {
            setObject(part.object as DeepPartial<T>);
          } else if (part.type === 'error') {
            setError(new Error(part.message));
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setLoading(false);
      }
    },
    [options.api, options.fetch, options.headers],
  );

  return { object, isLoading, error, submit, stop };
}

// --- useChat ---

export interface UIToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  /** 'call' = streamed; 'result' = executed (server or client); 'approval-requested' = awaiting a verdict. */
  state: 'call' | 'result' | 'approval-requested';
}

/** Render-friendly message. The canonical `Message[]` history is kept internally for POSTing. */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: UIToolCall[];
}

export interface UseChatOptions {
  /** Endpoint serving `toDeuzStreamResponse` output. */
  api: string;
  /** Seed canonical history (e.g. restored from storage). */
  initialMessages?: Message[];
  headers?: Record<string, string>;
  /** Extra fields merged into every request body. */
  body?: Record<string, unknown>;
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
  sendMessage: (text: string) => Promise<void>;
  /** Drop the trailing assistant/tool turns and re-run the last user turn. */
  regenerate: () => Promise<void>;
  /** Abort the in-flight stream (not an error). */
  stop: () => void;
  /** Gated tool calls awaiting verdicts — the chat is PAUSED while non-empty. */
  pendingApprovals: ToolApprovalRequest[];
  /**
   * Record one verdict. Once EVERY pending approval has a verdict, the chat
   * auto-resumes with `approvalResponses` in the request body (the server
   * settles the calls — the client never builds gated tool_results itself).
   */
  addToolApprovalResponse: (response: ToolApprovalResponse) => Promise<void>;
}

export function useChat(options: UseChatOptions): UseChatResult {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<Error | undefined>(undefined);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const canonicalRef = useRef<Message[]>(
    options.initialMessages ? [...options.initialMessages] : [],
  );
  const approvalsRef = useRef<ToolApprovalRequest[]>([]);
  const verdictsRef = useRef<ToolApprovalResponse[]>([]);
  const abortRef = useRef<AbortController | null>(null);

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
              ...(approvalResponses?.length ? { approvalResponses } : {}),
              ...options.body,
            }),
            signal: controller.signal,
          });
          approvalResponses = undefined; // consumed by the first round only

          let currentId = genId();
          let text = '';
          let reasoning = '';
          const toolCalls: UIToolCall[] = [];
          const approvals: ToolApprovalRequest[] = [];
          const serverResults = new Set<string>();
          setMessages((prev) => [...prev, { id: currentId, role: 'assistant', content: '' }]);
          const applyAssistant = (patch: Partial<UIMessage>, newId?: string): void => {
            const fromId = currentId;
            if (newId) currentId = newId;
            setMessages((prev) =>
              prev.map((m) => (m.id === fromId ? { ...m, ...patch, id: newId ?? m.id } : m)),
            );
          };

          for await (const part of readDeuzStream(res)) {
            switch (part.type) {
              case 'start':
                applyAssistant({}, part.messageId);
                break;
              case 'text-delta':
                text += part.text;
                applyAssistant({ content: text });
                break;
              case 'reasoning-delta':
                reasoning += part.text;
                applyAssistant({ reasoning });
                break;
              case 'tool-call':
                toolCalls.push({
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  state: 'call',
                });
                applyAssistant({ toolCalls: [...toolCalls] });
                break;
              case 'tool-result': {
                serverResults.add(part.toolCallId);
                const tc = toolCalls.find((t) => t.toolCallId === part.toolCallId);
                if (tc) {
                  tc.state = 'result';
                  tc.output = part.output;
                  if (part.isError) tc.isError = true;
                  applyAssistant({ toolCalls: [...toolCalls] });
                }
                break;
              }
              case 'tool-approval-request': {
                approvals.push({
                  approvalId: part.approvalId,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });
                const tc = toolCalls.find((t) => t.toolCallId === part.toolCallId);
                if (tc) {
                  tc.state = 'approval-requested';
                  applyAssistant({ toolCalls: [...toolCalls] });
                }
                break;
              }
              case 'error':
                throw new Error(part.message);
              default:
                break; // additive union — ignore the rest
            }
          }

          // Append the canonical assistant turn (client-tools.mdx reconstruction).
          const toolUses: Part[] = toolCalls.map((t) => ({
            type: 'tool_use',
            id: t.toolCallId,
            name: t.toolName,
            input: t.input,
          }));
          const content: string | Part[] =
            toolUses.length > 0
              ? [...(text ? [{ type: 'text' as const, text }] : []), ...toolUses]
              : text;
          canonicalRef.current = [...canonicalRef.current, { role: 'assistant', content }];

          // Approval pause: verdicts arrive via addToolApprovalResponse.
          if (approvals.length > 0) {
            approvalsRef.current = approvals;
            verdictsRef.current = [];
            setPendingApprovals(approvals);
            return;
          }

          // Client-tool auto-round-trip: everything the server didn't execute.
          const clientPending = toolCalls.filter((t) => !serverResults.has(t.toolCallId));
          if (clientPending.length === 0 || !options.onToolCall) return;
          const resultParts: Part[] = [];
          for (const call of clientPending) {
            try {
              const out = await options.onToolCall({
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              });
              call.state = 'result';
              call.output = out;
              resultParts.push({ type: 'tool_result', toolUseId: call.toolCallId, result: out });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              call.state = 'result';
              call.output = message;
              call.isError = true;
              resultParts.push({
                type: 'tool_result',
                toolUseId: call.toolCallId,
                result: message,
                isError: true,
              });
            }
            applyAssistant({ toolCalls: [...toolCalls] });
          }
          canonicalRef.current = [...canonicalRef.current, { role: 'tool', content: resultParts }];
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
      options.onToolCall,
      options.onError,
    ],
  );

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      canonicalRef.current = [...canonicalRef.current, { role: 'user', content: text }];
      setMessages((prev) => [...prev, { id: genId(), role: 'user', content: text }]);
      approvalsRef.current = [];
      verdictsRef.current = [];
      setPendingApprovals([]);
      await run();
    },
    [run],
  );

  const regenerate = useCallback(async (): Promise<void> => {
    const canonical = [...canonicalRef.current];
    while (canonical.length > 0 && canonical[canonical.length - 1]!.role !== 'user')
      canonical.pop();
    canonicalRef.current = canonical;
    setMessages((prev) => {
      const next = [...prev];
      while (next.length > 0 && next[next.length - 1]!.role !== 'user') next.pop();
      return next;
    });
    approvalsRef.current = [];
    verdictsRef.current = [];
    setPendingApprovals([]);
    await run();
  }, [run]);

  const addToolApprovalResponse = useCallback(
    async (response: ToolApprovalResponse): Promise<void> => {
      verdictsRef.current = [
        ...verdictsRef.current.filter((v) => v.approvalId !== response.approvalId),
        response,
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

  return {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    stop,
    pendingApprovals,
    addToolApprovalResponse,
  };
}

/** @deprecated The hooks are live — use `useChat` directly. Kept for the locked export name. */
export function createUseChat(): typeof useChat {
  return useChat;
}
