/**
 * `@deuz-sdk/core/schedule` (2.2): cron schedules and verified signals.
 * `parseCron` and friends evaluate five-field UTC cron; `createScheduler`
 * turns due occurrences into deduplicated runs, driven by a host cron trigger
 * (`tick`) or an injected clock (`start`). Edge-safe.
 */
export type { CronSchedule } from './schedule/cron';
export { parseCron, nextOccurrence, previousOccurrence, occurrencesBetween } from './schedule/cron';
export type {
  ScheduleOccurrence,
  ScheduleDefinition,
  ScheduleClaim,
  ScheduleCatchUp,
  SchedulerOptions,
  ScheduleOccurrenceResult,
  ScheduleTickResult,
  ScheduleStartOptions,
  Scheduler,
} from './schedule/scheduler';
export { createScheduler, createInMemoryClaim } from './schedule/scheduler';
export type {
  SignalRejection,
  SignalVerification,
  HmacAlgorithm,
  SignatureEncoding,
  HmacSignatureOptions,
  SlackVerifyOptions,
  SignalDispatchInput,
  HandleSignalOptions,
} from './schedule/signal';
export {
  verifyHmacSignature,
  verifyGitHubWebhook,
  verifySlackRequest,
  handleSignal,
} from './schedule/signal';
