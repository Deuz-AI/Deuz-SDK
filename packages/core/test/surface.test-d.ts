import { expectTypeOf } from 'vitest';
import { streamChat, createClient } from '../src/index';
import type {
  Part,
  Usage,
  FinishReason,
  CommonCallOptions,
  LanguageModel,
  Message,
  StreamChatResult,
} from '../src/index';

// `reasoning` part variant is present and carries `signature` (breaking-if-removed).
expectTypeOf<Extract<Part, { type: 'reasoning' }>>().toHaveProperty('signature');

// `signal` + `maxRetries` + sampling params are locked on the call surface.
expectTypeOf<CommonCallOptions>().toHaveProperty('signal');
expectTypeOf<CommonCallOptions>().toHaveProperty('maxRetries');
expectTypeOf<CommonCallOptions>().toHaveProperty('temperature');
expectTypeOf<CommonCallOptions>().toHaveProperty('effort');

// Usage carries the full cache/reasoning breakdown.
expectTypeOf<Usage>().toHaveProperty('reasoningTokens');
expectTypeOf<Usage>().toHaveProperty('cachedReadTokens');
expectTypeOf<Usage>().toHaveProperty('cacheWrite1hTokens');

// LanguageModel descriptor shape.
expectTypeOf<LanguageModel>().toHaveProperty('surface');
expectTypeOf<Message>().toHaveProperty('role');

// FinishReason union is exact.
expectTypeOf<FinishReason>().toEqualTypeOf<
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'aborted'
>();

// Free-function + client-method shapes.
expectTypeOf(streamChat).toBeFunction();
expectTypeOf(streamChat).returns.toEqualTypeOf<StreamChatResult>();

const client = createClient();
expectTypeOf(client.generateText).returns.resolves.toHaveProperty('text');

// --- 0.2.0 additive: effort accepts xhigh/max (input-union widening). ---
expectTypeOf<'xhigh'>().toExtend<NonNullable<CommonCallOptions['effort']>>();
expectTypeOf<'max'>().toExtend<NonNullable<CommonCallOptions['effort']>>();

// --- 0.2.0 additive: finish part carries optional providerMetadata. ---
import type { StreamPart } from '../src/index';
expectTypeOf<Extract<StreamPart, { type: 'finish' }>>().toHaveProperty('providerMetadata');

// --- 1.2.0 additive: providerOptions escape hatch + promptCaching. ---
expectTypeOf<CommonCallOptions>().toHaveProperty('providerOptions');
expectTypeOf<CommonCallOptions>().toHaveProperty('promptCaching');

// --- 1.3.0 additive: streamObject + DeepPartial. ---
import { streamObject } from '../src/index';
import type { DeepPartial, StreamObjectResult } from '../src/index';
expectTypeOf(streamObject).toBeFunction();
expectTypeOf<StreamObjectResult<{ a: string }>>().toHaveProperty('partialObjectStream');
expectTypeOf<StreamObjectResult<{ a: string }>>().toHaveProperty('object');
expectTypeOf<DeepPartial<{ a: { b: string }[] }>>().toEqualTypeOf<{
  a?: Array<{ b?: string }>;
}>();

// --- 1.3.0 additive: tool approval flow. ---
import type { GenerateTextResult, ToolApprovalRequest, ToolApprovalResponse } from '../src/index';
expectTypeOf<CommonCallOptions>().toHaveProperty('approveToolCall');
expectTypeOf<CommonCallOptions>().toHaveProperty('approvalResponses');
expectTypeOf<GenerateTextResult>().toHaveProperty('pendingApprovals');
expectTypeOf<Extract<StreamPart, { type: 'tool-approval-request' }>>().toHaveProperty('approvalId');
expectTypeOf<ToolApprovalRequest>().toHaveProperty('toolCallId');
expectTypeOf<ToolApprovalResponse>().toHaveProperty('approved');

// --- 1.3.0 additive: Tool.outputSchema metadata (MCP structured output). ---
import type { Tool } from '../src/index';
expectTypeOf<Tool>().toHaveProperty('outputSchema');

// --- 1.4.0 additive: loop hooks (prepareStep / activeTools / agentPath). ---
import type { PrepareStepResult } from '../src/index';
expectTypeOf<CommonCallOptions>().toHaveProperty('prepareStep');
expectTypeOf<CommonCallOptions>().toHaveProperty('activeTools');
expectTypeOf<CommonCallOptions>().toHaveProperty('agentPath');
expectTypeOf<PrepareStepResult>().toHaveProperty('activeTools');
expectTypeOf<PrepareStepResult>().toHaveProperty('model');

// --- 1.4.0 additive: budget stop conditions + stoppedBy metadata. ---
import { stepCountIs, totalTokensExceed, costExceeds } from '../src/index';
expectTypeOf(stepCountIs).toBeFunction();
expectTypeOf(totalTokensExceed).returns.toBeFunction();
expectTypeOf(costExceeds).returns.toBeFunction();
expectTypeOf<GenerateTextResult>().toHaveProperty('providerMetadata');

// --- 1.4.0 additive: compaction option + StreamPart. ---
import type { CompactionPolicy, CompactionOption } from '../src/index';
expectTypeOf<CommonCallOptions>().toHaveProperty('compaction');
expectTypeOf<CompactionPolicy>().toHaveProperty('threshold');
expectTypeOf<CompactionOption>().toEqualTypeOf<'auto' | CompactionPolicy>();
expectTypeOf<Extract<StreamPart, { type: 'compaction' }>>().toHaveProperty('layer');

// --- 1.5.0 additive: durable sessions (SessionStore/AgentCheckpoint/resume) + signed approvals. ---
import type { AgentCheckpoint, SessionStore, DurableSessionOptions } from '../src/index';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  createApprovalSigner,
  CheckpointNotFoundError,
} from '../src/durable';
expectTypeOf<CommonCallOptions>().toHaveProperty('session');
expectTypeOf<DurableSessionOptions>().toHaveProperty('store');
expectTypeOf<SessionStore>().toHaveProperty('save');
expectTypeOf<AgentCheckpoint>().toHaveProperty('runId');
expectTypeOf<AgentCheckpoint>().toHaveProperty('stepIndex');
expectTypeOf<AgentCheckpoint>().toHaveProperty('pendingApprovals');
expectTypeOf<GenerateTextResult>().toHaveProperty('runId');
expectTypeOf<StreamChatResult>().toHaveProperty('runId');
expectTypeOf<ToolApprovalRequest>().toHaveProperty('agentPath');
expectTypeOf<Extract<StreamPart, { type: 'tool-approval-request' }>>().toHaveProperty('agentPath');
expectTypeOf(createInMemorySessionStore).returns.toHaveProperty('save');
expectTypeOf(resumeFromCheckpoint).toBeFunction();
expectTypeOf(resumeStreamFromCheckpoint).toBeFunction();
expectTypeOf(serializeCheckpoint).returns.toBeString();
expectTypeOf(deserializeCheckpoint).returns.toHaveProperty('messages');
expectTypeOf(createApprovalSigner).returns.toHaveProperty('sign');
expectTypeOf<CheckpointNotFoundError>().toHaveProperty('runId');

// --- 1.6.0 additive: createClient parity (streamObject/embed/embedMany). ---
expectTypeOf(client.streamObject).toBeFunction();
expectTypeOf(client.streamObject<{ a: string }>).returns.toEqualTypeOf<
  StreamObjectResult<{ a: string }>
>();
expectTypeOf(client.embed).returns.resolves.toHaveProperty('embedding');
expectTypeOf(client.embedMany).returns.resolves.toHaveProperty('embeddings');

// --- 1.6.0 additive: durationExceeds stop condition + elapsedMs context. ---
// NOTE: imported from its module until the root export lands in src/index.ts
// (index/edge wiring is owned by the release integration).
import { durationExceeds } from '../src/inference/stop';
import type { StopCondition } from '../src/index';
expectTypeOf(durationExceeds).returns.toBeFunction();
expectTypeOf<Parameters<StopCondition>[0]>().toHaveProperty('elapsedMs');

// --- 1.6.0 additive: observation seam (Observer on Dependencies + event types on root). ---
// Full protocol pins live in test/observe-surface.test-d.ts; this block locks
// the root-surface facts: the seam exists, is optional, and stays OUT of the
// ResolvedDependencies Required set (absence = fast-path-off signal).
import type { Dependencies, ResolvedDependencies, Observer, ObserveEvent } from '../src/index';
expectTypeOf<Dependencies>().toHaveProperty('observer');
expectTypeOf<Dependencies['observer']>().toEqualTypeOf<Observer | undefined>();
expectTypeOf<ResolvedDependencies['observer']>().toEqualTypeOf<Observer | undefined>();
expectTypeOf<ObserveEvent['schemaVersion']>().toEqualTypeOf<1>();
// Tracer surface unchanged (api-contract lock — the 1.6 bridge must not touch it).
import type { Tracer, Span, SpanOptions } from '../src/index';
expectTypeOf<Tracer['startSpan']>().toBeFunction();
expectTypeOf<Span>().toHaveProperty('recordException');
expectTypeOf<SpanOptions>().toHaveProperty('parent');

// --- 1.6.1 additive: observation settlement on results. ---
expectTypeOf<GenerateTextResult['observation']>().toEqualTypeOf<
  { settled: Promise<void> } | undefined
>();
expectTypeOf<StreamChatResult['observation']>().toEqualTypeOf<
  { settled: Promise<void> } | undefined
>();

expectTypeOf<Dependencies['tracerMode']>().toEqualTypeOf<'hierarchical' | 'legacy' | undefined>();

// --- 1.7.0 additive: resumable UI wire v2 (./ui subpath surface). ---
import {
  DEUZ_STREAM_VERSION,
  negotiateDeuzStreamVersion,
  toDeuzStreamResponse,
  resumeDeuzStreamResponse,
  connectDeuzStream,
  createInMemoryStreamStateStore,
  type DeuzWireVersion,
  type StreamStateStore,
  type StreamStateRecord,
  type DeuzUIPart,
} from '../src/ui';
expectTypeOf<typeof DEUZ_STREAM_VERSION>().toEqualTypeOf<'v2'>();
expectTypeOf<DeuzWireVersion>().toEqualTypeOf<'v1' | 'v2'>();
expectTypeOf(negotiateDeuzStreamVersion).returns.toEqualTypeOf<DeuzWireVersion>();
expectTypeOf(toDeuzStreamResponse).returns.toEqualTypeOf<Response>();
expectTypeOf(resumeDeuzStreamResponse).returns.toEqualTypeOf<Response>();
expectTypeOf(connectDeuzStream).returns.toEqualTypeOf<AsyncGenerator<DeuzUIPart>>();
// The two-method seam stays two-method: append/read required, the rest optional.
expectTypeOf<StreamStateStore['append']>().toBeFunction();
expectTypeOf<StreamStateStore['read']>().returns.toEqualTypeOf<AsyncIterable<StreamStateRecord>>();
expectTypeOf<StreamStateStore['lastSeq']>().toEqualTypeOf<
  ((streamId: string) => number | undefined | Promise<number | undefined>) | undefined
>();
expectTypeOf(createInMemoryStreamStateStore).returns.toEqualTypeOf<Required<StreamStateStore>>();

// --- 1.7.0 additive: typed data parts + tool state machine + citations (P3). ---
import type { DataPart, CitationPart, ToolStatePart, ToolRunState } from '../src/index';
import { createDeuzStream, type DeuzStreamWriter } from '../src/ui';
expectTypeOf<DataPart>().toMatchTypeOf<{ type: 'data'; name: string; payload: unknown }>();
expectTypeOf<CitationPart['type']>().toEqualTypeOf<'citation'>();
expectTypeOf<CitationPart['chunkIndex']>().toEqualTypeOf<number | undefined>();
expectTypeOf<ToolStatePart['state']>().toEqualTypeOf<ToolRunState>();
expectTypeOf<ToolRunState>().toEqualTypeOf<
  'input-streaming' | 'input-complete' | 'awaiting-approval' | 'executing' | 'complete' | 'error'
>();
expectTypeOf(createDeuzStream).returns.toEqualTypeOf<DeuzStreamWriter>();
expectTypeOf<DeuzStreamWriter['writeData']>().toBeFunction();
// data-{name} rides the wire as a template-literal typed part.
expectTypeOf<
  Extract<import('../src/ui').DeuzUIPart, { payload: unknown }>['type']
>().toEqualTypeOf<`data-${string}`>();
