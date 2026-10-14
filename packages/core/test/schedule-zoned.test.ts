import { describe, expect, it } from 'vitest';
import { assertTimeZone, timeZoneOffset } from '../src/schedule/zoned';

const at = (iso: string): number => Date.parse(iso);
const HOUR = 3_600_000;
const MINUTE = 60_000;

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
