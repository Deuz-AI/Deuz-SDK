/**
 * `ChatSnapshotV1` in core (2.4, spec §4.3 "/chat, /ui"): the type a client
 * captures with `exportSnapshot()` and restores with `useChat({
 * initialSnapshot })` is published on `@deuz-sdk/core/chat` and
 * `@deuz-sdk/core/ui`, type only. `@deuz-sdk/react` keeps its own identical
 * copy (its core peer is `^2.0.0`); its tests check that the two are one shape.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  AssistantTurnState,
  ChatRecord,
  ChatSnapshotGateV1,
  ChatSnapshotV1,
  UIToolCall,
} from '../src/chat';
import type {
  ChatSnapshotGateV1 as UiChatSnapshotGateV1,
  ChatSnapshotV1 as UiChatSnapshotV1,
} from '../src/ui';
import type { Message } from '../src/types/message';
import type { ToolApprovalRequest, ToolApprovalResponse } from '../src/types/tool';

describe('ChatSnapshotV1 on core /chat and /ui', () => {
  it('is the same type on both subpaths', () => {
    expectTypeOf<UiChatSnapshotV1>().toEqualTypeOf<ChatSnapshotV1>();
    expectTypeOf<UiChatSnapshotGateV1>().toEqualTypeOf<ChatSnapshotGateV1>();
  });

  it('requires only version 1 and the messages', () => {
    expectTypeOf<ChatSnapshotV1['version']>().toEqualTypeOf<1>();
    expectTypeOf<ChatSnapshotV1['messages']>().toEqualTypeOf<Message[]>();
    expectTypeOf<{ version: 1; messages: Message[] }>().toMatchTypeOf<ChatSnapshotV1>();
    expectTypeOf<{ version: 2; messages: Message[] }>().not.toMatchTypeOf<ChatSnapshotV1>();
  });

  it('restores a stored ChatRecord with its message ids', () => {
    const fromRecord = (record: ChatRecord): ChatSnapshotV1 => ({
      version: 1,
      messages: record.messages,
      ...(record.messageIds ? { messageIds: record.messageIds } : {}),
    });
    expectTypeOf(fromRecord).returns.toEqualTypeOf<ChatSnapshotV1>();
  });

  it('carries the stream cursor, the open turn and the paused gate', () => {
    expectTypeOf<ChatSnapshotV1['cursor']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChatSnapshotV1['turn']>().toEqualTypeOf<AssistantTurnState | undefined>();
    expectTypeOf<ChatSnapshotV1['pendingApprovals']>().toEqualTypeOf<
      ToolApprovalRequest[] | undefined
    >();
    expectTypeOf<ChatSnapshotV1['pendingToolCalls']>().toEqualTypeOf<UIToolCall[] | undefined>();
    expectTypeOf<ChatSnapshotV1['gate']>().toEqualTypeOf<ChatSnapshotGateV1 | undefined>();
    expectTypeOf<ChatSnapshotV1['capabilities']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<ChatSnapshotGateV1['approvalResponses']>().toEqualTypeOf<
      ToolApprovalResponse[] | undefined
    >();
    expectTypeOf<ChatSnapshotGateV1['runId']>().toEqualTypeOf<string | undefined>();
  });
});
