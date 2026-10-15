/**
 * The offline measurement harness (2.4, spec §5.2). It reports, apart from
 * one another: tokens, latency, retrieval count, selected-record accuracy
 * (recall@k and precision@k on the labelled corpus of
 * `test/fixtures/retrieval-corpus`), cached input tokens, cost, and the share
 * of goal, constraint and decision items still in context after N
 * compactions.
 *
 * Everything is offline and scripted: a deterministic embedder, mock models
 * whose usage the harness derives from each request (cached input simulates a
 * provider prefix cache: the leading messages a request shares with the one
 * before it), a fictional price card and a scripted, lossy compaction
 * summarizer. The numbers describe this harness and the SDK's plumbing only;
 * they claim nothing about a real model, a real cache or a real price, and no
 * saving is promised from them.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compactMessages } from '../../src/compaction';
import { compileContext } from '../../src/context/compile';
import { createContextCompiler } from '../../src/context/compiler';
import { createRagContextSource } from '../../src/context/sources';
import type { ContextPackage, ContextSource, ContextStepInput } from '../../src/context/types';
import { applyWorkingMemoryPatch, createWorkingMemory } from '../../src/context/working-memory';
import type { WorkingMemorySnapshot } from '../../src/context/working-memory/types';
import { generateText } from '../../src/generate';
import { createTokenEstimator } from '../../src/internal/estimate-tokens';
import { createPriceProvider } from '../../src/pricing';
import { hybridRetrieve, retrieve } from '../../src/rag';
import { createMockModel } from '../../src/testing';
import type { Message } from '../../src/types/message';
import type { Usage } from '../../src/types/usage';
import {
  RETRIEVAL_QUERIES,
  RETRIEVAL_RECORDS,
  corpusIndex,
  evaluateRetrieval,
  type RetrievalQuery,
  type RetrievalSearch,
} from '../fixtures/retrieval-corpus';

/** recall@k and precision@k of one search method at one k. */
export interface RetrievalQuality {
  recall: number;
  precision: number;
}

/** A share of the goal, constraint and decision items, overall and per kind. */
export interface PreservationShare {
  all: number;
  goal: number;
  constraints: number;
  decisions: number;
}

/** One model step of the scripted session. */
export interface SessionStep {
  step: number;
  /** The compiler's refresh reason for the step. */
  refresh: string;
  /** Records the step's package selected from the corpus. */
  selected: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** The JSON report (version 1). */
export interface MeasurementReport {
  kind: 'deuz-measurement-report';
  version: 1;
  disclaimer: string;
  retrieval: {
    corpus: { records: number; queries: number; embedder: string };
    /** Per method, per k: mean recall and precision over the labelled queries. */
    methods: Record<'dense' | 'lexical' | 'hybrid' | 'compiled', Record<string, RetrievalQuality>>;
  };
  session: {
    questions: number;
    steps: number;
    compactions: number;
    tokens: { input: number; cachedInput: number; output: number; total: number };
    /** `cachedInput / (input + cachedInput)`. */
    cachedInputShare: number;
    costUsd: number;
    /** Wall-clock time of compile plus the call through the mock adapter; no provider latency. */
    latencyMs: { total: number; p50: number; max: number };
    retrievals: {
      /** Source queries the compiler made. */
      sourceQueries: number;
      /** Retrieval passes the run used (default limit 4). */
      passes: number;
      /** Steps that reused the placed context without a retrieval. */
      reusedSteps: number;
      /** Refreshes the pass limit turned into reuse. */
      passLimited: number;
    };
    selection: {
      /** Candidates asked of the corpus source per retrieval. */
      k: number;
      /** Mean recall / precision of each retrieval's selected records. */
      recall: number;
      precision: number;
      /** Mean share of each question's relevant records in the request that answers it. */
      contextRecall: number;
    };
    perStep: SessionStep[];
  };
  decisionPreservation: {
    items: { goal: number; constraints: number; decisions: number };
    /** Per number of compactions: what the history alone, and with working memory, still holds. */
    runs: {
      compactions: number;
      historyOnly: PreservationShare;
      workingMemory: PreservationShare;
      /**
       * Working memory with a share too small for every decision (220 tokens):
       * the critical items always, decisions by priority (accepted first).
       */
      tightWorkingMemory: PreservationShare;
    }[];
  };
}

export interface MeasurementOptions {
  /** Milliseconds for latency (default `performance.now`). */
  now?: () => number;
}

const DISCLAIMER =
  'Offline harness: deterministic embedder, scripted mock models (cached input simulates a ' +
  'provider prefix cache), a fictional price card and a scripted compaction summarizer. The ' +
  'numbers describe this harness and the SDK plumbing only and make no claim about real models.';

/** USD per million tokens for the mock model: fictional, for the arithmetic only. */
const PRICE_CARD = { input: 3, output: 15, cachedRead: 0.3 };
const MODEL = {
  provider: 'mock',
  modelId: 'mock-model',
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
};
const K = 5;

const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

function text(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

const allText = (messages: readonly Message[]): string => messages.map(text).join('\n');

// ===================================================================
// Retrieval quality
// ===================================================================

const ids = (chunks: readonly { meta?: Record<string, unknown> }[]) =>
  chunks.map((chunk) => String(chunk.meta?.id));

async function measureRetrieval(): Promise<MeasurementReport['retrieval']> {
  const { store, bm25, embedder } = await corpusIndex();
  const source = createRagContextSource({
    retrieve: (query, topK) =>
      hybridRetrieve(query, { embedder, store, bm25 }, { topK, perStageK: 20 }),
  });
  const searches: Record<keyof MeasurementReport['retrieval']['methods'], RetrievalSearch> = {
    dense: async (query, k) => ids(await retrieve(query, { embedder, store }, { topK: k })),
    lexical: async (query, k) => ids(bm25.search(query, k)),
    hybrid: async (query, k) =>
      ids(await hybridRetrieve(query, { embedder, store, bm25 }, { topK: k, perStageK: 20 })),
    compiled: async (query, k) => {
      const candidates = await source.query({ text: query, limit: k, budgetTokens: 0 });
      const pkg = compileContext({
        step: 1,
        results: [{ source: { id: 'rag', kind: 'rag' }, status: 'ok', candidates }],
        inputTokens: 200_000,
        usedTokens: 0,
        refresh: 'initial',
        pass: 1,
      });
      return pkg.manifest.entries.filter((entry) => entry.selected).map((entry) => entry.recordId);
    },
  };
  const methods = {} as MeasurementReport['retrieval']['methods'];
  for (const [name, search] of Object.entries(searches) as [
    keyof typeof searches,
    RetrievalSearch,
  ][]) {
    methods[name] = {};
    for (const k of [1, 5, 10]) {
      const { recall, precision } = await evaluateRetrieval(search, k);
      methods[name][String(k)] = { recall, precision };
    }
  }
  return {
    corpus: {
      records: RETRIEVAL_RECORDS.length,
      queries: RETRIEVAL_QUERIES.length,
      embedder: 'deterministic hashed bag of stems (256 dims)',
    },
    methods,
  };
}

// ===================================================================
// The scripted session
// ===================================================================

/** Five questions from five topics: one more than the default retrieval pass limit. */
const SESSION_QUERIES: readonly RetrievalQuery[] = [0, 8, 16, 24, 32].map(
  (index) => RETRIEVAL_QUERIES[index]!,
);

/** The scripted summarizer: keeps a count and the last decision line, drops the rest. */
async function scriptedSummary(slice: Message[], previousSummary?: string): Promise<string> {
  const lines = `${previousSummary ?? ''}\n${allText(slice)}`.split('\n');
  const decision = lines.filter((line) => line.startsWith('Decision:')).at(-1);
  return [
    `${slice.length} earlier messages were summarized.`,
    ...(decision ? [decision] : []),
  ].join('\n');
}

async function compact(history: Message[]): Promise<Message[]> {
  const { messages } = await compactMessages(
    history,
    { layers: ['summarize'], keepRecentSteps: 2 },
    { summarize: scriptedSummary },
  );
  return messages;
}

/** How many leading messages two requests share. */
function sharedPrefix(previous: readonly Message[], next: readonly Message[]): number {
  let count = 0;
  while (
    count < previous.length &&
    count < next.length &&
    JSON.stringify(previous[count]) === JSON.stringify(next[count])
  )
    count++;
  return count;
}

const RECORD_ID = /<record [^>]*\bid="([^"]+)"/g;

function sessionMemory(): WorkingMemorySnapshot {
  return createWorkingMemory({
    scope: 'measurement',
    goal: 'Answer employee handbook questions from the handbook only.',
    constraints: ['Quote the handbook rule that applies.', 'Say so when the handbook is silent.'],
    now: 0,
  });
}

async function measureSession(now: () => number): Promise<MeasurementReport['session']> {
  const { store, bm25, embedder } = await corpusIndex();
  let sourceQueries = 0;
  const rag = createRagContextSource({
    retrieve: (query, topK) => {
      sourceQueries++;
      return hybridRetrieve(query, { embedder, store, bm25 }, { topK, perStageK: 20 });
    },
  });
  const compiler = createContextCompiler({
    sources: [rag as ContextSource],
    budget: { candidatesPerSource: K },
  });
  const estimator = createTokenEstimator();
  const priceProvider = createPriceProvider({ table: { 'mock-model': PRICE_CARD } });
  const memory = sessionMemory();

  let history: Message[] = [{ role: 'system', content: 'You answer employee handbook questions.' }];
  let previous: Message[] = [];
  let step = 0;
  let compactions = 0;
  const perStep: SessionStep[] = [];
  const selection: { recall: number; precision: number }[] = [];
  const contextRecall: number[] = [];
  let passLimited = 0;

  for (const query of SESSION_QUERIES) {
    history = [...history, { role: 'user', content: query.text }];
    for (const phase of ['look-up', 'answer'] as const) {
      step++;
      const started = now();
      const input: ContextStepInput = {
        runId: 'measurement',
        step,
        messages: history,
        model: MODEL,
        overheadTokens: 0,
        workingMemory: memory,
        ...(phase === 'look-up' ? { refresh: true } : {}),
      };
      const pkg: ContextPackage = await compiler.beforeModelCall(input);
      const append = pkg.blocks.find((block) => block.placement === 'append')?.messages ?? [];
      const tail = pkg.blocks.find((block) => block.placement === 'ephemeral-tail')?.messages ?? [];
      // The placement contract: the append block joins the history, the tail does not.
      history = [...history, ...append];
      const request = [...history, ...tail];
      const relevant = new Set(query.relevant);
      const selected = pkg.manifest.entries
        .filter((entry) => entry.selected && entry.kind === 'rag')
        .map((entry) => entry.recordId);
      if (pkg.manifest.refresh !== 'reused') {
        const hits = selected.filter((id) => relevant.has(id)).length;
        selection.push({
          recall: hits / relevant.size,
          precision: selected.length === 0 ? 0 : hits / selected.length,
        });
      }
      if (pkg.manifest.fallback === 'pass-limit') passLimited++;
      const reply =
        phase === 'look-up'
          ? `Looking this up in the handbook: ${query.text}`
          : `${RETRIEVAL_RECORDS.find((record) => record.id === query.relevant[0])!.text}`;
      if (phase === 'answer') {
        const inRequest = new Set([...allText(request).matchAll(RECORD_ID)].map((m) => m[1]!));
        contextRecall.push(query.relevant.filter((id) => inRequest.has(id)).length / relevant.size);
      }

      const total = estimator.estimate(request);
      const cached = Math.min(
        total,
        estimator.estimate(request.slice(0, sharedPrefix(previous, request))),
      );
      const output = estimator.estimate([{ role: 'assistant', content: reply }]);
      const model = createMockModel({
        responses: [
          {
            text: reply,
            usage: { inputTokens: total - cached, cachedReadTokens: cached, outputTokens: output },
          },
        ],
      });
      const result = await generateText({ model, messages: request, maxRetries: 0 });
      const usage: Usage = result.usage;
      const costUsd = (await priceProvider.priceUsage('mock-model', usage)) ?? 0;
      history = [...history, ...result.response.messages];
      previous = request;
      perStep.push({
        step,
        refresh: pkg.manifest.refresh,
        selected: selected.length,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedReadTokens,
        outputTokens: usage.outputTokens,
        costUsd,
        latencyMs: round(now() - started),
      });
      if (step % 4 === 0) {
        history = await compact(history);
        compactions++;
      }
    }
  }

  const input = perStep.reduce((sum, row) => sum + row.inputTokens, 0);
  const cachedInput = perStep.reduce((sum, row) => sum + row.cachedInputTokens, 0);
  const output = perStep.reduce((sum, row) => sum + row.outputTokens, 0);
  const latencies = perStep.map((row) => row.latencyMs).sort((a, b) => a - b);
  const state = compiler.state();
  return {
    questions: SESSION_QUERIES.length,
    steps: step,
    compactions,
    tokens: { input, cachedInput, output, total: input + cachedInput + output },
    cachedInputShare: round(cachedInput / (input + cachedInput)),
    costUsd: round(
      perStep.reduce((sum, row) => sum + row.costUsd, 0),
      6,
    ),
    latencyMs: {
      total: round(latencies.reduce((sum, value) => sum + value, 0)),
      p50: latencies[Math.floor((latencies.length - 1) / 2)] ?? 0,
      max: latencies.at(-1) ?? 0,
    },
    retrievals: {
      sourceQueries,
      passes: state.passes,
      reusedSteps: perStep.filter((row) => row.refresh === 'reused').length,
      passLimited,
    },
    selection: {
      k: K,
      recall: round(mean(selection.map((row) => row.recall))),
      precision: round(mean(selection.map((row) => row.precision))),
      contextRecall: round(mean(contextRecall)),
    },
    perStep,
  };
}

// ===================================================================
// Decision preservation after N compactions
// ===================================================================

const GOAL = 'Migrate the billing reports to the new warehouse without downtime.';
const CONSTRAINTS = [
  'Keep the old reports readable until finance signs off.',
  'Run every backfill outside business hours.',
  'Never copy card numbers into the warehouse.',
];
/** Decisions by the block that takes them; the host accepts the first four, the model proposes two. */
const DECISIONS: readonly { text: string; block: number; writer: 'host' | 'model' }[] = [
  { text: 'Use nightly snapshots as the backfill source.', block: 0, writer: 'host' },
  { text: 'Partition the report tables by invoice month.', block: 0, writer: 'host' },
  { text: 'Validate totals per month against the old system.', block: 1, writer: 'host' },
  { text: 'Switch dashboards one team at a time.', block: 1, writer: 'host' },
  { text: 'Cache the monthly aggregates for one hour.', block: 2, writer: 'model' },
  { text: 'Drop the legacy CSV export after the switch.', block: 2, writer: 'model' },
];
const BLOCKS = 5;
/** A working-memory share that holds the critical items and only some decisions. */
const TIGHT_WORKING_MEMORY_TOKENS = 220;

/** One block of the scripted task: six turns, with the items it introduces. */
function block(index: number): Message[] {
  const turns: Message[] = [];
  if (index === 0) {
    turns.push({ role: 'user', content: `Goal: ${GOAL}` });
    turns.push({ role: 'assistant', content: 'Understood. I will plan the migration.' });
    turns.push({ role: 'user', content: `Constraints: ${CONSTRAINTS.join(' ')}` });
  } else {
    turns.push({ role: 'user', content: `Status check ${index}: continue with the next part.` });
    turns.push({ role: 'assistant', content: `Part ${index} is under way.` });
    turns.push({ role: 'user', content: `Any blockers on part ${index}?` });
  }
  const decisions = DECISIONS.filter((decision) => decision.block === index);
  turns.push({
    role: 'assistant',
    content:
      decisions.length > 0
        ? decisions.map((decision) => `Decision: ${decision.text}`).join('\n')
        : `No new decision in part ${index}.`,
  });
  turns.push({ role: 'user', content: `Thanks. Log part ${index}.` });
  turns.push({ role: 'assistant', content: `Part ${index} logged.` });
  return turns;
}

function preservationMemory(): WorkingMemorySnapshot {
  let snapshot = createWorkingMemory({
    scope: 'measurement',
    goal: GOAL,
    constraints: CONSTRAINTS,
    now: 0,
  });
  for (const [index, decision] of DECISIONS.entries()) {
    const result = applyWorkingMemoryPatch(
      snapshot,
      {
        operationId: `decision-${index}`,
        expectedRevision: snapshot.revision,
        writer: decision.writer,
        operations: [{ op: 'add-decision', text: decision.text }],
      },
      { now: index + 1 },
    );
    if (result.status !== 'applied') throw new Error(`working memory patch ${result.status}`);
    snapshot = result.snapshot;
  }
  return snapshot;
}

function share(found: (item: string) => boolean): PreservationShare {
  const goal = found(GOAL) ? 1 : 0;
  const constraints = CONSTRAINTS.filter(found).length;
  const decisions = DECISIONS.map((decision) => decision.text).filter(found).length;
  return {
    all: round((goal + constraints + decisions) / (1 + CONSTRAINTS.length + DECISIONS.length)),
    goal,
    constraints: round(constraints / CONSTRAINTS.length),
    decisions: round(decisions / DECISIONS.length),
  };
}

async function measurePreservation(): Promise<MeasurementReport['decisionPreservation']> {
  const memory = preservationMemory();
  const runs: MeasurementReport['decisionPreservation']['runs'] = [];
  for (let compactions = 0; compactions < BLOCKS; compactions++) {
    let history: Message[] = [{ role: 'system', content: 'You run a data migration.' }];
    for (let index = 0; index < BLOCKS; index++) {
      history = [...history, ...block(index)];
      if (index < compactions) history = await compact(history);
    }
    const withMemory = async (workingMemoryTokens?: number): Promise<string> => {
      const pkg = compileContext({
        step: 1,
        results: [],
        inputTokens: MODEL.contextWindow - MODEL.maxOutputTokens,
        usedTokens: createTokenEstimator().estimate(history),
        ...(workingMemoryTokens !== undefined ? { budget: { workingMemoryTokens } } : {}),
        workingMemory: memory,
        refresh: 'initial',
        pass: 1,
      });
      return allText([...history, ...pkg.blocks.flatMap((entry) => entry.messages)]);
    };
    const historyText = allText(history);
    const full = await withMemory();
    const tight = await withMemory(TIGHT_WORKING_MEMORY_TOKENS);
    runs.push({
      compactions,
      historyOnly: share((item) => historyText.includes(item)),
      workingMemory: share((item) => full.includes(item)),
      tightWorkingMemory: share((item) => tight.includes(item)),
    });
  }
  return {
    items: { goal: 1, constraints: CONSTRAINTS.length, decisions: DECISIONS.length },
    runs,
  };
}

// ===================================================================
// The report
// ===================================================================

/** Runs every measurement and returns the report; it writes nothing. */
export async function runMeasurement(options: MeasurementOptions = {}): Promise<MeasurementReport> {
  const now = options.now ?? (() => performance.now());
  return {
    kind: 'deuz-measurement-report',
    version: 1,
    disclaimer: DISCLAIMER,
    retrieval: await measureRetrieval(),
    session: await measureSession(now),
    decisionPreservation: await measurePreservation(),
  };
}

/** Writes the report as JSON to `path`, creating its directory: only on opt-in. */
export async function writeMeasurementReport(
  report: MeasurementReport,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
