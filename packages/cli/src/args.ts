/**
 * Flag parsing shared by the commands: a `node:util` `parseArgs` wrapper that
 * turns its errors into one-line usage errors, budget windows, amounts and
 * ports. Pure: nothing here reads the process.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DeuzCliError } from './errors';

type FlagSpec = Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }>;
type FlagValues = Record<string, string | boolean | undefined>;

/**
 * Parse `argv` against `spec`, strictly. Unknown flags, missing values and
 * stray positionals become a `usage` {@link DeuzCliError} that names the
 * command's help.
 */
export function parseFlags(
  command: string,
  argv: readonly string[],
  spec: FlagSpec,
  allowPositionals = false,
): { values: FlagValues; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: spec,
      strict: true,
      allowPositionals,
    });
    return { values: parsed.values as FlagValues, positionals: parsed.positionals };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const quoted = /'([^']+)'/.exec(error instanceof Error ? error.message : '')?.[1];
    const hint = `run 'deuz ${command} --help'`;
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      throw new DeuzCliError(
        'usage',
        `unknown option '${quoted ?? '?'}' for deuz ${command}; ${hint}.`,
      );
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const flag = quoted?.split(/[ ,]/, 1)[0] ?? 'an option';
      throw new DeuzCliError('usage', `${flag} needs a value; ${hint}.`);
    }
    if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      throw new DeuzCliError(
        'usage',
        `unexpected argument '${quoted ?? '?'}' for deuz ${command}; ${hint}.`,
      );
    }
    throw error;
  }
}

/** Split `argv` at the first `--`: the flags before it, the rest after (or `undefined` without one). */
export function splitAtDoubleDash(argv: readonly string[]): {
  flags: string[];
  rest: string[] | undefined;
} {
  const index = argv.indexOf('--');
  if (index < 0) return { flags: [...argv], rest: undefined };
  return { flags: argv.slice(0, index), rest: argv.slice(index + 1) };
}

/** A budget window: a rolling span in milliseconds, or `null` for a lifetime budget. */
export interface CliWindow {
  readonly ms: number | null;
  /** How the CLI names it: `lifetime`, `1d`, `7d`, `30d`, `12h`... */
  readonly label: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Parse a `--window` value: `lifetime` (also `none`, `all`), `day`, `week`,
 * `month` (a rolling 30 days), or a count with a unit (`12h`, `7d`, `2w`).
 */
export function parseWindow(spec: string): CliWindow {
  const text = spec.trim().toLowerCase();
  if (text === 'lifetime' || text === 'none' || text === 'all')
    return { ms: null, label: 'lifetime' };
  const named: Record<string, CliWindow> = {
    day: { ms: DAY_MS, label: '1d' },
    week: { ms: 7 * DAY_MS, label: '7d' },
    month: { ms: 30 * DAY_MS, label: '30d' },
  };
  const hit = named[text];
  if (hit) return hit;
  const match = /^(\d{1,5})(h|d|w)$/.exec(text);
  if (match && Number(match[1]) >= 1) {
    const count = Number(match[1]);
    const unit = match[2] as 'h' | 'd' | 'w';
    return {
      ms: count * (unit === 'h' ? HOUR_MS : unit === 'd' ? DAY_MS : 7 * DAY_MS),
      label: `${count}${unit}`,
    };
  }
  throw new DeuzCliError(
    'usage',
    `unknown --window '${spec}'; use lifetime, day, week, month, or a count with h, d or w (12h, 7d).`,
  );
}

/** A nonnegative number flag (`integer` for token counts). */
export function parseAmount(value: string, flag: string, integer: boolean): number {
  const n = Number(value);
  if (
    value.trim() === '' ||
    !Number.isFinite(n) ||
    n < 0 ||
    (integer && !Number.isSafeInteger(n))
  ) {
    throw new DeuzCliError(
      'usage',
      `${flag} must be a nonnegative ${integer ? 'integer' : 'number'}, got '${value}'.`,
    );
  }
  return n;
}

/** A TCP port flag, 0..65535 (0 lets the OS pick). */
export function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n > 65_535) {
    throw new DeuzCliError('usage', `--port must be an integer 0..65535, got '${value}'.`);
  }
  return n;
}

/** An http(s) URL flag. */
export function parseHttpUrl(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeuzCliError('usage', `${flag} must be an http(s) URL, got '${value}'.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DeuzCliError('usage', `${flag} must be an http(s) URL, got '${value}'.`);
  }
  return value.replace(/\/+$/, '');
}

/** The budget flags `deuz meter` and `deuz acp` share. */
export const BUDGET_FLAGS = {
  'budget-usd': { type: 'string' },
  budget: { type: 'string' },
  'budget-tokens': { type: 'string' },
  window: { type: 'string' },
  key: { type: 'string' },
  store: { type: 'string' },
} as const satisfies FlagSpec;

/** A budget the user asked for on the command line. */
export interface CliBudget {
  readonly usd?: number;
  readonly tokens?: number;
  readonly window: CliWindow;
  /** The `BudgetStore` key. */
  readonly key: string;
  /** SQLite file for the store, as given (unresolved); absent for an in-memory store. */
  readonly store?: string;
}

/**
 * Read the shared budget flags. Returns `undefined` when no ceiling was given;
 * `--window`, `--key` or `--store` without a ceiling is a usage error.
 * `defaultKey` is suffixed with `:<window>` for a windowed budget, because a
 * store fixes a key's window when the key is first used.
 */
export function readBudget(values: FlagValues, defaultKey: string): CliBudget | undefined {
  const usdText = str(values['budget-usd']) ?? str(values.budget);
  const tokensText = str(values['budget-tokens']);
  const usd = usdText !== undefined ? parseAmount(usdText, '--budget-usd', false) : undefined;
  const tokens =
    tokensText !== undefined ? parseAmount(tokensText, '--budget-tokens', true) : undefined;
  if (usd === undefined && tokens === undefined) {
    for (const flag of ['window', 'key', 'store'] as const) {
      if (values[flag] !== undefined) {
        throw new DeuzCliError(
          'usage',
          `--${flag} needs a ceiling: add --budget-usd or --budget-tokens.`,
        );
      }
    }
    return undefined;
  }
  const window = parseWindow(str(values.window) ?? 'lifetime');
  const key =
    str(values.key) ?? (window.ms === null ? defaultKey : `${defaultKey}:${window.label}`);
  if (key.trim() === '') throw new DeuzCliError('usage', '--key must not be empty.');
  const store = str(values.store);
  return {
    ...(usd !== undefined ? { usd } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    window,
    key,
    ...(store !== undefined ? { store } : {}),
  };
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolve a file flag against `cwd`. A leading `~` is the home directory, so
 * a path works the same when an editor launches the CLI without a shell.
 */
export function resolvePath(cwd: string, path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return resolve(cwd, path);
}
