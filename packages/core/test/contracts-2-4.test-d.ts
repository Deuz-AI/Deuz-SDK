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
import type { GoalStore } from '../src/goal';
import type {
  FetchHandler,
  GoalRuntimeStore,
  ScheduleSpec,
  GoalInboxEnqueueResult,
} from '../src/goal/runtime';
import type {
  AgentEvent,
  AgentRunEnvelope,
  AgentRunMemoryExtraction,
  AgentStream,
} from '../src/types/agent-run';
import type {
  AgentEventV3,
  AgentRunEnvelopeV3,
  AgentRunMemoryExtractionV3,
  AgentStreamV3,
} from '../src/types/agent-run-v3';

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

describe('goal runtime', () => {
  it('a goal runtime store is a GoalStore (the 2.3 conformance fixture runs against it)', () => {
    expectTypeOf<GoalRuntimeStore>().toMatchTypeOf<GoalStore>();
  });

  it('serves webhooks with the Fetch API signature', () => {
    expectTypeOf<FetchHandler>().toEqualTypeOf<(request: Request) => Promise<Response>>();
    expectTypeOf<GoalInboxEnqueueResult['status']>().toEqualTypeOf<
      'enqueued' | 'duplicate' | 'conflict'
    >();
  });

  it('names the DST and catch-up policies of spec §3.2', () => {
    expectTypeOf<NonNullable<ScheduleSpec['dstGap']>>().toEqualTypeOf<'shift' | 'skip'>();
    expectTypeOf<NonNullable<ScheduleSpec['dstOverlap']>>().toEqualTypeOf<'first' | 'both'>();
    expectTypeOf<NonNullable<ScheduleSpec['catchUp']>>().toEqualTypeOf<'latest' | 'all' | 'none'>();
  });
});

describe('V3 runs', () => {
  it('keeps the 2.3 envelope and its closed unions as they are', () => {
    expectTypeOf<AgentRunEnvelope['version']>().toEqualTypeOf<1 | 2>();
    expectTypeOf<AgentRunMemoryExtraction['status']>().toEqualTypeOf<
      'pending' | 'completed' | 'failed'
    >();
    expectTypeOf<AgentEvent['type']>().toEqualTypeOf<
      'part' | 'phase' | 'partial-output' | 'array-element' | 'tool-output' | 'result'
    >();
  });

  it('adds version 3, the partial extraction and a separate event union', () => {
    expectTypeOf<AgentRunEnvelopeV3['version']>().toEqualTypeOf<3>();
    expectTypeOf<AgentRunMemoryExtractionV3['status']>().toEqualTypeOf<
      'pending' | 'completed' | 'partial' | 'failed'
    >();
    expectTypeOf<AgentEvent>().toMatchTypeOf<AgentEventV3>();
    expectTypeOf<AgentEventV3['type']>().toEqualTypeOf<
      AgentEvent['type'] | 'context' | 'working-memory' | 'memory-intent'
    >();
  });

  it('streams a V3 run as an AgentStream, so the UI bridge takes it unchanged', () => {
    expectTypeOf<AgentStreamV3>().toMatchTypeOf<AgentStream>();
  });
});
