/**
 * `deuz meter`: the budget proxy of `@deuz-sdk/core/meter/node` as a command.
 *
 * Without a trailing command it listens, prints the base URLs and the
 * environment lines for each supported harness, and logs one line per
 * request until interrupted. With `-- <command>` it starts that command with
 * the base URLs already in its environment, passes stdio through, prints a
 * spend summary when the command exits, and exits with the command's code.
 */
import { spawn, type StdioOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type {
  MeterReceipt,
  MeterReceiptSink,
  MeterUpstream,
  MeterWarning,
} from '@deuz-sdk/core/meter/node';
import {
  BUDGET_FLAGS,
  parseFlags,
  parseHttpUrl,
  parsePort,
  readBudget,
  resolvePath,
  splitAtDoubleDash,
  type CliBudget,
} from './args';
import { describeBudget, formatInt, formatUsd, openBudget, type OpenBudget } from './budget';
import { DeuzCliError, describeError } from './errors';
import { onFirstSignal, writeLine, type CliIo, type CliSignal } from './io';
import { childExitCode, envValue, mergeEnv, resolveCommand } from './spawn';

/** The port `deuz meter` listens on when it runs without a command and no `--port` is given. */
export const DEFAULT_METER_PORT = 8787;

const DEFAULT_ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_OPENAI_UPSTREAM = 'https://api.openai.com';

/** `deuz meter` after its flags are parsed. */
export interface MeterCommand {
  readonly budget: CliBudget | undefined;
  /** Undefined: the default (8787 without a command, a free port with one). */
  readonly port: number | undefined;
  readonly receipts: string | undefined;
  readonly anthropicUpstream: string;
  readonly openaiUpstream: string;
  /** Which upstreams were given by flag rather than defaulted. */
  readonly upstreamFlags?: { readonly anthropic: boolean; readonly openai: boolean };
  readonly forwardUnmetered: boolean;
  /** The harness to run, after `--`. */
  readonly command: readonly string[] | undefined;
}

const METER_FLAGS = {
  ...BUDGET_FLAGS,
  port: { type: 'string' },
  receipts: { type: 'string' },
  'anthropic-upstream': { type: 'string' },
  'openai-upstream': { type: 'string' },
  'forward-unmetered': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Parse `deuz meter` arguments; `'help'` when `--help` was given. */
export function parseMeterArgs(argv: readonly string[]): MeterCommand | 'help' {
  const { flags, rest } = splitAtDoubleDash(argv);
  const { values, positionals } = parseFlags('meter', flags, METER_FLAGS, true);
  if (values.help === true) return 'help';
  if (positionals.length > 0) {
    throw new DeuzCliError(
      'usage',
      `put the command after '--': deuz meter [options] -- ${positionals.join(' ')}`,
    );
  }
  if (rest !== undefined && rest.length === 0) {
    throw new DeuzCliError(
      'usage',
      `'--' must be followed by a command to run, e.g. deuz meter --budget-usd 5 -- claude`,
    );
  }
  const port = typeof values.port === 'string' ? parsePort(values.port) : undefined;
  const receipts = typeof values.receipts === 'string' ? values.receipts : undefined;
  if (receipts !== undefined && receipts.trim() === '')
    throw new DeuzCliError('usage', '--receipts needs a file path.');
  return {
    budget: readBudget(values, 'deuz:meter'),
    port,
    receipts,
    anthropicUpstream:
      typeof values['anthropic-upstream'] === 'string'
        ? parseHttpUrl(values['anthropic-upstream'], '--anthropic-upstream')
        : DEFAULT_ANTHROPIC_UPSTREAM,
    openaiUpstream:
      typeof values['openai-upstream'] === 'string'
        ? parseHttpUrl(values['openai-upstream'], '--openai-upstream')
        : DEFAULT_OPENAI_UPSTREAM,
    upstreamFlags: {
      anthropic: typeof values['anthropic-upstream'] === 'string',
      openai: typeof values['openai-upstream'] === 'string',
    },
    forwardUnmetered: values['forward-unmetered'] === true,
    command: rest,
  };
}

/** The environment a harness needs to send its traffic through the meter at `url`. */
export function meterEnvironment(url: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: url,
    OPENAI_BASE_URL: `${url}/v1`,
    DEUZ_METER_URL: url,
  };
}

/** Run `deuz meter`. Returns the exit code (the child's, with a command). */
export async function runMeter(command: MeterCommand, io: CliIo): Promise<number> {
  const { createMeterProxy, createJsonlReceiptSink } = await import('@deuz-sdk/core/meter/node');
  const wrap = command.command !== undefined;
  const log = (line: string): void => writeLine(io.stderr, `deuz meter: ${line}`);
  if (wrap) {
    refuseRedirectedBaseUrls(command, io);
    refuseProviderSwitches(io);
  }

  const budget = command.budget ? await openBudget(command.budget, io.cwd) : undefined;
  const sinks: MeterReceiptSink[] = [];
  const jsonl = command.receipts
    ? createJsonlReceiptSink({ path: resolvePath(io.cwd, command.receipts) })
    : undefined;
  if (jsonl) sinks.push(jsonl);
  if (!wrap) {
    sinks.push(async (receipt) => {
      const left = budget ? await budget.remaining().catch(() => undefined) : undefined;
      writeLine(io.stderr, receiptLine(receipt, left?.text));
    });
  }
  const unpriced = new Set<string>();
  const upstreams: MeterUpstream[] = [
    { provider: 'anthropic', kind: 'anthropic', baseUrl: command.anthropicUpstream },
    { provider: 'openai', kind: 'openai', baseUrl: command.openaiUpstream },
  ];
  const proxy = createMeterProxy({
    upstreams,
    ...(budget ? { budget: { store: budget.store, scopes: budget.scopes } } : {}),
    receipts: sinks,
    unmeteredRoutes: command.forwardUnmetered ? 'forward' : 'reject',
    onWarning: (warning: MeterWarning) => {
      if (warning.type === 'unpriced-model') {
        unpriced.add(warning.model);
        if (!wrap) log(`no price known for ${warning.model}: it is charged tokens only.`);
      } else if (!wrap) {
        log(`no final usage for ${warning.model} (${warning.detail}): charged its estimate.`);
      }
    },
    onError: (error, context) => log(`${context.stage} failed: ${describeError(error)}`),
  });

  let address;
  try {
    address = await proxy.listen({ port: command.port ?? (wrap ? 0 : DEFAULT_METER_PORT) });
  } catch (error) {
    await budget?.close().catch(() => {});
    throw error;
  }

  let code = 0;
  try {
    if (wrap) {
      const left = budget ? await budget.remaining() : undefined;
      log(
        `${address.url}, budget ${budget ? `${describeBudget(budget)}; ${left!.text}` : 'none (measuring only)'}; ` +
          `running ${command.command!.join(' ')}`,
      );
      if (left?.exhausted)
        log('the budget is already exhausted: metered requests will be refused (402).');
      code = await runChild(command.command!, meterEnvironment(address.url), io, log);
    } else {
      await printSetup(io, address.url, budget, command);
      await serveUntilStopped(
        io,
        () => proxy.close(),
        (force) => proxy.close({ force }),
      );
    }
  } finally {
    await proxy.close().catch(() => {});
    await jsonl?.flush().catch(() => {});
    for (const line of await summaryLines(proxy.stats(), budget, unpriced)) log(line);
    await budget?.close().catch(() => {});
  }
  return code;
}

/**
 * With a command, the meter replaces the harness's ANTHROPIC_BASE_URL and
 * OPENAI_BASE_URL. When the environment already points one elsewhere (a
 * gateway, OpenRouter, a local server) and no upstream flag says where to
 * send it, the harness's credentials for that endpoint would go to the
 * default upstream instead, so the command is refused. The value is not
 * printed: a base URL can carry credentials.
 */
function refuseRedirectedBaseUrls(command: MeterCommand, io: CliIo): void {
  const checks = [
    {
      name: 'ANTHROPIC_BASE_URL',
      flag: '--anthropic-upstream',
      given: command.upstreamFlags?.anthropic === true,
      upstream: command.anthropicUpstream,
      base: (url: string) => url.replace(/\/+$/, ''),
    },
    {
      name: 'OPENAI_BASE_URL',
      flag: '--openai-upstream',
      given: command.upstreamFlags?.openai === true,
      upstream: command.openaiUpstream,
      base: (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, ''),
    },
  ];
  for (const check of checks) {
    if (check.given) continue;
    const value = (
      io.platform === 'win32' ? envValue(io.env, check.name) : io.env[check.name]
    )?.trim();
    if (!value || check.base(value) === check.upstream) continue;
    throw new DeuzCliError(
      'usage',
      `${check.name} is set to another endpoint; the meter would replace it and send that endpoint's credentials to ${check.upstream}. ` +
        `Pass ${check.flag} <its base URL${check.name === 'OPENAI_BASE_URL' ? ' without /v1' : ''}> to meter it, or unset ${check.name}.`,
    );
  }
}

/**
 * The variables that switch Claude Code to another model provider (Amazon
 * Bedrock, Bedrock Mantle, Google Cloud's Agent Platform, Microsoft Foundry,
 * Claude Platform on AWS, Claude Models on Google Cloud). The same list as
 * `CLAUDE_CODE_PROVIDER_SWITCHES` in `@deuz-sdk/core/harness`, kept here so
 * the CLI does not depend on a core newer than its own release.
 */
const CLAUDE_CODE_PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
] as const;

/** Values that leave a switch off, as Claude Code reads its boolean variables. */
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * With a command, a Claude Code provider switch set to a true value would
 * send the harness's model traffic to that provider, around the meter:
 * nothing would be measured or capped. The command is refused, as for a
 * foreign base URL. Only the name is printed, never the value.
 */
function refuseProviderSwitches(io: CliIo): void {
  const on = CLAUDE_CODE_PROVIDER_SWITCHES.filter((name) => {
    const value = io.platform === 'win32' ? envValue(io.env, name) : io.env[name];
    return value !== undefined && !OFF_VALUES.has(value.trim().toLowerCase());
  });
  if (on.length === 0) return;
  throw new DeuzCliError(
    'usage',
    `${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} set: Claude Code would send its model traffic to that provider instead of the meter, so nothing would be measured or capped. ` +
      `Unset ${on.length === 1 ? 'it' : 'them'} for this command.`,
  );
}

async function printSetup(
  io: CliIo,
  url: string,
  budget: OpenBudget | undefined,
  command: MeterCommand,
): Promise<void> {
  const out = (line = ''): void => writeLine(io.stdout, line);
  out(`deuz meter listening on ${url}`);
  if (budget) {
    const left = await budget.remaining();
    out(`budget: ${describeBudget(budget)}; ${left.text}`);
  } else {
    out('budget: none (measuring only; add --budget-usd to set a ceiling)');
  }
  if (command.receipts) out(`receipts: ${resolvePath(io.cwd, command.receipts)}`);
  out();
  const env = meterEnvironment(url);
  const style = shellStyle(io);
  out('Claude Code, Anthropic SDKs:');
  for (const line of envLines('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL!, style))
    out(`  ${line}`);
  out('Codex CLI (API-key mode), OpenAI SDKs, OpenAI-compatible tools:');
  for (const line of envLines('OPENAI_BASE_URL', env.OPENAI_BASE_URL!, style)) out(`  ${line}`);
  out();
  out(`Or let deuz start the harness: deuz meter ${budget ? '--budget-usd <n> ' : ''}-- claude`);
  out('Press Ctrl+C to stop.');
}

type ShellStyle = 'posix' | 'windows';

function shellStyle(io: CliIo): ShellStyle {
  if (io.platform !== 'win32') return 'posix';
  // Git Bash, MSYS2 and Cygwin on Windows take POSIX syntax.
  return io.env.MSYSTEM || io.env.SHELL ? 'posix' : 'windows';
}

function envLines(name: string, value: string, style: ShellStyle): string[] {
  if (style === 'posix') return [`export ${name}=${value}`];
  return [`$env:${name} = "${value}"    # PowerShell`, `set ${name}=${value}    # cmd.exe`];
}

/** Wait for a stop request, then drain; a second Ctrl+C cuts requests in flight. */
async function serveUntilStopped(
  io: CliIo,
  drain: () => Promise<void>,
  close: (force: boolean) => Promise<void>,
): Promise<void> {
  const names: CliSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
  if (io.untilStopped) {
    await io.untilStopped();
  } else {
    const first = onFirstSignal(io.signals, names, io.platform);
    await first.promise;
  }
  writeLine(
    io.stderr,
    'deuz meter: stopping; waiting for requests in flight (Ctrl+C again to cut them).',
  );
  const second = onFirstSignal(io.signals, names, io.platform);
  try {
    await Promise.race([drain(), second.promise.then(() => close(true))]);
  } finally {
    second.dispose();
  }
}

/** Start the harness, pass stdio through, forward termination signals, and return its exit code. */
async function runChild(
  argv: readonly string[],
  meterEnv: Record<string, string>,
  io: CliIo,
  log: (line: string) => void,
): Promise<number> {
  const [program, ...args] = argv as [string, ...string[]];
  const resolved = resolveCommand(program, args, {
    platform: io.platform,
    env: io.env,
    cwd: io.cwd,
  });
  const own = (stream: unknown, proc: unknown): boolean => stream === proc;
  const stdio: StdioOptions = [
    own(io.stdin, process.stdin) ? 'inherit' : 'pipe',
    own(io.stdout, process.stdout) ? 'inherit' : 'pipe',
    own(io.stderr, process.stderr) ? 'inherit' : 'pipe',
  ];
  const child = spawn(resolved.file, [...resolved.args], {
    cwd: io.cwd,
    env: mergeEnv(io.env, meterEnv, io.platform),
    stdio,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    windowsHide: false,
  });
  if (child.stdin) {
    child.stdin.on('error', () => {});
    io.stdin.pipe(child.stdin);
  }
  child.stdout?.pipe(io.stdout, { end: false });
  child.stderr?.pipe(io.stderr, { end: false });

  // Ctrl+C reaches the child through the terminal (its process group, or the
  // Windows console); forwarding it too would deliver it twice. The meter
  // ignores it and waits for the child. Termination requests aimed at this
  // process alone are forwarded.
  const ignore = (): void => {};
  const forwardTerm = (): void => void child.kill('SIGTERM');
  const forwardHup = (): void => void child.kill(io.platform === 'win32' ? 'SIGTERM' : 'SIGHUP');
  io.signals.on('SIGINT', ignore);
  if (io.platform === 'win32') io.signals.on('SIGBREAK', ignore);
  io.signals.on('SIGTERM', forwardTerm);
  io.signals.on('SIGHUP', forwardHup);
  try {
    return await new Promise<number>((resolveExit) => {
      let settled = false;
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (error.code === 'ENOENT') {
          log(`cannot start '${program}': command not found.`);
          resolveExit(127);
        } else {
          log(`cannot start '${program}': ${describeError(error)}`);
          resolveExit(error.code === 'EACCES' ? 126 : 1);
        }
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (child.stdin) io.stdin.unpipe(child.stdin);
        resolveExit(childExitCode(code, signal, osConstants.signals as Record<string, number>));
      });
    });
  } finally {
    io.signals.off('SIGINT', ignore);
    if (io.platform === 'win32') io.signals.off('SIGBREAK', ignore);
    io.signals.off('SIGTERM', forwardTerm);
    io.signals.off('SIGHUP', forwardHup);
  }
}

/** One log line per receipt. */
export function receiptLine(receipt: MeterReceipt, remaining: string | undefined): string {
  const time = new Date(receipt.endedAt).toTimeString().slice(0, 8);
  const parts: string[] = [
    `${time} ${receipt.method ?? 'POST'} ${receipt.route}`,
    receipt.model ?? 'unknown model',
    `${receipt.status ?? '-'} ${receipt.outcome}`,
  ];
  if (receipt.usage) parts.push(`${formatInt(receipt.usage.totalTokens)} tok`);
  if (receipt.usd !== undefined) parts.push(formatUsd(receipt.usd));
  else if (!receipt.priced && receipt.usage) parts.push('unpriced');
  if (receipt.settlement === 'estimate' && receipt.charged) {
    parts.push(`charged estimate ${formatUsd(receipt.charged.usd)}`);
  }
  if (receipt.refusal?.reason === 'budget_exceeded') {
    parts.push(`budget ${receipt.refusal.key} exhausted (${receipt.refusal.dimension})`);
  } else if (receipt.refusal?.reason === 'unpriced_model') {
    parts.push('refused: no price for this model');
  }
  if (remaining) parts.push(remaining);
  return parts.join(' · ');
}

async function summaryLines(
  stats: {
    requests: number;
    completed: number;
    refused: number;
    upstreamErrors: number;
    aborted: number;
    failed: number;
    tokens: number;
    usd: number;
    chargedUsd: number;
  },
  budget: OpenBudget | undefined,
  unpriced: ReadonlySet<string>,
): Promise<string[]> {
  const breakdown = [
    `${stats.completed} completed`,
    stats.refused ? `${stats.refused} refused` : undefined,
    stats.upstreamErrors ? `${stats.upstreamErrors} upstream errors` : undefined,
    stats.aborted ? `${stats.aborted} aborted` : undefined,
    stats.failed ? `${stats.failed} failed` : undefined,
  ].filter(Boolean);
  const lines = [
    `${stats.requests} metered ${stats.requests === 1 ? 'request' : 'requests'} (${breakdown.join(', ')}), ` +
      `${formatInt(stats.tokens)} tokens, ${formatUsd(stats.usd)} measured, ${formatUsd(stats.chargedUsd)} charged.`,
  ];
  if (unpriced.size > 0)
    lines.push(`no price known for ${[...unpriced].join(', ')} (charged tokens only).`);
  if (budget) {
    const left = await budget.remaining().catch(() => undefined);
    if (left)
      lines.push(
        `budget ${budget.budget.key}: ${left.text}${left.exhausted ? ' (exhausted)' : ''}.`,
      );
  }
  return lines;
}
