/**
 * `@deuz-sdk/core/harness/node` (2.5) — run an external coding harness as a
 * child process under a Deuz budget: start a deuz meter on a loopback port,
 * point the harness's base URLs at it, spawn the harness as an ACP agent, send
 * one prompt, decide its permission requests, and report the measured and the
 * declared cost side by side.
 *
 * ```ts
 * import { runHarness } from '@deuz-sdk/core/harness/node';
 * import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';
 *
 * const result = await runHarness({
 *   harness: 'claude-code',
 *   prompt: 'Run the tests and fix what fails.',
 *   cwd: '/work/repo',
 *   budget: {
 *     store: createSqliteBudgetStore({ path: '.deuz/budget.sqlite' }),
 *     scopes: [{ key: 'harness:ci', limits: { usd: 2 } }],
 *   },
 *   policy: { rules: [{ decision: 'allow', kinds: ['read', 'search', 'edit'], paths: ['**'] }] },
 * });
 * result.cost.measured?.usd; result.cost.comparison.status; result.toolCalls.observedOnly;
 * ```
 *
 * Node-only (`node:child_process`, `node:http`, `node:fs`), loaded on use.
 */
import type { AcpSpawnOptions } from './acp-stdio';
import { spawnAcpAgent } from './acp-stdio';
import { createMeterProxy, type MeterProxy, type MeterProxyOptions } from './meter';
import { resolveHarness } from '../harness/presets';
import { createHarnessReceiptCollector, runAcpHarness } from '../harness/run';
import type { HarnessPresetName } from '../harness/presets';
import type {
  HarnessMeterLink,
  HarnessPreset,
  HarnessResult,
  HarnessSpec,
  RunAcpHarnessOptions,
} from '../harness/types';
import type { MeterBudgetOptions, MeterReceiptSink } from '../meter/types';
import type { JSONSchema } from '../types/schema';
import type { Tool, ToolExecuteContext } from '../types/tool';

export type * from '../harness/types';
export type { HarnessPresetName } from '../harness/presets';

/** Options of {@link runHarness}. */
export interface RunHarnessOptions extends Omit<
  RunAcpHarnessOptions,
  'connect' | 'meter' | 'name' | 'cwd' | 'keepOpen' | 'resolvePath'
> {
  /** A preset name (`'claude-code'`, `'codex'`, `'gemini-cli'`, `'opencode'`), a preset, or your own spec. */
  readonly harness: HarnessPresetName | HarnessPreset | HarnessSpec;
  /** The session's working directory and the child's. Default: this process's. */
  readonly cwd?: string;
  /**
   * The budget the harness's model traffic is charged to and refused at. A
   * meter is started for the run with it. Pass the same store and scope keys
   * as the parent run to share its ceiling.
   */
  readonly budget?: MeterBudgetOptions;
  /**
   * The meter. Omitted: a meter of this run alone on 127.0.0.1 (with
   * `budget`, or measuring only), closed when the run ends. Options: the same,
   * with these meter options (upstreams, estimate, price provider…). A
   * listening `MeterProxy`: a shared meter, whose stats are diffed over the
   * run (`measured.exact: false`, no per-run receipts, no live ceiling
   * cancel). `false`: no meter; nothing is measured or capped.
   */
  readonly meter?:
    | false
    | MeterProxy
    | Omit<MeterProxyOptions, 'budget' | 'receipts' | 'host' | 'port'>;
  /**
   * A budget is rejected, because the ceiling could not hold, with a harness
   * whose traffic the meter cannot measure (Gemini CLI), and while one of the
   * harness's provider switches (`unmeteredEnv`, e.g. Claude Code's
   * `CLAUDE_CODE_USE_BEDROCK`) is set to a true value in this process's
   * environment or `env`. True runs it anyway; what goes around the meter is
   * neither measured nor capped.
   */
  readonly allowUnmetered?: boolean;
  /**
   * Resolve the paths of each permission request to their real paths
   * (symlinks, junctions, Windows short 8.3 names) before the policy is
   * evaluated, so a link to a denied file is denied: see
   * `RunAcpHarnessOptions.resolvePath`. A path that does not exist yet is
   * resolved through its nearest existing ancestor (a dangling link through
   * its target). Default: on, with `fs.realpath.native`. `false` turns it
   * off; a function replaces the resolver.
   */
  readonly resolvePath?: false | ((path: string) => Promise<string | null>);
  /**
   * Added to this process's environment for the child (API keys, for
   * example). The meter's base URL variables are set over it, so they cannot
   * be overridden by accident; route the meter itself with `meter.upstreams`.
   */
  readonly env?: Record<string, string | undefined>;
  /**
   * Run through a shell. Default: the preset's `windowsShell` on win32.
   * Arguments are not escaped: the command line is the command and its
   * arguments joined by spaces, as Node itself would join them.
   */
  readonly shell?: boolean;
  /** The child's stderr; see `AcpSpawnOptions.stderr`. Default `'inherit'`. */
  readonly stderr?: AcpSpawnOptions['stderr'];
  readonly killTimeoutMs?: number;
  /** Where every receipt goes: the meter's measured ones and the declared one. */
  readonly receipts?: MeterReceiptSink | readonly MeterReceiptSink[];
}

const isMeterProxy = (value: unknown): value is MeterProxy =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as MeterProxy).listen === 'function' &&
  'handler' in value;

function sharedMeterLink(proxy: MeterProxy): HarnessMeterLink {
  let base = proxy.stats();
  return {
    start() {
      base = proxy.stats();
    },
    flush: () => proxy.handler.flush(),
    read() {
      const now = proxy.stats();
      return {
        receipts: [],
        usd: now.usd - base.usd,
        chargedUsd: now.chargedUsd - base.chargedUsd,
        tokens: now.tokens - base.tokens,
        requests: now.requests - base.requests,
        refused: now.refused - base.refused,
        exhaustedKeys: [],
        exact: false,
      };
    },
  };
}

const sinksOf = (
  sinks: MeterReceiptSink | readonly MeterReceiptSink[] | undefined,
): MeterReceiptSink[] =>
  sinks === undefined ? [] : typeof sinks === 'function' ? [sinks] : [...sinks];

interface NodeProcessLike {
  cwd(): string;
  platform: string;
  env: Record<string, string | undefined>;
}

async function nodeModule<T>(spec: string): Promise<T> {
  const mod = (await import(spec)) as { default?: T } & T;
  return mod.default ?? mod;
}

const nodeProcess = () => nodeModule<NodeProcessLike>('node:process');

/** Values that leave a switch off, as Claude Code reads its boolean variables. */
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * The names of `switches` set to a true value in `env`, matched without case
 * on Windows (where variable names are case-insensitive). Anything but an
 * empty or off value counts as on, so an odd value fails closed.
 */
function switchesOn(
  env: Record<string, string | undefined>,
  switches: readonly string[],
  platform: string,
): string[] {
  const on = new Set<string>();
  const wanted = new Map(
    switches.map((name) => [platform === 'win32' ? name.toUpperCase() : name, name]),
  );
  for (const [key, value] of Object.entries(env)) {
    const name = wanted.get(platform === 'win32' ? key.toUpperCase() : key);
    if (name !== undefined && value !== undefined && !OFF_VALUES.has(value.trim().toLowerCase()))
      on.add(name);
  }
  return [...on];
}

interface FsLike {
  realpath: { native(path: string, callback: (error: Error | null, real: string) => void): void };
  readlink(path: string, callback: (error: Error | null, target: string) => void): void;
}
interface PathLike {
  resolve(...paths: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  join(...paths: string[]): string;
}

/** How many links one path may pass through before it is given up on, like the OS's ELOOP. */
const MAX_LINK_HOPS = 40;

/**
 * A Node resolver for `resolvePath`: `fs.realpath.native` (which also expands
 * Windows short names) on the nearest existing ancestor, with the rest of the
 * path appended. A dangling link is followed to its target, since writing to
 * it creates the target. `null` when the path cannot be resolved (a link
 * loop, no access): the policy then never allows it.
 */
async function nodeRealPathResolver(): Promise<(path: string) => Promise<string | null>> {
  const fs = await nodeModule<FsLike>('node:fs');
  const path = await nodeModule<PathLike>('node:path');
  const real = (p: string) =>
    new Promise<string>((resolve, reject) =>
      fs.realpath.native(p, (error, value) => (error ? reject(error) : resolve(value))),
    );
  const link = (p: string) =>
    new Promise<string | null>((resolve) =>
      fs.readlink(p, (error, value) => resolve(error ? null : value)),
    );
  return async (input) => {
    let current = path.resolve(input);
    const rest: string[] = [];
    for (let hops = 0; ; ) {
      try {
        const base = await real(current);
        return rest.length === 0 ? base : path.join(base, ...[...rest].reverse());
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        const target = code === 'ENOENT' ? await link(current) : null;
        if (target !== null) {
          if (++hops > MAX_LINK_HOPS) return null;
          current = path.resolve(path.dirname(current), target);
          continue;
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        rest.push(path.basename(current));
        current = parent;
      }
    }
  };
}

/**
 * Run one prompt on a coding harness under a Deuz budget (2.5).
 *
 * 1. A deuz meter starts on 127.0.0.1 (unless `meter` says otherwise), bound
 *    to `budget`, and the harness's base URL variables point at it, so its own
 *    model traffic is charged and refused with 402 at the ceiling. At the
 *    first budget refusal the turn is cancelled (`onBudgetExhausted`).
 * 2. The harness is spawned as an ACP agent (`spawnAcpAgent`) and given one
 *    session in `cwd` and the prompt; `signal` cancels the turn.
 * 3. Its permission requests are decided by `policy`, `onPermission`,
 *    `approveToolCall`, then `fallback` (deny); see `runAcpHarness`.
 * 4. The result carries the text and stop reason, the measured receipts and
 *    the declared one with a divergence check, and tool calls counted by
 *    whether they went through a Deuz decision. The harness and its meter are
 *    shut down before it resolves.
 *
 * 5. Before the policy sees a request, its paths are resolved to their real
 *    paths (`resolvePath`), so a symlink, junction or short name of a denied
 *    file is denied. The preset's `sessionMode` is set before the prompt
 *    (Claude Code: `default`, where it asks before each tool call).
 *
 * Fails closed with a budget: a harness the meter cannot measure, or one of
 * the harness's provider switches set in the environment (Claude Code's
 * `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and the like, which
 * send its traffic around the meter), is refused with a `TypeError` naming
 * the variable, unless `allowUnmetered`.
 *
 * Limits: the ceiling holds only for traffic that passes the meter. A
 * harness's own settings files can reroute it, and are not read (Claude
 * Code's settings `env`). Codex signed in with ChatGPT needs ChatGPT's Codex
 * backend as the meter's OpenAI upstream (`meter.upstreams`, see
 * `codexHarness`). Admission is by estimate, so one request in flight can
 * overshoot (see the meter's docs). A harness runs its tools itself and asks
 * only when it chooses to.
 */
export async function runHarness(options: RunHarnessOptions): Promise<HarnessResult> {
  const {
    harness: harnessInput,
    cwd: cwdOption,
    budget,
    meter: meterOption,
    allowUnmetered,
    env,
    shell,
    stderr,
    killTimeoutMs,
    receipts,
    resolvePath: resolvePathOption,
    ...runOptions
  } = options;
  const harness = resolveHarness(harnessInput);
  if (budget && harness.meterable === 'none' && !allowUnmetered) {
    throw new TypeError(
      `runHarness: the meter cannot measure '${harness.name}' traffic, so a budget could not be enforced. Pass allowUnmetered: true to run it with declared cost only.`,
    );
  }
  if (budget && meterOption !== undefined && (meterOption === false || isMeterProxy(meterOption))) {
    throw new TypeError(
      'runHarness: `budget` configures the meter this run starts; with a shared meter or `meter: false`, leave it out.',
    );
  }
  const proc = await nodeProcess();
  if (budget && !allowUnmetered && harness.unmeteredEnv.length > 0) {
    // The child's environment: this process's, with `env` over it (undefined removes).
    const on = switchesOn({ ...proc.env, ...(env ?? {}) }, harness.unmeteredEnv, proc.platform);
    if (on.length > 0) {
      // Names only: a value is never echoed.
      throw new TypeError(
        `runHarness: ${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} set, which sends '${harness.name}' model traffic to another provider around the meter, so the budget could not be enforced. ` +
          `Unset ${on.length === 1 ? 'it' : 'them'} for the harness (env: { ${on[0]}: undefined }) or pass allowUnmetered: true.`,
      );
    }
  }
  const cwd = cwdOption ?? proc.cwd();
  const resolvePath =
    resolvePathOption === false ? undefined : (resolvePathOption ?? (await nodeRealPathResolver()));
  const userSinks = sinksOf(receipts);

  let owned: MeterProxy | undefined;
  let link: HarnessMeterLink | undefined;
  let meterUrl: string | undefined;
  if (meterOption !== false && harness.meterable !== 'none') {
    if (isMeterProxy(meterOption)) {
      if (!meterOption.address)
        throw new TypeError('runHarness: the shared meter is not listening.');
      meterUrl = meterOption.address.url;
      link = sharedMeterLink(meterOption);
    } else {
      // The collector's flush runs only after the proxy below exists.
      const collector = createHarnessReceiptCollector({ flush: () => proxy.handler.flush() });
      const proxy: MeterProxy = createMeterProxy({
        ...(meterOption ?? {}),
        ...(budget ? { budget } : {}),
        receipts: [collector.sink, ...userSinks],
      });
      owned = proxy;
      meterUrl = (await proxy.listen()).url;
      link = collector.link;
    }
  }

  try {
    // Inside the try: a spec's `env` that throws must not leave the meter listening.
    const childEnv: Record<string, string | undefined> = {
      ...(env ?? {}),
      ...(meterUrl ? harness.env(meterUrl) : {}),
    };
    const useShell = shell ?? (harness.windowsShell && proc.platform === 'win32');
    const sessionMode = runOptions.sessionMode ?? harness.sessionMode;
    const sessionMeta = runOptions.sessionMeta ?? harness.sessionMeta;
    return await runAcpHarness({
      ...runOptions,
      name: harness.name,
      cwd,
      ...(link ? { meter: link } : {}),
      ...(userSinks.length > 0 ? { receipts: userSinks } : {}),
      ...(resolvePath ? { resolvePath } : {}),
      ...(sessionMode !== undefined ? { sessionMode } : {}),
      ...(sessionMeta !== undefined ? { sessionMeta } : {}),
      connect: (hooks) =>
        spawnAcpAgent({
          // With a shell, one command line: what Node builds from an args
          // array, without its DEP0190 warning.
          command: useShell ? [harness.command, ...harness.args].join(' ') : harness.command,
          args: useShell ? [] : harness.args,
          cwd,
          env: childEnv,
          shell: useShell,
          ...(stderr !== undefined ? { stderr } : {}),
          ...(killTimeoutMs !== undefined ? { killTimeoutMs } : {}),
          onPermissionRequest: hooks.onPermissionRequest,
          onSessionUpdate: hooks.onSessionUpdate,
          ...(hooks.signal ? { signal: hooks.signal } : {}),
        }),
    });
  } finally {
    await owned?.close({ force: true });
  }
}

/** Options of {@link harnessTool}. */
export interface HarnessToolOptions extends Omit<RunHarnessOptions, 'prompt' | 'signal'> {
  /** Shown to the parent model. Default: a sentence naming the harness. */
  readonly description?: string;
  /**
   * Gate the delegation itself in the parent run. This is where the parent's
   * signed (HMAC) approval flow applies: the parent suspends before the
   * harness starts and resumes with the verdict.
   */
  readonly needsApproval?: Tool['needsApproval'];
  /**
   * Decide the harness's permission requests with the parent's server-mode
   * `approveToolCall` when the loop hands one down (`generateText`,
   * `streamText`, `agentTool`). Default true. Native `runAgent` tools get no
   * approver, so there only `policy` and `onPermission` decide.
   */
  readonly useParentApprover?: boolean;
  /** Sign each decision with the parent's `approvalSigner` when it has one. Default true. */
  readonly signDecisions?: boolean;
  /** Every full result, for logs and receipts (the model sees a summary). */
  onResult?(result: HarnessResult, context: ToolExecuteContext): void | Promise<void>;
}

/** What the parent model sees from a {@link harnessTool} call. */
export interface HarnessToolOutput {
  readonly text: string;
  readonly stopReason: HarnessResult['stopReason'];
  readonly measuredUsd?: number;
  readonly declaredUsd?: number;
  readonly costStatus: HarnessResult['cost']['comparison']['status'];
  readonly budgetExhausted: boolean;
  readonly toolCalls: HarnessResult['toolCalls'];
}

const HARNESS_PROMPT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { prompt: { type: 'string', description: 'The task for the coding harness.' } },
  required: ['prompt'],
  additionalProperties: false,
};

/**
 * A harness as a tool (2.5): `{ prompt }` in, a {@link HarnessToolOutput}
 * out. Drops into `generateText` / `streamText` tools and `runAgent` tools,
 * so a Deuz agent can delegate a coding task to a harness under a budget.
 * Each call spawns a fresh harness and session (`runHarness`), cancelled by
 * the call's `signal`.
 *
 * What the parent's approval machinery can and cannot carry:
 * - The delegation itself: `needsApproval` gates it with the parent's own
 *   flow, including signed approvals with suspend and resume.
 * - The harness's permission requests mid-turn: the child process waits on
 *   an open ACP request, so the parent cannot suspend and resume around it
 *   (possibly in another process). They are decided synchronously: `policy`,
 *   `onPermission`, then the parent's server-mode `approveToolCall` when one
 *   is inherited. With the parent's `approvalSigner`, each decision record is
 *   HMAC-signed as an audit attestation, which is not a resumable approval.
 *
 * The harness's spend is charged to `budget` by the meter. It is not folded
 * into the parent call's own usage, so it is not counted twice when both
 * share one BudgetStore.
 */
export function harnessTool(options: HarnessToolOptions): Tool {
  const { description, needsApproval, useParentApprover, signDecisions, onResult, ...runOptions } =
    options;
  const name = resolveHarness(options.harness).name;
  return {
    description:
      description ??
      `Delegate a coding task to the ${name} coding agent. It works in the repository and replies with what it did.`,
    parameters: HARNESS_PROMPT_SCHEMA,
    ...(needsApproval !== undefined ? { needsApproval } : {}),
    execute: async (args, ctx): Promise<HarnessToolOutput> => {
      const prompt = (args as { prompt?: unknown }).prompt;
      if (typeof prompt !== 'string' || prompt === '')
        throw new TypeError(`${name}: prompt must be a non-empty string.`);
      const approver =
        runOptions.approveToolCall ??
        ((useParentApprover ?? true) ? ctx.approveToolCall : undefined);
      const signer =
        runOptions.signer ?? ((signDecisions ?? true) ? ctx.approvalSigner : undefined);
      const runId = runOptions.runId ?? ctx.session?.runId;
      const result = await runHarness({
        ...runOptions,
        prompt,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(approver
          ? {
              approveToolCall: (call, context) =>
                approver(call, {
                  messages: context.messages.length > 0 ? context.messages : ctx.messages,
                }),
            }
          : {}),
        ...(signer ? { signer } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
      await onResult?.(result, ctx);
      const comparison = result.cost.comparison;
      return {
        text: result.text,
        stopReason: result.stopReason,
        ...(comparison.measuredUsd !== undefined ? { measuredUsd: comparison.measuredUsd } : {}),
        ...(comparison.declaredUsd !== undefined ? { declaredUsd: comparison.declaredUsd } : {}),
        costStatus: comparison.status,
        budgetExhausted: result.budget.exhausted,
        toolCalls: result.toolCalls,
      };
    },
  };
}
