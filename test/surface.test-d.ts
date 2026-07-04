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
