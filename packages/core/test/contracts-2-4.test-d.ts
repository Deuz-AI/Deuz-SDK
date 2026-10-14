/**
 * Type contracts of the 2.4 skeletons (W0), checked by `npm run test:types`:
 * the compatibility properties the spec requires of them, which no runtime
 * test of a stub can see. A 2.4 store must plug in where its 2.3 seam goes;
 * 2.3 unions stay closed and the new ones are exactly what the spec names.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { ChatStore } from '../src/chat';
import type { ConditionalChatStore, TranscriptIndex } from '../src/chat';
import type {
  ContextBlock,
  ContextPlacement,
  ContextRefreshReason,
  ContextSourceKind,
  WorkingMemoryConstraint,
  WorkingMemoryGoal,
  WorkingMemoryPatchResult,
} from '../src/context';
import type { GoalErrorCode } from '../src/goal';
import type {
  MemoryOrigin,
  MemorySourceKind,
  VersionedMemoryCommitResult,
} from '../src/memory/versioned';
import type { BudgetReservation, BudgetReservationInput, BudgetTotals } from '../src/agent';
import type { DurableStreamStateStore, StreamStateStore } from '../src/ui';
import type { ConflictSubsystem, StoreFeature } from '../src/errors';

describe('2.4 stores plug into their 2.3 seams', () => {
  it('a conditional chat store is a ChatStore', () => {
    expectTypeOf<ConditionalChatStore>().toMatchTypeOf<ChatStore>();
  });

  it('a durable stream store is a StreamStateStore, so replay reads it unchanged', () => {
    expectTypeOf<DurableStreamStateStore>().toMatchTypeOf<StreamStateStore>();
  });

  it('a transcript search is scoped by the memory scope of chats', () => {
    expectTypeOf<Parameters<TranscriptIndex['search']>[0]>().toEqualTypeOf<
      Parameters<NonNullable<ChatStore['listChats']>>[0] & {}
    >();
  });
});

describe('context placement', () => {
  it('has exactly the two placements of spec §2.3', () => {
    expectTypeOf<ContextPlacement>().toEqualTypeOf<'append' | 'ephemeral-tail'>();
    expectTypeOf<ContextBlock['kind']>().toEqualTypeOf<'retrieval' | 'working-memory'>();
  });

  it('names the source kinds and refresh reasons', () => {
    expectTypeOf<ContextSourceKind>().toEqualTypeOf<'memory' | 'rag' | 'transcript' | 'skills'>();
    expectTypeOf<ContextRefreshReason>().toEqualTypeOf<
      'initial' | 'active-task-changed' | 'host-request' | 'reused' | 'overflow-retry' | 'redacted'
    >();
  });
});

describe('working memory', () => {
  it('lets only the host write the goal and constraints', () => {
    expectTypeOf<WorkingMemoryGoal['writer']>().toEqualTypeOf<'host'>();
    expectTypeOf<WorkingMemoryConstraint['writer']>().toEqualTypeOf<'host'>();
  });

  it('always hands back the snapshot to keep', () => {
    expectTypeOf<WorkingMemoryPatchResult['status']>().toEqualTypeOf<
      'applied' | 'duplicate' | 'conflict' | 'rejected'
    >();
    expectTypeOf<WorkingMemoryPatchResult>().toHaveProperty('snapshot');
  });
});

describe('versioned memory', () => {
  it('names the origins and source kinds of spec §2.1', () => {
    expectTypeOf<MemoryOrigin>().toEqualTypeOf<'asserted' | 'inferred'>();
    expectTypeOf<MemorySourceKind>().toEqualTypeOf<
      'user' | 'assistant' | 'tool' | 'external' | 'host'
    >();
    expectTypeOf<VersionedMemoryCommitResult['status']>().toEqualTypeOf<
      'committed' | 'replayed' | 'conflict'
    >();
  });
});

describe('accounting', () => {
  it('adds unaccounted as optional fields only', () => {
    expectTypeOf<BudgetReservationInput['unaccounted']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<BudgetReservation['unaccounted']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<BudgetTotals['unaccounted']>().toEqualTypeOf<number | undefined>();
  });
});

describe('error codes', () => {
  it('widens GoalErrorCode by the four 2.4 codes', () => {
    expectTypeOf<GoalErrorCode>().toEqualTypeOf<
      | 'invalid_goal'
      | 'invalid_event'
      | 'invalid_command'
      | 'unsupported_version'
      | 'revision_conflict'
      | 'scope_mismatch'
      | 'lease_lost'
      | 'stale'
      | 'policy_limit'
      | 'delivery_conflict'
    >();
  });

  it('names the conflict subsystems and store features', () => {
    expectTypeOf<ConflictSubsystem>().toEqualTypeOf<
      'memory' | 'chat' | 'stream' | 'process' | 'run'
    >();
    expectTypeOf<StoreFeature>().toEqualTypeOf<
      | 'agent-run-v3'
      | 'versioned-memory'
      | 'goal-runtime'
      | 'conditional-chat'
      | 'transcript-index'
      | 'process-operations'
    >();
  });
});
