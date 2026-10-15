/**
 * The 2.4 acceptance scenarios (new.txt §5.1). Every lane declares its spec
 * scenarios with `scenario(area, id, fn)` in a `test/scenarios-2-4/<lane>.test.ts`
 * file; `scenarios-count.test.ts` reads those calls statically and holds the
 * per-area minimums of the spec table.
 *
 * A fault scenario (`{ fault: true }`) runs three times, each run on stores it
 * builds itself, with no retry: a recovery that only holds sometimes fails. A
 * scenario's `fn` must therefore create every store, clock and model it uses
 * inside the call, never share one across runs.
 */
import { describe, it } from 'vitest';

export const SCENARIO_MINIMUMS = {
  'versioned-memory': 9,
  context: 10,
  transcript: 2,
  skill: 4,
  supervisor: 8,
  scheduler: 6,
  docker: 6,
  'chat-stream-react': 6,
  acceptance: 3,
  retention: 2,
} as const;

export type ScenarioArea = keyof typeof SCENARIO_MINIMUMS;

/**
 * Turned on by the integrator once every lane that owns scenarios has landed
 * (wave W2): from then on each area must reach its minimum.
 */
export const ENFORCE_SCENARIO_MINIMUMS = true;

export interface ScenarioOptions {
  /** A crash/recovery scenario: three clean runs, no retry. */
  fault?: boolean;
  /** Per-run timeout in ms. */
  timeout?: number;
}

/** Ids are kebab-case so the static count can read them. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function scenario(
  area: ScenarioArea,
  id: string,
  fn: () => unknown,
  options: ScenarioOptions = {},
): void {
  if (!ID.test(id)) throw new Error(`scenario id ${JSON.stringify(id)} must be kebab-case`);
  const name = `${area}/${id}`;
  if (options.fault) {
    describe(`scenario ${name} (fault: 3 clean runs)`, () => {
      for (let run = 1; run <= 3; run++)
        it(`run ${run}`, { retry: 0, timeout: options.timeout }, async () => {
          await fn();
        });
    });
    return;
  }
  it(`scenario ${name}`, { retry: 0, timeout: options.timeout }, async () => {
    await fn();
  });
}
