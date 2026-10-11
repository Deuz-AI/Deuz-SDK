import { expectTypeOf } from 'vitest';
import type { AgentStream } from '../src/types/agent-run';
import type { StopDetails } from '../src/types/methods';
import type { ToolApprovalRequest, ToolCallOutcome } from '../src/types/tool';
import type { AssistantTurnState, UIMessagePart, UIToolCall } from '../src/chat';
import {
  agentStateFromParts,
  toDeuzAgentStreamResponse,
  type DeuzAgentClientCall,
  type DeuzAgentFrame,
  type DeuzAgentState,
  type DeuzAgentStatus,
  type DeuzUIPart,
  type ToDeuzAgentStreamOptions,
  type ToDeuzStreamOptions,
} from '../src/ui';

// The native bridge (2.3): a serializer over a native stream, a reducer over parts.
expectTypeOf(toDeuzAgentStreamResponse<{ answer: number }>)
  .parameter(0)
  .toEqualTypeOf<AgentStream<{ answer: number }>>();
expectTypeOf(toDeuzAgentStreamResponse).returns.toEqualTypeOf<Response>();
expectTypeOf<ToDeuzAgentStreamOptions>().toMatchTypeOf<ToDeuzStreamOptions>();
expectTypeOf<ToDeuzAgentStreamOptions['runId']>().toEqualTypeOf<string | undefined>();

// The typed final output exists only on a completed state, as `T`.
type State = DeuzAgentState<{ answer: number }>;
expectTypeOf(agentStateFromParts<{ answer: number }>).returns.toEqualTypeOf<State>();
expectTypeOf<Extract<State, { status: 'completed' }>['output']>().toEqualTypeOf<{
  answer: number;
}>();
expectTypeOf<Extract<State, { status: 'running' }>>().not.toHaveProperty('output');
expectTypeOf<Extract<State, { status: 'suspended' }>>().not.toHaveProperty('output');
expectTypeOf<Extract<State, { status: 'stopped' }>>().not.toHaveProperty('output');
// A draft is `unknown`, never `T`.
expectTypeOf<
  NonNullable<Extract<State, { status: 'running' }>['partial']>['value']
>().toEqualTypeOf<unknown>();
expectTypeOf<Extract<State, { status: 'suspended' }>['pendingApprovals']>().toEqualTypeOf<
  ToolApprovalRequest[]
>();
expectTypeOf<Extract<State, { status: 'suspended' }>['pendingClientCalls']>().toEqualTypeOf<
  DeuzAgentClientCall[]
>();
expectTypeOf<Extract<State, { status: 'stopped' }>['stopDetails']>().toEqualTypeOf<
  StopDetails | undefined
>();
expectTypeOf<DeuzAgentStatus>().toEqualTypeOf<
  'idle' | 'running' | 'completed' | 'suspended' | 'stopped' | 'failed'
>();
expectTypeOf<DeuzAgentFrame['kind']>().toEqualTypeOf<
  'run' | 'phase' | 'partial' | 'element' | 'result'
>();
expectTypeOf<DeuzAgentFrame['seq']>().toEqualTypeOf<number>();

// The frames ride the existing `data-${string}` member: no union is widened.
expectTypeOf<{ type: 'data-agent'; id: 'run'; payload: DeuzAgentFrame }>().toMatchTypeOf<
  Extract<DeuzUIPart, { type: `data-${string}` }>
>();

// Display fields (2.3): optional and additive.
expectTypeOf<Extract<DeuzUIPart, { type: 'finish' }>['stopDetails']>().toEqualTypeOf<
  StopDetails | undefined
>();
expectTypeOf<Extract<DeuzUIPart, { type: 'tool-result' }>['outcome']>().toEqualTypeOf<
  ToolCallOutcome | undefined
>();
expectTypeOf<UIToolCall['outcome']>().toEqualTypeOf<ToolCallOutcome | undefined>();
expectTypeOf<AssistantTurnState['stopDetails']>().toEqualTypeOf<StopDetails | undefined>();
expectTypeOf<AssistantTurnState['agent']>().toEqualTypeOf<DeuzAgentState | undefined>();

// A turn built before 2.3 (no `agent`, no `stopDetails`) still type-checks.
expectTypeOf<{
  message: AssistantTurnState['message'];
  approvals: AssistantTurnState['approvals'];
  serverResults: string[];
  dataParts: AssistantTurnState['dataParts'];
  citations: AssistantTurnState['citations'];
  activity: AssistantTurnState['activity'];
}>().toMatchTypeOf<AssistantTurnState>();

// A text's round-trip data (2.3, a Gemini text signature) rides the wire and the UI part.
expectTypeOf<Extract<DeuzUIPart, { type: 'text-delta' }>['providerMetadata']>().toEqualTypeOf<
  Record<string, unknown> | undefined
>();
expectTypeOf<Extract<UIMessagePart, { type: 'text' }>['providerMetadata']>().toEqualTypeOf<
  Record<string, unknown> | undefined
>();
