import { DeuzError } from '@deuz-sdk/core';

/**
 * What went wrong in the `deuz` command line, as a stable string a host can
 * branch on:
 *
 * - `usage`: an unknown command, an unknown flag or a bad flag value. The CLI
 *   exits with code 2.
 * - `budget_conflict`: the budget key already exists in the store with a
 *   different window.
 * - `store_unavailable`: the budget store could not be opened (for example a
 *   Node without `node:sqlite`).
 * - `module_not_found`: `deuz acp` could not find the agent module.
 * - `module_load_failed`: the agent module threw while it was imported.
 * - `module_export`: the module has no such export, or the export has the wrong shape.
 */
export type DeuzCliErrorCode =
  | 'usage'
  | 'budget_conflict'
  | 'store_unavailable'
  | 'module_not_found'
  | 'module_load_failed'
  | 'module_export';

/** The one error class `@deuz-sdk/cli` throws itself; branch on `code`. */
export class DeuzCliError extends DeuzError {
  readonly code: DeuzCliErrorCode;

  constructor(code: DeuzCliErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** The exit code for an error the CLI reports: 2 for usage errors, 1 otherwise. */
export function exitCodeFor(error: unknown): number {
  return error instanceof DeuzCliError && error.code === 'usage' ? 2 : 1;
}

/** A one-line, credential-free description of any thrown value. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(/\r?\n/, 1)[0] ?? text;
}
