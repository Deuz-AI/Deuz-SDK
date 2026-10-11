/**
 * Type contract of `@deuz-sdk/core/headless` (2.3 preview), checked by
 * `npm run test:types`.
 */
import { describe, expectTypeOf, it } from 'vitest';
import { createInMemoryAgentRunStore } from '../src/agent';
import type { AgentOutput } from '../src/agent';
import { createMockModel } from '../src/testing';
import {
  HEADLESS_EXIT_CODES,
  doctor,
  exitCodeFor,
  inspectRun,
  loadProjectInstructions,
  resumeHeadless,
  runHeadless,
} from '../src/node/headless';
import type {
  DoctorReport,
  HeadlessOutcome,
  HeadlessPendingAction,
  HeadlessReport,
  ProjectInstructions,
} from '../src/node/headless';

const model = createMockModel({ responses: [] });
const store = createInMemoryAgentRunStore();

describe('headless types (2.3 preview)', () => {
  it('returns plain reports and maps them to exit codes', () => {
    expectTypeOf(runHeadless).returns.toEqualTypeOf<Promise<HeadlessReport>>();
    expectTypeOf(resumeHeadless).returns.toEqualTypeOf<Promise<HeadlessReport>>();
    expectTypeOf(inspectRun).returns.toEqualTypeOf<Promise<HeadlessReport>>();
    expectTypeOf(doctor).returns.toEqualTypeOf<Promise<DoctorReport>>();
    expectTypeOf(loadProjectInstructions).returns.toEqualTypeOf<Promise<ProjectInstructions>>();
    expectTypeOf(exitCodeFor).parameter(0).toEqualTypeOf<HeadlessReport | DoctorReport>();
    expectTypeOf(exitCodeFor).returns.toEqualTypeOf<number>();
    expectTypeOf<HeadlessOutcome>().toEqualTypeOf<
      'completed' | 'failed' | 'pending' | 'refused' | 'cancelled' | 'limit' | 'stopped'
    >();
    expectTypeOf<keyof typeof HEADLESS_EXIT_CODES>().toEqualTypeOf<
      HeadlessOutcome | 'usage' | 'doctor'
    >();
    expectTypeOf<HeadlessPendingAction['kind']>().toEqualTypeOf<
      'approval' | 'client-tool' | 'unknown-effect' | 'resume'
    >();
  });

  it('makes the session from store, runId and scope', () => {
    void runHeadless({ model, prompt: 'hi', store });
    // @ts-expect-error the session is made from `store`
    void runHeadless({ model, prompt: 'hi', store, session: { store, runId: 'r', scope: 's' } });
    // @ts-expect-error a durable store is required
    void runHeadless({ model, prompt: 'hi' });
    void resumeHeadless({ model, store, runId: 'r' });
    // @ts-expect-error a resume continues the stored transcript
    void resumeHeadless({ model, store, runId: 'r', prompt: 'again' });
    // @ts-expect-error a resume names its run
    void resumeHeadless({ model, store });
  });

  it('keeps runAgent typing: a typed output is required', () => {
    const output = {} as AgentOutput<{ ok: boolean }>;
    void runHeadless<{ ok: boolean }>({ model, prompt: 'hi', store, output });
    // @ts-expect-error a typed run needs its output
    void runHeadless<{ ok: boolean }>({ model, prompt: 'hi', store });
  });
});
