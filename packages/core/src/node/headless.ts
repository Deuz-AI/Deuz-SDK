/**
 * `@deuz-sdk/core/headless` (2.3, a PREVIEW, not a stable API): run, resume and
 * inspect native agent runs from a script or CI job, and check a provider /
 * model / configuration before running it. Node-only: it reads project
 * instruction files and skill folders from disk and the environment. There is
 * no `bin` and no CLI package; `examples/headless` shows a command line built
 * on it.
 *
 * Every function returns plain JSON — a {@link HeadlessReport} or a
 * {@link DoctorReport} — and {@link exitCodeFor} maps it to a documented exit
 * code, so a run that did not complete never exits 0.
 */
import type { AgentRunStore } from '../types/agent-run';
import { reportFromEnvelope, type HeadlessReport } from '../headless/report';

export {
  HEADLESS_EXIT_CODES,
  exitCodeFor,
  type HeadlessCost,
  type HeadlessOutcome,
  type HeadlessPendingAction,
  type HeadlessReport,
} from '../headless/report';
export type { DoctorFinding, DoctorReport, DoctorSeverity } from '../headless/doctor';

/**
 * The report of a stored run (2.3 preview), read from `store` with no model
 * call: its outcome, what it waits for, usage and cost. A run with no result
 * yet reports `status: 'in-progress'` and a pending `'resume'`, with any call
 * whose effect is unknown; that is accurate only when no executor still drives
 * it. Rejects an unknown run ID with a TypeError.
 */
export async function inspectRun(store: AgentRunStore, runId: string): Promise<HeadlessReport> {
  const envelope = await store.load(runId);
  if (!envelope) throw new TypeError(`Unknown native run: ${runId}`);
  if (envelope.kind !== 'deuz-agent-run' || envelope.runId !== runId)
    throw new TypeError(`Not a native run record: ${runId}`);
  return reportFromEnvelope(envelope);
}
