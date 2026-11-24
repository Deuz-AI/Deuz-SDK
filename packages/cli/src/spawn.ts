/**
 * Starting the harness command of `deuz meter -- <command>`.
 *
 * Windows needs care: `child_process.spawn` without a shell runs only `.exe`
 * and `.com` files and refuses `.cmd` / `.bat` (the npm shims of `claude`,
 * `codex`, `npx`...). {@link resolveCommand} searches `PATH` with `PATHEXT`
 * itself, runs an executable directly, and runs a batch file through
 * `cmd.exe /d /s /c` with every argument quoted and its metacharacters
 * escaped (the algorithm of the `cross-spawn` package), so arguments reach
 * the program as given and are never interpreted by the shell. Every batch
 * file gets the double escape, since it passes `%*` through cmd.exe again.
 * A line break cannot pass through cmd.exe, so such an argument is refused.
 */
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { DeuzCliError } from './errors';

/** What to pass to `child_process.spawn`. */
export interface ResolvedCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** Set for a batch file run through `cmd.exe`: the arguments are already quoted. */
  readonly windowsVerbatimArguments: boolean;
}

/** The host facts {@link resolveCommand} reads. */
export interface ResolveCommandHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Whether a regular file exists at `path`. Default: `fs.statSync`. */
  readonly isFile?: (path: string) => boolean;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Turn a command and its arguments into what `spawn` can run without a shell.
 * On POSIX the command is returned as is (`execvp` searches `PATH`). On
 * Windows, a command that cannot be found is also returned as is, so `spawn`
 * reports `ENOENT`.
 */
export function resolveCommand(
  command: string,
  args: readonly string[],
  host: ResolveCommandHost,
): ResolvedCommand {
  if (host.platform !== 'win32') return { file: command, args, windowsVerbatimArguments: false };
  const isFile = host.isFile ?? defaultIsFile;
  const found = findOnWindows(command, host, isFile);
  if (!found) return { file: command, args, windowsVerbatimArguments: false };
  const ext = win32.extname(found).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat')
    return { file: found, args, windowsVerbatimArguments: false };
  if (args.some((a) => /[\r\n]/.test(a)))
    throw new DeuzCliError(
      'usage',
      `${win32.basename(found)} runs through cmd.exe, which cuts an argument at a line break; pass that text another way (a file or stdin).`,
    );
  // A batch file reads its arguments through cmd.exe a second time (`%*`):
  // npm's shims do, in node_modules/.bin and in the global %AppData%\npm alike.
  const line = [
    escapeCmdCommand(win32.normalize(found)),
    ...args.map((a) => escapeCmdArgument(a, true)),
  ].join(' ');
  return {
    file: envValue(host.env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function findOnWindows(
  command: string,
  host: ResolveCommandHost,
  isFile: (path: string) => boolean,
): string | undefined {
  const pathExt = (envValue(host.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const hasExt = pathExt.includes(win32.extname(command).toLowerCase());
  const candidates = (base: string): string[] =>
    hasExt ? [base, ...pathExt.map((e) => base + e)] : pathExt.map((e) => base + e);
  const hasDir = /[\\/]/.test(command) || win32.isAbsolute(command);
  const dirs = hasDir
    ? ['']
    : (envValue(host.env, 'PATH') ?? '')
        .split(';')
        .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
  for (const dir of dirs) {
    const base = hasDir ? win32.resolve(host.cwd, command) : win32.join(dir, command);
    for (const candidate of candidates(base)) if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Look up an environment variable case-insensitively, as Windows does. */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

/**
 * `base` with `overrides` set. On Windows, where names are case-insensitive,
 * an existing variable that differs only in case is replaced, not duplicated.
 */
export function mergeEnv(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  const replaced = new Set(
    Object.keys(overrides).map((k) => (platform === 'win32' ? k.toUpperCase() : k)),
  );
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (replaced.has(platform === 'win32' ? key.toUpperCase() : key)) continue;
    out[key] = value;
  }
  return Object.assign(out, overrides);
}

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  // Backslashes before a quote, or at the end, are doubled; quotes are escaped (MSVCRT rules).
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`.replace(CMD_META, '^$1');
  // npm's .cmd shims pass %* through cmd.exe a second time.
  if (doubleEscape) out = out.replace(CMD_META, '^$1');
  return out;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The exit code of a child that ended with `code` or `signal`: the code, else 128 + the signal number. */
export function childExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  signalNumbers: Readonly<Record<string, number>>,
): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (signalNumbers[signal] ?? 0);
  return 1;
}
