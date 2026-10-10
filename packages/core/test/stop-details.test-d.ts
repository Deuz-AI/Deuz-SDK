import { expectTypeOf } from 'vitest';
import type {
  GenerateObjectResult,
  StepResult,
  StopDetails,
  StreamChatResult,
  StreamObjectResult,
} from '../src/index';

// The provider's stop explanation rides every result (2.3, F16): optional and
// additive, a plain value on buffered results and a promise on streams.
expectTypeOf<StreamChatResult['stopDetails']>().toEqualTypeOf<
  Promise<StopDetails | undefined> | undefined
>();
expectTypeOf<GenerateObjectResult['stopDetails']>().toEqualTypeOf<StopDetails | undefined>();
expectTypeOf<StreamObjectResult['stopDetails']>().toEqualTypeOf<
  Promise<StopDetails | undefined> | undefined
>();
expectTypeOf<StepResult['stopDetails']>().toEqualTypeOf<StopDetails | undefined>();

// A result written before 2.3 (no `stopDetails`) still type-checks.
expectTypeOf<{
  object: unknown;
  usage: GenerateObjectResult['usage'];
  finishReason: GenerateObjectResult['finishReason'];
}>().toMatchTypeOf<GenerateObjectResult>();
