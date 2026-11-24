/**
 * Option plumbing shared by the CLI and the programmatic entry: budget windows,
 * the per-user default data directory, and `argv` + environment parsing. Pure:
 * every host fact (platform, environment, home directory) comes in as an
 * argument, so the CLI behaves the same under test as on a user's machine.
 */
import { posix, win32 } from 'node:path';
import { McpLedgerError } from './errors';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A budget window after parsing: a rolling span in milliseconds, or `null` for a
 * lifetime budget. `label` is how status reports name it (`'30d'`, `'lifetime'`).
 */
export interface LedgerWindow {
  readonly ms: number | null;
  readonly label: string;
}

/**
 * Parse a budget window. Accepted: `lifetime` (also `none`, `all`), `day`,
 * `week`, `month` (a rolling 30 days, not a calendar month), or a count with a
 * unit: `12h`, `7d`, `2w`. Windows are rolling: `7d` means the last seven days
 * from now, wherever the week started.
 *
 * @throws McpLedgerError `invalid_option` for anything else.
 */
export function parseLedgerWindow(spec: string): LedgerWindow {
  const text = spec.trim().toLowerCase();
  if (text === 'lifetime' || text === 'none' || text === 'all') {
    return { ms: null, label: 'lifetime' };
  }
  const named: Record<string, LedgerWindow> = {
    day: { ms: DAY_MS, label: '1d' },
    daily: { ms: DAY_MS, label: '1d' },
    week: { ms: 7 * DAY_MS, label: '7d' },
    weekly: { ms: 7 * DAY_MS, label: '7d' },
    month: { ms: 30 * DAY_MS, label: '30d' },
    monthly: { ms: 30 * DAY_MS, label: '30d' },
  };
  const hit = named[text];
  if (hit) return hit;
  const match = /^(\d{1,5})\s*(h|d|w)$/.exec(text);
  if (match) {
    const count = Number(match[1]);
    const unit = match[2] as 'h' | 'd' | 'w';
    if (count >= 1) {
      const ms = count * (unit === 'h' ? HOUR_MS : unit === 'd' ? DAY_MS : 7 * DAY_MS);
      return { ms, label: `${count}${unit}` };
    }
  }
  throw new McpLedgerError(
    'invalid_option',
    `Unknown budget window '${spec}'. Use lifetime, day, week, month, or a count with h, d or w (e.g. 12h, 7d).`,
  );
}

/** The host facts {@link defaultDataDir} reads. */
export interface DataDirHost {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}

/**
 * The per-user data directory used when neither `--data-dir` nor
 * `DEUZ_LEDGER_DIR` names one:
 *
 * - Windows: `%LOCALAPPDATA%\deuz\mcp-ledger` (else `%APPDATA%`)
 * - macOS: `~/Library/Application Support/deuz/mcp-ledger`
 * - elsewhere: `$XDG_DATA_HOME/deuz/mcp-ledger`, else `~/.local/share/deuz/mcp-ledger`
 */
export function defaultDataDir(host: DataDirHost): string {
  const env = host.env;
  if (host.platform === 'win32') {
    const base =
      nonEmpty(env.LOCALAPPDATA) ??
      nonEmpty(env.APPDATA) ??
      win32.join(host.homedir, 'AppData', 'Local');
    return win32.join(base, 'deuz', 'mcp-ledger');
  }
  if (host.platform === 'darwin') {
    return posix.join(host.homedir, 'Library', 'Application Support', 'deuz', 'mcp-ledger');
  }
  const base = nonEmpty(env.XDG_DATA_HOME) ?? posix.join(host.homedir, '.local', 'share');
  return posix.join(base, 'deuz', 'mcp-ledger');
}

/** Default port of `--http` when none is given. */
export const DEFAULT_HTTP_PORT = 3741;

/** What the CLI was asked to do. */
export type LedgerCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | {
      kind: 'serve';
      dataDir: string;
      budget: { usd?: number; tokens?: number; window: LedgerWindow };
      namespace?: string;
      /** Present for the loopback Streamable HTTP mode; absent for stdio. */
      http?: { port: number };
    };

/**
 * Parse CLI arguments (without the `node` and script entries) and the
 * environment. Flags win over environment variables:
 *
 * | flag | environment | meaning |
 * | --- | --- | --- |
 * | `--data-dir <path>` | `DEUZ_LEDGER_DIR` | where the three SQLite files live |
 * | `--budget-usd <n>` (`--budget`) | `DEUZ_LEDGER_BUDGET_USD` | USD ceiling |
 * | `--budget-tokens <n>` | `DEUZ_LEDGER_BUDGET_TOKENS` | token ceiling |
 * | `--window <spec>` | `DEUZ_LEDGER_WINDOW` | see {@link parseLedgerWindow}; default `month` |
 * | `--namespace <name>` | `DEUZ_LEDGER_NAMESPACE` | separate memory space; default `default` |
 * | `--http [port]` | | loopback Streamable HTTP instead of stdio |
 * | `-h`, `--help` / `-v`, `--version` | | |
 *
 * @throws McpLedgerError `invalid_option` for an unknown flag or a bad value.
 */
export function parseLedgerArgs(argv: readonly string[], host: DataDirHost): LedgerCommand {
  const flags = new Map<string, string | true>();
  const valued = new Set([
    '--data-dir',
    '--budget-usd',
    '--budget',
    '--budget-tokens',
    '--window',
    '--namespace',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '-h' || raw === '--help') return { kind: 'help' };
    if (raw === '-v' || raw === '--version') return { kind: 'version' };
    const eq = raw.indexOf('=');
    const name = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    if (valued.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new McpLedgerError('invalid_option', `${name} needs a value.`);
      }
      flags.set(name === '--budget' ? '--budget-usd' : name, value);
    } else if (name === '--http') {
      const next = argv[i + 1];
      if (inline !== undefined) flags.set('--http', inline);
      else if (next !== undefined && /^\d+$/.test(next)) {
        flags.set('--http', next);
        i++;
      } else flags.set('--http', true);
    } else {
      throw new McpLedgerError('invalid_option', `Unknown option '${raw}'. Run with --help.`);
    }
  }

  const pick = (flag: string, envName: string): string | undefined => {
    const fromFlag = flags.get(flag);
    if (typeof fromFlag === 'string') return fromFlag;
    return nonEmpty(host.env[envName]);
  };

  const dataDir = pick('--data-dir', 'DEUZ_LEDGER_DIR') ?? defaultDataDir(host);
  const usd = amount(pick('--budget-usd', 'DEUZ_LEDGER_BUDGET_USD'), 'budget-usd', false);
  const tokens = amount(
    pick('--budget-tokens', 'DEUZ_LEDGER_BUDGET_TOKENS'),
    'budget-tokens',
    true,
  );
  const window = parseLedgerWindow(pick('--window', 'DEUZ_LEDGER_WINDOW') ?? 'month');
  const namespace = pick('--namespace', 'DEUZ_LEDGER_NAMESPACE');

  const httpFlag = flags.get('--http');
  let http: { port: number } | undefined;
  if (httpFlag !== undefined) {
    const port = httpFlag === true ? DEFAULT_HTTP_PORT : Number(httpFlag);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new McpLedgerError(
        'invalid_option',
        `--http port must be 0..65535, got '${String(httpFlag)}'.`,
      );
    }
    http = { port };
  }

  return {
    kind: 'serve',
    dataDir,
    budget: {
      ...(usd !== undefined ? { usd } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      window,
    },
    ...(namespace !== undefined ? { namespace } : {}),
    ...(http ? { http } : {}),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function amount(value: string | undefined, label: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < 0 ||
    (integer && !Number.isSafeInteger(n)) ||
    value.trim() === ''
  ) {
    throw new McpLedgerError(
      'invalid_option',
      `--${label} must be a nonnegative ${integer ? 'integer' : 'number'}, got '${value}'.`,
    );
  }
  return n;
}
