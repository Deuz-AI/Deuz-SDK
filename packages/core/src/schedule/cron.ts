/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in
 * UTC. Pure arithmetic over `Date.UTC`, so it runs on any edge runtime.
 */

/** A parsed cron expression. Every list is sorted and deduplicated. */
export interface CronSchedule {
  readonly expression: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0 is Sunday; a 7 in the expression is folded into 0. */
  readonly daysOfWeek: readonly number[];
  /**
   * Whether the day-of-month field restricts days. A field that starts with
   * `*` (including `*\/2`) does not. When both day fields restrict, a day
   * matches if EITHER does; otherwise both must match (the Vixie cron rule).
   */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
];

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MINUTE = 60_000;
/** Longest month length per month (February counts its leap day). */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
/** The Gregorian calendar repeats every 400 years; a search past that never ends. */
const HORIZON_YEARS = 401;

function invalid(expression: string, detail: string): TypeError {
  return new TypeError(`Invalid cron expression ${JSON.stringify(expression)}: ${detail}`);
}

function parseValue(text: string, spec: FieldSpec, expression: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const index = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  if (index < 0) throw invalid(expression, `bad ${spec.name} value ${JSON.stringify(text)}`);
  return index + (spec.min === 1 ? 1 : 0);
}

function parseField(text: string, spec: FieldSpec, expression: string): number[] {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const parts = item.split('/');
    if (parts.length > 2) throw invalid(expression, `bad ${spec.name} step in ${item}`);
    const [rangeText = '', stepText] = parts;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw invalid(expression, `bad ${spec.name} step in ${JSON.stringify(item)}`);
      step = Number(stepText);
    }
    let low: number;
    let high: number;
    if (rangeText === '*') {
      low = spec.min;
      high = spec.max;
    } else {
      const bounds = rangeText.split('-');
      if (bounds.length > 2 || bounds.some((bound) => bound === ''))
        throw invalid(expression, `bad ${spec.name} range ${JSON.stringify(item)}`);
      low = parseValue(bounds[0] ?? '', spec, expression);
      high =
        bounds[1] !== undefined
          ? parseValue(bounds[1], spec, expression)
          : stepText !== undefined
            ? spec.max
            : low;
    }
    if (low < spec.min || high > spec.max)
      throw invalid(expression, `${spec.name} out of range ${spec.min}-${spec.max}`);
    if (low > high) throw invalid(expression, `backwards ${spec.name} range ${item}`);
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a five-field UTC cron expression or a macro such as `@daily`. Throws TypeError. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== 'string') throw new TypeError('Cron expression must be a string');
  const trimmed = expression.trim();
  const source = trimmed.startsWith('@') ? MACROS[trimmed.toLowerCase()] : trimmed;
  if (source === undefined) throw invalid(expression, 'unknown macro');
  const fields = source.split(/\s+/);
  if (fields.length !== 5 || fields[0] === '')
    throw invalid(expression, 'expected 5 fields: minute hour day-of-month month day-of-week');
  const [minutes, hours, daysOfMonth, months, rawDays] = FIELDS.map((spec, i) =>
    parseField(fields[i] ?? '', spec, expression),
  ) as [number[], number[], number[], number[], number[]];
  const daysOfWeek = [...new Set(rawDays.map((day) => day % 7))].sort((a, b) => a - b);
  const dayOfMonthRestricted = !(fields[2] ?? '').startsWith('*');
  const dayOfWeekRestricted = !(fields[4] ?? '').startsWith('*');
  // With the OR rule every month holds every weekday; otherwise some listed day
  // must exist in some listed month (every valid date meets every weekday
  // within the 400-year cycle).
  const possible =
    (dayOfMonthRestricted && dayOfWeekRestricted) ||
    months.some((month) => daysOfMonth.some((day) => day <= (MONTH_DAYS[month - 1] ?? 0)));
  if (!possible) throw invalid(expression, 'the day and month fields never fire together');
  return Object.freeze({
    expression,
    minutes: Object.freeze(minutes),
    hours: Object.freeze(hours),
    daysOfMonth: Object.freeze(daysOfMonth),
    months: Object.freeze(months),
    daysOfWeek: Object.freeze(daysOfWeek),
    dayOfMonthRestricted,
    dayOfWeekRestricted,
  });
}

interface Matcher {
  minutes: boolean[];
  hours: boolean[];
  daysOfMonth: boolean[];
  months: boolean[];
  daysOfWeek: boolean[];
  either: boolean;
}

const matchers = new WeakMap<CronSchedule, Matcher>();

function flags(values: readonly number[]): boolean[] {
  const out: boolean[] = [];
  for (const value of values) out[value] = true;
  return out;
}

function matcherFor(cron: CronSchedule | string): Matcher {
  const schedule = typeof cron === 'string' ? parseCron(cron) : cron;
  const cached = matchers.get(schedule);
  if (cached) return cached;
  const matcher: Matcher = {
    minutes: flags(schedule.minutes),
    hours: flags(schedule.hours),
    daysOfMonth: flags(schedule.daysOfMonth),
    months: flags(schedule.months),
    daysOfWeek: flags(schedule.daysOfWeek),
    either: schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted,
  };
  matchers.set(schedule, matcher);
  return matcher;
}

function dayMatches(m: Matcher, date: Date): boolean {
  const dom = m.daysOfMonth[date.getUTCDate()] === true;
  const dow = m.daysOfWeek[date.getUTCDay()] === true;
  return m.either ? dom || dow : dom && dow;
}

function assertTime(ms: number, name: string): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms))
    throw new TypeError(`${name} must be a finite number of milliseconds`);
}

/** The first matching minute strictly after `afterMs` (epoch milliseconds, UTC). */
export function nextOccurrence(cron: CronSchedule | string, afterMs: number): number {
  assertTime(afterMs, 'afterMs');
  const m = matcherFor(cron);
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const lastYear = new Date(t).getUTCFullYear() + HORIZON_YEARS;
  for (;;) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    if (year > lastYear) throw new RangeError('Cron expression has no next occurrence');
    const month = d.getUTCMonth();
    if (m.months[month + 1] !== true) {
      t = Date.UTC(year, month + 1, 1);
    } else if (!dayMatches(m, d)) {
      t = Date.UTC(year, month, d.getUTCDate() + 1);
    } else if (m.hours[d.getUTCHours()] !== true) {
      t = Date.UTC(year, month, d.getUTCDate(), d.getUTCHours() + 1);
    } else if (m.minutes[d.getUTCMinutes()] !== true) {
      t += MINUTE;
    } else {
      return t;
    }
  }
}

/** The last matching minute strictly before `beforeMs` (epoch milliseconds, UTC). */
export function previousOccurrence(cron: CronSchedule | string, beforeMs: number): number {
  assertTime(beforeMs, 'beforeMs');
  const m = matcherFor(cron);
  let t = Math.ceil(beforeMs / MINUTE) * MINUTE - MINUTE;
  const firstYear = new Date(t).getUTCFullYear() - HORIZON_YEARS;
  for (;;) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    if (year < firstYear) throw new RangeError('Cron expression has no previous occurrence');
    const month = d.getUTCMonth();
    if (m.months[month + 1] !== true) {
      t = Date.UTC(year, month, 1) - MINUTE;
    } else if (!dayMatches(m, d)) {
      t = Date.UTC(year, month, d.getUTCDate()) - MINUTE;
    } else if (m.hours[d.getUTCHours()] !== true) {
      t = Date.UTC(year, month, d.getUTCDate(), d.getUTCHours()) - MINUTE;
    } else if (m.minutes[d.getUTCMinutes()] !== true) {
      t -= MINUTE;
    } else {
      return t;
    }
  }
}

/**
 * Occurrences in the window (`fromMs`, `toMs`]: the start is excluded and the
 * end included, so consecutive windows never share an occurrence. At most
 * `limit` (default 1000) are returned, earliest first.
 */
export function occurrencesBetween(
  cron: CronSchedule | string,
  fromMs: number,
  toMs: number,
  limit = 1000,
): number[] {
  assertTime(fromMs, 'fromMs');
  assertTime(toMs, 'toMs');
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError('limit must be a positive integer');
  const schedule = typeof cron === 'string' ? parseCron(cron) : cron;
  const out: number[] = [];
  let t = fromMs;
  while (out.length < limit) {
    t = nextOccurrence(schedule, t);
    if (t > toMs) break;
    out.push(t);
  }
  return out;
}
