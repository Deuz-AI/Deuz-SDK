import { expectTypeOf, test } from 'vitest';
import {
  createA2AAgentExecutor,
  createA2AHandler,
  type A2AAgentAction,
  type A2AAgentAnswers,
  type A2AAgentEngine,
  type A2AAgentExecutorOptions,
  type A2AAgentFailed,
  type A2AAgentPendingActions,
  type A2AAgentRunContext,
  type A2AAgentStopped,
  type A2AAgentCard,
  type A2AExecutor,
  type A2APart,
  type A2ATask,
} from '../src/a2a';
import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '../src/agent';
import type { LanguageModel } from '../src/types/model';

declare const card: A2AAgentCard;
declare const model: LanguageModel;
const store = createInMemoryAgentRunStore();
const agent = { streamAgent, resumeStreamAgent };

test('the native engine plugs in as { streamAgent, resumeStreamAgent }', () => {
  expectTypeOf(agent).toMatchTypeOf<A2AAgentEngine>();
  const executor = createA2AAgentExecutor({ agent, store, run: { model, bindingId: 'v1' } });
  expectTypeOf(executor).toEqualTypeOf<A2AExecutor>();
  createA2AHandler({ card, executor });
  // @ts-expect-error the engine needs both legs
  createA2AAgentExecutor({ agent: { streamAgent }, store, run: { model } });
});

test('a typed output infers the run’s output type, and an explicit one is checked', () => {
  createA2AAgentExecutor({
    agent,
    store,
    run: {
      model,
      output: {
        schema: { type: 'object' },
        validate: (value: unknown) => ({ answer: Number((value as { answer: unknown }).answer) }),
      },
    },
  });
  createA2AAgentExecutor<{ answer: number }>({
    agent,
    store,
    run: {
      model,
      output: {
        schema: { type: 'object' },
        // @ts-expect-error the validator must give the declared output type
        validate: (value: unknown) => String(value),
      },
    },
  });
});

test('run is the options, or a function of the turn that gives them', () => {
  createA2AAgentExecutor({
    agent,
    store,
    run: async (context) => {
      expectTypeOf(context).toEqualTypeOf<A2AAgentRunContext>();
      expectTypeOf(context.task).toEqualTypeOf<A2ATask | undefined>();
      expectTypeOf(context.owner).toEqualTypeOf<string | undefined>();
      expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>();
      // The update methods stay with the executor.
      expectTypeOf(context).not.toHaveProperty('working');
      return { model, prompt: `Answer: ${context.message.parts.length}` };
    },
  });
});

test('drafts is an optional boolean', () => {
  expectTypeOf<A2AAgentExecutorOptions['drafts']>().toEqualTypeOf<boolean | undefined>();
  createA2AAgentExecutor({ agent, store, run: { model }, drafts: true });
  // @ts-expect-error drafts is on or off
  createA2AAgentExecutor({ agent, store, run: { model }, drafts: 'auto' });
});

test('the options the executor sets on every leg are not run options', () => {
  createA2AAgentExecutor({
    agent,
    store,
    // @ts-expect-error the session is the task's
    run: { model, session: { store, runId: 'r', scope: 's' } },
  });
  // @ts-expect-error the answers come from the client's message
  createA2AAgentExecutor({ agent, store, run: { model, approvalResponses: [] } });
  // @ts-expect-error the signal is the task's
  createA2AAgentExecutor({ agent, store, run: { model, signal: new AbortController().signal } });
});

test('the data parts narrow by their type, an action by its kind', () => {
  const read = (data: A2AAgentPendingActions | A2AAgentStopped | A2AAgentFailed) => {
    if (data.type === 'pending-actions') {
      for (const action of data.actions) {
        expectTypeOf(action).toEqualTypeOf<A2AAgentAction>();
        if (action.kind === 'approval') expectTypeOf(action.approvalId).toEqualTypeOf<string>();
        else expectTypeOf(action.input).toEqualTypeOf<unknown>();
      }
    } else if (data.type === 'stopped') expectTypeOf(data.reason).toEqualTypeOf<string>();
    else expectTypeOf(data.error.name).toEqualTypeOf<string>();
  };
  void read;
  const answers: A2AAgentAnswers = {
    approvalResponses: [{ approvalId: 'call_1@x', approved: true, token: 'v1.a.b' }],
    clientToolResults: [{ toolCallId: 'call_2', output: { title: 'Weather' } }],
  };
  const part: A2APart = { data: answers };
  void part;
});
