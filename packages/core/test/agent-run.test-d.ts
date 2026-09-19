import { expectTypeOf, test } from 'vitest';
import { runAgent, streamAgent } from '../src/agent-run';
import type { AgentResult, AgentRunOptions, AgentArrayElement } from '../src/types/agent-run';
import type { LanguageModel } from '../src/types/model';
import type { StandardSchemaV1 } from '../src/types/schema';

declare const model: LanguageModel;
declare const schema: StandardSchemaV1<unknown, { answer: number }>;
declare const arraySchema: StandardSchemaV1<unknown, { answer: number }[]>;

test('native schema and array-element inference preserve validated output types', () => {
  expectTypeOf(runAgent({ model, prompt: 'x' })).toEqualTypeOf<Promise<AgentResult<string>>>();
  const object = runAgent({ model, prompt: 'x', output: { schema } });
  expectTypeOf(object).toEqualTypeOf<Promise<AgentResult<{ answer: number }>>>();
  const array = streamAgent({
    model,
    prompt: 'x',
    output: { schema: arraySchema, element: { schema } },
  });
  expectTypeOf(array.elementStream).toEqualTypeOf<
    AsyncIterable<AgentArrayElement<{ answer: number }>>
  >();
  expectTypeOf(array.partialOutputStream).toEqualTypeOf<
    AsyncIterable<{ attempt: number; value: unknown }>
  >();
  const invalid: AgentRunOptions<{ answer: number }> = {
    model,
    prompt: 'x',
    // @ts-expect-error Raw JSON schema cannot promise runtime validation without a validator.
    output: { schema: { type: 'object' } },
  };
  void invalid;
  // @ts-expect-error A non-text result type needs a validating output contract.
  void runAgent<number>({ model, prompt: 'x' });
  // @ts-expect-error Unsupported native options remain on the legacy API only.
  const unsupported: AgentRunOptions = { model, prompt: 'x', memory: {} };
  void unsupported;
});

test('only the completed discriminant permits access to output', () => {
  declareResult(undefined as unknown as AgentResult<{ answer: number }>);
});

function declareResult(result: AgentResult<{ answer: number }>): void {
  if (result.status === 'completed') expectTypeOf(result.output.answer).toEqualTypeOf<number>();
  else {
    // @ts-expect-error Partial/suspended/stopped outputs are never validated T.
    void result.output;
  }
}
