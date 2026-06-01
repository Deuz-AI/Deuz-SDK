/**
 * Parse a `Retry-After` header. It is either an integer number of seconds or an
 * HTTP-date. The date form needs "now" to compute a delay; callers without a
 * clock (e.g. error mapping) omit `nowMs` and get `undefined` for the date form
 * (resilience re-parses it with an injected clock). `Date.parse` is allowed —
 * only `Date.now()` is banned in core.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs?: number,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  if (nowMs === undefined) return undefined;
  return Math.max(0, dateMs - nowMs);
}
