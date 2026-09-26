import { expectTypeOf, test } from 'vitest';
import {
  createInMemoryClaim,
  createScheduler,
  handleSignal,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  previousOccurrence,
  verifyGitHubWebhook,
  verifyHmacSignature,
  verifySlackRequest,
} from '../src/schedule';
import type {
  CronSchedule,
  HandleSignalOptions,
  ScheduleClaim,
  ScheduleOccurrence,
  ScheduleOccurrenceResult,
  Scheduler,
  ScheduleTickResult,
  SignalVerification,
} from '../src/schedule';
import type { SqliteOpsStore } from '../src/node/ops-sqlite';
import type { PostgresOpsStore } from '../src/node/ops-postgres';

test('cron helpers', () => {
  expectTypeOf(parseCron).returns.toEqualTypeOf<CronSchedule>();
  expectTypeOf(nextOccurrence).parameters.toEqualTypeOf<[CronSchedule | string, number]>();
  expectTypeOf(nextOccurrence).returns.toEqualTypeOf<number>();
  expectTypeOf(previousOccurrence).returns.toEqualTypeOf<number>();
  expectTypeOf(occurrencesBetween).returns.toEqualTypeOf<number[]>();
});

test('scheduler', () => {
  const scheduler = createScheduler({
    schedules: [{ id: 'digest', cron: '0 9 * * MON-FRI', run: (o) => o.key }],
    claim: createInMemoryClaim(),
    catchUp: 'all',
  });
  expectTypeOf(scheduler).toEqualTypeOf<Scheduler>();
  expectTypeOf(scheduler.tick).returns.resolves.toEqualTypeOf<ScheduleTickResult>();
  expectTypeOf(scheduler.start).returns.resolves.toBeVoid();
  expectTypeOf(createInMemoryClaim()).toExtend<ScheduleClaim>();
  expectTypeOf(createInMemoryClaim().release).toEqualTypeOf<(key: string) => Promise<void>>();
  // A plain function is still a claim; `release` is optional.
  expectTypeOf<(key: string) => boolean>().toExtend<ScheduleClaim>();
  expectTypeOf<(key: string) => Promise<boolean>>().toExtend<HandleSignalOptions['dedupe']>();
  expectTypeOf<ScheduleClaim['release']>().toEqualTypeOf<
    ((key: string) => void | Promise<void>) | undefined
  >();
  // The ops stores' durable claims fit both consumers, and always release.
  expectTypeOf<SqliteOpsStore['claims']>().toExtend<ScheduleClaim>();
  expectTypeOf<PostgresOpsStore['claims']>().toExtend<ScheduleClaim>();
  expectTypeOf<PostgresOpsStore['claims']>().toExtend<HandleSignalOptions['dedupe']>();
  expectTypeOf<SqliteOpsStore['claims']['release']>().toEqualTypeOf<
    (key: string) => Promise<void>
  >();
  expectTypeOf<ScheduleOccurrence>().toEqualTypeOf<{
    readonly id: string;
    readonly at: number;
    readonly key: string;
  }>();
  expectTypeOf<ScheduleOccurrenceResult['status']>().toEqualTypeOf<
    'ran' | 'duplicate' | 'failed'
  >();
  // @ts-expect-error unknown catch-up mode
  createScheduler({ schedules: [], catchUp: 'some' });
  // @ts-expect-error start needs a signal
  void scheduler.start({ intervalMs: 1000 });
});

test('signals', () => {
  expectTypeOf(verifyGitHubWebhook).returns.resolves.toEqualTypeOf<SignalVerification>();
  expectTypeOf(verifySlackRequest).returns.resolves.toEqualTypeOf<SignalVerification>();
  expectTypeOf(verifyHmacSignature).returns.resolves.toEqualTypeOf<SignalVerification>();
  expectTypeOf(handleSignal).returns.resolves.toEqualTypeOf<Response>();
  expectTypeOf<HandleSignalOptions['dispatch']>().parameter(0).toHaveProperty('key');
  const verification = {} as SignalVerification;
  if (verification.ok) expectTypeOf(verification.body).toBeString();
  // @ts-expect-error Slack verification needs a time
  void verifySlackRequest(new Request('https://x.test'), 'secret');
});
