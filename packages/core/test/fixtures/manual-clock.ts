import type { Clock } from '../../src/types/deps';

/**
 * A clock that only moves when the test says so. `advance` fires every timer
 * that came due, in due order, and lets their callbacks' promises settle.
 */
export function manualClock(start = 1_000): {
  clock: Clock;
  advance(ms: number): Promise<void>;
  /** Timers still waiting. */
  pending(): number;
} {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const settle = async () => {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    clock: {
      now: () => now,
      setTimeout(callback, ms) {
        const id = nextId++;
        timers.set(id, { at: now + ms, callback });
        return () => {
          timers.delete(id);
        };
      },
    },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, left], [, right]) => left.at - right.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
    pending: () => timers.size,
  };
}
