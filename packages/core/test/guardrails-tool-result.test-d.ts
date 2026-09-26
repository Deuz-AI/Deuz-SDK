import { expectTypeOf } from 'vitest';
import type {
  Guardrails,
  GuardrailPart,
  ToolResultGuardrail,
  ToolResultGuardrailContext,
  ToolResultGuardrailResult,
} from '../src/types';
import { maxToolResultLength } from '../src/guardrails';

// The fourth hook sits beside the other three, one guardrail or an ordered array.
expectTypeOf<Guardrails['onToolResult']>().toEqualTypeOf<
  ToolResultGuardrail | ToolResultGuardrail[] | undefined
>();

expectTypeOf<ToolResultGuardrailContext['result']>().toBeUnknown();
expectTypeOf<ToolResultGuardrailContext['isError']>().toEqualTypeOf<boolean>();
expectTypeOf<ToolResultGuardrailResult>().toEqualTypeOf<
  { action: 'pass' } | { action: 'block'; reason?: string } | { action: 'rewrite'; result: unknown }
>();

// Its verdicts report as their own hook.
expectTypeOf<'tool-result'>().toExtend<GuardrailPart['hook']>();

expectTypeOf(maxToolResultLength(100)).toEqualTypeOf<ToolResultGuardrail>();
