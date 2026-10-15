import { expectTypeOf, test } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  resumeAgent,
  resumeStreamAgent,
  runAgent,
  streamAgent,
} from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import type { AgentResult, AgentRunReconciliation, AgentStream } from '../src/types/agent-run';
import type { AgentEventV3, AgentStreamV3 } from '../src/types/agent-run-v3';
import type { LanguageModel } from '../src/types/model';
import type { StandardSchemaV1 } from '../src/types/schema';

declare const model: LanguageModel;
declare const schema: StandardSchemaV1<unknown, { answer: number }>;

const v3 = { store: createInMemoryAgentRunStoreV3(), runId: 'r', scope: 't' };
const legacy = { store: createInMemoryAgentRunStore(), runId: 'r', scope: 't' };

test('checkpointVersion 3 selects the V3 overloads', () => {
  expectTypeOf(runAgent({ model, prompt: 'x', checkpointVersion: 3, session: v3 })).toEqualTypeOf<
    Promise<AgentResult<string>>
  >();
  const typed = runAgent({
    model,
    prompt: 'x',
    checkpointVersion: 3,
    session: v3,
    output: { schema },
  });
  expectTypeOf(typed).toEqualTypeOf<Promise<AgentResult<{ answer: number }>>>();
  const stream = streamAgent({ model, prompt: 'x', checkpointVersion: 3, session: v3 });
  expectTypeOf(stream).toEqualTypeOf<AgentStreamV3>();
  expectTypeOf(stream.eventsV3).toEqualTypeOf<AsyncIterable<AgentEventV3>>();
  expectTypeOf(resumeAgent({ model, checkpointVersion: 3, session: v3 })).toEqualTypeOf<
    Promise<AgentResult<string>>
  >();
  expectTypeOf(
    resumeStreamAgent({ model, checkpointVersion: 3, session: v3 }),
  ).toEqualTypeOf<AgentStreamV3>();
  expectTypeOf(reconcileAgentRun({ checkpointVersion: 3, session: v3 })).toEqualTypeOf<
    Promise<AgentRunReconciliation>
  >();
});

test('without it, every call keeps its 2.3 type', () => {
  expectTypeOf(streamAgent({ model, prompt: 'x' })).toEqualTypeOf<AgentStream>();
  expectTypeOf(resumeStreamAgent({ model, session: legacy })).toEqualTypeOf<AgentStream>();
  expectTypeOf(reconcileAgentRun({ session: legacy })).toEqualTypeOf<
    Promise<AgentRunReconciliation>
  >();
});

test('a V3 run needs a V3 store, and the V3 options need a V3 run', () => {
  // @ts-expect-error a 2.3 AgentRunStore keeps version 1 and 2 runs only
  void runAgent({ model, prompt: 'x', checkpointVersion: 3, session: legacy });
  // @ts-expect-error the context compiler is a V3 option
  void runAgent({ model, prompt: 'x', context: { sources: [] } });
  // @ts-expect-error a V3 run requires its session
  void runAgent({ model, prompt: 'x', checkpointVersion: 3 });
});
