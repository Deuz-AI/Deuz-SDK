/**
 * The CLI body, separate from the `bin` shim so a host (or a test) can run it
 * in-process with its own argv, environment and streams.
 */
import { parseAcpArgs, runAcp } from './acp';
import { DeuzCliError, describeError, exitCodeFor } from './errors';
import { ACP_HELP, CLI_VERSION, MAIN_HELP, METER_HELP } from './help';
import { resolveIo, writeLine, type CliIo } from './io';
import { parseMeterArgs, runMeter } from './meter';

const COMMANDS = ['meter', 'acp'] as const;

/**
 * Run the `deuz` command line with `argv` (without the `node` and script
 * entries). Returns the exit code and never calls `process.exit`: 0 on
 * success, 2 for an unknown command or a bad flag, 1 for any other failure,
 * and under `deuz meter -- <command>` the command's own exit code (127 when
 * it cannot be found).
 *
 * ```ts
 * import { runCli } from '@deuz-sdk/cli';
 * const code = await runCli(['meter', '--budget-usd', '5', '--', 'claude']);
 * ```
 */
export async function runCli(argv: readonly string[], io?: Partial<CliIo>): Promise<number> {
  const resolved = resolveIo(io);
  const [first, ...rest] = argv;
  try {
    if (first === undefined || first === '-h' || first === '--help') {
      resolved.stdout.write(MAIN_HELP);
      return 0;
    }
    if (first === 'help') {
      const topic = rest[0];
      if (topic !== undefined && topic !== 'meter' && topic !== 'acp')
        return usage(resolved, unknownCommand(topic));
      resolved.stdout.write(
        topic === 'meter' ? METER_HELP : topic === 'acp' ? ACP_HELP : MAIN_HELP,
      );
      return 0;
    }
    if (first === '-v' || first === '--version') {
      writeLine(resolved.stdout, CLI_VERSION);
      return 0;
    }
    if (first === 'meter') {
      const command = parseMeterArgs(rest);
      if (command === 'help') {
        resolved.stdout.write(METER_HELP);
        return 0;
      }
      return await runMeter(command, resolved);
    }
    if (first === 'acp') {
      const command = parseAcpArgs(rest);
      if (command === 'help') {
        // stdout may be an editor's protocol channel: help goes there only when asked for.
        resolved.stdout.write(ACP_HELP);
        return 0;
      }
      return await runAcp(command, resolved);
    }
    throw first.startsWith('-')
      ? new DeuzCliError('usage', `unknown option '${first}'; run 'deuz --help'.`)
      : unknownCommand(first);
  } catch (error) {
    return usage(resolved, error);
  }
}

function unknownCommand(name: string): DeuzCliError {
  return new DeuzCliError(
    'usage',
    `unknown command '${name}'; the commands are ${COMMANDS.join(' and ')} (run 'deuz --help').`,
  );
}

function usage(io: CliIo, error: unknown): number {
  writeLine(io.stderr, `deuz: ${describeError(error)}`);
  return exitCodeFor(error);
}
