/**
 * `deuz acp <module>`: serve a Deuz agent over the Agent Client Protocol on
 * stdio, as an editor (Zed, JetBrains IDEs) launches it. The module exports
 * the options of `serveAcpAgentStdio` (from `@deuz-sdk/core/acp/stdio`), or a
 * function that returns them. `agent` and `store` may be left out: the CLI
 * then uses the native engine and an in-memory run store.
 *
 * Standard output is the protocol channel. Every log line goes to standard
 * error, and while serving on the real stdout, `console.log` / `info` /
 * `debug` / `dir` / `dirxml` are redirected to standard error too, so a stray
 * log in the agent module cannot corrupt the protocol.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, inspect, type InspectOptions } from 'node:util';
import type { AcpStdioServeOptions } from '@deuz-sdk/core/acp/stdio';
import { BUDGET_FLAGS, parseFlags, readBudget, splitAtDoubleDash, type CliBudget } from './args';
import { describeBudget, openBudget } from './budget';
import { DeuzCliError, describeError } from './errors';
import { onFirstSignal, writeLine, type CliIo } from './io';

/**
 * What a `deuz acp` module exports: the options of `serveAcpAgentStdio`
 * without the streams. `agent` defaults to `{ streamAgent, resumeStreamAgent }`
 * from `@deuz-sdk/core/agent`, `store` to an in-memory run store.
 */
export type DeuzAcpAgent = Omit<AcpStdioServeOptions, 'agent' | 'store' | 'stdin' | 'stdout'> &
  Partial<Pick<AcpStdioServeOptions, 'agent' | 'store'>>;

/** What a factory export of a `deuz acp` module is called with. */
export interface DeuzAcpAgentContext {
  /** The arguments after `--` on the `deuz acp` command line. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A `deuz acp` module export: the agent's options, or a (possibly async) function returning them. */
export type DeuzAcpAgentModule =
  | DeuzAcpAgent
  | ((context: DeuzAcpAgentContext) => DeuzAcpAgent | Promise<DeuzAcpAgent>);

/**
 * Type the export of a `deuz acp` module. It returns its argument unchanged.
 *
 * ```ts
 * // agent.ts
 * import { defineAcpAgent } from '@deuz-sdk/cli';
 * import { createAnthropic } from '@deuz-sdk/core/anthropic';
 * const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
 * export default defineAcpAgent({
 *   info: { name: 'my-agent', version: '1.0.0' },
 *   run: { model: anthropic('claude-sonnet-5-5'), instructions: 'A careful coding agent.', maxSteps: 20 },
 * });
 * ```
 */
export function defineAcpAgent<T extends DeuzAcpAgentModule>(agent: T): T {
  return agent;
}

/**
 * Gives a run that names no price provider Deuz's bundled price table
 * (`createPriceProvider()` from `@deuz-sdk/core/pricing`), as `deuz meter` and
 * the AI SDK wrapper price by default. `deuz acp` applies it under
 * `--budget-usd`: core prices nothing by itself, so without a price provider a
 * USD ceiling counts $0 and never refuses. A run that sets
 * `deps.priceProvider` keeps its own. A model the table does not know is still
 * recorded as unpriced, and the reply's budget footer says so.
 */
export async function withDefaultPrices(run: DeuzAcpAgent['run']): Promise<DeuzAcpAgent['run']> {
  const { createPriceProvider } = await import('@deuz-sdk/core/pricing');
  const priceProvider = createPriceProvider();
  const priced = <T>(value: T): T => {
    // Anything but run options goes through as it is: the server reports it.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const deps: unknown = (value as { deps?: unknown }).deps;
    if (deps !== undefined && (typeof deps !== 'object' || deps === null)) return value;
    if ((deps as { priceProvider?: unknown } | undefined)?.priceProvider !== undefined)
      return value;
    return { ...value, deps: { ...(deps as object | undefined), priceProvider } };
  };
  if (typeof run !== 'function') return priced(run);
  return async (context) => priced(await run(context));
}

/** `deuz acp` after its flags are parsed. */
export interface AcpCommand {
  /** The module as given: a file path or a package name. */
  readonly module: string;
  /** The export to use; default `default`. */
  readonly exportName: string;
  readonly budget: CliBudget | undefined;
  readonly footer: boolean;
  /** Passed to a factory export as `argv`. */
  readonly args: readonly string[];
}

const ACP_FLAGS = {
  ...BUDGET_FLAGS,
  export: { type: 'string' },
  footer: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Parse `deuz acp` arguments; `'help'` when `--help` was given. */
export function parseAcpArgs(argv: readonly string[]): AcpCommand | 'help' {
  const { flags, rest } = splitAtDoubleDash(argv);
  const { values, positionals } = parseFlags('acp', flags, ACP_FLAGS, true);
  if (values.help === true) return 'help';
  if (positionals.length === 0) {
    throw new DeuzCliError(
      'usage',
      `deuz acp needs the agent module: deuz acp ./agent.js [--export name]`,
    );
  }
  if (positionals.length > 1) {
    throw new DeuzCliError(
      'usage',
      `unexpected argument '${positionals[1]}' for deuz acp; pass arguments for the module after '--'.`,
    );
  }
  const exportName = typeof values.export === 'string' ? values.export : 'default';
  if (exportName.trim() === '') throw new DeuzCliError('usage', '--export needs an export name.');
  return {
    module: positionals[0]!,
    exportName,
    budget: readBudget(values, 'deuz:acp'),
    footer: values.footer === true,
    args: rest ?? [],
  };
}

/** Run `deuz acp`: load the module, serve until the client closes stdin or a signal arrives. */
export async function runAcp(command: AcpCommand, io: CliIo): Promise<number> {
  const log = (line: string): void => writeLine(io.stderr, `deuz acp: ${line}`);
  const restoreConsole = io.stdout === process.stdout ? redirectConsole(io.stderr) : () => {};
  try {
    const options = await loadAcpAgent(command, io);
    if (options.budget && command.budget) {
      throw new DeuzCliError(
        'usage',
        `the module's options set 'budget' already; drop --budget-usd / --budget-tokens or remove it from the module.`,
      );
    }
    const core = options.agent && options.store ? undefined : await import('@deuz-sdk/core/agent');
    const agent = options.agent ?? {
      streamAgent: core!.streamAgent,
      resumeStreamAgent: core!.resumeStreamAgent,
    };
    const store = options.store ?? core!.createInMemoryAgentRunStore();
    const budget = command.budget ? await openBudget(command.budget, io.cwd) : undefined;
    try {
      const { serveAcpAgentStdio } = await import('@deuz-sdk/core/acp/stdio');
      const userOnError = options.onError;
      // A USD ceiling from the flags only bites on priced calls.
      const run =
        command.budget?.usd !== undefined ? await withDefaultPrices(options.run) : options.run;
      const connection = await serveAcpAgentStdio({
        ...options,
        run,
        agent,
        store,
        ...(budget ? { budget: { store: budget.store, scopes: budget.scopes } } : {}),
        ...(command.footer ? { budgetFooter: true } : {}),
        stdin: io.stdin,
        stdout: io.stdout,
        onError: (error: unknown) => {
          log(`error: ${describeError(error)}`);
          userOnError?.(error);
        },
      });
      const name = options.info?.name ?? 'deuz-agent';
      log(
        `serving ${name} from ${command.module}${command.exportName === 'default' ? '' : ` (export ${command.exportName})`} over stdio` +
          (budget ? `; budget ${describeBudget(budget)}` : ''),
      );
      const stop = io.untilStopped
        ? { promise: io.untilStopped(), dispose: () => {} }
        : onFirstSignal(io.signals, ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'], io.platform);
      try {
        await Promise.race([connection.closed, stop.promise]);
      } finally {
        stop.dispose();
      }
      await connection.close();
      return 0;
    } finally {
      await budget?.close().catch(() => {});
    }
  } finally {
    restoreConsole();
  }
}

/**
 * Import the module and check its export's shape.
 *
 * @throws DeuzCliError `module_not_found`, `module_load_failed` or `module_export`.
 */
export async function loadAcpAgent(
  command: Pick<AcpCommand, 'module' | 'exportName' | 'args'>,
  io: Pick<CliIo, 'cwd' | 'env'>,
): Promise<DeuzAcpAgent> {
  const url = resolveModule(command.module, io.cwd);
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw new DeuzCliError(
      'module_load_failed',
      `cannot load ${command.module}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }
  const name = command.exportName;
  let value: unknown = namespace[name];
  if (value === undefined && name !== 'default') {
    // A CommonJS module's named exports may only be reachable through `default`.
    const fallback = namespace.default;
    if (fallback !== null && typeof fallback === 'object')
      value = (fallback as Record<string, unknown>)[name];
  }
  const label = `export '${name}' of ${command.module}`;
  if (value === undefined) {
    const names = Object.keys(namespace)
      .filter((k) => k !== '__esModule')
      .sort();
    throw new DeuzCliError(
      'module_export',
      `${command.module} has no export '${name}'` +
        (names.length
          ? ` (it exports: ${names.join(', ')}); pass --export <name>.`
          : ' (it exports nothing).'),
    );
  }
  if (typeof value === 'function') {
    try {
      value = await (value as (context: DeuzAcpAgentContext) => unknown)({
        argv: command.args,
        cwd: io.cwd,
        env: io.env,
      });
    } catch (error) {
      throw new DeuzCliError('module_load_failed', `${label} threw: ${describeError(error)}`, {
        cause: error,
      });
    }
    return checkShape(value, `the value returned by ${label}`);
  }
  return checkShape(value, label);
}

function checkShape(value: unknown, label: string): DeuzAcpAgent {
  const fail = (what: string): never => {
    throw new DeuzCliError('module_export', `${label} ${what}`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      `must be the agent's options ({ run: { model, ... } }) or a function returning them; got ${describeType(value)}.`,
    );
  }
  const options = value as Record<string, unknown>;
  const run = options.run;
  if (run === undefined)
    fail(`has no 'run': give the turn's run options ({ model, instructions, tools, ... }).`);
  if (typeof run !== 'function' && (run === null || typeof run !== 'object')) {
    fail(
      `has a 'run' that is ${describeType(run)}; it must be the run options or a function returning them.`,
    );
  }
  if (typeof run === 'object' && (run as Record<string, unknown>).model === undefined) {
    fail(`has a 'run' without 'model'.`);
  }
  const agent = options.agent as Record<string, unknown> | undefined;
  if (
    agent !== undefined &&
    (typeof agent !== 'object' ||
      typeof agent?.streamAgent !== 'function' ||
      typeof agent.resumeStreamAgent !== 'function')
  ) {
    fail(
      `has an 'agent' without streamAgent and resumeStreamAgent functions (from @deuz-sdk/core/agent).`,
    );
  }
  const store = options.store as Record<string, unknown> | undefined;
  if (
    store !== undefined &&
    (typeof store !== 'object' ||
      typeof store?.load !== 'function' ||
      typeof store.save !== 'function')
  ) {
    fail(`has a 'store' that is not an AgentRunStore (load and save).`);
  }
  return options as DeuzAcpAgent;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** A file path (resolved against `cwd`) or a package name (resolved from `cwd`), as an import URL. */
function resolveModule(spec: string, cwd: string): string {
  const path = resolve(cwd, spec);
  if (existsSync(path)) return pathToFileURL(path).href;
  const looksLikePath =
    spec.startsWith('.') ||
    isAbsolute(spec) ||
    spec.includes('\\') ||
    /\.[cm]?[jt]sx?$/i.test(spec);
  if (looksLikePath) throw new DeuzCliError('module_not_found', `no such file: ${path}`);
  try {
    return pathToFileURL(createRequire(join(cwd, 'package.json')).resolve(spec)).href;
  } catch (error) {
    throw new DeuzCliError(
      'module_not_found',
      `cannot find the file or package '${spec}' from ${cwd}.`,
      { cause: error },
    );
  }
}

/** Send `console.log`, `info`, `debug`, `dir` and `dirxml` to `stderr`; returns the undo. */
function redirectConsole(stderr: NodeJS.WritableStream): () => void {
  const saved = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    dir: console.dir,
    dirxml: console.dirxml,
  };
  const toStderr = (...args: unknown[]): void => {
    stderr.write(`${format(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  // Node's dir and dirxml write to stdout directly, not through console.log.
  console.dir = (item: unknown, options?: InspectOptions): void => {
    stderr.write(`${inspect(item, options)}\n`);
  };
  console.dirxml = toStderr;
  return () => Object.assign(console, saved);
}
