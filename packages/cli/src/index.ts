/**
 * `@deuz-sdk/cli`: the `deuz` command line, plus a programmatic entry that
 * runs it in-process.
 *
 * - `deuz meter`: a budget proxy in front of Claude Code, Codex or any
 *   Anthropic / OpenAI client (`@deuz-sdk/core/meter/node`).
 * - `deuz acp <module>`: a Deuz agent served to an editor over the Agent
 *   Client Protocol on stdio (`@deuz-sdk/core/acp/stdio`).
 */
export { runCli } from './run';
export { CLI_VERSION } from './help';
export { DeuzCliError, type DeuzCliErrorCode } from './errors';
export type { CliIo, CliSignal, CliSignals } from './io';
export {
  defineAcpAgent,
  type DeuzAcpAgent,
  type DeuzAcpAgentContext,
  type DeuzAcpAgentModule,
} from './acp';
