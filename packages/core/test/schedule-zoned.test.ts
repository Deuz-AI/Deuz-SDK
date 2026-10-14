import { describe, expect, it } from 'vitest';
import { occurrencesBetween } from '../src/schedule/cron';
import {
  assertTimeZone,
  nextZonedOccurrence,
  timeZoneOffset,
  zonedOccurrencesBetween,
  type ZonedCronOptions,
} from '../src/schedule/zoned';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString().replace(':00.000Z', 'Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The UTC instants of `cron` in (`from`, `to`], as ISO strings without seconds. */
function runs(cron: string, from: string, to: string, options?: ZonedCronOptions): string[] {
  return zonedOccurrencesBetween(cron, at(from), at(to), options).map((o) => iso(o.at));
}

describe('timeZoneOffset', () => {
  it('is the wall clock minus UTC, from Intl, whatever the host zone', () => {
    expect(timeZoneOffset('America/New_York', at('2026-01-15T12:00:00Z'))).toBe(-5 * HOUR);
    expect(timeZoneOffset('America/New_York', at('2026-07-15T12:00:00Z'))).toBe(-4 * HOUR);
    expect(timeZoneOffset('Asia/Kolkata', at('2026-07-15T12:00:00Z'))).toBe(5 * HOUR + 30 * MINUTE);
    expect(timeZoneOffset('Europe/Istanbul', at('2026-01-15T12:00:00Z'))).toBe(3 * HOUR);
    expect(timeZoneOffset('Europe/Istanbul', at('2026-07-15T12:00:00Z'))).toBe(3 * HOUR);
    // Lord Howe Island moves its clock by half an hour.
    expect(timeZoneOffset('Australia/Lord_Howe', at('2026-07-15T12:00:00Z'))).toBe(
      10 * HOUR + 30 * MINUTE,
    );
    expect(timeZoneOffset('Australia/Lord_Howe', at('2026-01-15T12:00:00Z'))).toBe(11 * HOUR);
    expect(timeZoneOffset('UTC', at('2026-07-15T12:00:00Z'))).toBe(0);
  });

  it('changes exactly at the transition instant', () => {
    expect(timeZoneOffset('America/New_York', at('2026-03-08T06:59:59Z'))).toBe(-5 * HOUR);
    expect(timeZoneOffset('America/New_York', at('2026-03-08T07:00:00Z'))).toBe(-4 * HOUR);
    expect(timeZoneOffset('America/New_York', at('2026-11-01T05:59:59Z'))).toBe(-4 * HOUR);
    expect(timeZoneOffset('America/New_York', at('2026-11-01T06:00:00Z'))).toBe(-5 * HOUR);
  });

  it('refuses a zone Intl does not know, and a non-string', () => {
    expect(() => timeZoneOffset('Mars/Olympus_Mons', 0)).toThrow(TypeError);
    expect(() => assertTimeZone('Mars/Olympus_Mons')).toThrow(/time zone/i);
    expect(() => assertTimeZone('')).toThrow(TypeError);
    expect(() => assertTimeZone(42 as never)).toThrow(TypeError);
    expect(assertTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(() => timeZoneOffset('UTC', Number.NaN)).toThrow(TypeError);
  });
});

describe('zonedOccurrencesBetween', () => {
  it('is plain UTC cron by default', () => {
    const from = at('2026-03-01T00:00:00Z');
    const to = at('2026-03-03T00:00:00Z');
    expect(zonedOccurrencesBetween('0 */6 * * *', from, to).map((o) => o.at)).toEqual(
      occurrencesBetween('0 */6 * * *', from, to),
    );
    expect(zonedOccurrencesBetween('0 9 * * *', from, to, { timezone: 'UTC' })[0]).toEqual({
      at: at('2026-03-01T09:00:00Z'),
      wall: at('2026-03-01T09:00:00Z'),
    });
  });

  it('reports each run with the wall time it matched', () => {
    const [run] = zonedOccurrencesBetween(
      '0 9 * * *',
      at('2026-03-01T00:00:00Z'),
      at('2026-03-02T00:00:00Z'),
      { timezone: 'Asia/Kolkata' },
    );
    expect(run).toEqual({ at: at('2026-03-01T03:30:00Z'), wall: at('2026-03-01T09:00:00Z') });
  });

  describe('a local time the clock skips (America/New_York, 2026-03-08 02:00 -> 03:00)', () => {
    const window = ['2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'] as const;

    it('shift (the default) runs once at the first valid instant after the gap', () => {
      expect(runs('30 2 * * *', ...window, { timezone: 'America/New_York' })).toEqual([
        '2026-03-07T07:30Z', // 02:30 EST
        '2026-03-08T07:00Z', // 03:00 EDT: 02:30 does not exist that day
        '2026-03-09T06:30Z', // 02:30 EDT
      ]);
      const [, shifted] = zonedOccurrencesBetween('30 2 * * *', at(window[0]), at(window[1]), {
        timezone: 'America/New_York',
      });
      expect(shifted).toEqual({
        at: at('2026-03-08T07:00:00Z'),
        wall: at('2026-03-08T02:30:00Z'),
        shifted: true,
      });
    });

    it('skip drops it', () => {
      expect(
        runs('30 2 * * *', ...window, { timezone: 'America/New_York', dstGap: 'skip' }),
      ).toEqual(['2026-03-07T07:30Z', '2026-03-09T06:30Z']);
    });

    it('collapses every skipped time into the one run at the end of the gap', () => {
      expect(
        runs('*/15 * * * *', '2026-03-08T06:40:00Z', '2026-03-08T07:20:00Z', {
          timezone: 'America/New_York',
        }),
      ).toEqual(['2026-03-08T06:45Z', '2026-03-08T07:00Z', '2026-03-08T07:15Z']);
      // 03:00 itself matches, so the regular run is kept and nothing is marked shifted.
      const runsAtGapEnd = zonedOccurrencesBetween(
        '*/15 * * * *',
        at('2026-03-08T06:50:00Z'),
        at('2026-03-08T07:00:00Z'),
        { timezone: 'America/New_York' },
      );
      expect(runsAtGapEnd).toEqual([
        { at: at('2026-03-08T07:00:00Z'), wall: at('2026-03-08T03:00:00Z') },
      ]);
    });

    it('belongs to the window holding the transition instant', () => {
      const options = { timezone: 'America/New_York' };
      expect(runs('30 2 * * *', '2026-03-08T06:00:00Z', '2026-03-08T06:59:59Z', options)).toEqual(
        [],
      );
      expect(runs('30 2 * * *', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', options)).toEqual([
        '2026-03-08T07:00Z',
      ]);
      expect(runs('30 2 * * *', '2026-03-08T07:00:00Z', '2026-03-08T08:00:00Z', options)).toEqual(
        [],
      );
    });
  });

  describe('a local time the clock repeats (America/New_York, 2026-11-01 02:00 -> 01:00)', () => {
    const window = ['2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'] as const;

    it('first (the default) runs a fixed-time job once, at the first instant', () => {
      expect(runs('30 1 * * *', ...window, { timezone: 'America/New_York' })).toEqual([
        '2026-10-31T05:30Z', // 01:30 EDT
        '2026-11-01T05:30Z', // 01:30 EDT, the first of two
        '2026-11-02T06:30Z', // 01:30 EST
      ]);
    });

    it('both runs at each instant, with distinct UTC instants', () => {
      const both = zonedOccurrencesBetween('30 1 * * *', at(window[0]), at(window[1]), {
        timezone: 'America/New_York',
        dstOverlap: 'both',
      });
      expect(both.map((o) => iso(o.at))).toEqual([
        '2026-10-31T05:30Z',
        '2026-11-01T05:30Z',
        '2026-11-01T06:30Z',
        '2026-11-02T06:30Z',
      ]);
      expect(both[2]).toEqual({
        at: at('2026-11-01T06:30:00Z'),
        wall: at('2026-11-01T01:30:00Z'),
        repeated: true,
      });
    });

    it('drops the repeated hour of an hourly job under first', () => {
      const from = '2026-11-01T03:30:00Z';
      const to = '2026-11-01T07:30:00Z';
      expect(runs('0 * * * *', from, to, { timezone: 'America/New_York' })).toEqual([
        '2026-11-01T04:00Z', // 00:00 EDT
        '2026-11-01T05:00Z', // 01:00 EDT
        '2026-11-01T07:00Z', // 02:00 EST
      ]);
      expect(
        runs('0 * * * *', from, to, { timezone: 'America/New_York', dstOverlap: 'both' }),
      ).toEqual([
        '2026-11-01T04:00Z',
        '2026-11-01T05:00Z',
        '2026-11-01T06:00Z',
        '2026-11-01T07:00Z',
      ]);
    });

    it('still drops a repeat when the first instance lies before the window', () => {
      expect(
        runs('30 1 * * *', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', {
          timezone: 'America/New_York',
        }),
      ).toEqual([]);
    });
  });

  it('keeps a fixed offset in a zone without DST (Europe/Istanbul)', () => {
    const options = { timezone: 'Europe/Istanbul' };
    expect(runs('0 9 * * *', '2026-03-27T00:00:00Z', '2026-03-31T00:00:00Z', options)).toEqual([
      '2026-03-27T06:00Z',
      '2026-03-28T06:00Z',
      '2026-03-29T06:00Z',
      '2026-03-30T06:00Z',
    ]);
    expect(runs('0 9 * * *', '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z', options)).toEqual([
      '2026-10-24T06:00Z',
      '2026-10-25T06:00Z',
      '2026-10-26T06:00Z',
    ]);
  });

  it('handles a half-hour offset (Asia/Kolkata), across the UTC date line', () => {
    const options = { timezone: 'Asia/Kolkata' };
    expect(runs('0 0 * * *', '2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z', options)).toEqual([
      '2026-05-01T18:30Z',
      '2026-05-02T18:30Z',
    ]);
    // Monday in Kolkata starts at 18:30Z on Sunday.
    expect(runs('15 * * * 1', '2026-05-03T18:00:00Z', '2026-05-03T21:00:00Z', options)).toEqual([
      '2026-05-03T18:45Z',
      '2026-05-03T19:45Z',
      '2026-05-03T20:45Z',
    ]);
  });

  describe('a 30-minute DST (Australia/Lord_Howe)', () => {
    it('shifts a time in the half-hour gap (2026-10-04 02:00 -> 02:30)', () => {
      const options = { timezone: 'Australia/Lord_Howe' };
      expect(runs('15 2 * * *', '2026-10-02T00:00:00Z', '2026-10-05T00:00:00Z', options)).toEqual([
        '2026-10-02T15:45Z', // 02:15 at +10:30
        '2026-10-03T15:30Z', // 02:30 at +11: 02:15 does not exist
        '2026-10-04T15:15Z', // 02:15 at +11
      ]);
      expect(
        runs('15 2 * * *', '2026-10-02T00:00:00Z', '2026-10-05T00:00:00Z', {
          ...options,
          dstGap: 'skip',
        }),
      ).toEqual(['2026-10-02T15:45Z', '2026-10-04T15:15Z']);
    });

    it('runs a time in the repeated half hour once or twice (2026-04-05 02:00 -> 01:30)', () => {
      const window = ['2026-04-04T12:00:00Z', '2026-04-04T18:00:00Z'] as const;
      expect(runs('45 1 * * *', ...window, { timezone: 'Australia/Lord_Howe' })).toEqual([
        '2026-04-04T14:45Z',
      ]);
      expect(
        runs('45 1 * * *', ...window, { timezone: 'Australia/Lord_Howe', dstOverlap: 'both' }),
      ).toEqual(['2026-04-04T14:45Z', '2026-04-04T15:15Z']);
    });
  });

  it('returns at most `limit` runs, earliest first, and checks its arguments', () => {
    const from = at('2026-03-08T00:00:00Z');
    const to = at('2026-03-09T00:00:00Z');
    const options = { timezone: 'America/New_York' };
    expect(
      zonedOccurrencesBetween('* * * * *', from, to, options, 3).map((o) => iso(o.at)),
    ).toEqual(['2026-03-08T00:01Z', '2026-03-08T00:02Z', '2026-03-08T00:03Z']);
    // Every UTC minute is one local minute: the skipped hour adds no run of its own.
    expect(zonedOccurrencesBetween('* * * * *', from, to, options, 5000)).toHaveLength(24 * 60);
    expect(() => zonedOccurrencesBetween('* * * * *', from, to, options, 0)).toThrow(TypeError);
    expect(() => zonedOccurrencesBetween('nope', from, to)).toThrow(TypeError);
    expect(() => zonedOccurrencesBetween('* * * * *', from, Number.NaN)).toThrow(TypeError);
    expect(() =>
      zonedOccurrencesBetween('* * * * *', from, to, { dstGap: 'later' as never }),
    ).toThrow(TypeError);
    expect(() =>
      zonedOccurrencesBetween('* * * * *', from, to, { dstOverlap: 'last' as never }),
    ).toThrow(TypeError);
    expect(() =>
      zonedOccurrencesBetween('* * * * *', from, to, { timezone: 'Nowhere/City' }),
    ).toThrow(TypeError);
    expect(zonedOccurrencesBetween('* * * * *', to, from)).toEqual([]);
  });

  it('gives the same answer whatever the host time zone is', () => {
    const before = process.env.TZ;
    const sample = () =>
      runs('30 2 * * *', '2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z', {
        timezone: 'America/New_York',
      }).concat(
        runs('30 1 * * *', '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z', {
          timezone: 'America/New_York',
          dstOverlap: 'both',
        }),
      );
    const reference = sample();
    try {
      for (const zone of ['UTC', 'Pacific/Chatham', 'America/Los_Angeles', 'Asia/Kolkata']) {
        process.env.TZ = zone;
        expect(sample(), zone).toEqual(reference);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('nextZonedOccurrence', () => {
  it('is the first run strictly after a time, DST policies included', () => {
    const options = { timezone: 'America/New_York' };
    expect(iso(nextZonedOccurrence('30 2 * * *', at('2026-03-07T08:00:00Z'), options))).toBe(
      '2026-03-08T07:00Z',
    );
    expect(
      iso(
        nextZonedOccurrence('30 2 * * *', at('2026-03-07T08:00:00Z'), {
          ...options,
          dstGap: 'skip',
        }),
      ),
    ).toBe('2026-03-09T06:30Z');
    expect(iso(nextZonedOccurrence('30 1 * * *', at('2026-11-01T05:30:00Z'), options))).toBe(
      '2026-11-02T06:30Z',
    );
    expect(
      iso(
        nextZonedOccurrence('30 1 * * *', at('2026-11-01T05:30:00Z'), {
          ...options,
          dstOverlap: 'both',
        }),
      ),
    ).toBe('2026-11-01T06:30Z');
    expect(
      iso(
        nextZonedOccurrence('0 9 * * *', at('2026-03-01T03:30:00Z'), { timezone: 'Asia/Kolkata' }),
      ),
    ).toBe('2026-03-02T03:30Z');
  });

  it('jumps straight to a sparse occurrence', () => {
    expect(
      iso(
        nextZonedOccurrence('0 12 29 2 *', at('2026-03-01T00:00:00Z'), {
          timezone: 'Europe/Istanbul',
        }),
      ),
    ).toBe('2028-02-29T09:00Z');
    expect(iso(nextZonedOccurrence('0 12 29 2 *', at('2026-03-01T00:00:00Z')))).toBe(
      '2028-02-29T12:00Z',
    );
  });

  it('stays fast over many years of DST gaps', () => {
    const started = performance.now();
    let t = at('2026-01-01T00:00:00Z');
    // 02:30 on 8 March: shifted in the years DST starts that day, regular otherwise.
    for (let index = 0; index < 50; index++)
      t = nextZonedOccurrence('30 2 8 3 *', t, { timezone: 'America/New_York' });
    expect(new Date(t).getUTCFullYear()).toBe(2075);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('checks its arguments', () => {
    expect(() => nextZonedOccurrence('nope', 0)).toThrow(TypeError);
    expect(() => nextZonedOccurrence('* * * * *', Number.NaN)).toThrow(TypeError);
    expect(() => nextZonedOccurrence('* * * * *', 0, { timezone: 'Nowhere/City' })).toThrow(
      TypeError,
    );
  });
});
