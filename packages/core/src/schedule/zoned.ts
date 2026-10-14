/**
 * Five-field cron in an IANA time zone (2.4, spec §3.2). The cron is matched
 * on the zone's wall clock with the UTC arithmetic of `./cron` (a wall-clock
 * minute is just a calendar minute), and each matching wall time is mapped to
 * its UTC instant with the zone's offset from `Intl.DateTimeFormat`. No
 * dependency and no host time zone: the results are the same on every
 * runtime and host. Edge-safe.
 */
import { nextOccurrence, occurrencesBetween, parseCron } from './cron';
import type { CronSchedule } from './cron';

/** What a DST change that skips a local time does to a run at that time. */
export type ZonedDstGap = 'shift' | 'skip';

/** What a DST change that repeats a local time does to a run at that time. */
export type ZonedDstOverlap = 'first' | 'both';

/** How a cron is read in a time zone. */
export interface ZonedCronOptions {
  /** IANA time zone. Default `'UTC'`. */
  timezone?: string;
  /**
   * A local time the clock skips: `'shift'` (default) runs it once at the
   * first valid instant after the gap, `'skip'` drops it.
   */
  dstGap?: ZonedDstGap;
  /**
   * A local time the clock repeats: `'first'` (default) runs it once, at its
   * first instant; `'both'` runs it at both instants.
   */
  dstOverlap?: ZonedDstOverlap;
}

/** One run of a zoned cron. */
export interface ZonedOccurrence {
  /** The UTC instant, epoch ms. */
  at: number;
  /**
   * The local wall time the cron matched, as epoch ms of that wall clock read
   * as UTC (`new Date(wall).toISOString()` prints it).
   */
  wall: number;
  /** A local time the clock skipped, run at the first valid instant after the gap. */
  shifted?: true;
  /** The second instant of a repeated local time (`dstOverlap: 'both'`). */
  repeated?: true;
}

const SECOND = 1_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Offsets are sampled this often: no zone changes its offset twice within an hour. */
const SAMPLE_MS = HOUR;
/** Far enough back to see a transition whose repeated local times reach into a window. */
const LOOKBACK_MS = DAY;
/** Wider than any two offsets differ (-12 h to +14 h). */
const OFFSET_SPAN_MS = 2 * DAY;

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

const offsetAt = (timeZone: string, ms: number): number =>
  offsetAtSecond(timeZone, Math.floor(ms / SECOND));

/**
 * The offset of `timeZone` at the UTC instant `atMs`: the zone's wall clock
 * minus UTC, in ms (New York in winter: -18 000 000). Throws TypeError for an
 * unknown zone or a non-finite time.
 */
export function timeZoneOffset(timeZone: string, atMs: number): number {
  assertTimeZone(timeZone);
  assertTime(atMs, 'atMs');
  return offsetAt(timeZone, atMs);
}

interface ZonedCron {
  schedule: CronSchedule;
  timeZone: string;
  gap: ZonedDstGap;
  overlap: ZonedDstOverlap;
}

function zoned(cron: CronSchedule | string, options: ZonedCronOptions | undefined): ZonedCron {
  const schedule = typeof cron === 'string' ? parseCron(cron) : cron;
  const timeZone = options?.timezone === undefined ? 'UTC' : assertTimeZone(options.timezone);
  const gap = options?.dstGap ?? 'shift';
  if (gap !== 'shift' && gap !== 'skip')
    throw new TypeError(`dstGap must be 'shift' or 'skip', not ${JSON.stringify(gap)}`);
  const overlap = options?.dstOverlap ?? 'first';
  if (overlap !== 'first' && overlap !== 'both')
    throw new TypeError(`dstOverlap must be 'first' or 'both', not ${JSON.stringify(overlap)}`);
  return { schedule, timeZone, gap, overlap };
}

/** A stretch of UTC time `[start, end)` with one offset; `before` when an offset change began it. */
interface Segment {
  start: number;
  end: number;
  offset: number;
  before?: number;
}

/** The first whole second in `(low, high]` at which the offset is no longer `offset`. */
function transitionInstant(timeZone: string, low: number, high: number, offset: number): number {
  let lo = Math.floor(low / SECOND);
  let hi = Math.floor(high / SECOND);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAtSecond(timeZone, mid) === offset) lo = mid;
    else hi = mid;
  }
  return hi * SECOND;
}

/** `[from, to]` cut into stretches of one offset, in order; the last one is open-ended. */
function segments(timeZone: string, from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let start = from;
  let offset = offsetAt(timeZone, from);
  let before: number | undefined;
  for (let t = from; t < to; ) {
    const next = Math.min(t + SAMPLE_MS, to);
    const sampled = offsetAt(timeZone, next);
    if (sampled !== offset) {
      const at = transitionInstant(timeZone, t, next, offset);
      out.push({ start, end: at, offset, ...(before !== undefined ? { before } : {}) });
      before = offset;
      start = at;
      offset = sampled;
    }
    t = next;
  }
  out.push({ start, end: Infinity, offset, ...(before !== undefined ? { before } : {}) });
  return out;
}

/** Whether the cron matches the wall-clock minute `wall`. */
const matches = (schedule: CronSchedule, wall: number): boolean =>
  nextOccurrence(schedule, wall - 1) === wall;

function collect(cron: ZonedCron, from: number, to: number, limit: number): ZonedOccurrence[] {
  const { schedule, timeZone, gap, overlap } = cron;
  const out: ZonedOccurrence[] = [];
  for (const { start, end, offset, before } of segments(timeZone, from - LOOKBACK_MS, to)) {
    if (start > to) break;
    // A gap opens this segment: the skipped local times run at `start`, once,
    // unless the first local time after the gap is a run of its own.
    if (before !== undefined && offset > before && gap === 'shift' && start > from) {
      const skipped = nextOccurrence(schedule, start + before - 1);
      if (skipped < start + offset && !matches(schedule, start + offset)) {
        out.push({ at: start, wall: skipped, shifted: true });
        if (out.length >= limit) return out;
      }
    }
    const low = Math.max(from, start - 1);
    const high = Math.min(to, end - 1);
    if (high <= low) continue;
    // A repeat opens this segment: the local times before `start + before`
    // already came once, before the clock went back.
    const repeatsUntil = before !== undefined && offset < before ? start + before : -Infinity;
    for (let wall = low + offset; ; ) {
      wall = nextOccurrence(schedule, wall);
      const at = wall - offset;
      if (at > high) break;
      const repeated = wall < repeatsUntil;
      if (repeated && overlap === 'first') continue;
      out.push(repeated ? { at, wall, repeated: true } : { at, wall });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * The runs of `cron` read in a time zone whose UTC instant lies in the window
 * (`fromMs`, `toMs`]: the start excluded and the end included, so consecutive
 * windows never share a run. At most `limit` (default 1000), earliest first.
 *
 * A local time the clock skips runs once at the first valid instant after
 * the gap (`dstGap: 'shift'`; several skipped times make one run, and none
 * when that instant is a run of its own) or not at all (`'skip'`). A repeated
 * local time runs at its first instant (`dstOverlap: 'first'`) or at both
 * (`'both'`). Throws TypeError for a bad cron, zone, policy or time.
 */
export function zonedOccurrencesBetween(
  cron: CronSchedule | string,
  fromMs: number,
  toMs: number,
  options?: ZonedCronOptions,
  limit = 1000,
): ZonedOccurrence[] {
  assertTime(fromMs, 'fromMs');
  assertTime(toMs, 'toMs');
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError('limit must be a positive integer');
  const resolved = zoned(cron, options);
  if (toMs <= fromMs) return [];
  if (resolved.timeZone === 'UTC')
    return occurrencesBetween(resolved.schedule, fromMs, toMs, limit).map((at) => ({
      at,
      wall: at,
    }));
  return collect(resolved, fromMs, toMs, limit);
}

/**
 * The first run of `cron` read in a time zone strictly after `afterMs`
 * (epoch ms, UTC), with the DST policies of `zonedOccurrencesBetween`. Jumps
 * over empty stretches with the cron arithmetic, so a sparse cron costs no
 * more than a dense one. Throws RangeError when the cron never fires again.
 */
export function nextZonedOccurrence(
  cron: CronSchedule | string,
  afterMs: number,
  options?: ZonedCronOptions,
): number {
  assertTime(afterMs, 'afterMs');
  const resolved = zoned(cron, options);
  if (resolved.timeZone === 'UTC') return nextOccurrence(resolved.schedule, afterMs);
  for (let from = afterMs; ; ) {
    const to = from + OFFSET_SPAN_MS;
    const [found] = collect(resolved, from, to, 1);
    if (found) return found.at;
    // Nothing in (from, to]: go to the next local time the cron matches after
    // it (RangeError past the cron's horizon), less the widest offset.
    const wall = to + offsetAt(resolved.timeZone, to);
    const candidate = nextOccurrence(resolved.schedule, wall - OFFSET_SPAN_MS);
    from = Math.max(to, candidate - OFFSET_SPAN_MS);
  }
}
