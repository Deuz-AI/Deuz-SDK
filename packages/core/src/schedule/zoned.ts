/**
 * Five-field cron in an IANA time zone (2.4, spec §3.2). The cron is matched
 * on the zone's wall clock with the UTC arithmetic of `./cron` (a wall-clock
 * minute is just a calendar minute), and each matching wall time is mapped to
 * its UTC instant with the zone's offset from `Intl.DateTimeFormat`. No
 * dependency and no host time zone: the results are the same on every
 * runtime and host. Edge-safe.
 */

const SECOND = 1_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

function assertTime(ms: number, name: string): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms))
    throw new TypeError(`${name} must be a finite number of milliseconds`);
}

/**
 * Checks that `timeZone` is an IANA zone this runtime's `Intl` knows, and
 * returns it unchanged. Throws TypeError otherwise.
 */
export function assertTimeZone(timeZone: string): string {
  if (typeof timeZone !== 'string' || timeZone === '')
    throw new TypeError('A time zone must be a nonempty IANA name such as "Europe/Istanbul"');
  try {
    formatter(timeZone);
  } catch {
    throw new TypeError(`Unknown time zone ${JSON.stringify(timeZone)}`);
  }
  return timeZone;
}

/** The zone's offset at a whole UTC second: its wall clock minus UTC, in ms. */
function offsetAtSecond(timeZone: string, second: number): number {
  if (timeZone === 'UTC') return 0;
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(second * SECOND))
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  const wall = Date.UTC(
    fields.year ?? 1970,
    (fields.month ?? 1) - 1,
    fields.day ?? 1,
    // Some engines still write midnight as 24 under h23.
    (fields.hour ?? 0) % 24,
    fields.minute ?? 0,
    fields.second ?? 0,
  );
  return wall - second * SECOND;
}

/**
 * The offset of `timeZone` at the UTC instant `atMs`: the zone's wall clock
 * minus UTC, in ms (New York in winter: -18 000 000). Throws TypeError for an
 * unknown zone or a non-finite time.
 */
export function timeZoneOffset(timeZone: string, atMs: number): number {
  assertTimeZone(timeZone);
  assertTime(atMs, 'atMs');
  return offsetAtSecond(timeZone, Math.floor(atMs / SECOND));
}
