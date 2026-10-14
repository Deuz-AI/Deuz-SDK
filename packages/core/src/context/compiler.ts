/**
 * The stateful context compiler (2.4 preview, spec §2.3): when to query the
 * sources, what the package of each model step holds, and the state a V3
 * checkpoint keeps so a restart compiles the same context. The compiling
 * itself is `compileContext`. Edge-safe.
 */
import { canonicalJson, digestJson, sha256Digest, type Sha256Digest } from '../internal/digest';
import { createTokenEstimator } from '../internal/estimate-tokens';
import { resolveDependencies } from '../internal/resolve-deps';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan, type TelemetryAttributes } from '../internal/telemetry';
import type { Message } from '../types/message';
import type { CallWarning } from '../types/methods';
import { compileContext } from './compile';
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_CONTEXT_REFRESH } from './defaults';
import { isContextMessage, messageText, placedPasses } from './render';
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
  placedBefore: ContextPlacedEntry[];
  results: ContextSourceResult[];
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
 *   gets `scope`, `candidatesPerSource`, a token hint of its share and
 *   `recordedAsOf` (the clock at the pass).
 * - Automatic refreshes (an active-task change) wait `minSteps` model steps
 *   after the last retrieval; host requests (`requestRefresh()`,
 *   `input.refresh`) do not. A due refresh past `maxPasses` is consumed with
 *   `fallback: 'pass-limit'`. `input.redacted` always retrieves again.
 * - Between refreshes (`refresh: 'reused'`) nothing new is retrieved. An
 *   entry whose `'append'` block left the messages (a compaction) is placed
 *   again from what this compiler instance retrieved; after a restart it
 *   waits for the next refresh.
 * - `cachePrefixChanged` is true when the messages no longer start with the
 *   previous request's messages and its `'append'` block (placed right after
 *   them).
 * - `onOverflow` recompiles the step's package from the same retrieval
 *   under the smaller `inputTokens` (refresh `'overflow-retry'`), replacing
 *   the overflowed package's placements; mandatory content that does not fit
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
    const hints = budgetHints(inputTokens, usedTokens);
    const recordedAsOf = deps.clock.now();
    const settled = await Promise.allSettled(
      sources.map(async (source) => {
        const answer = await source.query({
          text: query,
          ...(options.scope ? { scope: options.scope } : {}),
          limit,
          budgetTokens: hints.get(source.id) ?? 0,
          recordedAsOf,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!Array.isArray(answer))
          throw new TypeError(
            `The context source '${source.id}' answered without a candidate list`,
          );
        return answer as readonly ContextCandidate[];
      }),
    );
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected' && sources[index]!.required) throw outcome.reason;
    });
    return settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? { source: describe(sources[index]!), status: 'ok', candidates: outcome.value }
        : {
            source: describe(sources[index]!),
            status: 'failed',
            candidates: [],
            error: errorSummary(outcome.reason),
          },
    );
  }

  function describe(source: ContextSource): ContextSourceResult['source'] {
    return { id: source.id, kind: source.kind, ...(source.required ? { required: true } : {}) };
  }

  /** The candidates to place again: those whose block a compaction removed. */
  function replacements(dropped: readonly ContextPlacedEntry[]): ContextSourceResult[] {
    const bySource = new Map<string, ContextSourceResult>();
    for (const entry of dropped) {
      const found = known.get(placedKey(entry));
      if (!found) continue;
      const result = bySource.get(found.source.id) ?? {
        source: found.source,
        status: 'ok' as const,
        candidates: [],
      };
      (result.candidates as ContextCandidate[]).push(found.candidate);
      bySource.set(found.source.id, result);
    }
    return sources.flatMap((source) => bySource.get(source.id) ?? []);
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

  /** The placed entries whose blocks the messages still carry, and those a compaction removed. */
  function stillPlaced(entries: readonly ContextPlacedEntry[], messages: readonly Message[]) {
    const present = placedPasses(messages);
    const kept: ContextPlacedEntry[] = [];
    const dropped: ContextPlacedEntry[] = [];
    for (const entry of entries)
      (entry.pass === undefined || present.has(entry.pass) ? kept : dropped).push(entry);
    return { kept, dropped };
  }

  function prefixChanged(messages: readonly Message[]): boolean {
    const prefix = state.prefix;
    if (!prefix) return false;
    if (messages.length < prefix.messages) return true;
    return prefixDigest(messages.slice(0, prefix.messages).map(messageDigest)) !== prefix.digest;
  }

  async function beforeModelCall(input: ContextStepInput): Promise<ContextPackage> {
    return observeSpan(deps, DEUZ_SPAN.contextCompile, undefined, async (annotate) => {
      const { inputTokens, usedTokens } = checkStep(input);
      const { kept, dropped } = stillPlaced(state.placed, input.messages);
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
        if (results.some((result) => result.status === 'failed')) fallback = 'source-failed';
      } else if (due !== undefined && !limited) {
        // Nothing to ask yet (no user text, no task): the refresh stays due.
        results = sources.map((source) => ({
          source: describe(source),
          status: 'skipped' as const,
          candidates: [],
        }));
        pass = state.passes;
        refresh = 'reused';
      } else {
        results = replacements(dropped);
        pass = state.passes;
        refresh = 'reused';
        if (limited) fallback = 'pass-limit';
      }

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
          for (const candidate of result.candidates)
            known.set(
              placedKey({
                source: result.source.id,
                recordId: candidate.recordId,
                digest: candidate.digest,
              }),
              { source: result.source, candidate },
            );
      lastStep = {
        step: input.step,
        placedBefore: kept,
        results,
        pass,
        ...(fallback ? { fallback } : {}),
        cachePrefixChanged,
        ...(activeTaskId !== undefined ? { activeTaskId } : {}),
      };
      for (const warning of contextWarnings(pkg.manifest)) options.onWarning?.(warning);
      return finish(input, pkg, kept, annotate);
    });
  }

  async function onOverflow(
    input: ContextStepInput & { inputTokens: number },
  ): Promise<ContextPackage> {
    return observeSpan(deps, DEUZ_SPAN.contextCompile, undefined, async (annotate) => {
      const { usedTokens } = checkStep(input);
      const inputTokens = finite(input.inputTokens, 0, 'inputTokens');
      const memory = lastStep?.step === input.step ? lastStep : undefined;
      const { kept } = stillPlaced(memory?.placedBefore ?? state.placed, input.messages);
      const pkg = compileContext({
        step: input.step,
        results: memory?.results ?? [],
        inputTokens,
        usedTokens,
        ...(options.budget ? { budget: options.budget } : {}),
        ...(input.workingMemory ? { workingMemory: input.workingMemory } : {}),
        placed: kept,
        refresh: 'overflow-retry',
        pass: memory?.pass ?? state.passes,
        ...(memory?.fallback ? { fallback: memory.fallback } : {}),
        cachePrefixChanged: memory?.cachePrefixChanged ?? prefixChanged(input.messages),
        phase: 'overflow-retry',
        estimator,
        estimatorKind: estimatorKind(input),
      });
      return finish(input, pkg, kept, annotate);
    });
  }

  return {
    sources,
    beforeModelCall,
    onOverflow,
    requestRefresh() {
      state = { ...state, refreshRequested: true };
    },
    state() {
      return JSON.parse(JSON.stringify(state)) as ContextCompilerState;
    },
  };
}
