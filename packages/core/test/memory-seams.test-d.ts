/**
 * MemorySeams.llm keeps its 2.3 type (2.4): code that reads it as a
 * `MemoryLLM`, or awaits its text as a string, still compiles. The accounted
 * variant (`defineAccountedMemoryLLM`) goes in the additive `accountedLlm`.
 */
import { expectTypeOf, test } from 'vitest';
import {
  createInMemoryMemoryStore,
  defineAccountedMemoryLLM,
  type AccountedMemoryLLM,
  type MemoryLLM,
  type MemorySeams,
} from '../src/memory';
import type { Usage } from '../src/types/usage';

const usage: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2,
};

test('seams.llm reads as the 2.3 MemoryLLM', async () => {
  expectTypeOf<MemorySeams['llm']>().toEqualTypeOf<MemoryLLM>();
  const consumer = async (seams: MemorySeams): Promise<string> => {
    const text: string = await seams.llm({ system: 's', user: 'u' });
    const reuse: MemoryLLM = seams.llm;
    return text + (await reuse({ system: 's', user: 'u' }));
  };
  expectTypeOf(consumer).returns.resolves.toEqualTypeOf<string>();
});

test('an accounted memory LLM goes in accountedLlm, beside the plain llm', () => {
  const accounted = defineAccountedMemoryLLM(async () => ({ text: '', usage, modelId: 'm' }));
  expectTypeOf<MemorySeams['accountedLlm']>().toEqualTypeOf<AccountedMemoryLLM | undefined>();
  const seams: MemorySeams = {
    store: createInMemoryMemoryStore(),
    llm: async () => '',
    accountedLlm: accounted,
    clock: { now: () => 0, setTimeout: () => () => {} },
    generateId: () => 'id',
  };
  expectTypeOf(seams.accountedLlm).toEqualTypeOf<AccountedMemoryLLM | undefined>();
});
