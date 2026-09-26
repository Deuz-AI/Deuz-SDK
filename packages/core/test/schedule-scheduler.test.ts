import { describe, expect, it, vi } from 'vitest';
import { createInMemoryClaim, createScheduler } from '../src/schedule';
import type { ScheduleOccurrence, ScheduleTickResult } from '../src/schedule';
import type { Clock } from '../src/types/deps';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

function recorder() {
  const runs: ScheduleOccurrence[] = [];
  return { runs, run: (occurrence: ScheduleOccurrence) => void runs.push(occurrence) };
}

/** A hand-driven clock: timers fire only inside advance(). */
function manualClock(start: number) {
  let now = start;
  const timers: { at: number; ms: number; fn: () => void; done: boolean }[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { at: now + ms, ms, fn, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
  };
  return {
    clock,
    timers,
    pending: () => timers.filter((timer) => !timer.done),
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.find((timer) => !timer.done && timer.at <= now);
        if (!due) break;
        due.done = true;
        due.fn();
        await flush();
      }
      await flush();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('createScheduler().tick', () => {
  it('runs the occurrence that fell due inside the lookback window', async () => {
    const { runs, run } = recorder();
    const scheduler = createScheduler({ schedules: [{ id: 'digest', cron: '0 * * * *', run }] });
    const result = await scheduler.tick(at('2026-01-01T12:00:30Z'));
    expect(result.from).toBe(at('2026-01-01T11:59:30Z'));
    expect(result.to).toBe(at('2026-01-01T12:00:30Z'));
    const key = `digest@${at('2026-01-01T12:00:00Z')}`;
    expect(result.occurrences).toEqual([
      { id: 'digest', at: at('2026-01-01T12:00:00Z'), key, status: 'ran' },
    ]);
    expect(runs).toEqual([{ id: 'digest', at: at('2026-01-01T12:00:00Z'), key }]);
  });

  it('continues from the previous tick instead of the lookback', async () => {
    const { runs, run } = recorder();
    const scheduler = createScheduler({ schedules: [{ id: 'm', cron: '* * * * *', run }] });
    await scheduler.tick(at('2026-01-01T12:00:10Z'));
    const second = await scheduler.tick(at('2026-01-01T12:02:10Z'));
    expect(second.from).toBe(at('2026-01-01T12:00:10Z'));
    expect(runs.map((r) => iso(r.at))).toEqual([
      '2026-01-01T12:00:00.000Z',
      // default catchUp 'latest': 12:01 is superseded by 12:02
      '2026-01-01T12:02:00.000Z',
    ]);
  });

  it('does nothing when time did not move forward', async () => {
    const { runs, run } = recorder();
    const scheduler = createScheduler({ schedules: [{ id: 'm', cron: '* * * * *', run }] });
    await scheduler.tick(at('2026-01-01T12:00:10Z'));
    const again = await scheduler.tick(at('2026-01-01T12:00:10Z'));
    const back = await scheduler.tick(at('2026-01-01T11:00:00Z'));
    expect(again.occurrences).toEqual([]);
    expect(back.occurrences).toEqual([]);
    expect(runs).toHaveLength(1);
  });

  it('reads the injected clock when no time is given', async () => {
    const { runs, run } = recorder();
    const { clock } = manualClock(at('2026-01-01T12:00:05Z'));
    const scheduler = createScheduler({
      schedules: [{ id: 'm', cron: '* * * * *', run }],
      deps: { clock },
    });
    const result = await scheduler.tick();
    expect(result.to).toBe(at('2026-01-01T12:00:05Z'));
    expect(runs).toHaveLength(1);
  });

  it('dedupes across restarts through a shared claim', async () => {
    const claim = createInMemoryClaim();
    const first = recorder();
    const second = recorder();
    const before = createScheduler({
      schedules: [{ id: 'digest', cron: '0 * * * *', run: first.run }],
      claim,
    });
    await before.tick(at('2026-01-01T12:00:30Z'));
    // A fresh process (no previous tick) looks back over the same occurrence.
    const after = createScheduler({
      schedules: [{ id: 'digest', cron: '0 * * * *', run: second.run }],
      claim,
    });
    const result = await after.tick(at('2026-01-01T12:00:50Z'));
    expect(first.runs).toHaveLength(1);
    expect(second.runs).toHaveLength(0);
    expect(result.occurrences.map((o) => o.status)).toEqual(['duplicate']);
  });

  it('asks the claim with the occurrence key before running', async () => {
    const asked: string[] = [];
    const { runs, run } = recorder();
    const scheduler = createScheduler({
      schedules: [{ id: 'a', cron: '0 12 * * *', run }],
      claim: async (key) => {
        asked.push(key);
        return false;
      },
    });
    await scheduler.tick(at('2026-01-01T12:00:30Z'));
    expect(asked).toEqual([`a@${at('2026-01-01T12:00:00Z')}`]);
    expect(runs).toEqual([]);
  });

  describe('catch-up after downtime', () => {
    const now = at('2026-01-01T05:30:00Z');
    const lookbackMs = 6 * 3_600_000;

    it("'latest' runs only the newest missed occurrence", async () => {
      const { runs, run } = recorder();
      const scheduler = createScheduler({
        schedules: [{ id: 'h', cron: '0 * * * *', run }],
        lookbackMs,
      });
      await scheduler.tick(now);
      expect(runs.map((r) => iso(r.at))).toEqual(['2026-01-01T05:00:00.000Z']);
    });

    it("'all' runs every missed occurrence, oldest first", async () => {
      const { runs, run } = recorder();
      const scheduler = createScheduler({
        schedules: [{ id: 'h', cron: '0 * * * *', run }],
        lookbackMs,
        catchUp: 'all',
      });
      await scheduler.tick(now);
      expect(runs.map((r) => iso(r.at).slice(11, 16))).toEqual([
        '00:00',
        '01:00',
        '02:00',
        '03:00',
        '04:00',
        '05:00',
      ]);
    });

    it("'all' keeps the most recent maxCatchUp occurrences", async () => {
      const { runs, run } = recorder();
      const scheduler = createScheduler({
        schedules: [{ id: 'h', cron: '0 * * * *', run }],
        lookbackMs,
        catchUp: 'all',
        maxCatchUp: 3,
      });
      await scheduler.tick(now);
      expect(runs.map((r) => iso(r.at).slice(11, 16))).toEqual(['03:00', '04:00', '05:00']);
    });

    it("'none' skips an occurrence older than graceMs", async () => {
      const { runs, run } = recorder();
      const scheduler = createScheduler({
        schedules: [{ id: 'h', cron: '0 * * * *', run }],
        lookbackMs,
        catchUp: 'none',
      });
      const result = await scheduler.tick(now);
      expect(result.occurrences).toEqual([]);
      expect(runs).toEqual([]);
    });

    it("'none' still runs an occurrence that is on time", async () => {
      const { runs, run } = recorder();
      const scheduler = createScheduler({
        schedules: [{ id: 'h', cron: '0 * * * *', run }],
        lookbackMs,
        catchUp: 'none',
        graceMs: 120_000,
      });
      await scheduler.tick(at('2026-01-01T05:01:30Z'));
      expect(runs.map((r) => iso(r.at))).toEqual(['2026-01-01T05:00:00.000Z']);
    });
  });

  it('reports run and claim errors per occurrence without throwing', async () => {
    const { runs, run } = recorder();
    const boom = new Error('boom');
    const claimError = new Error('claim store down');
    const scheduler = createScheduler({
      schedules: [
        {
          id: 'bad',
          cron: '* * * * *',
          run: () => {
            throw boom;
          },
        },
        { id: 'good', cron: '* * * * *', run },
        { id: 'unclaimable', cron: '* * * * *', run },
      ],
      claim: (key) => {
        if (key.startsWith('unclaimable@')) throw claimError;
        return true;
      },
    });
    const result = await scheduler.tick(at('2026-01-01T12:00:10Z'));
    const byId = Object.fromEntries(result.occurrences.map((o) => [o.id, o]));
    expect(byId.bad).toMatchObject({ status: 'failed', phase: 'run', error: boom });
    expect(byId.good).toMatchObject({ status: 'ran' });
    expect(byId.unclaimable).toMatchObject({ status: 'failed', phase: 'claim', error: claimError });
    expect(runs.map((r) => r.id)).toEqual(['good']);
  });

  it('keeps the claim of a failed run, so no process runs that occurrence again', async () => {
    const claim = createInMemoryClaim();
    const release = vi.spyOn(claim, 'release');
    const failing = createScheduler({
      schedules: [
        {
          id: 'digest',
          cron: '0 * * * *',
          run: () => {
            throw new Error('boom');
          },
        },
      ],
      claim,
    });
    const first = await failing.tick(at('2026-01-01T12:00:30Z'));
    expect(first.occurrences).toMatchObject([{ status: 'failed', phase: 'run' }]);
    expect(release).not.toHaveBeenCalled();
    // Another process looking back over the same minute sees a duplicate.
    const { runs, run } = recorder();
    const other = createScheduler({ schedules: [{ id: 'digest', cron: '0 * * * *', run }], claim });
    const second = await other.tick(at('2026-01-01T12:00:50Z'));
    expect(second.occurrences.map((o) => o.status)).toEqual(['duplicate']);
    expect(runs).toEqual([]);
  });

  it('awaits async runs before the tick resolves', async () => {
    let finished = false;
    const scheduler = createScheduler({
      schedules: [
        {
          id: 'slow',
          cron: '* * * * *',
          run: async () => {
            await flush();
            finished = true;
          },
        },
      ],
    });
    await scheduler.tick(at('2026-01-01T12:00:10Z'));
    expect(finished).toBe(true);
  });

  it('accepts a parsed cron', async () => {
    const { parseCron } = await import('../src/schedule');
    const { runs, run } = recorder();
    const scheduler = createScheduler({
      schedules: [{ id: 'p', cron: parseCron('0 12 * * *'), run }],
    });
    await scheduler.tick(at('2026-01-01T12:00:10Z'));
    expect(runs).toHaveLength(1);
  });

  it.each([
    ['an empty id', [{ id: '', cron: '* * * * *', run: () => {} }]],
    [
      'duplicate ids',
      [
        { id: 'a', cron: '* * * * *', run: () => {} },
        { id: 'a', cron: '0 * * * *', run: () => {} },
      ],
    ],
    ['a bad cron', [{ id: 'a', cron: '61 * * * *', run: () => {} }]],
    ['a missing run', [{ id: 'a', cron: '* * * * *' }]],
  ])('rejects %s', (_, schedules) => {
    expect(() =>
      createScheduler({
        schedules: schedules as Parameters<typeof createScheduler>[0]['schedules'],
      }),
    ).toThrow(TypeError);
  });

  it('rejects bad options', () => {
    const schedules = [{ id: 'a', cron: '* * * * *', run: () => {} }];
    expect(() => createScheduler({ schedules, lookbackMs: -1 })).toThrow(TypeError);
    expect(() => createScheduler({ schedules, graceMs: Number.NaN })).toThrow(TypeError);
    expect(() => createScheduler({ schedules, maxCatchUp: 0 })).toThrow(TypeError);
    expect(() => createScheduler({ schedules, catchUp: 'some' as unknown as 'all' })).toThrow(
      TypeError,
    );
  });
});

describe('createScheduler().start', () => {
  it('ticks now, then every intervalMs on the injected clock, until aborted', async () => {
    const { runs, run } = recorder();
    const manual = manualClock(at('2026-01-01T12:00:30Z'));
    const ticks: ScheduleTickResult[] = [];
    const scheduler = createScheduler({
      schedules: [{ id: 'm', cron: '* * * * *', run }],
      deps: { clock: manual.clock },
    });
    const controller = new AbortController();
    let stopped = false;
    const done = scheduler
      .start({ intervalMs: 30_000, signal: controller.signal, onTick: (r) => ticks.push(r) })
      .then(() => {
        stopped = true;
      });
    await flush();
    expect(runs.map((r) => iso(r.at))).toEqual(['2026-01-01T12:00:00.000Z']);
    expect(manual.pending().map((t) => t.ms)).toEqual([30_000]);

    await manual.advance(30_000);
    expect(runs.map((r) => iso(r.at))).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:01:00.000Z',
    ]);
    await manual.advance(30_000);
    expect(ticks).toHaveLength(3);
    expect(stopped).toBe(false);

    controller.abort();
    await done;
    expect(stopped).toBe(true);
    expect(manual.pending()).toEqual([]);
    await manual.advance(120_000);
    expect(runs).toHaveLength(2);
  });

  it('returns at once for an already aborted signal', async () => {
    const { runs, run } = recorder();
    const manual = manualClock(at('2026-01-01T12:00:30Z'));
    const scheduler = createScheduler({
      schedules: [{ id: 'm', cron: '* * * * *', run }],
      deps: { clock: manual.clock },
    });
    await scheduler.start({ intervalMs: 1_000, signal: AbortSignal.abort() });
    expect(runs).toEqual([]);
    expect(manual.pending()).toEqual([]);
  });

  it('waits for the in-flight tick when aborted mid-run', async () => {
    const manual = manualClock(at('2026-01-01T12:00:30Z'));
    const controller = new AbortController();
    let release!: () => void;
    let finished = false;
    const scheduler = createScheduler({
      schedules: [
        {
          id: 'slow',
          cron: '* * * * *',
          run: async () => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            finished = true;
          },
        },
      ],
      deps: { clock: manual.clock },
    });
    let stopped = false;
    const done = scheduler.start({ intervalMs: 1_000, signal: controller.signal }).then(() => {
      stopped = true;
    });
    await flush();
    controller.abort();
    await flush();
    expect(stopped).toBe(false);
    release();
    await done;
    expect(finished).toBe(true);
    expect(manual.pending()).toEqual([]);
  });

  it('treats a late occurrence as on time within one interval under catchUp none', async () => {
    const { runs, run } = recorder();
    const manual = manualClock(at('2026-01-01T12:04:00Z'));
    const scheduler = createScheduler({
      schedules: [{ id: 'm', cron: '0 * * * *', run }],
      catchUp: 'none',
      lookbackMs: 3_600_000,
      deps: { clock: manual.clock },
    });
    const controller = new AbortController();
    const done = scheduler.start({ intervalMs: 300_000, signal: controller.signal });
    await flush();
    controller.abort();
    await done;
    expect(runs.map((r) => iso(r.at))).toEqual(['2026-01-01T12:00:00.000Z']);
  });

  it('refuses a second concurrent start and bad intervals', async () => {
    const manual = manualClock(at('2026-01-01T12:00:30Z'));
    const scheduler = createScheduler({
      schedules: [{ id: 'm', cron: '* * * * *', run: () => {} }],
      deps: { clock: manual.clock },
    });
    const controller = new AbortController();
    const done = scheduler.start({ intervalMs: 1_000, signal: controller.signal });
    await expect(
      scheduler.start({ intervalMs: 1_000, signal: new AbortController().signal }),
    ).rejects.toThrow(/already started/);
    await expect(
      createScheduler({ schedules: [] }).start({
        intervalMs: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(TypeError);
    controller.abort();
    await done;
  });
});

describe('createInMemoryClaim', () => {
  it('claims a key once', async () => {
    const claim = createInMemoryClaim();
    expect(await claim('a')).toBe(true);
    expect(await claim('a')).toBe(false);
    expect(await claim('b')).toBe(true);
  });

  it('gives a key back on release', async () => {
    const claim = createInMemoryClaim();
    expect(await claim('a')).toBe(true);
    await claim.release('a');
    expect(await claim('a')).toBe(true);
    expect(await claim('a')).toBe(false);
    await claim.release('never-claimed');
    expect(await claim('never-claimed')).toBe(true);
  });

  it('forgets the oldest keys beyond max', async () => {
    const claim = createInMemoryClaim({ max: 2 });
    await claim('a');
    await claim('b');
    await claim('c');
    expect(await claim('a')).toBe(true);
    expect(await claim('c')).toBe(false);
  });
});
