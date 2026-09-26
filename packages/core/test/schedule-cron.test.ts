import { describe, expect, it } from 'vitest';
import { nextOccurrence, occurrencesBetween, parseCron, previousOccurrence } from '../src/schedule';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

describe('parseCron', () => {
  it('expands stars, lists, ranges and steps into sorted field values', () => {
    const cron = parseCron('5-20/5 9,17 1-3 */4 1-5');
    expect(cron.minutes).toEqual([5, 10, 15, 20]);
    expect(cron.hours).toEqual([9, 17]);
    expect(cron.daysOfMonth).toEqual([1, 2, 3]);
    expect(cron.months).toEqual([1, 5, 9]);
    expect(cron.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(cron.expression).toBe('5-20/5 9,17 1-3 */4 1-5');
    expect(Object.isFrozen(cron)).toBe(true);
  });

  it('treats a single value with a step as a range to the field maximum', () => {
    expect(parseCron('50/5 * * * *').minutes).toEqual([50, 55]);
  });

  it('accepts month and weekday names in any case, and 7 as Sunday', () => {
    const cron = parseCron('0 0 * jan,Jul SUN,mon-Wed');
    expect(cron.months).toEqual([1, 7]);
    expect(cron.daysOfWeek).toEqual([0, 1, 2, 3]);
    expect(parseCron('0 0 * * 5-7').daysOfWeek).toEqual([0, 5, 6]);
  });

  it('marks day fields as restricted unless they start with a star', () => {
    const both = parseCron('0 0 13 * 5');
    expect([both.dayOfMonthRestricted, both.dayOfWeekRestricted]).toEqual([true, true]);
    const stepped = parseCron('0 0 */2 * 1');
    expect([stepped.dayOfMonthRestricted, stepped.dayOfWeekRestricted]).toEqual([false, true]);
  });

  it('expands the standard macros', () => {
    expect(parseCron('@hourly')).toMatchObject({ minutes: [0], hours: range(0, 23) });
    expect(parseCron('@daily')).toMatchObject({ minutes: [0], hours: [0] });
    expect(parseCron('@midnight')).toMatchObject({ minutes: [0], hours: [0] });
    expect(parseCron('@weekly')).toMatchObject({ daysOfWeek: [0], dayOfWeekRestricted: true });
    expect(parseCron('@monthly')).toMatchObject({ daysOfMonth: [1], months: range(1, 12) });
    expect(parseCron('@yearly')).toMatchObject({ daysOfMonth: [1], months: [1] });
    expect(parseCron('@annually').expression).toBe('@annually');
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(parseCron('  0\t12   * *  * ').hours).toEqual([12]);
  });

  it.each([
    [''],
    ['* * * *'],
    ['* * * * * *'],
    ['60 * * * *'],
    ['* 24 * * *'],
    ['* * 0 * *'],
    ['* * 32 * *'],
    ['* * * 0 *'],
    ['* * * 13 *'],
    ['* * * * 8'],
    ['*/0 * * * *'],
    ['*/x * * * *'],
    ['a * * * *'],
    ['5-1 * * * *'],
    ['1,,2 * * * *'],
    ['1- * * * *'],
    ['-1 * * * *'],
    ['1.5 * * * *'],
    ['* * * FOO *'],
    ['* * * * FRI-MON'],
    ['@reboot'],
    ['@never'],
  ])('rejects %j', (expression) => {
    expect(() => parseCron(expression)).toThrow(TypeError);
  });

  it('rejects expressions that can never fire', () => {
    expect(() => parseCron('0 0 30 2 *')).toThrow(/never/);
    expect(() => parseCron('0 0 31 4,6,9,11 *')).toThrow(/never/);
    // February 29 exists in leap years, and a weekday OR makes any date possible.
    expect(() => parseCron('0 0 29 2 *')).not.toThrow();
    expect(() => parseCron('0 0 30 2 1')).not.toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => parseCron(5 as unknown as string)).toThrow(TypeError);
  });
});

describe('nextOccurrence', () => {
  it('returns the next matching minute strictly after the given time', () => {
    expect(iso(nextOccurrence('* * * * *', at('2026-01-01T00:00:30.500Z')))).toBe(
      '2026-01-01T00:01:00.000Z',
    );
    expect(iso(nextOccurrence('* * * * *', at('2026-01-01T00:01:00Z')))).toBe(
      '2026-01-01T00:02:00.000Z',
    );
  });

  it('walks steps across hour boundaries', () => {
    expect(iso(nextOccurrence('*/15 * * * *', at('2026-01-01T00:16:00Z')))).toBe(
      '2026-01-01T00:30:00.000Z',
    );
    expect(iso(nextOccurrence('*/15 * * * *', at('2026-01-01T23:46:00Z')))).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('accepts a parsed schedule', () => {
    const cron = parseCron('30 9 * * *');
    expect(iso(nextOccurrence(cron, at('2026-01-01T10:00:00Z')))).toBe('2026-01-02T09:30:00.000Z');
  });

  it('skips the weekend for a weekday range', () => {
    // 2026-01-03 is a Saturday.
    expect(iso(nextOccurrence('0 9 * * MON-FRI', at('2026-01-03T12:00:00Z')))).toBe(
      '2026-01-05T09:00:00.000Z',
    );
  });

  it('fires on either day field when both are restricted (the OR rule)', () => {
    const cron = parseCron('0 0 15 * MON');
    const got = occurrencesBetween(cron, at('2026-01-01T00:00:00Z'), at('2026-01-31T00:00:00Z'));
    // Mondays 5, 12, 19, 26 and Thursday the 15th.
    expect(got.map((ms) => iso(ms)?.slice(0, 10))).toEqual([
      '2026-01-05',
      '2026-01-12',
      '2026-01-15',
      '2026-01-19',
      '2026-01-26',
    ]);
  });

  it('requires both day fields when day-of-month starts with a star', () => {
    const got = occurrencesBetween(
      '0 0 */2 * MON',
      at('2026-01-01T00:00:00Z'),
      at('2026-01-31T00:00:00Z'),
    );
    // Odd days that are also Mondays.
    expect(got.map((ms) => iso(ms)?.slice(0, 10))).toEqual(['2026-01-05', '2026-01-19']);
  });

  it('skips months that are too short for the day', () => {
    expect(iso(nextOccurrence('0 0 31 * *', at('2026-01-31T00:00:00Z')))).toBe(
      '2026-03-31T00:00:00.000Z',
    );
    expect(iso(nextOccurrence('0 0 31 * *', at('2026-03-31T00:00:00Z')))).toBe(
      '2026-05-31T00:00:00.000Z',
    );
  });

  it('finds February 29 in the next leap year, skipping 2100', () => {
    expect(iso(nextOccurrence('0 0 29 2 *', at('2026-01-01T00:00:00Z')))).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(iso(nextOccurrence('0 0 29 2 *', at('2096-03-01T00:00:00Z')))).toBe(
      '2104-02-29T00:00:00.000Z',
    );
  });

  it('crosses year boundaries', () => {
    expect(iso(nextOccurrence('@yearly', at('2026-06-01T00:00:00Z')))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('rejects a non-finite time', () => {
    expect(() => nextOccurrence('* * * * *', Number.NaN)).toThrow(TypeError);
  });
});

describe('previousOccurrence', () => {
  it('returns the latest matching minute strictly before the given time', () => {
    // 2026-01-05 is a Monday; the previous weekday run is Friday.
    expect(iso(previousOccurrence('0 9 * * MON-FRI', at('2026-01-05T08:00:00Z')))).toBe(
      '2026-01-02T09:00:00.000Z',
    );
    expect(iso(previousOccurrence('0 9 * * *', at('2026-01-05T09:00:00Z')))).toBe(
      '2026-01-04T09:00:00.000Z',
    );
    expect(iso(previousOccurrence('0 9 * * *', at('2026-01-05T09:00:00.001Z')))).toBe(
      '2026-01-05T09:00:00.000Z',
    );
  });

  it('walks back over short months and non-leap years', () => {
    expect(iso(previousOccurrence('0 0 31 * *', at('2026-05-01T00:00:00Z')))).toBe(
      '2026-03-31T00:00:00.000Z',
    );
    expect(iso(previousOccurrence('0 0 29 2 *', at('2104-01-01T00:00:00Z')))).toBe(
      '2096-02-29T00:00:00.000Z',
    );
  });
});

describe('occurrencesBetween', () => {
  it('excludes the start and includes the end', () => {
    const got = occurrencesBetween(
      '0 * * * *',
      at('2026-01-01T00:00:00Z'),
      at('2026-01-01T03:00:00Z'),
    );
    expect(got.map(iso)).toEqual([
      '2026-01-01T01:00:00.000Z',
      '2026-01-01T02:00:00.000Z',
      '2026-01-01T03:00:00.000Z',
    ]);
  });

  it('stops at the limit and returns nothing for an empty window', () => {
    const from = at('2026-01-01T00:00:00Z');
    expect(occurrencesBetween('* * * * *', from, from + 3_600_000, 2)).toHaveLength(2);
    expect(occurrencesBetween('* * * * *', from, from)).toEqual([]);
    expect(occurrencesBetween('* * * * *', from, from - 1)).toEqual([]);
  });

  it('rejects a bad limit', () => {
    expect(() => occurrencesBetween('* * * * *', 0, 60_000, 0)).toThrow(TypeError);
    expect(() => occurrencesBetween('* * * * *', 0, 60_000, 1.5)).toThrow(TypeError);
  });
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
