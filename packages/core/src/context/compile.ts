/**
 * The pure context compiler (2.4, spec §2.3): selection into one token
 * budget, append-only placement and the manifest. No I/O, no clock, no
 * randomness: the same input gives the same package, byte for byte.
 * Edge-safe.
 */
import { ContextBudgetExceededError, InvalidRequestError } from '../errors';
import { isSha256Digest } from '../internal/digest';
import { createTokenEstimator } from '../internal/estimate-tokens';
import { estimateTextTokens } from './count';
import { DEFAULT_CONTEXT_BUDGET } from './defaults';
import {
  RETRIEVAL_CLOSING,
  renderRecord,
  renderWorkingMemory,
  retrievalOpening,
  sectionWrapper,
  workingMemoryFrame,
  workingMemoryItems,
  type RecordLabel,
  type WorkingMemoryItem,
} from './render';
import { sha256DigestSync } from './sha256';
import type {
  CompileContextInput,
  ContextBlock,
  ContextBudgetOptions,
  ContextCandidate,
  ContextEntryReason,
  ContextManifest,
  ContextManifestEntry,
  ContextManifestSource,
  ContextPackage,
  ContextSourceKind,
} from './types';

/** Source kinds in the order a final fill visits them. */
const KINDS: readonly ContextSourceKind[] = ['memory', 'rag', 'transcript', 'skills'];

/** Uncalibrated, so a compile without an estimator counts the same every time. */
const DEFAULT_ESTIMATOR = createTokenEstimator();

interface ResolvedBudget {
  ratio: number;
  maxTokens: number;
  workingMemoryTokens: number;
  shares: Record<ContextSourceKind, number>;
  candidatesPerSource: number;
}

/** One source candidate on its way through the compile. */
interface Work {
  /** Index of its result in `input.results`. */
  result: number;
  source: string;
  kind: ContextSourceKind;
  candidate: ContextCandidate;
  /** Its position in the source's ranked list. */
  order: number;
  tokens: number;
  record: string;
  mandatory: boolean;
  selected: boolean;
  reason?: ContextEntryReason;
}

function finite(value: unknown, min: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw new TypeError(`compileContext: ${name} must be a finite number of at least ${min}`);
  return value;
}

function resolveBudget(options: ContextBudgetOptions = {}): ResolvedBudget {
  const ratio = finite(options.ratio ?? DEFAULT_CONTEXT_BUDGET.ratio, 0, 'budget.ratio');
  if (ratio > 1) throw new TypeError('compileContext: budget.ratio must be at most 1');
  const candidatesPerSource =
    options.candidatesPerSource ?? DEFAULT_CONTEXT_BUDGET.candidatesPerSource;
  if (!Number.isSafeInteger(candidatesPerSource) || candidatesPerSource < 1)
    throw new TypeError('compileContext: budget.candidatesPerSource must be a positive integer');
  const shares = {} as Record<ContextSourceKind, number>;
  for (const kind of KINDS)
    shares[kind] = finite(
      options.shares?.[kind] ?? DEFAULT_CONTEXT_BUDGET.shares[kind],
      0,
      `budget.shares.${kind}`,
    );
  return {
    ratio,
    maxTokens: finite(options.maxTokens ?? DEFAULT_CONTEXT_BUDGET.maxTokens, 0, 'budget.maxTokens'),
    workingMemoryTokens: finite(
      options.workingMemoryTokens ?? DEFAULT_CONTEXT_BUDGET.workingMemoryTokens,
      0,
      'budget.workingMemoryTokens',
    ),
    shares,
    candidatesPerSource,
  };
}

/** A candidate as the compile trusts it: a string text, a finite score, a digest. */
function normalize(candidate: ContextCandidate): ContextCandidate {
  const text = typeof candidate.text === 'string' ? candidate.text : String(candidate.text ?? '');
  return {
    ...candidate,
    recordId: String(candidate.recordId),
    text,
    score: Number.isFinite(candidate.score) ? candidate.score : 0,
    digest: isSha256Digest(candidate.digest) ? candidate.digest : sha256DigestSync(text),
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Mandatory first, then by descending score, then by record id. */
function byRank(a: ContextCandidate, b: ContextCandidate): number {
  return (
    Number(b.mandatory === true) - Number(a.mandatory === true) ||
    b.score - a.score ||
    compareIds(a.recordId, b.recordId)
  );
}

function placedKey(source: string, recordId: string, revision: number | undefined, digest: string) {
  return revision !== undefined
    ? `${source}\u0000${recordId}\u0000r${revision}`
    : `${source}\u0000${recordId}\u0000d${digest}`;
}

const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0);

/**
 * Shares `total` tokens among the source kinds by `shares`, then lets what a
 * kind leaves unused flow to the kinds that still have candidates. A kind
 * fills its quota by descending score, an equal score by source order and
 * then by rank within the source (`byRank`), skipping a candidate too large
 * for what is left.
 */
function allocate(
  eligible: readonly Work[],
  total: number,
  shares: Record<ContextSourceKind, number>,
): void {
  const pools: Array<[ContextSourceKind, Work[]]> = [];
  for (const kind of KINDS) {
    const pool = eligible
      .filter((work) => work.kind === kind)
      .sort(
        (a, b) => b.candidate.score - a.candidate.score || a.result - b.result || a.order - b.order,
      );
    if (pool.length > 0 && shares[kind] > 0) pools.push([kind, pool]);
  }
  let left = total;
  for (let round = 0; left > 0; round++) {
    const hungry = pools.filter(([, pool]) =>
      pool.some((work) => !work.selected && work.tokens <= left),
    );
    if (hungry.length === 0) return;
    const weight = sum(hungry.map(([kind]) => shares[kind]));
    const reason: ContextEntryReason = round === 0 ? 'ranked' : 'reallocated';
    let taken = 0;
    for (const [kind, pool] of hungry) {
      let quota = Math.floor((left * shares[kind]) / weight);
      for (const work of pool) {
        if (work.selected || work.tokens > quota) continue;
        work.selected = true;
        work.reason = reason;
        quota -= work.tokens;
        taken += work.tokens;
      }
    }
    left -= taken;
    if (taken === 0) {
      // Every quota is smaller than any one candidate: fill what is left in kind order.
      for (const [, pool] of hungry)
        for (const work of pool)
          if (!work.selected && work.tokens <= left) {
            work.selected = true;
            work.reason = 'reallocated';
            left -= work.tokens;
          }
      return;
    }
  }
}

/**
 * Compiles a context package (2.4). Pure and deterministic: the same input
 * gives the same package, byte for byte; nothing is fetched or awaited.
 *
 * 1. The added-context budget is `min(ratio × (inputTokens − usedTokens),
 *    maxTokens)`; the working memory takes up to `workingMemoryTokens` of it
 *    first, its critical fields (goal, constraints, active task) whatever the
 *    ranking.
 * 2. The rest is shared by source kind (memory 2 : rag 2 : skills 1, plus
 *    transcript 1 when present); a share a source leaves unused flows to the
 *    others (`'reallocated'`).
 * 3. Within a share, candidates go by descending score; an equal score goes
 *    by source order (the order of `results`), then by `recordId` within one
 *    source. An entry in `placed` at the same revision (or digest) is
 *    `'already-placed'` and not written again, a digest seen from another
 *    source is `'duplicate'`, and mandatory candidates come first.
 * 4. Selected retrieval forms one `'append'` block (only what is new), the
 *    working memory one `'ephemeral-tail'` block; content is labelled as data
 *    with its origin and source kinds.
 *
 * Throws `ContextBudgetExceededError` (with `input.phase`) when mandatory
 * content does not fit; never truncates it.
 *
 * Details (2.4):
 * - Mandatory content (the working memory's critical fields, mandatory
 *   candidates and the frame they need) may pass the added-context budget,
 *   since it is never cut; it must fit what the request leaves
 *   (`inputTokens − usedTokens`). Optional content gets what the budget has
 *   left after it. In the `'overflow-retry'` phase the request itself must
 *   fit too: `usedTokens` plus the mandatory content above `inputTokens`
 *   throws, reporting both as required against `inputTokens`.
 * - A source's candidates beyond `candidatesPerSource` (by rank) are ignored;
 *   its mandatory candidates are always kept. A repeated `recordId` within a
 *   source counts once.
 * - A failed required source in `results` is refused with
 *   `InvalidRequestError`: the call stops instead of compiling without it.
 * - Every block is a single `user` message: the system message and the tool
 *   schemas are never touched. An entry's `tokens` is its record (a source's
 *   own `tokens` plus the record framing); a block's adds its frame.
 */
export function compileContext(input: CompileContextInput): ContextPackage {
  const estimator = input.estimator ?? DEFAULT_ESTIMATOR;
  const phase = input.phase ?? 'compile';
  const inputTokens = finite(input.inputTokens, 0, 'inputTokens');
  const usedTokens = finite(input.usedTokens, 0, 'usedTokens');
  const budget = resolveBudget(input.budget);
  const available = Math.max(0, Math.floor(inputTokens - usedTokens));
  const contextTokens = Math.floor(Math.min(budget.ratio * available, budget.maxTokens));
  const workingMemoryShare = Math.floor(Math.min(budget.workingMemoryTokens, contextTokens));

  for (const result of input.results)
    if (result.status === 'failed' && result.source.required)
      throw new InvalidRequestError({
        message: `The required context source '${result.source.id}' failed (${result.error?.name ?? 'Error'}); the model call stops.`,
      });

  // ---- Source candidates, ranked and capped per source.
  const placedKeys = new Set<string>();
  const placedDigests = new Set<string>();
  for (const entry of input.placed ?? []) {
    placedKeys.add(placedKey(entry.source, entry.recordId, entry.revision, entry.digest));
    placedDigests.add(entry.digest);
  }
  const works: Work[][] = input.results.map((result, index) => {
    if (result.status !== 'ok') return [];
    const seen = new Set<string>();
    const kept: ContextCandidate[] = [];
    for (const candidate of result.candidates.map(normalize).sort(byRank)) {
      if (seen.has(candidate.recordId)) continue;
      if (kept.length >= budget.candidatesPerSource && candidate.mandatory !== true) continue;
      seen.add(candidate.recordId);
      kept.push(candidate);
    }
    return kept.map((candidate, order) => {
      const label: RecordLabel = {
        source: result.source.id,
        kind: result.source.kind,
        recordId: candidate.recordId,
        ...(candidate.revision !== undefined ? { revision: candidate.revision } : {}),
        ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
      };
      const record = renderRecord(label, candidate.text);
      const own = candidate.tokens;
      const tokens =
        typeof own === 'number' && Number.isFinite(own) && own >= 0
          ? Math.ceil(own) + estimateTextTokens(renderRecord(label, ''), estimator)
          : estimateTextTokens(record, estimator);
      return {
        result: index,
        source: result.source.id,
        kind: result.source.kind,
        candidate,
        order,
        tokens,
        record,
        mandatory: candidate.mandatory === true,
        selected: false,
      };
    });
  });
  const all = works.flat();

  // ---- Already placed, or the same content from another source: not written again.
  const claimed = new Set<string>();
  const classify = (work: Work): void => {
    const { candidate } = work;
    if (
      placedKeys.has(
        placedKey(work.source, candidate.recordId, candidate.revision, candidate.digest),
      ) ||
      placedDigests.has(candidate.digest)
    )
      work.reason = 'already-placed';
    else if (claimed.has(candidate.digest)) work.reason = 'duplicate';
    else claimed.add(candidate.digest);
  };
  for (const work of all) if (work.mandatory) classify(work);
  for (const work of all) if (!work.mandatory) classify(work);

  // ---- Working memory: the critical fields first, whatever the budget.
  const snapshot = input.workingMemory;
  const memoryItems = snapshot ? workingMemoryItems(snapshot) : [];
  const frameTokens = snapshot
    ? estimator.estimate([{ role: 'user', content: workingMemoryFrame(snapshot) }])
    : 0;
  const memorySelected = new Set<WorkingMemoryItem>();
  const memoryReasons = new Map<WorkingMemoryItem, ContextEntryReason>();
  const openSections = new Set<string>();
  let memoryTokens = 0;
  const memoryCost = (item: WorkingMemoryItem): number =>
    estimateTextTokens(item.line, estimator) +
    (openSections.has(item.section)
      ? 0
      : estimateTextTokens(sectionWrapper(item.section), estimator)) +
    (memorySelected.size === 0 ? frameTokens : 0);
  const selectMemory = (item: WorkingMemoryItem, cost: number, reason: ContextEntryReason) => {
    memoryTokens += cost;
    openSections.add(item.section);
    memorySelected.add(item);
    memoryReasons.set(item, reason);
  };
  for (const item of memoryItems)
    if (item.critical) selectMemory(item, memoryCost(item), 'mandatory');
  const criticalTokens = memoryTokens;

  // ---- Mandatory content must fit; it is never cut.
  const mandatory = all.filter((work) => work.mandatory && work.reason === undefined);
  const openingTokens = estimator.estimate([
    { role: 'user', content: retrievalOpening(input.pass, input.step) + RETRIEVAL_CLOSING },
  ]);
  const mandatoryRetrieval =
    mandatory.length > 0 ? openingTokens + sum(mandatory.map((work) => work.tokens)) : 0;
  const mandatoryTokens = criticalTokens + mandatoryRetrieval;
  if (
    phase === 'overflow-retry'
      ? usedTokens + mandatoryTokens > inputTokens
      : mandatoryTokens > available
  )
    throw new ContextBudgetExceededError(
      phase === 'overflow-retry'
        ? {
            requiredTokens: Math.ceil(usedTokens + mandatoryTokens),
            availableTokens: Math.floor(inputTokens),
            phase,
          }
        : { requiredTokens: mandatoryTokens, availableTokens: available, phase },
    );
  for (const work of mandatory) {
    work.selected = true;
    work.reason = 'mandatory';
  }

  // ---- Optional working memory within its share, by priority.
  let optionalLeft = Math.max(0, contextTokens - mandatoryTokens);
  const memoryLimit = Math.min(optionalLeft, Math.max(0, workingMemoryShare - criticalTokens));
  let memoryOptional = 0;
  for (const item of memoryItems) {
    if (item.critical) continue;
    const cost = memoryCost(item);
    if (memoryOptional + cost <= memoryLimit) {
      memoryOptional += cost;
      selectMemory(item, cost, 'ranked');
    } else memoryReasons.set(item, 'over-budget');
  }
  optionalLeft -= memoryOptional;

  // ---- Optional retrieval: shares by kind, unused shares reallocated.
  const eligible = all.filter((work) => !work.mandatory && work.reason === undefined);
  const allocation = optionalLeft - (mandatory.length > 0 ? 0 : openingTokens);
  if (allocation > 0 && eligible.length > 0) allocate(eligible, allocation, budget.shares);
  for (const work of eligible) if (!work.selected) work.reason = 'over-budget';

  // ---- The manifest: working memory first, then the sources in order. Never text.
  const entries: ContextManifestEntry[] = [];
  const memoryIndex = new Map<WorkingMemoryItem, number>();
  for (const item of memoryItems) {
    memoryIndex.set(item, entries.length);
    entries.push({
      source: 'working-memory',
      kind: 'working-memory',
      recordId: item.recordId,
      revision: item.revision,
      digest: sha256DigestSync(item.line),
      selected: memorySelected.has(item),
      reason: memoryReasons.get(item)!,
      tokens: estimateTextTokens(item.line, estimator),
    });
  }
  const workIndex = new Map<Work, number>();
  for (const work of all) {
    workIndex.set(work, entries.length);
    const { candidate } = work;
    entries.push({
      source: work.source,
      kind: work.kind,
      recordId: candidate.recordId,
      ...(candidate.revision !== undefined ? { revision: candidate.revision } : {}),
      digest: candidate.digest,
      ...(candidate.query !== undefined ? { query: candidate.query } : {}),
      selected: work.selected,
      reason: work.reason!,
      tokens: work.tokens,
    });
  }

  // ---- The blocks: only what is new is appended; the working memory is the tail.
  const blocks: ContextBlock[] = [];
  const appended = all.filter((work) => work.selected);
  if (appended.length > 0)
    blocks.push({
      placement: 'append',
      kind: 'retrieval',
      messages: [
        {
          role: 'user',
          content:
            retrievalOpening(input.pass, input.step) +
            appended.map((work) => work.record).join('') +
            RETRIEVAL_CLOSING,
        },
      ],
      tokens: openingTokens + sum(appended.map((work) => work.tokens)),
      entries: appended.map((work) => workIndex.get(work)!),
    });
  if (snapshot && memorySelected.size > 0) {
    const items = memoryItems.filter((item) => memorySelected.has(item));
    blocks.push({
      placement: 'ephemeral-tail',
      kind: 'working-memory',
      messages: [{ role: 'user', content: renderWorkingMemory(snapshot, items) }],
      tokens: memoryTokens,
      entries: items.map((item) => memoryIndex.get(item)!),
    });
  }

  const sources: ContextManifestSource[] = input.results.map((result, index) => {
    const list = works[index]!;
    const selected = list.filter((work) => work.selected);
    const error = result.error;
    return {
      source: result.source.id,
      kind: result.source.kind,
      required: result.source.required === true,
      status: result.status,
      selected: selected.length,
      excluded: list.length - selected.length,
      tokens: sum(selected.map((work) => work.tokens)),
      ...(error
        ? { error: { name: error.name, ...(error.code !== undefined ? { code: error.code } : {}) } }
        : {}),
    };
  });

  const estimatorKind = input.estimatorKind;
  const manifest: ContextManifest = {
    version: 1,
    step: input.step,
    entries,
    sources,
    budget: {
      inputTokens,
      usedTokens,
      contextTokens,
      workingMemoryTokens: workingMemoryShare,
      selectedTokens: sum(blocks.map((block) => block.tokens)),
    },
    estimator: estimatorKind
      ? { kind: estimatorKind.kind, calibrated: estimatorKind.calibrated }
      : { kind: 'heuristic', calibrated: false },
    refresh: input.refresh,
    pass: input.pass,
    ...(input.fallback !== undefined ? { fallback: input.fallback } : {}),
    placement: {
      append: blocks.some((block) => block.placement === 'append'),
      tail: blocks.some((block) => block.placement === 'ephemeral-tail'),
    },
    cachePrefixChanged: input.cachePrefixChanged ?? false,
    ...(input.refresh === 'redacted' ? { redacted: true } : {}),
  };
  return { version: 1, blocks, manifest };
}
