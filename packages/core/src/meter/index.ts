/**
 * `@deuz-sdk/core/meter` (2.5): deuz meter, a local budget proxy for coding
 * harnesses. Claude Code, Codex and other clients let you change their API
 * base URL; pointed at the meter, every request is charged to a persistent
 * Deuz budget, refused with HTTP 402 at the ceiling, and recorded as one
 * receipt, with no change to the harness.
 *
 * ```ts
 * import { createMeterHandler } from '@deuz-sdk/core/meter';
 * import { createInMemoryBudgetStore } from '@deuz-sdk/core/agent';
 *
 * const meter = createMeterHandler({
 *   budget: {
 *     store: createInMemoryBudgetStore(),
 *     scopes: [{ key: 'harness:claude-code', limits: { usd: 5 } }],
 *   },
 *   receipts: (receipt) => console.log(receipt.model, receipt.usd),
 * });
 * export default { fetch: meter.fetch }; // any Fetch API host
 * ```
 *
 * For a local server on 127.0.0.1 and a JSONL receipt file, use
 * `createMeterProxy` and `createJsonlReceiptSink` from `@deuz-sdk/core/meter/node`.
 * Edge-safe.
 */
export { createMeterHandler, DEFAULT_METER_UPSTREAMS } from './handler';
export { MeterError } from './errors';
export type { MeterErrorCode } from './errors';
export {
  DEFAULT_METER_CHARS_PER_TOKEN,
  DEFAULT_METER_MAX_OUTPUT_TOKENS,
  estimatePromptTokens,
} from './estimate';
export { declaredReceipt } from './receipt';
export type { DeclaredReceiptInput, DeclaredReceiptOptions } from './receipt';
export type * from './types';
