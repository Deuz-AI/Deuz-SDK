import { DeuzError } from '@deuz-sdk/core';

/**
 * What went wrong in the ledger, as a stable string a host can branch on:
 *
 * - `invalid_option`: a flag, environment variable or option has a bad value.
 * - `invalid_argument`: a programmatic call got an argument it cannot use.
 * - `receipt_conflict`: a receipt id was recorded before with other content.
 * - `spend_conflict`: a spend id was recorded before with other amounts.
 * - `not_found`: no memory with that id exists in this namespace.
 * - `revision_conflict`: the memory changed since the revision the caller read.
 * - `asserted_record`: the memory was asserted by the host; tools cannot change it.
 * - `sqlite_unavailable`: this Node has no `node:sqlite` (it ships unflagged
 *   from Node 22.13 / 23.4).
 * - `closed`: the ledger was closed.
 */
export type McpLedgerErrorCode =
  | 'invalid_option'
  | 'invalid_argument'
  | 'receipt_conflict'
  | 'spend_conflict'
  | 'not_found'
  | 'revision_conflict'
  | 'asserted_record'
  | 'sqlite_unavailable'
  | 'closed';

/** The one error class `@deuz-sdk/mcp-ledger` throws itself; branch on `code`. */
export class McpLedgerError extends DeuzError {
  readonly code: McpLedgerErrorCode;

  constructor(code: McpLedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
