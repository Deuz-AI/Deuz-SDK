/**
 * The stateful context compiler (2.4 preview, spec §2.3): when to query the
 * sources, what the package of each model step holds, and the state a V3
 * checkpoint keeps so a restart compiles the same context. The compiling
 * itself is `compileContext`. Edge-safe.
 */
import { canonicalJson, digestJson, sha256Digest, type Sha256Digest } from '../internal/digest';
import { createTokenEstimator } from '../internal/estimate-tokens';
import { pinCompilerScope } from '../internal/memory-scope-claims';
import { resolveDependencies } from '../internal/resolve-deps';
import { runExecutionOf, telemetryParentOf } from '../internal/native-context';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan, type TelemetryAttributes } from '../internal/telemetry';
import type { CallAccounting } from '../types/accounting';
import type { NativeExecutionContext } from '../types/execution';
import type { Message } from '../types/message';
import type { CallWarning } from '../types/methods';
import { compileContext } from './compile';
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_CONTEXT_REFRESH } from './defaults';
import { blockKey, isContextMessage, messageText, placedBlocks, placedPasses } from './render';
import { sha256DigestSync } from './sha256';
import type {
  ContextBlobRef,
  ContextCandidate,
  ContextCompiler,
  ContextCompilerState,
  ContextEstimator,
  ContextManifest,
  ContextPackage,
  ContextPlacedEntry,
  ContextRefreshReason,
  ContextSource,
  ContextSourceKind,
  ContextSourceResult,
  ContextStepInput,
  CreateContextCompilerOptions,
} from './types';

/** The longest query handed to the sources, in characters. */
const QUERY_MAX_CHARS = 2000;

const encoder = new TextEncoder();

/** A package as the V3 run store keeps it: content-addressed, indexed by memory record. */
export interface ContextPackageBlob extends ContextBlobRef {
  /** The canonical JSON of the package's blocks. */
  content: string;
  /** The memory records (and revisions) its `'append'` block placed, for `forget`. */
  records: { recordId: string; revision?: number }[];
}

/**
 * The blob of a compiled package (2.4): the canonical JSON of its blocks,
 * its `sha256:<hex>` digest and size, and the memory records it placed, as
 * `AgentRunStoreV3.putBlob` takes them.
 */
export async function contextPackageBlob(pkg: ContextPackage): Promise<ContextPackageBlob> {
  const content = canonicalJson(pkg.blocks);
  const records: ContextPackageBlob['records'] = [];
  for (const block of pkg.blocks) {
    if (block.placement !== 'append') continue;
    for (const index of block.entries) {
      const entry = pkg.manifest.entries[index];
      if (entry?.kind !== 'memory') continue;
      records.push({
        recordId: entry.recordId,
        ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
      });
    }
  }
  return {
    digest: await sha256Digest(content),
    bytes: encoder.encode(content).length,
    content,
    records,
  };
}

/** The `context-source-failed` warnings a manifest implies: one per failed optional source. */
export function contextWarnings(manifest: ContextManifest): CallWarning[] {
  return manifest.sources
    .filter((source) => source.status === 'failed' && !source.required)
    .map((source) => ({
      type: 'context-source-failed' as const,
      setting: source.source,
      message: `The optional context source '${source.source}' failed (${source.error?.name ?? 'Error'}); the step went on without it.`,
    }));
}

/** A stable fingerprint of one message: canonical key order, bytes by their digest. */
function messageDigest(message: Message): string {
  const encode = (value: unknown): string => {
    if (value instanceof Uint8Array) return `{"bytes":"${sha256DigestSync(value)}"}`;
    if (Array.isArray(value)) return `[${value.map((item) => encode(item ?? null)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined && typeof record[key] !== 'function')
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`);
      return `{${members.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  return sha256DigestSync(encode(message));
}

function prefixDigest(digests: readonly string[]): Sha256Digest {
  return sha256DigestSync(digests.join('\n'));
}

function placedKey(entry: { source: string; recordId: string; digest: string }): string {
  return `${entry.source}\u0000${entry.recordId}\u0000${entry.digest}`;
}

function integer(value: unknown, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new TypeError(`createContextCompiler: ${name} must be an integer of at least ${min}`);
  return value as number;
}

function finite(value: unknown, min: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw new TypeError(`context compiler: ${name} must be a finite number of at least ${min}`);
  return value;
}

function initialState(state: ContextCompilerState | undefined): ContextCompilerState {
  if (state === undefined) return { version: 1, passes: 0, placed: [] };
  if (state.version !== 1 || !Array.isArray(state.placed))
    throw new TypeError('createContextCompiler: state is not a version 1 ContextCompilerState');
  return JSON.parse(JSON.stringify(state)) as ContextCompilerState;
}

/** The latest user text (the compiler's own blocks skipped) and the active task's title. */
function buildQuery(input: ContextStepInput): string {
  let userText = '';
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]!;
    if (message.role !== 'user' || isContextMessage(message)) continue;
    const text = messageText(message).trim();
    if (text !== '') {
      userText = text;
      break;
    }
  }
  const tasks = input.workingMemory?.tasks;
  const title =
    tasks?.activeTaskId !== undefined
      ? tasks.list.tasks.find((task) => task.id === tasks.activeTaskId)?.title?.trim()
      : undefined;
  return [title, userText]
    .filter((part): part is string => !!part)
    .join('\n')
    .slice(0, QUERY_MAX_CHARS);
}

function errorSummary(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { name, code } : { name };
}

/** Telemetry attribute keys accept a source id only in a safe spelling. */
function attributeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

/** What one step compiled, kept for an overflow retry of that step. */
interface StepMemory {
  step: number;
  /** Everything placed when the step began, its blocks present or not. */
  placedAtStart: ContextPlacedEntry[];
  results: ContextSourceResult[];
  /** The sources answered at this step: their answer decides what it holds. */
  fresh: boolean;
  /** A refresh was due with nothing to ask: the sources were skipped. */
  skipped: boolean;
  pass: number;
  fallback?: ContextManifest['fallback'];
  cachePrefixChanged: boolean;
  activeTaskId?: string;
}

/**
 * A stateful context compiler for the native loop (2.4, preview). Implements
 * `ContextLoopHooks`: refreshes retrieval on the first call, an active-task
 * change or `requestRefresh()`, at least `minSteps` model steps apart and at
 * most `maxPasses` times per run (then reusing the last package, with
 * `fallback: 'pass-limit'` in the manifest); a failing optional source is a
 * `context-source-failed` warning, a failing required one stops the call.
 * Reports `deuz.context.compile` spans. A restored `state` compiles the same
 * context again; refusing a legacy durable session for adaptive use is the
 * loop's job.
 *
 * Details (2.4):
 * - The query is the active task's title and the latest user text (the
 *   compiler's own blocks skipped), at most 2000 characters; it is rewritten
 *   only by `refresh.rewriteQuery`. With an empty query every source is
 *   `'skipped'` and the refresh stays due, spending no pass. Each source
 *   gets `scope`, `candidatesPerSource` and a token hint of its share, and
 *   reads what it holds now: the compiler sends no `recordedAsOf`, since its
 *   clock is not a memory store's. A restarted step does not ask again: the
 *   V3 run sends the step's stored package. In a V3 run each query also
 *   carries `accounting` (the run's execution context, a request id of its
 *   own) and `onWarning`, so a source's billable call (a RAG query
 *   embedding) is charged to the run's ledger.
 * - Automatic refreshes (an active-task change) wait `minSteps` model steps
 *   after the last retrieval; host requests (`requestRefresh()`,
 *   `input.refresh`) do not. A due refresh past `maxPasses` is consumed with
 *   `fallback: 'pass-limit'`. `input.redacted` always retrieves again.
 * - Between refreshes (`refresh: 'reused'`) nothing new is retrieved. An
 *   entry whose `'append'` block left the messages (a compaction) is placed
 *   again from what this compiler instance retrieved. After a restart an
 *   optional entry waits for the next refresh, and a mandatory one (a loaded
 *   skill body) is asked of its source again with the step's query, even an
 *   empty one, past `minSteps` and `maxPasses` and without spending a pass;
 *   only that record is taken from the answer. Only a record's latest
 *   placement comes back: an older revision (or digest) a later pass
 *   superseded is never appended after the newer one.
 * - `cachePrefixChanged` is true when the messages no longer start with the
 *   previous request's messages and its `'append'` block (placed right after
 *   them).
 * - `onOverflow` recompiles the step's package from the same retrieval
 *   under the smaller `inputTokens` (refresh `'overflow-retry'`), replacing
 *   the overflowed package's placements. Entries whose blocks the retry's
 *   compaction removed are placed again as on a reused step (after a fresh
 *   retrieval, that retrieval decides); mandatory content that does not fit
 *   throws `ContextBudgetExceededError` (phase `'overflow-retry'`).
 * - `usedTokens` is the estimator's count of the messages plus
 *   `overheadTokens`; `inputTokens` is the context window less the output
 *   reservation.
 * - Two sources with one id are refused (`TypeError`).
 */
export function createContextCompiler(options: CreateContextCompilerOptions): ContextCompiler {
  const sources: readonly ContextSource[] = [...options.sources];
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id))
      throw new TypeError(`createContextCompiler: two context sources share the id '${source.id}'`);
    ids.add(source.id);
  }
  const minSteps = integer(
    options.refresh?.minSteps ?? DEFAULT_CONTEXT_REFRESH.minSteps,
    0,
    'refresh.minSteps',
  );
  const maxPasses = integer(
    options.refresh?.maxPasses ?? DEFAULT_CONTEXT_REFRESH.maxPasses,
    0,
    'refresh.maxPasses',
  );
  const limit = options.budget?.candidatesPerSource ?? DEFAULT_CONTEXT_BUDGET.candidatesPerSource;
  const deps = resolveDependencies(options.deps);
  const estimator = options.estimator ?? createTokenEstimator();
  let state = initialState(options.state);
  /** Every candidate this instance retrieved, to place again what a compaction removed. */
  const known = new Map<
    string,
    { source: ContextSourceResult['source']; candidate: ContextCandidate }
  >();
  let lastStep: StepMemory | undefined;

  const estimatorKind = (input: ContextStepInput): ContextEstimator =>
    input.estimatorKind ?? options.estimatorKind ?? { kind: 'heuristic', calibrated: false };

  /** A token hint per source: its kind's share of what the budget leaves after working memory. */
  function budgetHints(inputTokens: number, usedTokens: number): Map<string, number> {
    const ratio = options.budget?.ratio ?? DEFAULT_CONTEXT_BUDGET.ratio;
    const maxTokens = options.budget?.maxTokens ?? DEFAULT_CONTEXT_BUDGET.maxTokens;
    const memoryTokens =
      options.budget?.workingMemoryTokens ?? DEFAULT_CONTEXT_BUDGET.workingMemoryTokens;
    const context = Math.min(ratio * Math.max(0, inputTokens - usedTokens), maxTokens);
    const rest = Math.max(0, context - memoryTokens);
    const shares = (kind: ContextSourceKind): number =>
      options.budget?.shares?.[kind] ?? DEFAULT_CONTEXT_BUDGET.shares[kind];
    const kinds = [...new Set(sources.map((source) => source.kind))];
    const weight = kinds.reduce((total, kind) => total + shares(kind), 0);
    const hints = new Map<string, number>();
    for (const source of sources) {
      const siblings = sources.filter((other) => other.kind === source.kind).length;
      hints.set(
        source.id,
        weight > 0 ? Math.floor((rest * shares(source.kind)) / weight / siblings) : 0,
      );
    }
    return hints;
  }

  async function querySources(
    input: ContextStepInput,
    inputTokens: number,
    usedTokens: number,
  ): Promise<ContextSourceResult[] | undefined> {
    let query = buildQuery(input);
    if (query !== '' && options.refresh?.rewriteQuery)
      query = (await options.refresh.rewriteQuery(query, input.signal)).slice(0, QUERY_MAX_CHARS);
    if (query.trim() === '') return undefined;
    return ask(sources, query, input, inputTokens, usedTokens);
  }

  /**
   * One query's accounting on the run's execution context. Its request id
   * is drawn the first time a source reads it, so a query that charges
   * nothing costs no `generateId()` draw, and stays the same after that.
   */
  function queryAccounting(execution: NativeExecutionContext, sourceId: string): CallAccounting {
    let requestId: string | undefined;
    return {
      execution,
      get requestId() {
        return (requestId ??= `${execution.scopeId}/context/${sourceId}/${deps.generateId()}`);
      },
    };
  }

  /** Asks `list` for `query`: a required source's failure is thrown, an optional one's recorded. */
  async function ask(
    list: readonly ContextSource[],
    query: string,
    input: ContextStepInput,
    inputTokens: number,
    usedTokens: number,
  ): Promise<ContextSourceResult[]> {
    const hints = budgetHints(inputTokens, usedTokens);
    // A V3 run's execution: each query may charge one billable call to its
    // ledger, under a request id of its own (spec §3.1).
    const execution = runExecutionOf(input);
    // No `recordedAsOf`: a current read needs none, and the compiler's clock
    // (a V3 run's) is not the clock a memory store stamps its revisions with.
    const settled = await Promise.allSettled(
      list.map(async (source) => {
        const answer = await source.query({
          text: query,
          ...(options.scope ? { scope: options.scope } : {}),
          limit,
          budgetTokens: hints.get(source.id) ?? 0,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(execution
            ? {
                accounting: queryAccounting(execution, source.id),
                ...(options.onWarning ? { onWarning: options.onWarning } : {}),
              }
            : {}),
        });
        if (!Array.isArray(answer))
          throw new TypeError(
            `The context source '${source.id}' answered without a candidate list`,
          );
        return answer as readonly ContextCandidate[];
      }),
    );
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected' && list[index]!.required) throw outcome.reason;
    });
    return settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? { source: describe(list[index]!), status: 'ok', candidates: outcome.value }
        : {
            source: describe(list[index]!),
            status: 'failed',
            candidates: [],
            error: errorSummary(outcome.reason),
          },
    );
  }

  function describe(source: ContextSource): ContextSourceResult['source'] {
    return { id: source.id, kind: source.kind, ...(source.required ? { required: true } : {}) };
  }

  /** Keeps a retrieved candidate, to place it again after a compaction. */
  function remember(source: ContextSourceResult['source'], candidate: ContextCandidate): void {
    known.set(
      placedKey({ source: source.id, recordId: candidate.recordId, digest: candidate.digest }),
      { source, candidate },
    );
  }

  /**
   * The candidates to place again: those whose block a compaction removed,
   * from what this instance retrieved. A mandatory entry it did not retrieve
   * (a restored compiler) is asked of its source again, whatever `minSteps`
   * and `maxPasses` say and with no pass spent: only those records are taken
   * from the answer, none when the source no longer offers them. A failing
   * source answers for the step: optional, it is recorded as failed (its
   * other entries wait for the next refresh); required, it stops the call.
   */
  async function replacements(
    dropped: readonly ContextPlacedEntry[],
    input: ContextStepInput,
    inputTokens: number,
    usedTokens: number,
  ): Promise<ContextSourceResult[]> {
    const bySource = new Map<string, ContextSourceResult>();
    const take = (source: ContextSourceResult['source'], candidate?: ContextCandidate) => {
      const result = bySource.get(source.id) ?? { source, status: 'ok' as const, candidates: [] };
      if (candidate) (result.candidates as ContextCandidate[]).push(candidate);
      bySource.set(source.id, result);
    };
    const missing = new Map<string, Set<string>>();
    for (const entry of dropped) {
      const found = known.get(placedKey(entry));
      if (found) take(found.source, found.candidate);
      else if (entry.mandatory)
        missing.set(entry.source, (missing.get(entry.source) ?? new Set()).add(entry.recordId));
    }
    const owners = sources.filter((source) => missing.has(source.id));
    if (owners.length > 0)
      for (const result of await ask(owners, buildQuery(input), input, inputTokens, usedTokens)) {
        if (result.status !== 'ok') {
          bySource.set(result.source.id, result);
          continue;
        }
        take(result.source);
        for (const candidate of result.candidates)
          if (missing.get(result.source.id)!.has(String(candidate.recordId))) {
            remember(result.source, candidate);
            take(result.source, candidate);
          }
      }
    return sources.flatMap((source) => bySource.get(source.id) ?? []);
  }

  /**
   * What a step without a fresh retrieval compiles: the entries a compaction
   * removed, placed again; with `skipped`, every other source is `'skipped'`.
   * Only a record's latest placement (in `placed`, oldest first) comes back:
   * one a later revision or digest superseded leaves the state instead.
   */
  async function reuse(
    dropped: readonly ContextPlacedEntry[],
    placed: readonly ContextPlacedEntry[],
    skipped: boolean,
    input: ContextStepInput,
    inputTokens: number,
    usedTokens: number,
  ): Promise<ContextSourceResult[]> {
    const latest = new Map<string, ContextPlacedEntry>();
    for (const entry of placed) latest.set(`${entry.source}\u0000${entry.recordId}`, entry);
    const again = await replacements(
      dropped.filter((entry) => latest.get(`${entry.source}\u0000${entry.recordId}`) === entry),
      input,
      inputTokens,
      usedTokens,
    );
    if (!skipped) return again;
    return sources.map(
      (source) =>
        again.find((result) => result.source.id === source.id) ?? {
          source: describe(source),
          status: 'skipped' as const,
          candidates: [],
        },
    );
  }

  async function finish(
    input: ContextStepInput,
    pkg: ContextPackage,
    placedBefore: readonly ContextPlacedEntry[],
    annotate: (more: TelemetryAttributes) => void,
  ): Promise<ContextPackage> {
    const append = pkg.blocks.find((block) => block.placement === 'append');
    const newly: ContextPlacedEntry[] = (append?.entries ?? []).map((index) => {
      const entry = pkg.manifest.entries[index]!;
      return {
        source: entry.source,
        recordId: entry.recordId,
        ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
        digest: entry.digest,
        pass: pkg.manifest.pass,
        step: pkg.manifest.step,
        ...(entry.reason === 'mandatory' ? { mandatory: true } : {}),
      };
    });
    const digests = [...input.messages, ...(append?.messages ?? [])].map(messageDigest);
    const blob = await contextPackageBlob(pkg);
    state = {
      ...state,
      placed: [...placedBefore, ...newly],
      lastPackage: { digest: blob.digest, bytes: blob.bytes },
      prefix: { messages: digests.length, digest: prefixDigest(digests) },
    };
    const { manifest } = pkg;
    const attributes: Record<string, string | number | boolean> = {
      [DEUZ_ATTR.contextSelected]: manifest.entries.filter((entry) => entry.selected).length,
      [DEUZ_ATTR.contextExcluded]: manifest.entries.filter((entry) => !entry.selected).length,
      [DEUZ_ATTR.contextTokens]: manifest.budget.selectedTokens,
      [DEUZ_ATTR.contextEstimator]: manifest.estimator.kind,
      [DEUZ_ATTR.contextRefreshReason]: manifest.refresh,
      [DEUZ_ATTR.contextCachePrefixChanged]: manifest.cachePrefixChanged,
      [DEUZ_ATTR.contextManifestDigest]: await digestJson(manifest),
    };
    if (manifest.fallback) attributes[DEUZ_ATTR.contextFallback] = manifest.fallback;
    for (const source of manifest.sources) {
      const key = `deuz.context.source.${attributeId(source.source)}`;
      attributes[`${key}.selected`] = source.selected;
      attributes[`${key}.excluded`] = source.excluded;
      attributes[`${key}.tokens`] = source.tokens;
    }
    annotate(attributes);
    return pkg;
  }

  function checkStep(input: ContextStepInput): { inputTokens: number; usedTokens: number } {
    integer(input.step, 0, 'step');
    if (!Array.isArray(input.messages))
      throw new TypeError('context compiler: messages must be an array');
    const window = finite(input.model?.contextWindow, 1, 'model.contextWindow');
    const output = finite(input.model?.maxOutputTokens, 0, 'model.maxOutputTokens');
    const overhead = finite(input.overheadTokens, 0, 'overheadTokens');
    return {
      inputTokens: Math.max(0, window - output),
      usedTokens: estimator.estimate(input.messages) + overhead,
    };
  }

  /**
   * The placed entries whose blocks the messages still carry, and those a
   * compaction removed. A block is its pass and step; an entry checkpointed
   * without its step is kept while any block of its pass is present.
   */
  function stillPlaced(entries: readonly ContextPlacedEntry[], messages: readonly Message[]) {
    const passes = placedPasses(messages);
    const blocks = placedBlocks(messages);
    const kept: ContextPlacedEntry[] = [];
    const dropped: ContextPlacedEntry[] = [];
    for (const entry of entries) {
      const present =
        entry.pass === undefined ||
        (entry.step === undefined
          ? passes.has(entry.pass)
          : blocks.has(blockKey(entry.pass, entry.step)));
      (present ? kept : dropped).push(entry);
    }
    return { kept, dropped };
  }

  function prefixChanged(messages: readonly Message[]): boolean {
    const prefix = state.prefix;
    if (!prefix) return false;
    if (messages.length < prefix.messages) return true;
    return prefixDigest(messages.slice(0, prefix.messages).map(messageDigest)) !== prefix.digest;
  }

  async function beforeModelCall(input: ContextStepInput): Promise<ContextPackage> {
    const compile = async (annotate: (more: TelemetryAttributes) => void) => {
      const { inputTokens, usedTokens } = checkStep(input);
      const placedAtStart = state.placed;
      const { kept, dropped } = stillPlaced(placedAtStart, input.messages);
      const cachePrefixChanged = prefixChanged(input.messages);
      const activeTaskId = input.workingMemory?.tasks?.activeTaskId;
      const requested = state.refreshRequested === true || input.refresh === true;

      let due: ContextRefreshReason | undefined;
      if (input.redacted) due = 'redacted';
      else if (state.passes === 0 && state.lastRefreshStep === undefined) due = 'initial';
      else if (requested) due = 'host-request';
      else if (
        activeTaskId !== state.activeTaskId &&
        (state.lastRefreshStep === undefined || input.step - state.lastRefreshStep >= minSteps)
      )
        due = 'active-task-changed';
      const limited = due !== undefined && due !== 'redacted' && state.passes >= maxPasses;

      let results: ContextSourceResult[];
      let pass: number;
      let refresh: ContextRefreshReason;
      let fallback: ContextManifest['fallback'];
      const answered =
        due !== undefined && !limited
          ? await querySources(input, inputTokens, usedTokens)
          : undefined;
      if (answered) {
        results = answered;
        pass = state.passes + 1;
        refresh = due!;
      } else if (due !== undefined && !limited) {
        // Nothing to ask yet (no user text, no task): the refresh stays due.
        results = await reuse(dropped, placedAtStart, true, input, inputTokens, usedTokens);
        pass = state.passes;
        refresh = 'reused';
      } else {
        results = await reuse(dropped, placedAtStart, false, input, inputTokens, usedTokens);
        pass = state.passes;
        refresh = 'reused';
        if (limited) fallback = 'pass-limit';
      }
      if (!fallback && results.some((result) => result.status === 'failed'))
        fallback = 'source-failed';

      const pkg = compileContext({
        step: input.step,
        results,
        inputTokens,
        usedTokens,
        ...(options.budget ? { budget: options.budget } : {}),
        ...(input.workingMemory ? { workingMemory: input.workingMemory } : {}),
        placed: kept,
        refresh,
        pass,
        ...(fallback ? { fallback } : {}),
        cachePrefixChanged,
        phase: 'compile',
        estimator,
        estimatorKind: estimatorKind(input),
      });

      if (answered || limited) {
        // A due refresh is consumed even past the pass limit, so the limit is reported once.
        const next: ContextCompilerState = { ...state };
        delete next.refreshRequested;
        if (activeTaskId !== undefined) next.activeTaskId = activeTaskId;
        else delete next.activeTaskId;
        if (answered) {
          next.passes = pass;
          next.lastRefreshStep = input.step;
        }
        state = next;
      }
      if (answered)
        for (const result of results)
          for (const candidate of result.candidates) remember(result.source, candidate);
      lastStep = {
        step: input.step,
        placedAtStart,
        results,
        fresh: answered !== undefined,
        skipped: answered === undefined && due !== undefined && !limited,
        pass,
        ...(fallback ? { fallback } : {}),
        cachePrefixChanged,
        ...(activeTaskId !== undefined ? { activeTaskId } : {}),
      };
      for (const warning of contextWarnings(pkg.manifest)) options.onWarning?.(warning);
      return finish(input, pkg, kept, annotate);
    };
    return observeSpan(
      deps,
      DEUZ_SPAN.contextCompile,
      undefined,
      compile,
      telemetryParentOf(input),
    );
  }

  async function onOverflow(
    input: ContextStepInput & { inputTokens: number },
  ): Promise<ContextPackage> {
    const compile = async (annotate: (more: TelemetryAttributes) => void) => {
      const { usedTokens } = checkStep(input);
      const inputTokens = finite(input.inputTokens, 0, 'inputTokens');
      const memory = lastStep?.step === input.step ? lastStep : undefined;
      // Against what was placed when the step began: the retry's compaction
      // may have removed blocks the step still carried.
      const placedAtStart = memory?.placedAtStart ?? state.placed;
      const { kept, dropped } = stillPlaced(placedAtStart, input.messages);
      // A fresh retrieval decides what its step holds, as in beforeModelCall;
      // otherwise what the compactions removed is placed again.
      const results = memory?.fresh
        ? memory.results
        : await reuse(
            dropped,
            placedAtStart,
            memory?.skipped === true,
            input,
            inputTokens,
            usedTokens,
          );
      const fallback =
        memory?.fallback ??
        (results.some((result) => result.status === 'failed') ? 'source-failed' : undefined);
      const pkg = compileContext({
        step: input.step,
        results,
        inputTokens,
        usedTokens,
        ...(options.budget ? { budget: options.budget } : {}),
        ...(input.workingMemory ? { workingMemory: input.workingMemory } : {}),
        placed: kept,
        refresh: 'overflow-retry',
        pass: memory?.pass ?? state.passes,
        ...(fallback ? { fallback } : {}),
        cachePrefixChanged: memory?.cachePrefixChanged ?? prefixChanged(input.messages),
        phase: 'overflow-retry',
        estimator,
        estimatorKind: estimatorKind(input),
      });
      // A fresh step's failures were reported when it compiled; these are the retry's own.
      if (!memory?.fresh)
        for (const warning of contextWarnings(pkg.manifest)) options.onWarning?.(warning);
      return finish(input, pkg, kept, annotate);
    };
    return observeSpan(
      deps,
      DEUZ_SPAN.contextCompile,
      undefined,
      compile,
      telemetryParentOf(input),
    );
  }

  // A V3 run given this instance claims its `scope` as it claims the options' one.
  return pinCompilerScope(
    {
      sources,
      beforeModelCall,
      onOverflow,
      requestRefresh() {
        state = { ...state, refreshRequested: true };
      },
      state() {
        return JSON.parse(JSON.stringify(state)) as ContextCompilerState;
      },
    },
    options.scope,
  );
}
