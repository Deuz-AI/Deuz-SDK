/**
 * Type contract of the eval suite in `@deuz-sdk/core/testing` (2.3), checked by
 * `npm run test:types`.
 */
import { describe, expectTypeOf, it } from 'vitest';
import { runAgent } from '../../src/agent';
import type { AgentResult } from '../../src/agent';
import { runEvalSuite } from '../../src/testing';
import type {
  EvalAttemptReport,
  EvalRecovery,
  EvalSuiteReport,
  EvalTaskContext,
  EvalTaskManifest,
  EvalTaskOutcome,
  EvalTier,
  RunEvalSuiteOptions,
} from '../../src/testing';
import type { ToolApprovalRequest, ToolApprovalResponse } from '../../src/types/tool';

describe('eval suite types (2.3)', () => {
  it('names the tiers and the recovery classes', () => {
    expectTypeOf<EvalTier>().toEqualTypeOf<'offline' | 'real-model'>();
    expectTypeOf<EvalRecovery>().toEqualTypeOf<
      'not-needed' | 'recovered' | 'rescued' | 'contained' | 'failed'
    >();
    expectTypeOf<EvalAttemptReport['status']>().toEqualTypeOf<
      'completed' | 'suspended' | 'stopped' | 'failed' | 'timeout' | 'error'
    >();
  });

  it('takes manifests and options, and resolves to the report', () => {
    expectTypeOf(runEvalSuite).parameters.toEqualTypeOf<
      [tasks: readonly EvalTaskManifest[], options?: RunEvalSuiteOptions]
    >();
    expectTypeOf(runEvalSuite).returns.toEqualTypeOf<Promise<EvalSuiteReport>>();
    expectTypeOf<EvalSuiteReport['format']>().toEqualTypeOf<'deuz-eval-suite'>();
  });

  it('accepts a native result as an outcome, and a typed task in a suite', () => {
    expectTypeOf<AgentResult<{ total: number }>>().toMatchTypeOf<
      EvalTaskOutcome<{ total: number }>
    >();
    expectTypeOf<EvalTaskManifest<{ total: number }>>().toMatchTypeOf<EvalTaskManifest>();
    const task: EvalTaskManifest = {
      id: 't',
      version: 1,
      acceptance: [{ name: 'done', check: (outcome) => outcome.status === 'completed' }],
      run: (context) => runAgent({ model: {} as never, messages: context.messages }),
    };
    expectTypeOf(task).toMatchTypeOf<EvalTaskManifest>();
  });

  it('hands an attempt its recorders', () => {
    expectTypeOf<EvalTaskContext['approve']>().toEqualTypeOf<
      (requests: readonly ToolApprovalRequest[], approved?: boolean) => ToolApprovalResponse[]
    >();
    expectTypeOf<EvalTaskContext['effect']>().toEqualTypeOf<(key: string) => void>();
    expectTypeOf<RunEvalSuiteOptions['report']>().toEqualTypeOf<
      string | ((report: EvalSuiteReport) => void | Promise<void>) | undefined
    >();
  });
});
