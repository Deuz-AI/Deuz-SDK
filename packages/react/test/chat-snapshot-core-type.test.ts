/**
 * This package's `ChatSnapshotV1` and core's (2.4, spec §4.3): the React
 * package keeps its own copy (its core peer is `^2.0.0`, so `src` never
 * imports a core symbol 2.3 lacks), and core publishes the type on `/chat`
 * and `/ui`. The two must stay one shape, so a snapshot a server builds with
 * core's type restores in `useChat` and the other way round. Checked by
 * `npm run typecheck` (tsc); the runtime assertions are no-ops.
 */
import type {
  ChatSnapshotGateV1 as CoreChatSnapshotGateV1,
  ChatSnapshotV1 as CoreChatSnapshotV1,
} from '@deuz-sdk/core/chat';
import type { ChatSnapshotV1 as UiChatSnapshotV1 } from '@deuz-sdk/core/ui';
import { describe, expectTypeOf, it } from 'vitest';
import type { ChatSnapshotGateV1, ChatSnapshotV1 } from '../src/chat-snapshot';

describe("ChatSnapshotV1 here and in core's /chat and /ui", () => {
  it('is one shape: each copy is assignable to the other', () => {
    expectTypeOf<CoreChatSnapshotV1>().toEqualTypeOf<ChatSnapshotV1>();
    expectTypeOf<UiChatSnapshotV1>().toEqualTypeOf<ChatSnapshotV1>();
    expectTypeOf<CoreChatSnapshotGateV1>().toEqualTypeOf<ChatSnapshotGateV1>();
    const toCore = (snapshot: ChatSnapshotV1): CoreChatSnapshotV1 => snapshot;
    const fromCore = (snapshot: CoreChatSnapshotV1): ChatSnapshotV1 => snapshot;
    expectTypeOf(toCore).returns.toEqualTypeOf<CoreChatSnapshotV1>();
    expectTypeOf(fromCore).returns.toEqualTypeOf<ChatSnapshotV1>();
  });
});
