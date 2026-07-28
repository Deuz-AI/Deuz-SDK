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

// --- 1.7.0 additive: live cost part + budget guardrail (D2/D3). ---
import type { CostPart, BudgetExceededPart } from '../src/index';
import { durationExceeds as durationExceedsRoot } from '../src/index';
expectTypeOf<CostPart>().toMatchTypeOf<{ type: 'cost'; costUsd: number }>();
expectTypeOf<BudgetExceededPart['kind']>().toEqualTypeOf<'usd' | 'tokens'>();
expectTypeOf<CommonCallOptions['budget']>().toEqualTypeOf<
  { usd?: number; tokens?: number } | undefined
>();
expectTypeOf(durationExceedsRoot).returns.toBeFunction();
// PriceProvider.cacheSavings stays OPTIONAL (additive seam extension).
expectTypeOf<Dependencies['priceProvider']>().not.toBeNever();
expectTypeOf<
  NonNullable<NonNullable<Dependencies['priceProvider']>['cacheSavings']>
>().toBeFunction();

// --- 1.7.0 additive: chat engine + ChatStore (./chat subpath, P2+P6). ---
import {
  applyUIPart as chatApplyUIPart,
  branchBeforeUserMessage,
  createInMemoryChatStore,
  type AssistantTurnState,
  type ChatHistory,
  type ChatRecord,
  type ChatStore,
  type ChatPersistOptions,
  type UIMessage as ChatUIMessage,
} from '../src/chat';
expectTypeOf(chatApplyUIPart).returns.toEqualTypeOf<AssistantTurnState>();
expectTypeOf(branchBeforeUserMessage).returns.toEqualTypeOf<ChatHistory | undefined>();
expectTypeOf(createInMemoryChatStore).returns.toEqualTypeOf<Required<ChatStore>>();
// The seam stays two-method: saveChat/loadChat required, the rest optional.
expectTypeOf<ChatStore['saveChat']>().toBeFunction();
expectTypeOf<ChatStore['loadChat']>().toBeFunction();
expectTypeOf<ChatRecord['scope']>().not.toBeNever();
expectTypeOf<ChatUIMessage['role']>().toEqualTypeOf<'user' | 'assistant'>();
expectTypeOf<CommonCallOptions['chat']>().toEqualTypeOf<ChatPersistOptions | undefined>();
// MemoryScope gained chatId (additive).
import type { MemoryScope as ChatMemoryScope } from '../src/chat';
expectTypeOf<ChatMemoryScope['chatId']>().toEqualTypeOf<string | undefined>();

// --- 1.7.0 additive: built-in chat memory (D1). ---
import type { MemoryCallOptions, MemoryMutation } from '../src/memory';
expectTypeOf<CommonCallOptions['memory']>().toEqualTypeOf<MemoryCallOptions | undefined>();
expectTypeOf<GenerateTextResult['memory']>().toEqualTypeOf<Promise<MemoryMutation[]> | undefined>();
expectTypeOf<StreamChatResult['memory']>().toEqualTypeOf<Promise<MemoryMutation[]> | undefined>();

// --- 1.7.0 additive: durable × resumable endpoint (D5). ---
import { resumeDeuzChatResponse, type ResumeDeuzChatOptions } from '../src/durable';
expectTypeOf(resumeDeuzChatResponse).returns.toEqualTypeOf<Response>();
expectTypeOf<ResumeDeuzChatOptions['streamStateStore']>().not.toBeNever();
expectTypeOf<ResumeDeuzChatOptions['call']>().not.toBeNever();

// --- 1.7.0 additive: cross-provider fail-over + circuit breaker (D6). ---
import { withFallback, BreakerOpenError as BreakerOpenErrorRoot } from '../src/index';
import type { FallbackHooks } from '../src/index';
expectTypeOf(withFallback).parameters.toMatchTypeOf<
  [LanguageModel[], (FallbackHooks | undefined)?]
>();
expectTypeOf<CommonCallOptions['fallbackModels']>().toEqualTypeOf<LanguageModel[] | undefined>();
expectTypeOf<InstanceType<typeof BreakerOpenErrorRoot>['cooldownUntil']>().toEqualTypeOf<number>();

// --- 1.7.0 additive: signed approvals end-to-end (D4). ---

expectTypeOf<ToolApprovalRequest['token']>().toEqualTypeOf<string | undefined>();
expectTypeOf<ToolApprovalResponse['token']>().toEqualTypeOf<string | undefined>();
expectTypeOf<CommonCallOptions['approvalSigner']>().not.toBeNever();
expectTypeOf<CommonCallOptions['approvalMaxAgeMs']>().toEqualTypeOf<number | undefined>();

// --- 1.9.0 additive: verify part on the wire + readDeuzStream HTTP-error option. ---
import { readDeuzStream, type ReadDeuzStreamOptions } from '../src/ui';
// The `verify` verdict is a first-class wire part (v2-only at runtime).
expectTypeOf<Extract<DeuzUIPart, { type: 'verify' }>>().toEqualTypeOf<{
  type: 'verify';
  stepIndex: number;
  attempt: number;
  ok: boolean;
  willRetry: boolean;
  feedback?: string;
}>();
// The options bag is OPTIONAL — a 1-arg call stays valid (no breaking change).
expectTypeOf(readDeuzStream).parameters.toMatchTypeOf<
  [Response, (ReadDeuzStreamOptions | undefined)?]
>();
expectTypeOf<ReadDeuzStreamOptions['onHttpError']>().toEqualTypeOf<
  'error-part' | 'ignore' | undefined
>();
expectTypeOf(readDeuzStream).returns.toEqualTypeOf<AsyncGenerator<DeuzUIPart>>();

// --- 1.9.0 additive: finish/step-finish/verify fold into the chat turn. ---
// All four are OPTIONAL: `createAssistantTurn`'s object literal is unchanged.
expectTypeOf<AssistantTurnState['verifications']>().toEqualTypeOf<
  Array<Extract<DeuzUIPart, { type: 'verify' }>> | undefined
>();
expectTypeOf<AssistantTurnState['usage']>().toEqualTypeOf<Usage | undefined>();
expectTypeOf<AssistantTurnState['finishReason']>().toEqualTypeOf<FinishReason | undefined>();
expectTypeOf<AssistantTurnState['steps']>().toEqualTypeOf<
  Array<{ step: number; usage: Usage; finishReason: FinishReason }> | undefined
>();

// ===================================================================
// 1.9.0 Sprint 2 — ergonomics surface. ALL ADDITIVE: every pin below is a NEW
// member or a NEW export, so nothing above is weakened. The point of pinning
// them now is that they are the first-hour API (`prompt`, `instructions`,
// `tool()`, `timeout`) — silently changing their shape later would break the
// migration path this release exists to open.
// ===================================================================
import { tool, filePart, imagePart, getModelCapabilities, generateText } from '../src/index';
// `Tool` and `GenerateTextResult` are already imported above — reuse them.
import type {
  CallWarning,
  ModelCapabilities,
  ImagePart,
  InferToolInput,
  InferToolOutput,
} from '../src/index';

// --- Input shape: `prompt` / `instructions` are optional STRINGS, and
// `messages` stays REQUIRED on the interface (the either/or lives in the call
// functions' overloads — see below). ---
expectTypeOf<CommonCallOptions['prompt']>().toEqualTypeOf<string | undefined>();
expectTypeOf<CommonCallOptions['instructions']>().toEqualTypeOf<string | undefined>();
expectTypeOf<CommonCallOptions['messages']>().toEqualTypeOf<Message[]>();

// The `prompt` overload really accepts a call with NO `messages` key at all,
// on every one of the four entry points. This is the pin that would catch the
// overloads being dropped back to a single signature.
expectTypeOf(streamChat).toBeCallableWith({ model: {} as LanguageModel, prompt: 'hi' });
expectTypeOf(generateText).toBeCallableWith({ model: {} as LanguageModel, prompt: 'hi' });
expectTypeOf(streamChat).toBeCallableWith({
  model: {} as LanguageModel,
  prompt: 'hi',
  instructions: 'be terse',
});

// --- Cancellation alias: same type as `signal` (deprecated, `signal` wins). ---
expectTypeOf<CommonCallOptions['abortSignal']>().toEqualTypeOf<AbortSignal | undefined>();

// --- Timeout layers. The object form is INLINE on the interface (deliberately
// not a named export), so it is pinned structurally. ---
expectTypeOf<CommonCallOptions['timeout']>().toEqualTypeOf<
  number | { totalMs?: number; ttftMs?: number; stepMs?: number; toolMs?: number } | undefined
>();

// --- Per-call capability override + the public read accessor. ---
expectTypeOf<CommonCallOptions['capabilities']>().toEqualTypeOf<
  Partial<ModelCapabilities> | undefined
>();
expectTypeOf(getModelCapabilities).toBeCallableWith({} as LanguageModel);
expectTypeOf(getModelCapabilities).returns.toEqualTypeOf<Readonly<ModelCapabilities>>();
expectTypeOf<ModelCapabilities>().toHaveProperty('maxOutput');
expectTypeOf<ModelCapabilities>().toHaveProperty('contextWindow');
expectTypeOf<ModelCapabilities>().toHaveProperty('known');

// --- `tool()` is an IDENTITY helper whose result must still slot into a plain
// `ToolSet`. That assignability is the whole reason its return type is an
// intersection; if it regresses, `tools: { t }` stops compiling. ---
const pinnedTool = tool({
  description: 'pin',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  execute: async () => 42,
});
expectTypeOf(pinnedTool).toExtend<Tool>();
expectTypeOf<{ t: typeof pinnedTool }>().toExtend<Record<string, Tool>>();
// A raw JSON Schema carries no type-level payload: args degrade to `unknown`,
// NEVER `any` (an `any` here would silently disable checking in every handler).
expectTypeOf<InferToolInput<typeof pinnedTool>>().toEqualTypeOf<unknown>();
// `Awaited`, so a sync and an async tool report the SAME output type.
expectTypeOf<InferToolOutput<typeof pinnedTool>>().toEqualTypeOf<number>();
// Non-tools degrade instead of erroring.
expectTypeOf<InferToolInput<string>>().toEqualTypeOf<unknown>();
expectTypeOf<InferToolOutput<{ description: string }>>().toEqualTypeOf<unknown>();

// --- Per-tool execution cap. ---
expectTypeOf<Tool['timeoutMs']>().toEqualTypeOf<number | undefined>();

// --- Content-part constructors. `filePart` REQUIRES `mediaType` (there is no
// sane default for a document); `imagePart` does not. Both return the LOCKED
// `ImagePart` carrier — not a new Part kind (that is 2.0). ---
expectTypeOf(filePart).returns.toEqualTypeOf<ImagePart>();
expectTypeOf(imagePart).returns.toEqualTypeOf<ImagePart>();
expectTypeOf(filePart).toBeCallableWith({ data: 'x', mediaType: 'application/pdf' });
expectTypeOf(imagePart).toBeCallableWith({ data: new Uint8Array() });

// --- `consume()`: drains the lazy G2 pump so terminal effects run. Returns
// Promise<void> and is contractually NON-REJECTING (failures go to onError). ---
expectTypeOf<StreamChatResult['consume']>().toEqualTypeOf<
  ((options?: { onError?: (error: unknown) => void }) => Promise<void>) | undefined
>();
expectTypeOf<StreamObjectResult<{ a: string }>['consume']>().toEqualTypeOf<
  ((options?: { onError?: (error: unknown) => void }) => Promise<void>) | undefined
>();

// --- Warnings channel. The TYPES are locked here even though no collector
// populates them yet (Sprint 2 shipped the channel, not the emitters), so the
// shape cannot drift before the producers land. ---
expectTypeOf<CallWarning['type']>().toEqualTypeOf<
  'unsupported-setting' | 'clamped-setting' | 'unknown-model' | 'unsupported-tool' | 'other'
>();
expectTypeOf<CallWarning['message']>().toEqualTypeOf<string>();
expectTypeOf<CallWarning['setting']>().toEqualTypeOf<string | undefined>();
expectTypeOf<GenerateTextResult['warnings']>().toEqualTypeOf<CallWarning[] | undefined>();
expectTypeOf<StreamChatResult['warnings']>().toEqualTypeOf<Promise<CallWarning[]> | undefined>();
// `warning` is a member of the OPEN StreamPart union.
expectTypeOf<Extract<StreamPart, { type: 'warning' }>>().toEqualTypeOf<{
  type: 'warning';
  warning: CallWarning;
}>();

import { z } from 'zod';
import { generateObject } from '../src/index';
import type { StandardSchemaV1, InferSchemaOutput } from '../src/index';

// --- Standard Schema: a REAL zod schema must be structurally assignable. ---
// Regression pin. `StandardSchemaIssue.path` was `ReadonlyArray<PropertyKey>`,
// which made zod's FailureResult incompatible, so `generateObject({ schema:
// z.object(…) })` — the advertised typed path — did not typecheck at all.
// Nothing in core reads `path`; the fix is a type-only widening.
const zodObject = z.object({ city: z.string(), n: z.number().optional() });
expectTypeOf(zodObject).toMatchTypeOf<StandardSchemaV1<unknown, { city: string; n?: number }>>();
expectTypeOf<InferSchemaOutput<typeof zodObject>>().toMatchTypeOf<{ city: string }>();
// …and it is accepted by the structured-output entry points, not just the type.
expectTypeOf(generateObject<{ city: string; n?: number }>).toBeCallableWith({
  model: {} as LanguageModel,
  messages: [],
  schema: zodObject,
});

// ===================================================================
// 1.9.0 Sprint 3 — chat UI surface. ALL ADDITIVE. Two pins here are NEGATIVE
// (they assert a union did NOT gain a member) because the whole design of 3.7a
// rests on `UIToolCall.state` staying three literals: every consumer switches on
// it exhaustively, so denial had to arrive as optional FIELDS. A future edit that
// "tidies" denial into a 4th state must go red here, not in someone's app.
// ===================================================================
import {
  canonicalFromUI,
  sealAssistantTurn,
  userMessageFromInput,
  filesToImageParts,
  uiFromMessages,
  type UIMessagePart,
  type UIToolCall,
  type ChatInput,
} from '../src/chat';

// --- 3.1 ordered part projection. `parts` is OPTIONAL and absent until the
// first element exists, so `createAssistantTurn`'s literal is unchanged and a
// pre-1.9 / hand-built UIMessage stays assignable. ---
expectTypeOf<ChatUIMessage['parts']>().toEqualTypeOf<UIMessagePart[] | undefined>();
expectTypeOf<UIMessagePart['type']>().toEqualTypeOf<
  'text' | 'reasoning' | 'tool' | 'data' | 'citation' | 'step-start' | 'file'
>();
// A tool element is a REFERENCE into `toolCalls`, never a copy — two copies of a
// call whose state mutates over the turn would drift. Exact shape, so adding a
// denormalized field here goes red.
expectTypeOf<Extract<UIMessagePart, { type: 'tool' }>>().toEqualTypeOf<{
  type: 'tool';
  toolCallId: string;
}>();
expectTypeOf<Extract<UIMessagePart, { type: 'text' }>['state']>().toEqualTypeOf<
  'streaming' | 'done'
>();
expectTypeOf<Extract<UIMessagePart, { type: 'step-start' }>>().toEqualTypeOf<{
  type: 'step-start';
  step: number;
}>();
// `file` carries the canonical ImagePart.image VERBATIM (bytes stay bytes — the
// reducer must not base64-encode a buffer on a render path), plus a resolved
// mediaType and a `url` only when `data` is already a renderable src.
expectTypeOf<Extract<UIMessagePart, { type: 'file' }>['data']>().toEqualTypeOf<
  string | Uint8Array
>();
expectTypeOf<Extract<UIMessagePart, { type: 'file' }>['mediaType']>().toEqualTypeOf<string>();
expectTypeOf<Extract<UIMessagePart, { type: 'file' }>['url']>().toEqualTypeOf<string | undefined>();

// --- 3.7a denial, WITHOUT a 4th state literal. ---
expectTypeOf<UIToolCall['state']>().toEqualTypeOf<'call' | 'result' | 'approval-requested'>();
expectTypeOf<UIToolCall['denied']>().toEqualTypeOf<boolean | undefined>();
expectTypeOf<UIToolCall['deniedReason']>().toEqualTypeOf<string | undefined>();
expectTypeOf<UIToolCall['providerMetadata']>().toEqualTypeOf<Record<string, unknown> | undefined>();
// The sibling refusal in the same release: `ToolRunState` keeps SIX members.
expectTypeOf<ToolRunState>().not.toEqualTypeOf<
  | 'input-streaming'
  | 'input-complete'
  | 'awaiting-approval'
  | 'executing'
  | 'complete'
  | 'error'
  | 'denied'
>();
// Data-part entries gained an OPTIONAL id — `dataParts` is still a defaulted
// array, and an id-less write still typechecks.
expectTypeOf<AssistantTurnState['dataParts']>().toEqualTypeOf<
  Array<{ name: string; id?: string; payload: unknown }>
>();
expectTypeOf<Extract<UIMessagePart, { type: 'data' }>['id']>().toEqualTypeOf<string | undefined>();

// --- 3.2a inverse projection + the tail seal. ---
expectTypeOf(canonicalFromUI).parameters.toEqualTypeOf<[ChatUIMessage[]]>();
expectTypeOf(canonicalFromUI).returns.toEqualTypeOf<Message[]>();
expectTypeOf(sealAssistantTurn).returns.toEqualTypeOf<AssistantTurnState>();
// Round-trippable in the type system too: uiFromMessages ∘ canonicalFromUI.
expectTypeOf(uiFromMessages).returns.toEqualTypeOf<ChatUIMessage[]>();
expectTypeOf(canonicalFromUI).toBeCallableWith(uiFromMessages([], () => 'id'));

// --- 3.3a multimodal input primitives. `ChatInput` must keep accepting a bare
// string: `sendMessage(text)` is the 1.8 call every app already makes. ---
expectTypeOf<ChatInput>().toEqualTypeOf<string | { text?: string; parts?: Part[] }>();
expectTypeOf<string>().toExtend<ChatInput>();
expectTypeOf(userMessageFromInput).toBeCallableWith('hi');
expectTypeOf(userMessageFromInput).toBeCallableWith({ text: 'hi', parts: [] });
expectTypeOf(userMessageFromInput).returns.toEqualTypeOf<Message>();
expectTypeOf(filesToImageParts).returns.resolves.toEqualTypeOf<ImagePart[]>();

// --- 3.7b addressable + transient data parts on the wire. The options bag is
// the THIRD parameter and OPTIONAL, so every existing 2-arg writeData call
// stays valid — that is the non-breaking half of the change. ---
import type { WriteDataOptions } from '../src/ui';
expectTypeOf<WriteDataOptions>().toEqualTypeOf<{ id?: string; transient?: boolean }>();
expectTypeOf<DeuzStreamWriter['writeData']>().toEqualTypeOf<
  (name: string, payload: unknown, options?: WriteDataOptions) => void
>();
expectTypeOf<DeuzStreamWriter['writeData']>().toBeCallableWith('status', { n: 1 });
expectTypeOf<DeuzStreamWriter['writeData']>().toBeCallableWith('status', { n: 1 }, { id: 'a' });
// `data-{name}` now really produces the pre-seeded `id`.
expectTypeOf<Extract<DeuzUIPart, { type: `data-${string}` }>['id']>().toEqualTypeOf<
  string | undefined
>();
// Denial crosses the wire on the tool-state part, canonical AND UI side.
expectTypeOf<Extract<DeuzUIPart, { type: 'tool-state' }>>().toEqualTypeOf<{
  type: 'tool-state';
  toolCallId: string;
  toolName?: string;
  state: ToolRunState;
  denied?: boolean;
  deniedReason?: string;
}>();
expectTypeOf<ToolStatePart['denied']>().toEqualTypeOf<boolean | undefined>();
expectTypeOf<ToolStatePart['deniedReason']>().toEqualTypeOf<string | undefined>();

// --- Request validation (./chat subpath). A discriminated result, never a
// throw, and the options bag is optional so a 1-arg call is the happy path. ---
import {
  validateChatRequest,
  parseDeuzChatRequest,
  type DeuzChatRequest,
  type ValidateChatOptions,
  type ValidateChatResult,
} from '../src/chat';
expectTypeOf<ValidateChatResult>().toEqualTypeOf<
  { ok: true; request: DeuzChatRequest } | { ok: false; issues: string[] }
>();
expectTypeOf(validateChatRequest).toBeCallableWith({});
expectTypeOf(validateChatRequest).returns.toEqualTypeOf<ValidateChatResult>();
expectTypeOf(parseDeuzChatRequest).returns.toEqualTypeOf<DeuzChatRequest>();
expectTypeOf<DeuzChatRequest['messages']>().toEqualTypeOf<Message[]>();
// `rest` is deliberately `Record<string, unknown>` — UNVALIDATED passthrough, so
// the type refuses to let a caller spread it into typed call options.
expectTypeOf<DeuzChatRequest['rest']>().toEqualTypeOf<Record<string, unknown>>();
expectTypeOf<ValidateChatOptions>().toEqualTypeOf<{
  maxMessages?: number;
  maxTextBytes?: number;
  rejectSystemRole?: boolean;
  rejectToolResults?: boolean;
  rejectAssistantTurns?: boolean;
}>();

// --- The BARREL wiring, not just the modules. These pins exist because the
// re-export lines in `src/edge.ts` are the one part of this release with no
// other test: a dropped line breaks every edge consumer and nothing else fails.
// The api contract only locks ROOT exports, so it would not catch it either. ---
import {
  canonicalFromUI as edgeCanonicalFromUI,
  sealAssistantTurn as edgeSealAssistantTurn,
  userMessageFromInput as edgeUserMessageFromInput,
  filesToImageParts as edgeFilesToImageParts,
  validateChatRequest as edgeValidateChatRequest,
  parseDeuzChatRequest as edgeParseDeuzChatRequest,
  type UIMessagePart as EdgeUIMessagePart,
  type ChatInput as EdgeChatInput,
} from '../src/edge';
expectTypeOf(edgeCanonicalFromUI).toEqualTypeOf<typeof canonicalFromUI>();
expectTypeOf(edgeSealAssistantTurn).toEqualTypeOf<typeof sealAssistantTurn>();
expectTypeOf(edgeUserMessageFromInput).toEqualTypeOf<typeof userMessageFromInput>();
expectTypeOf(edgeFilesToImageParts).toEqualTypeOf<typeof filesToImageParts>();
expectTypeOf(edgeValidateChatRequest).toEqualTypeOf<typeof validateChatRequest>();
expectTypeOf(edgeParseDeuzChatRequest).toEqualTypeOf<typeof parseDeuzChatRequest>();
expectTypeOf<EdgeUIMessagePart>().toEqualTypeOf<UIMessagePart>();
expectTypeOf<EdgeChatInput>().toEqualTypeOf<ChatInput>();
