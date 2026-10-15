/**
 * The offline measurement report (2.4, spec §5.2): its shape and this
 * harness's baseline numbers. The numbers describe the harness and the SDK
 * plumbing (labelled corpus, scripted models, fictional prices, scripted
 * compaction) and claim nothing about real models; a deliberate change to any
 * of them updates the baseline in the same commit, never to pass.
 *
 * Opt in to the JSON report with `DEUZ_MEASUREMENT_REPORT=<path>` (wall-clock
 * latency); nothing is written otherwise.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMeasurement, writeMeasurementReport, type MeasurementReport } from './harness';

/** Latency from a clock that moves one millisecond per reading, so the report is stable. */
function countingClock(): () => number {
  let now = 0;
  return () => (now += 1);
}

let report: MeasurementReport;

beforeAll(async () => {
  report = await runMeasurement({ now: countingClock() });
  const path = process.env.DEUZ_MEASUREMENT_REPORT;
  if (path) await writeMeasurementReport(await runMeasurement(), path);
}, 60_000);

describe('the measurement report (spec §5.2)', () => {
  it('reports each measure apart, with its disclaimer', () => {
    expect(report.kind).toBe('deuz-measurement-report');
    expect(report.version).toBe(1);
    expect(report.disclaimer).toMatch(/make no claim about real models/);
    expect(Object.keys(report)).toEqual([
      'kind',
      'version',
      'disclaimer',
      'retrieval',
      'session',
      'decisionPreservation',
    ]);
    expect(Object.keys(report.session)).toEqual([
      'questions',
      'steps',
      'compactions',
      'tokens',
      'cachedInputShare',
      'costUsd',
      'latencyMs',
      'retrievals',
      'selection',
      'perStep',
    ]);
    expect(Object.keys(report.session.tokens)).toEqual(['input', 'cachedInput', 'output', 'total']);
    for (const row of report.session.perStep)
      expect(Object.keys(row)).toEqual([
        'step',
        'refresh',
        'selected',
        'inputTokens',
        'cachedInputTokens',
        'outputTokens',
        'costUsd',
        'latencyMs',
      ]);
  });

  it('pins recall@k and precision@k on the labelled corpus', () => {
    expect(report.retrieval).toEqual(RETRIEVAL_BASELINE);
  });

  it('pins the scripted session: tokens, cached input, cost, latency, retrievals, selection', () => {
    const { perStep, ...session } = report.session;
    expect(session).toEqual(SESSION_BASELINE);
    expect(
      perStep.map((row) => [
        row.step,
        row.refresh,
        row.selected,
        row.inputTokens,
        row.cachedInputTokens,
        row.outputTokens,
        row.costUsd,
        row.latencyMs,
      ]),
    ).toEqual(STEP_BASELINE);
    const sum = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens') =>
      perStep.reduce((total, row) => total + row[key], 0);
    expect(session.tokens).toEqual({
      input: sum('inputTokens'),
      cachedInput: sum('cachedInputTokens'),
      output: sum('outputTokens'),
      total: sum('inputTokens') + sum('cachedInputTokens') + sum('outputTokens'),
    });
  });

  it('pins decision preservation after 0 to 4 compactions', () => {
    expect(report.decisionPreservation.items).toEqual({ goal: 1, constraints: 3, decisions: 6 });
    expect(
      report.decisionPreservation.runs.map((run) => [
        run.compactions,
        run.historyOnly.all,
        run.workingMemory.all,
        run.tightWorkingMemory.all,
      ]),
    ).toEqual(PRESERVATION_BASELINE);
    for (const run of report.decisionPreservation.runs) {
      // The working memory's critical items (goal, constraints) are always in context.
      expect(run.workingMemory).toMatchObject({ goal: 1, constraints: 1 });
      expect(run.tightWorkingMemory).toMatchObject({ goal: 1, constraints: 1 });
      expect(run.workingMemory.all).toBeGreaterThanOrEqual(run.historyOnly.all);
    }
  });

  it('reports the same numbers on a second run', async () => {
    expect(await runMeasurement({ now: countingClock() })).toEqual(report);
  }, 30_000);

  it('writes the report as JSON only where asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-measurement-'));
    try {
      const path = join(dir, 'nested', 'report.json');
      await writeMeasurementReport(report, path);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Measured with this harness (2.4.0); update deliberately, never to pass. */
const RETRIEVAL_BASELINE: MeasurementReport['retrieval'] = {
  corpus: {
    records: 200,
    queries: 50,
    embedder: 'deterministic hashed bag of stems (256 dims)',
  },
  methods: {
    dense: {
      1: { recall: 0.44, precision: 0.5 },
      5: { recall: 0.64, precision: 0.148 },
      10: { recall: 0.72, precision: 0.086 },
    },
    lexical: {
      1: { recall: 0.41, precision: 0.46 },
      5: { recall: 0.65, precision: 0.152 },
      10: { recall: 0.75, precision: 0.088 },
    },
    hybrid: {
      1: { recall: 0.49, precision: 0.56 },
      5: { recall: 0.68, precision: 0.156 },
      10: { recall: 0.75, precision: 0.09 },
    },
    compiled: {
      1: { recall: 0.49, precision: 0.56 },
      5: { recall: 0.68, precision: 0.156 },
      10: { recall: 0.75, precision: 0.09 },
    },
  },
};

const SESSION_BASELINE: Omit<MeasurementReport['session'], 'perStep'> = {
  questions: 5,
  steps: 10,
  compactions: 2,
  tokens: { input: 2851, cachedInput: 3052, output: 232, total: 6135 },
  cachedInputShare: 0.517,
  costUsd: 0.012951,
  latencyMs: { total: 10, p50: 1, max: 1 },
  // Five questions, four retrieval passes (the default limit): the fifth reuses.
  retrievals: { sourceQueries: 4, passes: 4, reusedSteps: 6, passLimited: 1 },
  selection: { k: 5, recall: 0.625, precision: 0.15, contextRecall: 0.5 },
};

/** step, refresh, selected, input, cached input, output, cost, latency. */
const STEP_BASELINE = [
  [1, 'initial', 5, 410, 0, 27, 0.001635, 1],
  [2, 'reused', 0, 148, 289, 24, 0.000891, 1],
  [3, 'host-request', 5, 409, 315, 20, 0.001622, 1],
  // A compaction after step 4 changes the cached prefix.
  [4, 'reused', 0, 141, 602, 26, 0.000994, 1],
  [5, 'host-request', 5, 452, 32, 22, 0.001696, 1],
  [6, 'reused', 0, 142, 363, 21, 0.00085, 1],
  [7, 'host-request', 5, 406, 384, 24, 0.001693, 1],
  [8, 'reused', 0, 145, 669, 22, 0.000966, 1],
  // Past the pass limit: the records the compaction removed are placed again.
  [9, 'reused', 5, 455, 32, 23, 0.00172, 1],
  [10, 'reused', 0, 143, 366, 23, 0.000884, 1],
];

/** compactions, history only, with working memory, with a tight working memory. */
const PRESERVATION_BASELINE = [
  [0, 1, 1, 1],
  [1, 0.7, 1, 1],
  [2, 0.6, 1, 0.9],
  [3, 0.4, 1, 0.9],
  [4, 0.2, 1, 0.8],
];
