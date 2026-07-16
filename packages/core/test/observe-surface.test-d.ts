import { expectTypeOf } from 'vitest';
import type {
  ObserveEvent,
  ObserveEventBase,
  ObserveAttributes,
  ObserveAttributeValue,
  Observer,
  ObservationOptions,
  ObservationCaptureOptions,
  ObservationLimits,
  ObservationRedactor,
  ObservedError,
  ObservedSubsystem,
  RunStartedEvent,
  RunCompletedEvent,
  RunSuspendedEvent,
  ModelRetryEvent,
  ModelFirstContentEvent,
  StepCompletedEvent,
  ToolStartedEvent,
  ToolDeniedEvent,
  ApprovalResolvedEvent,
  CheckpointSavedEvent,
  CompactionObserveEvent,
  SubAgentStartedEvent,
  CostCalculatedEvent,
  Dependencies,
  CompactionLayer,
  Usage,
} from '../src/index';

// --- 1.6.0: Dependencies gained the observer seam (additive). ---
expectTypeOf<Dependencies>().toHaveProperty('observer');
expectTypeOf<NonNullable<Dependencies['observer']>>().toEqualTypeOf<Observer>();

// Observer.emit is synchronous (void, never a Promise).
expectTypeOf<ReturnType<Observer['emit']>>().toEqualTypeOf<void>();

// --- The event union is exhaustively switchable on `type` (compile-time lock). ---
// Adding a member without extending consumers breaks here via the `never` check.
function exhaustive(event: ObserveEvent): string {
  switch (event.type) {
    case 'run.started':
    case 'run.completed':
    case 'run.suspended':
    case 'run.aborted':
    case 'run.failed':
    case 'model.started':
    case 'model.first-content':
    case 'model.retry':
    case 'model.completed':
    case 'model.failed':
    case 'step.started':
    case 'step.completed':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied':
    case 'approval.requested':
    case 'approval.resolved':
    case 'checkpoint.saved':
    case 'checkpoint.loaded':
    case 'checkpoint.failed':
    case 'compaction':
    case 'compaction.skipped':
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.suspended':
    case 'subagent.failed':
    case 'cost.calculated':
    case 'operation.started':
    case 'operation.completed':
    case 'operation.failed':
      return event.type;
    default: {
      const never: never = event;
      return never;
    }
  }
}
expectTypeOf(exhaustive).returns.toEqualTypeOf<string>();

// --- Base identity fields. ---
expectTypeOf<ObserveEventBase>().toHaveProperty('schemaVersion');
expectTypeOf<ObserveEventBase['schemaVersion']>().toEqualTypeOf<1>();
expectTypeOf<ObserveEventBase>().toHaveProperty('runId');
expectTypeOf<ObserveEventBase>().toHaveProperty('executionId');
expectTypeOf<ObserveEventBase>().toHaveProperty('sequence');
expectTypeOf<ObserveEventBase>().toHaveProperty('spanId');

// --- Metadata accepts only flat primitives / primitive arrays. ---
const validMeta: ObserveAttributes = { app: 'deuz', version: 2, beta: true, tags: ['a', 'b'] };
void validMeta;
expectTypeOf<() => void>().not.toExtend<ObserveAttributeValue>();
expectTypeOf<{ nested: { deep: string } }>().not.toExtend<ObserveAttributeValue>();
expectTypeOf<bigint>().not.toExtend<ObserveAttributeValue>();
expectTypeOf<symbol>().not.toExtend<ObserveAttributeValue>();

// --- Field-name pins that mirror code reality (see 1.6.0.md §0). ---
// run.started has NO separate 'resume' operation — resumed flag instead.
expectTypeOf<RunStartedEvent['operation']>().toEqualTypeOf<
  'stream-chat' | 'generate-text' | 'generate-object' | 'stream-object' | 'embed' | 'embed-many'
>();
expectTypeOf<RunStartedEvent>().toHaveProperty('resumed');

// endReason surfaces the runaway guard; stoppedBy mirrors shouldStop.
expectTypeOf<RunCompletedEvent['endReason']>().toEqualTypeOf<
  'natural' | 'stop-condition' | 'max-steps' | 'runaway-tool-errors'
>();

// Suspension reasons are derived at break sites.
expectTypeOf<RunSuspendedEvent['reason']>().toEqualTypeOf<
  'approval' | 'client-tool' | 'sub-agent-approval'
>();

// Retry reasons exclude 'timeout' (TimeoutError is never retried).
expectTypeOf<ModelRetryEvent['reason']>().toEqualTypeOf<
  'network' | 'rate-limit' | 'overloaded' | 'server-error'
>();
expectTypeOf<'timeout'>().not.toExtend<ModelRetryEvent['reason']>();

// tool-call counts as first content (1.6 TTFT fix).
expectTypeOf<'tool-call'>().toExtend<ModelFirstContentEvent['contentType']>();

// Tool events: needsApproval (real field name), executionMode has NO 'provider'.
expectTypeOf<ToolStartedEvent>().toHaveProperty('needsApproval');
expectTypeOf<ToolStartedEvent['executionMode']>().toEqualTypeOf<'server' | 'client'>();

// Denial causes are synthesized — signature outcomes are not observable in-loop.
expectTypeOf<ToolDeniedEvent['cause']>().toEqualTypeOf<
  'server-denied' | 'response-denied' | 'no-response' | 'client-tool-no-result'
>();

// Approval verdicts are boolean + source (no decision-string enum exists in code).
expectTypeOf<ApprovalResolvedEvent>().toHaveProperty('approved');
expectTypeOf<ApprovalResolvedEvent['source']>().toEqualTypeOf<
  'server' | 'client-response' | 'default-deny'
>();

// Checkpoint events use the real stepIndex naming + status values.
expectTypeOf<CheckpointSavedEvent>().toHaveProperty('checkpointStepIndex');
expectTypeOf<CheckpointSavedEvent['checkpointStatus']>().toEqualTypeOf<
  'running' | 'suspended' | 'completed'
>();

// Compaction layers stay assignable to the public CompactionLayer union
// (observe.ts inlines the literals to avoid a type-import cycle).
expectTypeOf<CompactionObserveEvent['layer']>().toEqualTypeOf<CompactionLayer>();
expectTypeOf<CompactionObserveEvent['trigger']>().toEqualTypeOf<'threshold'>();

// Sub-agents: parent correlation, durable child key optional.
expectTypeOf<SubAgentStartedEvent>().toHaveProperty('parentToolCallId');
expectTypeOf<SubAgentStartedEvent['childRunId']>().toEqualTypeOf<string | undefined>();

// Cost arrives possibly after the terminal event.
expectTypeOf<CostCalculatedEvent['target']>().toEqualTypeOf<'model' | 'run'>();

// step.completed carries both per-step and cumulative usage.
expectTypeOf<StepCompletedEvent['usage']>().toEqualTypeOf<Usage>();
expectTypeOf<StepCompletedEvent['cumulativeUsage']>().toEqualTypeOf<Usage>();

// ObservedError: category union pins the DeuzError.code mapping surface.
expectTypeOf<ObservedError['category']>().toEqualTypeOf<
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'validation'
  | 'tool'
  | 'approval'
  | 'checkpoint'
  | 'aborted'
  | 'unknown'
>();

// Options/capture/limits/redactor exist and capture defaults are all optional booleans.
expectTypeOf<ObservationOptions>().toHaveProperty('sampleRate');
expectTypeOf<ObservationCaptureOptions['toolInputs']>().toEqualTypeOf<boolean | undefined>();
expectTypeOf<ObservationLimits>().toHaveProperty('maxEventBytes');
expectTypeOf<ObservationRedactor>().toBeFunction();
expectTypeOf<ObservedSubsystem>().toEqualTypeOf<
  'embedding' | 'image' | 'midjourney' | 'rag' | 'memory' | 'mcp' | 'skills'
>();
