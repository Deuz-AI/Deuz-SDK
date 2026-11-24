import { expectTypeOf, test } from 'vitest';
import { createToolSearch } from '../src/tool-search';
import { generateText, streamChat } from '../src/generate';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import type { AgentResult, AgentToolSet } from '../src/types/agent-run';
import type { CommonCallOptions } from '../src/types/config';
import type { GenerateTextResult, StreamChatResult } from '../src/types';
import type { Guardrails } from '../src/types/guardrails';
import type { LanguageModel } from '../src/types/model';
import type { Tool, ToolSet } from '../src/types/tool';
import type { ToolSearchTool } from '../src/types/tool-search';

declare const model: LanguageModel;
declare const catalog: { send_email: Tool<{ to: string }, string>; get_time: Tool };
declare const agentCatalog: AgentToolSet;
declare const extra: Tool<{ q: string }, number>;

const search = createToolSearch({ tools: catalog });
const nativeSearch = createToolSearch({ tools: agentCatalog });

test('the documented one-liners typecheck for every call', () => {
  expectTypeOf(
    generateText(search.apply({ model, prompt: 'mail bob', maxSteps: 8 })),
  ).toEqualTypeOf<Promise<GenerateTextResult>>();
  expectTypeOf(
    streamChat(search.apply({ model, prompt: 'mail bob', maxSteps: 8 })),
  ).toEqualTypeOf<StreamChatResult>();
  expectTypeOf(
    runAgent(nativeSearch.apply({ model, prompt: 'mail bob', maxSteps: 8 })),
  ).toEqualTypeOf<Promise<AgentResult<string>>>();
  const legacy = { store: createInMemoryAgentRunStore(), runId: 'r', scope: 't' };
  expectTypeOf(runAgent(nativeSearch.apply({ model, prompt: 'x', session: legacy }))).toEqualTypeOf<
    Promise<AgentResult<string>>
  >();
  const v3 = { store: createInMemoryAgentRunStoreV3(), runId: 'r', scope: 't' };
  expectTypeOf(
    runAgent(nativeSearch.apply({ model, prompt: 'x', checkpointVersion: 3, session: v3 })),
  ).toEqualTypeOf<Promise<AgentResult<string>>>();
});

test("the result keeps the caller's own fields and types the three it replaces", () => {
  const applied = search.apply({ model, prompt: 'x', maxSteps: 4, tools: { extra } });
  expectTypeOf(applied.model).toEqualTypeOf<LanguageModel>();
  expectTypeOf(applied.prompt).toEqualTypeOf<string>();
  expectTypeOf(applied.maxSteps).toEqualTypeOf<number>();
  expectTypeOf(applied.prepareStep).toEqualTypeOf<NonNullable<CommonCallOptions['prepareStep']>>();
  expectTypeOf(applied.guardrails).toEqualTypeOf<Guardrails | undefined>();
  expectTypeOf(applied.tools.extra).toExtend<Tool<{ q: string }, number>>();
  expectTypeOf(applied.tools.send_email).toExtend<Tool<{ to: string }, string>>();
  // The search tool's name is configurable, so it is reached through the index signature.
  expectTypeOf(applied.tools.tool_search).toEqualTypeOf<ToolSearchTool | undefined>();
  expectTypeOf(applied.tools).toExtend<ToolSet>();
});

test('the fields apply composes with are still checked', () => {
  // @ts-expect-error activeTools is a list of names
  void search.apply({ model, prompt: 'x', activeTools: 'send_email' });
  // @ts-expect-error onToolCall is a guardrail or a list of them
  void search.apply({ model, prompt: 'x', guardrails: { onToolCall: 42 } });
  void search.apply({
    model,
    prompt: 'x',
    prepareStep: (ctx) => {
      expectTypeOf(ctx.stepIndex).toEqualTypeOf<number>();
      return { activeTools: ['send_email'] };
    },
  });
});
