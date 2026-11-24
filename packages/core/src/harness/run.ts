/**
 * harness/run.ts — one prompt to an external coding harness over ACP, with
 * every permission request decided by Deuz, the meter's measured receipts and
 * the harness's declared cost side by side, and the tool calls counted by
 * whether Deuz decided them (2.5). Edge-safe: the connection is injected, so
 * this runs over any ACP transport; `runHarness` in
 * `@deuz-sdk/core/harness/node` spawns the harness and its meter.
 */
import { AcpError } from '../acp/errors';
import type {
  AcpClientConnection,
  AcpClientSession,
  AcpPermissionHandler,
  AcpPromptResult,
} from '../acp/client';
import type { AcpRequestPermissionOutcome, AcpToolCallUpdate, AcpToolKind } from '../acp/types';
import { resolveDependencies } from '../internal/resolve-deps';
import { declaredReceipt } from '../meter/receipt';
import type { MeterReceipt, MeterReceiptSink } from '../meter/types';
import { decideHarnessPermission, harnessOutcome, normalizeHarnessPath } from './policy';
import type {
  HarnessCostComparison,
  HarnessDecisionRecord,
  HarnessMeasured,
  HarnessMeterLink,
  HarnessPermissionRequest,
  HarnessResult,
  RunAcpHarnessOptions,
} from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How long a harness has to end its turn after `session/cancel` before it is shut down. */
const CANCEL_GRACE_MS = 10_000;

/**
 * A meter link that collects the receipts of a meter this run owns: pass
 * `sink` among the meter's `receipts` and `link` to the run. `flush` is the
 * meter's own (`MeterHandler.flush`), so the totals include every request the
 * harness started.
 *
 * ```ts
 * const collector = createHarnessReceiptCollector({ flush: () => meter.flush() });
 * const meter = createMeterHandler({ budget, receipts: [collector.sink] });
 * ```
 */
export function createHarnessReceiptCollector(options: { flush?: () => Promise<void> } = {}): {
  sink: MeterReceiptSink;
  link: HarnessMeterLink;
} {
  const receipts: MeterReceipt[] = [];
  const listeners = new Set<(receipt: MeterReceipt) => void>();
  let started = false;
  const sink: MeterReceiptSink = (receipt) => {
    if (!started || receipt.source !== 'measured') return;
    receipts.push(receipt);
    for (const listener of listeners) {
      try {
        listener(receipt);
      } catch {
        // a listener never fails a receipt
      }
    }
  };
  return {
    sink,
    link: {
      start() {
        started = true;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      flush: options.flush ?? (() => Promise.resolve()),
      read: () => summarizeReceipts(receipts, true),
    },
  };
}

/** Totals of measured receipts. @internal */
export function summarizeReceipts(
  receipts: readonly MeterReceipt[],
  exact: boolean,
): HarnessMeasured {
  let usd = 0;
  let chargedUsd = 0;
  let tokens = 0;
  let refused = 0;
  const keys = new Set<string>();
  for (const receipt of receipts) {
    usd += receipt.usd ?? 0;
    chargedUsd += receipt.charged?.usd ?? 0;
    tokens += receipt.usage?.totalTokens ?? 0;
    if (receipt.outcome === 'refused') {
      refused++;
      if (receipt.refusal?.reason === 'budget_exceeded') keys.add(receipt.refusal.key);
    }
  }
  return {
    receipts: [...receipts],
    usd,
    chargedUsd,
    tokens,
    requests: receipts.length,
    refused,
    exhaustedKeys: [...keys],
    exact,
  };
}

/** Measured against declared; see {@link HarnessCostComparison}. */
export function compareHarnessCost(
  measuredUsd: number | undefined,
  declaredUsd: number | undefined,
  thresholds: { relative?: number; absoluteUsd?: number } = {},
): HarnessCostComparison {
  const relative = thresholds.relative ?? 0.1;
  const absolute = thresholds.absoluteUsd ?? 0.001;
  if (measuredUsd === undefined && declaredUsd === undefined)
    return { status: 'unavailable', diverged: false };
  if (measuredUsd === undefined)
    return { status: 'unmeasured', diverged: false, declaredUsd: declaredUsd as number };
  if (declaredUsd === undefined) return { status: 'undeclared', diverged: false, measuredUsd };
  const deltaUsd = measuredUsd - declaredUsd;
  const gap = Math.abs(deltaUsd);
  const diverged =
    gap > absolute && gap > relative * Math.max(Math.abs(measuredUsd), Math.abs(declaredUsd));
  return {
    status: diverged ? 'diverged' : 'consistent',
    diverged,
    measuredUsd,
    declaredUsd,
    deltaUsd,
  };
}

const locationsOf = (call: AcpToolCallUpdate | undefined): string[] =>
  Array.isArray(call?.locations)
    ? call!.locations.flatMap((location) =>
        isRecord(location) && typeof location.path === 'string' ? [location.path] : [],
      )
    : [];

/**
 * Send one prompt to a harness over ACP and report what it came to.
 *
 * - Every `session/request_permission` is decided by Deuz: `policy` (by tool
 *   kind and path), then `onPermission`, then `approveToolCall`, then
 *   `fallback` (deny). Each decision is recorded, and signed when `signer` is
 *   given. Deuz answers with a `*_once` option where offered, so the next call
 *   is asked about again.
 * - Cost: the meter's measured receipts (when `meter` is given) and the cost
 *   the harness declared in `usage_update` (recorded as a `source: 'declared'`
 *   receipt, sent to `receipts`) are reported side by side, with a
 *   comparison that flags divergence.
 * - At the first 402 for a budget ceiling the turn is cancelled (unless
 *   `onBudgetExhausted: 'continue'`).
 * - `sessionMode` switches the session (`session/set_mode`) before the
 *   prompt, for a harness that asks nothing in its default mode.
 *
 * The honest limits: a harness runs its tools itself and asks only when it
 * chooses to. Deuz decides what it is asked and sees what it is told; the
 * result's `toolCalls` says how many calls went through a Deuz decision and
 * how many were only observed. A harness configured to skip permission
 * prompts asks nothing. And this function cannot touch a file system, so
 * unless `resolvePath` is given the policy sees the paths as the harness sent
 * them: a symlink, junction or short (8.3) name of a denied file is matched
 * by its own name, not its target's. `runHarness` resolves them on Node.
 *
 * Rejects with an `AcpError` when the connection or the session cannot be
 * opened, the session mode cannot be set, or the turn fails at the protocol
 * level.
 */
export async function runAcpHarness(options: RunAcpHarnessOptions): Promise<HarnessResult> {
  const deps = resolveDependencies({
    ...(options.deps?.clock ? { clock: options.deps.clock } : {}),
    ...(options.deps?.generateId ? { generateId: options.deps.generateId } : {}),
  });
  const clock = deps.clock;
  if (options.signal?.aborted) {
    throw new AcpError({
      kind: 'cancelled',
      message: 'The harness run was aborted before it started.',
    });
  }
  const startedAt = clock.now();
  const decisions: HarnessDecisionRecord[] = [];
  const reported = new Map<string, { kind?: AcpToolKind; title?: string; paths: string[] }>();
  let sessionId: string | undefined;
  let sessionMode: string | undefined;
  let decisionCount = 0;
  let realCwd: Promise<string | null> | undefined;
  const resolvePaths = async (
    paths: readonly string[],
  ): Promise<{ resolvedPaths: (string | null)[]; resolvedCwd?: string } | undefined> => {
    const resolve = options.resolvePath;
    if (!resolve) return undefined;
    const safely = (path: string) =>
      resolve(path).then(
        (real) => (typeof real === 'string' && real !== '' ? real : null),
        () => null,
      );
    realCwd ??= safely(normalizeHarnessPath(options.cwd));
    const [cwd, ...resolvedPaths] = await Promise.all([
      realCwd,
      ...paths.map((path) => safely(normalizeHarnessPath(path, options.cwd))),
    ]);
    return { resolvedPaths, ...(cwd ? { resolvedCwd: cwd } : {}) };
  };

  const noteCall = (update: AcpToolCallUpdate & { sessionUpdate?: string }) => {
    const known = reported.get(update.toolCallId) ?? { paths: [] };
    if (update.kind) known.kind = update.kind;
    if (typeof update.title === 'string') known.title = update.title;
    const paths = locationsOf(update);
    if (paths.length > 0) known.paths = paths;
    reported.set(update.toolCallId, known);
  };

  const onPermissionRequest: AcpPermissionHandler = async (request, context) => {
    const call = request.toolCall;
    const known = reported.get(call.toolCallId);
    const kind = call.kind ?? known?.kind ?? undefined;
    const requestPaths = locationsOf(call);
    const paths = requestPaths.length > 0 ? requestPaths : (known?.paths ?? []);
    const title = typeof call.title === 'string' ? call.title : known?.title;
    const resolved = context.signal.aborted ? undefined : await resolvePaths(paths);
    const harnessRequest: HarnessPermissionRequest = {
      harness: options.name,
      sessionId: request.sessionId,
      toolCallId: call.toolCallId,
      ...(title !== undefined ? { title } : {}),
      ...(kind ? { kind } : {}),
      paths,
      ...(resolved ?? {}),
      ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
      options: request.options,
      request,
    };
    const draft = context.signal.aborted
      ? { decision: 'deny' as const, decidedBy: 'cancelled' as const }
      : await decideHarnessPermission(harnessRequest, options, {
          cwd: options.cwd,
          signal: context.signal,
        });
    const outcome: AcpRequestPermissionOutcome = context.signal.aborted
      ? { outcome: 'cancelled' }
      : harnessOutcome(draft.decision, request.options);
    const at = clock.now();
    let token: string | undefined;
    if (options.signer) {
      decisionCount++;
      try {
        token = await options.signer.sign(
          {
            approvalId: `harness:${request.sessionId}:${call.toolCallId}:${decisionCount}`,
            toolCallId: call.toolCallId,
            toolName: `${options.name}.${kind ?? 'other'}`,
            input: {
              decision: draft.decision,
              decidedBy: draft.decidedBy,
              kind: kind ?? 'other',
              paths,
            },
          },
          options.runId !== undefined ? { runId: options.runId } : undefined,
        );
      } catch {
        token = undefined;
      }
    }
    decisions.push({
      toolCallId: call.toolCallId,
      ...(title !== undefined ? { title } : {}),
      ...(kind ? { kind } : {}),
      paths,
      ...(resolved ? { resolvedPaths: resolved.resolvedPaths } : {}),
      decision: draft.decision,
      decidedBy: draft.decidedBy,
      ...(draft.rule !== undefined ? { rule: draft.rule } : {}),
      ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
      ...(outcome.outcome === 'selected' ? { optionId: outcome.optionId } : {}),
      at,
      ...(token !== undefined ? { token } : {}),
    });
    return outcome;
  };

  const onSessionUpdate = (notification: {
    sessionId: string;
    update: { sessionUpdate: string };
  }) => {
    if (sessionId !== undefined && notification.sessionId !== sessionId) return;
    const update = notification.update as unknown as AcpToolCallUpdate & {
      sessionUpdate: string;
      currentModeId?: unknown;
    };
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
      noteCall(update);
    else if (
      update.sessionUpdate === 'current_mode_update' &&
      typeof update.currentModeId === 'string'
    )
      sessionMode = update.currentModeId;
  };

  const connection: AcpClientConnection = await options.connect({
    onPermissionRequest,
    onSessionUpdate,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let unsubscribe: (() => void) | undefined;
  // A harness that ignores `session/cancel` is shut down (a spawned one is
  // killed) after a grace period, so an abort or a spent budget always ends
  // the run instead of waiting on the harness forever.
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let shutDown = false;
  const shutDownLater = () => {
    shutdownTimer ??= setTimeout(() => {
      shutDown = true;
      void connection.close().catch(() => undefined);
    }, CANCEL_GRACE_MS);
  };
  options.signal?.addEventListener('abort', shutDownLater, { once: true });
  if (options.signal?.aborted) shutDownLater();
  try {
    const session: AcpClientSession = await connection.newSession({
      cwd: options.cwd,
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
    });
    sessionId = session.sessionId;
    if (options.sessionMode !== undefined) {
      try {
        await connection.peer.request(
          'session/set_mode',
          { sessionId, modeId: options.sessionMode },
          options.signal ? { signal: options.signal } : {},
        );
      } catch (error) {
        throw new AcpError({
          kind: error instanceof AcpError && error.kind !== 'rpc' ? error.kind : 'protocol',
          message: `The harness did not switch the session to mode '${options.sessionMode}', so it could run its tools without asking; the prompt was not sent.`,
          cause: error,
        });
      }
      sessionMode = options.sessionMode;
    }
    const meter = options.meter;
    let cancelledForBudget = false;
    if (meter?.subscribe && (options.onBudgetExhausted ?? 'cancel') === 'cancel') {
      unsubscribe = meter.subscribe((receipt) => {
        if (cancelledForBudget || receipt.refusal?.reason !== 'budget_exceeded') return;
        cancelledForBudget = true;
        void session.cancel().catch(() => undefined);
        shutDownLater();
      });
    }
    meter?.start();
    const turn = session.prompt(options.prompt, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
    });
    const outcome: AcpPromptResult = await turn.result;
    for (const call of outcome.toolCalls) {
      noteCall({
        toolCallId: call.toolCallId,
        ...(call.kind ? { kind: call.kind } : {}),
        title: call.title,
        locations: call.locations,
      });
    }
    let measured: HarnessMeasured | undefined;
    if (meter) {
      await meter.flush();
      measured = meter.read();
    }
    const endedAt = clock.now();

    const declaredCost = outcome.cost;
    const declaredUsd =
      declaredCost && declaredCost.currency.toUpperCase() === 'USD'
        ? declaredCost.amount
        : undefined;
    const receipts: MeterReceipt[] = [...(measured?.receipts ?? [])];
    if (declaredCost) {
      const receipt = await declaredReceipt(
        {
          provider: `acp:${options.name}`,
          route: 'acp:session/prompt',
          ...(declaredUsd !== undefined ? { usd: Math.max(0, declaredUsd) } : {}),
          startedAt,
          endedAt,
          requestId: `declared:acp:${options.name}:${session.sessionId}:${deps.generateId()}`,
          outcome: outcome.stopReason === 'cancelled' ? 'aborted' : 'completed',
        },
        { clock, generateId: deps.generateId },
      );
      receipts.push(receipt);
      await deliver(options.receipts, receipt);
    }

    const decidedIds = new Set(decisions.map((decision) => decision.toolCallId));
    const allowed = new Set(
      decisions.filter((d) => d.decision === 'allow').map((d) => d.toolCallId),
    );
    const denied = new Set(decisions.filter((d) => d.decision === 'deny').map((d) => d.toolCallId));
    const observedIds = new Set([...reported.keys(), ...decidedIds]);
    return {
      harness: options.name,
      sessionId: session.sessionId,
      ...(sessionMode !== undefined ? { sessionMode } : {}),
      stopReason: outcome.stopReason,
      text: outcome.text,
      thought: outcome.thought,
      ...(outcome.plan ? { plan: outcome.plan } : {}),
      cost: {
        ...(measured ? { measured } : {}),
        ...(declaredCost
          ? {
              declared: {
                amount: declaredCost.amount,
                currency: declaredCost.currency,
                ...(declaredUsd !== undefined ? { usd: declaredUsd } : {}),
              },
            }
          : {}),
        comparison: compareHarnessCost(measured?.usd, declaredUsd, options.divergence),
      },
      receipts,
      budget: {
        exhausted: (measured?.exhaustedKeys.length ?? 0) > 0,
        refused: measured?.refused ?? 0,
        exhaustedKeys: measured?.exhaustedKeys ?? [],
      },
      toolCalls: {
        observed: observedIds.size,
        decided: decidedIds.size,
        allowed: allowed.size,
        denied: [...denied].filter((id) => !allowed.has(id)).length,
        observedOnly: [...observedIds].filter((id) => !decidedIds.has(id)).length,
      },
      decisions,
      calls: outcome.toolCalls,
      startedAt,
      durationMs: Math.max(0, endedAt - startedAt),
    };
  } catch (error) {
    if (!shutDown) throw error;
    throw new AcpError({
      kind: 'cancelled',
      message: `The harness did not end its turn within ${CANCEL_GRACE_MS} ms of the cancel, so it was shut down.`,
      cause: error,
    });
  } finally {
    options.signal?.removeEventListener('abort', shutDownLater);
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
    unsubscribe?.();
    if (!options.keepOpen) await connection.close().catch(() => undefined);
  }
}

async function deliver(
  sinks: MeterReceiptSink | readonly MeterReceiptSink[] | undefined,
  receipt: MeterReceipt,
): Promise<void> {
  if (!sinks) return;
  for (const sink of typeof sinks === 'function' ? [sinks] : sinks) {
    try {
      await sink(receipt);
    } catch {
      // a failing sink never fails the run
    }
  }
}
