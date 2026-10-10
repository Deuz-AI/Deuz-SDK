/**
 * `@deuz-sdk/core/goal` (2.3): goal, wakeup and event contracts. A goal is a
 * versioned JSON record (objective, acceptance criteria, evidence, budget,
 * deadline, an explicit waiting reason) that pure transitions move forward;
 * a wakeup or outside event is an envelope whose dedupe key shares one space
 * with schedule occurrence keys and signal keys. Persistence is the host's,
 * behind `GoalStore`; an in-memory reference store ships here. No service,
 * timer or model call runs. Edge-safe.
 */
export type * from './types';
export { GoalError } from './errors';
export type { GoalErrorCode } from './errors';
export {
  GOAL_RECORD_VERSION,
  GOAL_EVENT_VERSION,
  GOAL_SEEN_LIMIT,
  parseGoal,
  serializeGoal,
  parseGoalEvent,
  serializeGoalEvent,
} from './validate';
export { assessGoal } from './acceptance';
export { createGoal, transitionGoal } from './transition';
export type { CreateGoalInput, GoalTransitionOptions } from './transition';
export {
  createGoalEvent,
  goalEventFromOccurrence,
  goalEventFromSignal,
  goalWakeupEvent,
  goalWakeupKey,
} from './events';
export type { GoalEventInput, GoalEventTarget } from './events';
export { createInMemoryGoalStore } from './store';
