/**
 * `GoalRuntimeStore.pruneOccurrences` (2.4, spec §4.4): it takes `before`,
 * or the spec's `olderThan`, exactly one of them; the other retention calls
 * keep `before`.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  GoalRuntimeOccurrencePruneOptions,
  GoalRuntimePruneOptions,
  GoalRuntimeStore,
} from '../src/goal/runtime';

describe('pruneOccurrences options', () => {
  it('takes before or olderThan, with an optional scope', () => {
    expectTypeOf<{ before: number }>().toMatchTypeOf<GoalRuntimeOccurrencePruneOptions>();
    expectTypeOf<{ olderThan: number }>().toMatchTypeOf<GoalRuntimeOccurrencePruneOptions>();
    expectTypeOf<{
      olderThan: number;
      scope: string;
    }>().toMatchTypeOf<GoalRuntimeOccurrencePruneOptions>();
    expectTypeOf<GoalRuntimeStore['pruneOccurrences']>()
      .parameter(0)
      .toEqualTypeOf<GoalRuntimeOccurrencePruneOptions>();
  });

  it('refuses both, or neither', () => {
    expectTypeOf<{
      before: number;
      olderThan: number;
    }>().not.toMatchTypeOf<GoalRuntimeOccurrencePruneOptions>();
    expectTypeOf<{ scope: string }>().not.toMatchTypeOf<GoalRuntimeOccurrencePruneOptions>();
  });

  it('leaves the other retention calls on before', () => {
    expectTypeOf<GoalRuntimeStore['pruneInbox']>()
      .parameter(0)
      .toEqualTypeOf<GoalRuntimePruneOptions>();
    expectTypeOf<{ olderThan: number }>().not.toMatchTypeOf<GoalRuntimePruneOptions>();
  });
});
