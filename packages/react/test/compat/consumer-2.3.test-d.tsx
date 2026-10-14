/**
 * Frozen 2.3 consumer fixture for @deuz-sdk/react (2.4, W0A): the hooks,
 * components and re-exported types used the way a 2.3 application uses them.
 * A 2.4 change that removes an option or a result field, narrows a type a
 * component reads, or adds a required member to an interface the application
 * implements (`UseChatCursorStore`) breaks this file.
 *
 * The react package has no vitest type-test run: `npm run typecheck -w
 * @deuz-sdk/react` (tsc over `src` and `test`) checks this file, and vitest
 * never runs it (its name does not end in `.test.tsx`). Unions the UI reads may
 * widen in a 2.x release, so they are checked to still hold their 2.3 members,
 * never exhaustively.
 */
import { expectTypeOf } from 'vitest';
import {
  useChat,
  partsFromFiles,
  useObject,
  ToolApprovalCard,
  CostBadge,
  type UseChatOptions,
  type UseChatResult,
  type UseChatCost,
  type UseChatBudgetExceeded,
  type UseChatResumeOptions,
  type UseChatCursorStore,
  type UseChatAgent,
  type UseChatStopDetails,
  type UseObjectOptions,
  type UseObjectResult,
  type ToolApprovalCardProps,
  type CostBadgeProps,
  type UIMessage,
  type UIMessagePart,
  type UIToolCall,
  type AssistantTurnState,
  type ChatHistory,
  type ChatInput,
  type DeuzUIPart,
  type Message,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
} from '../../src/index';

declare const approval: ToolApprovalRequest;

const cursor: UseChatCursorStore = {
  load: () => undefined,
  save: (_id: string) => {},
};

const resume: UseChatResumeOptions = {
  endpoint: ({ lastEventId }) => new Response(lastEventId ?? ''),
  lastEventId: '7',
  auto: true,
  cursor,
};

const chatOptions: UseChatOptions = {
  api: '/api/chat',
  initialMessages: [{ role: 'user', content: 'hi' }] satisfies Message[],
  headers: { authorization: 'Bearer t' },
  body: { tenant: 't' },
  chatId: 'c',
  resume,
  generateId: () => 'id',
  throttleMs: 50,
  onToolCall: async ({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }),
  onData: ({ name, id, payload }) => ({ name, id, payload }),
  onError: (error: Error) => error.message,
  onHttpError: 'error-part',
  fetch: globalThis.fetch,
};

const objectOptions: UseObjectOptions = {
  api: '/api/object',
  headers: {},
  onHttpError: 'ignore',
  throttleMs: 50,
  fetch: globalThis.fetch,
};

export function ChatConsumer() {
  const chat: UseChatResult = useChat(chatOptions);
  const messages: UIMessage[] = chat.messages;
  const history: ChatHistory = chat.history;
  const error: Error | undefined = chat.error;
  const approvals: ToolApprovalRequest[] = chat.pendingApprovals;
  const toolCalls: UIToolCall[] = chat.pendingToolCalls;
  const cost: UseChatCost | undefined = chat.cost;
  const exceeded: UseChatBudgetExceeded | undefined = chat.budgetExceeded;
  const data: Array<{ name: string; id?: string; payload: unknown }> = chat.dataParts;
  const agent: UseChatAgent | undefined = chat.agent;
  const details: UseChatStopDetails | undefined = chat.stopDetails;
  expectTypeOf<'idle' | 'streaming' | 'error'>().toExtend<UseChatResult['status']>();
  expectTypeOf(chat.citations).toEqualTypeOf<AssistantTurnState['citations']>();
  expectTypeOf(chat.activity).toEqualTypeOf<AssistantTurnState['activity']>();

  const input: ChatInput = { text: 'hi', parts: [] };
  const send: Promise<void> = chat.sendMessage(input);
  const sendText: Promise<void> = chat.sendMessage('hi');
  const regenerate: Promise<void> = chat.regenerate();
  const edit: Promise<void> = chat.editAndResend('m1', 'again');
  const toolResult: Promise<void> = chat.addToolResult({
    toolCallId: 't',
    output: 1,
    isError: false,
  });
  const response: ToolApprovalResponse = { approvalId: 'a', approved: true, reason: 'ok' };
  const approve: Promise<void> = chat.addToolApprovalResponse(response);
  const reconnect: Promise<void> = chat.reconnect();
  chat.stop();
  chat.clearError();
  chat.setHistory((prev) => prev);
  chat.setMessages((prev) => prev);

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const typed: UIMessagePart = part;
      if (typed.type === 'text') expectTypeOf(typed.text).toBeString();
    }
  }

  const object: UseObjectResult<{ city: string }> = useObject<{ city: string }>(objectOptions);
  expectTypeOf(object.object).toEqualTypeOf<{ city?: string } | undefined>();
  const submit: Promise<void> = object.submit({ q: 'weather' });
  object.stop();

  const card: ToolApprovalCardProps = {
    approval,
    onRespond: (r: ToolApprovalResponse) => r,
    render: ({ approve: yes, deny }) => (
      <button onClick={() => (approval.toolName ? yes() : deny('no'))}>{approval.toolName}</button>
    ),
  };
  const badge: CostBadgeProps = { cost, format: (c: UseChatCost) => c.costUsd.toFixed(2) };
  const part: DeuzUIPart = { type: 'text-delta', text: 'hi' };

  expectTypeOf([history, error, approvals, toolCalls, exceeded, data, agent, details]).toBeArray();
  expectTypeOf([
    send,
    sendText,
    regenerate,
    edit,
    toolResult,
    approve,
    reconnect,
    submit,
  ]).toBeArray();
  expectTypeOf(partsFromFiles(null)).resolves.toBeArray();
  expectTypeOf(part).toExtend<DeuzUIPart>();

  return (
    <div>
      <ToolApprovalCard {...card} />
      <ToolApprovalCard approval={approval} onRespond={(r) => r.approved} />
      <CostBadge {...badge} />
      <CostBadge cost={chat.cost} />
    </div>
  );
}
