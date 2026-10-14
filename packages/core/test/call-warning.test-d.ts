import { expectTypeOf } from 'vitest';
import type { CallWarning } from '../src/index';

// 2.4 widens the warning union with the notices its new paths report. The full
// union is locked in `surface.test-d.ts`; this pins each 2.4 member and that a
// warning built against the 2.3 members still type-checks.
expectTypeOf<'embedding-mismatch'>().toMatchTypeOf<CallWarning['type']>();
expectTypeOf<'unaccounted-usage'>().toMatchTypeOf<CallWarning['type']>();
expectTypeOf<'context-source-failed'>().toMatchTypeOf<CallWarning['type']>();
expectTypeOf<'stream-store-error'>().toMatchTypeOf<CallWarning['type']>();
expectTypeOf<'memory-extraction-partial'>().toMatchTypeOf<CallWarning['type']>();

expectTypeOf<{ type: 'unpriced-model'; message: string }>().toMatchTypeOf<CallWarning>();
expectTypeOf<{
  type: 'memory-extraction-partial';
  setting: 'memory';
  message: string;
}>().toMatchTypeOf<CallWarning>();
