/**
 * Frozen 2.3 consumer fixture (2.4, W0A), part 1: the 2.3 public API used the
 * way an application uses it. Calls pass the documented option shapes, results
 * are read into variables of their 2.3 types, and stream parts and events are
 * narrowed by their `type` the way a renderer does.
 *
 * What breaks this file is what would break a 2.3 consumer: a removed export or
 * subpath, a removed or renamed option, an option made required or narrowed, a
 * result field removed or given an incompatible type, a part or event variant
 * removed. A 2.x release may WIDEN a union (an event, part, warning or error
 * code a consumer reads), so no check here is an exhaustive switch over one; a
 * union is checked to still hold its 2.3 members.
 *
 * Imports point at the source file behind each public subpath (the tsup entry
 * map): `../../src/index` is `@deuz-sdk/core`, `../../src/agent` is
 * `@deuz-sdk/core/agent`, and so on. Part 2 (`consumer-2.3-implement.test-d.ts`)
 * covers the interfaces an application implements.
 */
import { describe, expectTypeOf, test } from 'vitest';
import { z } from 'zod';
// @deuz-sdk/core
import {
  streamChat,
  generateText,
  generateObject,
  streamObject,
  embed,
  embedMany,
  stepCountIs,
  hasToolCall,
  totalTokensExceed,
  costExceeds,
  durationExceeds,
  agentTool,
  handoff,
  promptInjectionGuardrail,
  maxOutputLength,
  maxToolResultLength,
  compactMessages,
  tool,
  filePart,
  imagePart,
  getModelCapabilities,
  resolveModelProfile,
  createClient,
  resolveDependencies,
  DeuzError,
  isDeuzError,
  APICallError,
  NetworkError,
  RateLimitError,
  OverloadedError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  ContextOverflowError,
  TimeoutError,
  AbortError,
  BreakerOpenError,
  NoObjectGeneratedError,
  ToolExecutionError,
  UnsupportedCapabilityError,
  McpAuthorizationRequiredError,
  UnpricedModelError,
  createPriceProvider,
  priceUsage,
  PRICES_2026,
  anthropicWebSearch,
  openaiWebSearch,
  googleSearch,
  wrapModel,
  logging,
  simpleCache,
  redactPII,
  promptInjectionGuard,
  withFallback,
} from '../../src/index';
import type {
  CallWarning,
  CommonCallOptions,
  DeuzErrorJSON,
  EmbeddingModel,
  FinishReason,
  GenerateObjectResult,
  GenerateTextResult,
  LanguageModel,
  Message,
  ModelCapabilities,
  Part,
  Role,
  StepResult,
  StopDetails,
  StreamChatResult,
  StreamObjectResult,
  StreamPart,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolCallOutcome,
  ToolChoice,
  ToolResult,
  ToolSet,
  Usage,
  ObserveEvent,
  ObservedSubsystem,
  JSONSchema,
} from '../../src/index';
// Provider subpaths
import { createAnthropic, anthropic } from '../../src/anthropic';
import {
  createOpenAI,
  createOpenAIResponses,
  createOpenAIEmbedding,
  openai,
} from '../../src/openai';
import { createGoogle, createGoogleNative, createGoogleEmbedding } from '../../src/google';
import { createGeminiCache, uploadFile } from '../../src/google-extras';
import { createXai } from '../../src/xai';
import { createAzure } from '../../src/azure';
import { createBedrock } from '../../src/bedrock';
import {
  createVertexAnthropic,
  createVertexGoogle,
  createVertexGoogleNative,
  createServiceAccountKeyProvider,
} from '../../src/vertex';
import { createAdcKeyProvider } from '../../src/node/vertex-auth';
import { createVoyage, createVoyageReranker } from '../../src/voyage';
import {
  createProviderRegistry,
  createOpenAICompatible,
  createGroq,
  createMistral,
  createDeepSeek,
  createTogether,
  createOpenRouter,
  createCerebras,
  createFireworks,
  createMoonshot,
  createKimi,
  createQwen,
  createGLM,
  createMiniMax,
  createPerplexity,
  createCohere,
  createDeepInfra,
  createNvidia,
  createSambaNova,
  createHyperbolic,
  createOllama,
  createLMStudio,
} from '../../src/providers';
import { createYunwu } from '../../src/yunwu';
// Media subpaths
import { createImageProvider, generateImage } from '../../src/image';
import { createOpenAISpeech, createElevenLabs, generateSpeech } from '../../src/speech';
import { createOpenAITranscription, createDeepgram, transcribe } from '../../src/transcription';
import { createVideoProvider, generateVideo, submitVideo } from '../../src/video';
import { createMidjourney, imagine } from '../../src/midjourney';
import { createRealtimeSession, createOpenAIRealtime } from '../../src/realtime/index';
// Agent and run subpaths
import {
  createAgent,
  runAgent,
  streamAgent,
  resumeAgent,
  resumeStreamAgent,
  reconcileAgentRun,
  createInMemoryAgentRunStore,
  createExecutionContext,
  createBudgetLedger,
  createInMemoryBudgetStore,
  ExecutionPolicyError,
  BudgetLedgerError,
  BudgetStoreError,
  ExecutionPersistenceError,
} from '../../src/agent';
import type {
  AgentEvent,
  AgentResult,
  AgentRunEnvelope,
  AgentStream,
  AgentToolSet,
} from '../../src/agent';
import { agentRunLeaseKey, findStaleAgentRuns, createInMemoryLeaseProvider } from '../../src/ops';
import { createSwarm, createInMemorySwarmStore, createRounds } from '../../src/swarm';
import { evolve, createInMemoryPopulationStore } from '../../src/evolve';
import { createScheduler, parseCron, nextOccurrence, handleSignal } from '../../src/schedule';
import {
  createGoal,
  transitionGoal,
  createGoalEvent,
  createInMemoryGoalStore,
  parseGoal,
  serializeGoal,
  GoalError,
} from '../../src/goal/index';
import type { GoalErrorCode, GoalStatus } from '../../src/goal/index';
import { bestOfN, selfConsistency, parallelAgents } from '../../src/autonomy';
import {
  createInMemoryRunStore,
  createRunManager,
  emitPlanUpdate,
  emitActivity,
} from '../../src/runtime';
import { createFileRunStore } from '../../src/node/runtime';
import { createBrowserTools } from '../../src/browser';
import { createPlaywrightBrowser } from '../../src/node/browser';
import { createA2AHandler, createA2AClient, a2aText } from '../../src/a2a/index';
import { createBatchClient, createMemoryBatchJobStore } from '../../src/batch/index';
import { runHeadless, inspectRun, doctor } from '../../src/node/headless';
// Persistence, chat and UI subpaths
import {
  createInMemorySessionStore,
  serializeCheckpoint,
  deserializeCheckpoint,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
  resumeDeuzChatResponse,
  createApprovalSigner,
  CheckpointNotFoundError,
  CheckpointVersionError,
} from '../../src/durable';
import type { AgentCheckpoint } from '../../src/index';
import {
  uiFromMessages,
  canonicalFromUI,
  parseDeuzChatRequest,
  validateChatRequest,
  createAssistantTurn,
  applyUIPart,
  sealAssistantTurn,
  assistantMessageFromTurn,
  serializeChatRecord,
  deserializeChatRecord,
  createInMemoryChatStore,
  userMessageFromInput,
} from '../../src/chat';
import type { ChatRecord, UIMessage, UIMessagePart } from '../../src/chat';
import { createJsonlChatStore } from '../../src/node/chat-store';
import {
  createDeuzStream,
  toDeuzStreamResponse,
  toDeuzTextStreamResponse,
  toDeuzObjectStreamResponse,
  toDeuzAgentStreamResponse,
  readDeuzStream,
  connectDeuzStream,
  negotiateDeuzStreamVersion,
  createInMemoryStreamStateStore,
  DEUZ_STREAM_VERSION,
} from '../../src/ui';
import type { DeuzUIPart } from '../../src/ui';
import { useChat, useObject } from '../../src/react';
import {
  remember,
  recall,
  createMemoryTools,
  createInMemoryMemoryStore,
  createEmbedder,
} from '../../src/memory';
import type { MemoryCallOptions } from '../../src/memory';
import { createMarkdownMemoryStore } from '../../src/memory-markdown';
import { createSqliteStores } from '../../src/node/store-sqlite';
import { createPostgresStores } from '../../src/node/store-postgres';
import { createRedisStores } from '../../src/node/store-redis';
import { createSqliteOpsStore } from '../../src/node/ops-sqlite';
import { createPostgresOpsStore } from '../../src/node/ops-postgres';
import { createRedisOpsStore } from '../../src/node/ops-redis';
import { createSqliteSwarmStore } from '../../src/node/swarm-sqlite';
import { createPostgresSwarmStore } from '../../src/node/swarm-postgres';
import { createRedisSwarmStore } from '../../src/node/swarm-redis';
import { createSqlitePopulationStore } from '../../src/node/evolve-sqlite';
// Tools, retrieval and integration subpaths
import { createMcpClient, createMcpPool } from '../../src/mcp/index';
import { createStdioMcpClient } from '../../src/mcp/stdio';
import { createFileTokenStore } from '../../src/node/mcp';
import { createMcpServer } from '../../src/mcp/server';
import { serveMcpStdio } from '../../src/node/mcp-server';
import { retrieve, chunkRecursive, createMemoryVectorStore, hybridRetrieve } from '../../src/rag';
import { defaultNodeParserRegistry } from '../../src/rag-node';
import { parseSkill, createSkillRegistry } from '../../src/skills';
import { nodeSkillSource } from '../../src/skills/node';
import { codeActTool, shellTool } from '../../src/compute';
import { createNodeSandbox } from '../../src/node/compute';
import { createInMemoryWorkspace, createWorkspaceTools } from '../../src/workspace';
import { createFileWorkspace } from '../../src/node/workspace';
import { createPriceProvider as createPriceProviderSubpath } from '../../src/pricing';
import { wrapModel as wrapModelSubpath } from '../../src/middleware';
import { maxOutputLength as maxOutputLengthSubpath } from '../../src/guardrails';
import { createCallbackObserver, createMemoryObserver, composeObservers } from '../../src/observe';
import { createJsonlObserver } from '../../src/node/observe';
import { createOtelObserver, createOtelTracer } from '../../src/otel';
import { createMockModel, mockFetch, runEval } from '../../src/testing';
import * as edge from '../../src/edge';

declare const model: LanguageModel;
declare const embeddingModel: EmbeddingModel;
declare const messages: Message[];
declare const response: Response;

const weatherParameters: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

describe('the call surface (@deuz-sdk/core)', () => {
  test('generateText with the documented 2.3 options', async () => {
    const tools: ToolSet = {
      weather: tool({
        description: 'Weather for a city.',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, tempC: 21 }),
      }),
      search: {
        description: 'Search.',
        parameters: weatherParameters,
        needsApproval: true,
        timeoutMs: 5_000,
      },
    };
    const options: CommonCallOptions = {
      model,
      messages,
      instructions: 'Be brief.',
      signal: new AbortController().signal,
      abortSignal: new AbortController().signal,
      maxRetries: 2,
      timeout: { totalMs: 60_000, ttftMs: 10_000, stepMs: 30_000, toolMs: 10_000, chunkMs: 5_000 },
      headers: { 'x-trace': '1' },
      deps: { generateId: () => 'id' },
      onUsage: (usage, meta) => {
        expectTypeOf(usage).toEqualTypeOf<Usage>();
        expectTypeOf(meta.model).toBeString();
      },
      onFinish: (meta) => expectTypeOf(meta.finishReason).toEqualTypeOf<FinishReason>(),
      temperature: 0.2,
      maxOutputTokens: 1_024,
      topP: 0.9,
      stopSequences: ['END'],
      effort: 'high',
      responseFormat: 'text',
      providerOptions: { anthropic: { metadata: { user_id: 'u' } }, openai: { user: 'u' } },
      promptCaching: 'auto',
      capabilities: { contextWindow: 200_000, tools: true },
      tools,
      toolChoice: { type: 'tool', toolName: 'weather' },
      maxSteps: 5,
      stopWhen: [stepCountIs(5), hasToolCall('search'), totalTokensExceed(10_000)],
      budget: { usd: 1, tokens: 100_000, unknownPrice: 'warn' },
      maxToolConcurrency: 2,
      onStepFinish: (step) => expectTypeOf(step).toEqualTypeOf<StepResult>(),
      prepareStep: ({ stepIndex, messages: history }) =>
        stepIndex > 2
          ? { messages: history, activeTools: ['weather'], toolChoice: 'auto' }
          : undefined,
      activeTools: ['weather', 'search'],
      verifyStep: async ({ text }) => ({ ok: text.length > 0, feedback: 'again', retry: true }),
      maxVerifyAttempts: 2,
      doneWhen: ({ text }) => text.includes('done'),
      falseFinishGuard: { maxRetries: 1 },
      agentPath: ['root'],
      compaction: {
        threshold: 0.9,
        keepRecentSteps: 4,
        layers: ['prune-tool-results', 'summarize'],
      },
      approveToolCall: async (call) => call.toolName !== 'search',
      approvalResponses: [{ approvalId: 'a', approved: true, reason: 'ok' }],
      fallbackModels: [model],
      approvalMaxAgeMs: 60_000,
      mcp: [
        { url: 'https://mcp.example/mcp', type: 'http', headers: {}, namespace: 'docs' },
        { command: 'node', args: ['server.js'], env: {}, namespace: 'local' },
      ],
      onCatalogChange: 'accept',
      runtimeContext: { tenant: 't' },
      guardrails: {
        onInput: promptInjectionGuardrail(),
        onOutput: [maxOutputLength(10_000, { mode: 'truncate' })],
        onToolResult: maxToolResultLength(5_000),
      },
    };
    const result = await generateText(options);
    const text: string = result.text;
    const usage: Usage = result.usage;
    const finishReason: FinishReason = result.finishReason;
    const responseMessages: Message[] = result.response.messages;
    const steps: StepResult[] | undefined = result.steps;
    const toolCalls: ToolCall[] | undefined = result.toolCalls;
    const toolResults: ToolResult[] | undefined = result.toolResults;
    const pending: ToolApprovalRequest[] | undefined = result.pendingApprovals;
    const stopDetails: StopDetails | undefined = result.stopDetails;
    const warnings: CallWarning[] | undefined = result.warnings;
    const runId: string | undefined = result.runId;
    expectTypeOf([text, usage, finishReason, responseMessages, steps, toolCalls]).toBeArray();
    expectTypeOf([toolResults, pending, stopDetails, warnings, runId]).toBeArray();
    expectTypeOf(result.providerMetadata).toEqualTypeOf<
      Record<string, Record<string, unknown>> | undefined
    >();
    expectTypeOf(result).toExtend<GenerateTextResult>();
  });

  test('the prompt shorthand and the streaming call', async () => {
    expectTypeOf(
      generateText({ model, prompt: 'hi', instructions: 'brief' }),
    ).resolves.toHaveProperty('text');
    const stream: StreamChatResult = streamChat({ model, prompt: 'hi' });
    expectTypeOf(stream.textStream).toEqualTypeOf<AsyncIterable<string>>();
    expectTypeOf(stream.fullStream).toEqualTypeOf<AsyncIterable<StreamPart>>();
    expectTypeOf(stream.usage).toEqualTypeOf<Promise<Usage>>();
    expectTypeOf(stream.finishReason).toEqualTypeOf<Promise<FinishReason>>();
    const warnings: Promise<CallWarning[]> | undefined = stream.warnings;
    const details: Promise<StopDetails | undefined> | undefined = stream.stopDetails;
    expectTypeOf([warnings, details]).toBeArray();
    await stream.consume?.({ onError: (error) => expectTypeOf(error).toBeUnknown() });
    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta') expectTypeOf(part.text).toBeString();
      else if (part.type === 'tool-call') expectTypeOf(part.toolName).toBeString();
    }
  });

  test('structured output', async () => {
    const schema = z.object({ city: z.string(), tempC: z.number() });
    const typed = await generateObject({
      model,
      prompt: 'weather',
      schema,
      schemaName: 'w',
      mode: 'json',
    });
    expectTypeOf(typed.object).toEqualTypeOf<{ city: string; tempC: number }>();
    expectTypeOf(typed).toExtend<GenerateObjectResult<{ city: string; tempC: number }>>();
    const loose = await generateObject({
      model,
      messages,
      schema: weatherParameters,
      schemaDescription: 'weather',
      mode: 'tool',
    });
    expectTypeOf(loose.object).toBeUnknown();
    const streamed: StreamObjectResult<{ city: string; tempC: number }> = streamObject({
      model,
      prompt: 'weather',
      schema,
    });
    for await (const partial of streamed.partialObjectStream) {
      expectTypeOf(partial.city).toEqualTypeOf<string | undefined>();
    }
    expectTypeOf(streamed.object).resolves.toEqualTypeOf<{ city: string; tempC: number }>();
  });

  test('embeddings', async () => {
    const one = await embed({
      model: embeddingModel,
      value: 'q',
      dimensions: 256,
      taskType: 'search_query',
      title: 't',
      normalize: true,
      maxRetries: 1,
      headers: {},
    });
    expectTypeOf(one.embedding).toEqualTypeOf<number[]>();
    expectTypeOf(one.usage).toEqualTypeOf<Usage>();
    const many = await embedMany({
      model: embeddingModel,
      values: ['a', 'b'],
      maxBatchSize: 64,
      maxConcurrency: 2,
      taskType: 'search_document',
    });
    expectTypeOf(many.embeddings).toEqualTypeOf<number[][]>();
  });

  test('loop helpers, sub-agents, compaction and parts', async () => {
    expectTypeOf(costExceeds(1)).toBeFunction();
    expectTypeOf(durationExceeds(60_000)).toBeFunction();
    const sub = agentTool({ name: 'researcher', description: 'Research.', model, maxSteps: 4 });
    const transfers = handoff({ billing: { model, instructions: 'Billing.' } }, { maxHandoffs: 2 });
    expectTypeOf(sub).toHaveProperty('parameters');
    expectTypeOf(transfers).toExtend<ToolSet>();
    const compacted = await compactMessages(messages, { keepRecentSteps: 2 });
    expectTypeOf(compacted.messages).toEqualTypeOf<Message[]>();
    const file: Part = filePart({ data: new Uint8Array(), mediaType: 'application/pdf' });
    const image: Part = imagePart({ data: 'https://example.test/a.png' });
    expectTypeOf([file, image]).toBeArray();
  });

  test('capabilities, profiles, the client and pricing', () => {
    const caps: ModelCapabilities = getModelCapabilities(model);
    expectTypeOf(caps.contextWindow).toBeNumber();
    expectTypeOf(caps.tools).toBeBoolean();
    expectTypeOf(resolveModelProfile(model)).toHaveProperty('limits');
    const client = createClient({
      apiKeys: { anthropic: 'k', openai: 'k', custom: 'k' },
      baseUrls: { custom: 'https://x' },
      deps: {},
    });
    expectTypeOf(client.generateText({ model, prompt: 'hi' })).resolves.toHaveProperty('text');
    expectTypeOf(client.streamChat({ model, messages })).toHaveProperty('fullStream');
    expectTypeOf(client.embed).toBeFunction();
    expectTypeOf(resolveDependencies({})).toHaveProperty('clock');
    const prices = createPriceProvider({ table: PRICES_2026 });
    expectTypeOf(prices.priceUsage).toBeFunction();
    expectTypeOf(priceUsage).toBeFunction();
    expectTypeOf(anthropicWebSearch({ max_uses: 3 })).toHaveProperty('parameters');
    expectTypeOf(openaiWebSearch()).toHaveProperty('parameters');
    expectTypeOf(googleSearch()).toHaveProperty('parameters');
  });

  test('middleware', () => {
    const wrapped = wrapModel(model, [
      logging({ label: 'x' }),
      simpleCache({ ttlMs: 1_000 }),
      redactPII(),
      promptInjectionGuard(),
      withFallback([model]),
    ]);
    expectTypeOf(wrapped.generateText({ prompt: 'hi' })).resolves.toHaveProperty('text');
  });
});

describe('errors a consumer catches', () => {
  test('the error classes and their fields', () => {
    const error: unknown = new Error('x');
    if (isDeuzError(error)) {
      expectTypeOf(error.code).toBeString();
      expectTypeOf(error.toJSON()).toEqualTypeOf<DeuzErrorJSON>();
    }
    if (error instanceof APICallError) {
      const status: number = error.statusCode;
      const retryable: boolean = error.isRetryable;
      const after: number | undefined = error.retryAfterMs;
      const provider: string | undefined = error.provider;
      const requestId: string | undefined = error.requestId;
      expectTypeOf([status, retryable, after, provider, requestId]).toBeArray();
    }
    for (const subclass of [
      NetworkError,
      RateLimitError,
      OverloadedError,
      AuthenticationError,
      InvalidRequestError,
      ModelNotFoundError,
      ContextOverflowError,
    ]) {
      expectTypeOf(new subclass({ message: 'x' })).toExtend<APICallError>();
    }
    expectTypeOf(new TimeoutError('total').layer).toExtend<string>();
    expectTypeOf<AbortError>().toExtend<DeuzError>();
    expectTypeOf<BreakerOpenError['cooldownUntil']>().toBeNumber();
    expectTypeOf<NoObjectGeneratedError['text']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolExecutionError['toolName']>().toBeString();
    expectTypeOf<UnsupportedCapabilityError['capability']>().toBeString();
    expectTypeOf<McpAuthorizationRequiredError['serverUrl']>().toBeString();
    expectTypeOf<UnpricedModelError>().toExtend<Error>();
    expectTypeOf<ExecutionPolicyError>().toExtend<Error>();
    expectTypeOf<BudgetLedgerError>().toExtend<Error>();
    expectTypeOf<BudgetStoreError>().toExtend<Error>();
    expectTypeOf<ExecutionPersistenceError>().toExtend<Error>();
    expectTypeOf<CheckpointNotFoundError>().toExtend<Error>();
    expectTypeOf<CheckpointVersionError>().toExtend<Error>();
    expectTypeOf<GoalError['code']>().toEqualTypeOf<GoalErrorCode>();
  });
});

describe('messages, parts and unions a consumer reads (2.3 members still present)', () => {
  test('messages and content parts', () => {
    const history: Message[] = [
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi', providerMetadata: {} },
          { type: 'image', image: new Uint8Array(), mediaType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '',
            signature: 's',
            encrypted: false,
            redacted: false,
            source: 'anthropic',
          },
          { type: 'tool_use', id: 't1', name: 'weather', input: {}, providerMetadata: {} },
        ],
        providerMetadata: { openai: { phase: 'final' } },
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', result: 'ok', isError: false }],
      },
    ];
    expectTypeOf(history).toEqualTypeOf<Message[]>();
    expectTypeOf<'system' | 'user' | 'assistant' | 'tool'>().toExtend<Role>();
  });

  test('stream parts keep their 2.3 variants and fields', () => {
    type P<T extends StreamPart['type']> = Extract<StreamPart, { type: T }>;
    expectTypeOf<P<'text-delta'>['text']>().toBeString();
    expectTypeOf<P<'reasoning-delta'>['text']>().toBeString();
    expectTypeOf<P<'tool-call-delta'>['argsTextDelta']>().toBeString();
    expectTypeOf<P<'source'>['id']>().toBeString();
    expectTypeOf<P<'finish'>['usage']>().toEqualTypeOf<Usage>();
    expectTypeOf<P<'finish'>['finishReason']>().toEqualTypeOf<FinishReason>();
    expectTypeOf<P<'error'>['error']>().toBeUnknown();
    expectTypeOf<P<'step-start'>['stepIndex']>().toBeNumber();
    expectTypeOf<P<'step-finish'>['usage']>().toEqualTypeOf<Usage>();
    expectTypeOf<P<'tool-call'>['toolCallId']>().toBeString();
    expectTypeOf<P<'tool-call'>['input']>().toBeUnknown();
    expectTypeOf<P<'tool-result'>['output']>().toBeUnknown();
    expectTypeOf<P<'tool-approval-request'>['approvalId']>().toBeString();
    expectTypeOf<P<'compaction'>['tokensAfter']>().toBeNumber();
    expectTypeOf<P<'sub-agent'>['part']>().toEqualTypeOf<StreamPart>();
    expectTypeOf<P<'data'>['payload']>().toBeUnknown();
    expectTypeOf<P<'citation'>['id']>().toBeString();
    expectTypeOf<P<'tool-state'>['toolCallId']>().toBeString();
    expectTypeOf<P<'cost'>['costUsd']>().toBeNumber();
    expectTypeOf<P<'budget-exceeded'>['limit']>().toBeNumber();
    expectTypeOf<P<'verify'>['ok']>().toBeBoolean();
    expectTypeOf<P<'false-finish'>['willRetry']>().toBeBoolean();
    expectTypeOf<P<'plan-update'>['tasks']>().toBeArray();
    expectTypeOf<P<'activity'>['message']>().toBeString();
    expectTypeOf<P<'warning'>['warning']>().toEqualTypeOf<CallWarning>();
    expectTypeOf<P<'handoff'>['to']>().toBeString();
    expectTypeOf<P<'guardrail'>['action']>().toExtend<string>();
  });

  test('unions keep their 2.3 members', () => {
    expectTypeOf<
      'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'aborted'
    >().toExtend<FinishReason>();
    expectTypeOf<
      | 'unsupported-setting'
      | 'clamped-setting'
      | 'unknown-model'
      | 'unsupported-tool'
      | 'unpriced-model'
      | 'other'
    >().toExtend<CallWarning['type']>();
    expectTypeOf<
      | 'success'
      | 'tool-error'
      | 'permission-denied'
      | 'approval-denied'
      | 'approval-pending'
      | 'unknown-effect'
    >().toExtend<ToolCallOutcome>();
    expectTypeOf<
      'auto' | 'required' | 'none' | { type: 'tool'; toolName: string }
    >().toExtend<ToolChoice>();
    expectTypeOf<'completed' | 'suspended' | 'stopped' | 'failed'>().toExtend<
      AgentResult['status']
    >();
    expectTypeOf<
      'part' | 'phase' | 'partial-output' | 'array-element' | 'tool-output' | 'result'
    >().toExtend<AgentEvent['type']>();
    expectTypeOf<
      | 'invalid_goal'
      | 'invalid_event'
      | 'invalid_command'
      | 'unsupported_version'
      | 'revision_conflict'
      | 'scope_mismatch'
    >().toExtend<GoalErrorCode>();
    expectTypeOf<
      'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
    >().toExtend<GoalStatus>();
    expectTypeOf<
      | 'embedding'
      | 'image'
      | 'midjourney'
      | 'rag'
      | 'memory'
      | 'mcp'
      | 'skills'
      | 'speech'
      | 'transcription'
      | 'video'
    >().toExtend<ObservedSubsystem>();
    expectTypeOf<
      | 'run.started'
      | 'run.completed'
      | 'run.suspended'
      | 'run.aborted'
      | 'run.failed'
      | 'model.started'
      | 'model.completed'
      | 'model.failed'
      | 'step.started'
      | 'step.completed'
      | 'tool.started'
      | 'tool.completed'
      | 'tool.failed'
      | 'tool.denied'
      | 'approval.requested'
      | 'approval.resolved'
      | 'checkpoint.saved'
      | 'checkpoint.loaded'
      | 'checkpoint.failed'
      | 'compaction'
      | 'subagent.started'
      | 'subagent.completed'
      | 'cost.calculated'
      | 'operation.started'
      | 'operation.completed'
      | 'operation.failed'
    >().toExtend<ObserveEvent['type']>();
    expectTypeOf<
      Extract<ObserveEvent, { type: 'run.completed' }>['usage']
    >().toEqualTypeOf<Usage>();
    expectTypeOf<ObserveEvent['runId']>().toBeString();
  });
});

describe('providers (@deuz-sdk/core/<provider>)', () => {
  test('every 2.3 provider factory and its settings', () => {
    const settings = { apiKey: 'k', baseURL: 'https://x', fetch: globalThis.fetch, headers: {} };
    const models: LanguageModel[] = [
      anthropic('claude-sonnet-4-5'),
      createAnthropic(settings)('claude-opus-5-5'),
      openai('gpt-5.5'),
      createOpenAI(settings)('gpt-5.5'),
      createOpenAIResponses(settings)('gpt-5.4'),
      createGoogle({ ...settings, surface: 'native' })('gemini-2.5-flash'),
      createGoogleNative(settings)('gemini-2.5-flash'),
      createXai(settings)('grok-4.3'),
      createAzure({
        ...settings,
        resourceName: 'r',
        apiVersion: '2024-12-01-preview',
        auth: 'bearer',
      })('d'),
      createBedrock({ ...settings, region: 'us-west-2' })('openai.gpt-oss-120b'),
      createVertexAnthropic({ project: 'p', location: 'us-east5', accessToken: 't' })(
        'claude-sonnet-4-5',
      ),
      createVertexGoogle({ project: 'p', location: 'global', headers: {} })(
        'google/gemini-2.5-flash',
      ),
      createVertexGoogleNative({ project: 'p', location: 'global' })('gemini-2.5-flash'),
      createOpenAICompatible({
        ...settings,
        id: 'gateway',
        surface: 'chat_completions',
        authHeader: 'api-key',
        apiKeyOptional: true,
        capabilities: { tools: true },
      })('m'),
      ...[
        createGroq,
        createMistral,
        createDeepSeek,
        createTogether,
        createOpenRouter,
        createCerebras,
        createFireworks,
        createMoonshot,
        createKimi,
        createQwen,
        createGLM,
        createMiniMax,
        createPerplexity,
        createCohere,
        createDeepInfra,
        createNvidia,
        createSambaNova,
        createHyperbolic,
        createOllama,
        createLMStudio,
      ].map((factory) => factory({ ...settings, capabilities: { maxOutput: 4_096 } })('m')),
      createYunwu({ apiKey: 'k' }).chat('gpt-5.2'),
    ];
    expectTypeOf(models[0]!.provider).toBeString();
    expectTypeOf(models[0]!.modelId).toBeString();
    expectTypeOf(models[0]!.surface).toExtend<string>();
    const embeddings: EmbeddingModel[] = [
      createOpenAIEmbedding(settings)('text-embedding-3-small'),
      createGoogleEmbedding(settings)('gemini-embedding-001'),
      createVoyage(settings)('voyage-3.5'),
    ];
    expectTypeOf(embeddings).toBeArray();
    const registry = createProviderRegistry({ anthropic: createAnthropic(settings) });
    expectTypeOf(registry.model('anthropic:claude-sonnet-4-5')).toEqualTypeOf<LanguageModel>();
    expectTypeOf(registry.providers).toEqualTypeOf<readonly string[]>();
    expectTypeOf(createVoyageReranker({ apiKey: 'k', topK: 3 })).toHaveProperty('rerank');
    expectTypeOf(createServiceAccountKeyProvider).toBeFunction();
    expectTypeOf(createAdcKeyProvider).toBeFunction();
    expectTypeOf(createGeminiCache).toBeFunction();
    expectTypeOf(uploadFile).toBeFunction();
  });

  test('media providers', () => {
    expectTypeOf(
      generateImage({
        model: createImageProvider({ apiKey: 'k' })('gpt-image-1'),
        prompt: 'p',
        size: '1024x1024',
      }),
    ).resolves.toHaveProperty('images');
    expectTypeOf(
      generateSpeech({
        model: createOpenAISpeech({ apiKey: 'k' })('tts'),
        text: 't',
        voice: 'alloy',
        format: 'mp3',
      }),
    ).resolves.toHaveProperty('audio');
    expectTypeOf(createElevenLabs).toBeFunction();
    expectTypeOf(
      transcribe({
        model: createOpenAITranscription({ apiKey: 'k' })('whisper-1'),
        audio: new Uint8Array(),
        mediaType: 'audio/mpeg',
        language: 'en',
        timestamps: true,
      }),
    ).resolves.toHaveProperty('text');
    expectTypeOf(createDeepgram).toBeFunction();
    expectTypeOf(createVideoProvider({ apiKey: 'k' })('sora-2')).toHaveProperty('modelId');
    expectTypeOf(generateVideo).toBeFunction();
    expectTypeOf(submitVideo).toBeFunction();
    expectTypeOf(createMidjourney({ apiKey: 'k' })()).toHaveProperty('provider');
    expectTypeOf(imagine).toBeFunction();
    expectTypeOf(createRealtimeSession).toBeFunction();
    expectTypeOf(createOpenAIRealtime).toBeFunction();
  });
});

describe('agents and native runs (@deuz-sdk/core/agent)', () => {
  test('createAgent', async () => {
    const support = createAgent({ name: 'support', model, instructions: 'Help.', maxSteps: 4 });
    expectTypeOf(support.def.model).toEqualTypeOf<LanguageModel>();
    expectTypeOf(await support.generateText({ prompt: 'hi' })).toExtend<GenerateTextResult>();
    expectTypeOf(support.streamChat()).toEqualTypeOf<StreamChatResult>();
    expectTypeOf(support.asTool({ name: 'support', description: 'Support.' })).toHaveProperty(
      'parameters',
    );
    expectTypeOf(support.with({ temperature: 0 })).toEqualTypeOf(support);
  });

  test('runAgent, streamAgent and the resume calls', async () => {
    const tools: AgentToolSet = {
      charge: {
        description: 'Charge a card.',
        parameters: weatherParameters,
        replay: 'idempotent',
        needsApproval: async (_args, context) => context.toolCallId.length > 0,
        execute: async (_args, context) => {
          expectTypeOf(context.toolCallId).toBeString();
          expectTypeOf(context.modelStep).toEqualTypeOf<number | undefined>();
          return 'charged';
        },
        toModelOutput: (result) => result,
      },
    };
    const store = createInMemoryAgentRunStore();
    const session = { store, runId: 'r', scope: 't' };
    const result = await runAgent({
      model,
      prompt: 'hi',
      instructions: 'Be careful.',
      tools,
      toolsContext: { tenant: 't' },
      session,
      lease: { provider: createInMemoryLeaseProvider(), ttlMs: 30_000 },
      bindingId: 'v1',
      fallbackModels: [model],
      maxOutputAttempts: 2,
      maxVerifyAttempts: 3,
      verify: async ({ text }) =>
        text ? { status: 'verified' } : { status: 'rejected', feedback: 'empty' },
      onCatalogChange: 'stop',
    });
    const runId: string = result.runId;
    const text: string = result.text;
    const modelSteps: number = result.modelSteps;
    expectTypeOf([runId, text, modelSteps]).toBeArray();
    if (result.status === 'completed') expectTypeOf(result.output).toBeString();
    if (result.status === 'suspended') {
      expectTypeOf(result.pendingApprovals).toEqualTypeOf<ToolApprovalRequest[]>();
      expectTypeOf(result.pendingClientCalls).toEqualTypeOf<ToolCall[]>();
    }
    if (result.status === 'stopped') expectTypeOf(result.reason).toBeString();
    if (result.status === 'failed') expectTypeOf(result.error.message).toBeString();

    const typed = await runAgent({
      model,
      prompt: 'hi',
      output: { schema: z.object({ answer: z.string() }), name: 'answer' },
    });
    if (typed.status === 'completed')
      expectTypeOf(typed.output).toEqualTypeOf<{ answer: string }>();

    const stream: AgentStream = streamAgent({ model, prompt: 'hi' });
    expectTypeOf(stream.textStream).toEqualTypeOf<AsyncIterable<string>>();
    for await (const event of stream.events) {
      if (event.type === 'part') expectTypeOf(event.part).toEqualTypeOf<StreamPart>();
      if (event.type === 'result') expectTypeOf(event.result).toEqualTypeOf<AgentResult>();
    }
    expectTypeOf(stream.result).resolves.toEqualTypeOf<AgentResult>();
    expectTypeOf(stream.consume()).resolves.toEqualTypeOf<AgentResult>();

    const approvals: ToolApprovalResponse[] = [{ approvalId: 'a', approved: false, reason: 'no' }];
    expectTypeOf(
      resumeAgent({
        model,
        tools,
        session,
        approvalResponses: approvals,
        retryToolCallIds: ['c1'],
        clientToolResults: [{ toolCallId: 'c2', output: 'ok' }],
        reconciledToolResults: [{ toolCallId: 'c3', output: 'done', isError: false }],
        retryFailed: true,
      }),
    ).resolves.toEqualTypeOf<AgentResult>();
    expectTypeOf(resumeStreamAgent({ model, session })).toEqualTypeOf<AgentStream>();
    const reconciled = await reconcileAgentRun({ session });
    expectTypeOf(reconciled.runId).toBeString();
    const envelope: AgentRunEnvelope | undefined = await store.load('r');
    if (envelope) {
      expectTypeOf(envelope.runId).toBeString();
      expectTypeOf(envelope.scope).toBeString();
      expectTypeOf<1 | 2>().toExtend<AgentRunEnvelope['version']>();
    }
  });

  test('execution context, budgets, leases and run discovery', async () => {
    const execution = createExecutionContext({ budget: { usd: 5 } });
    await generateText({ model, prompt: 'hi', execution });
    expectTypeOf(createBudgetLedger({ budget: { tokens: 1 } })).toHaveProperty('reserve');
    expectTypeOf(createInMemoryBudgetStore()).toHaveProperty('reserve');
    const store = createInMemoryAgentRunStore();
    expectTypeOf(agentRunLeaseKey({ runId: 'r', scope: 't' })).toBeString();
    expectTypeOf(findStaleAgentRuns(store, { staleMs: 60_000, scope: 't' })).resolves.toBeArray();
  });

  test('swarms, evolve, autonomy, runtime, browser, A2A, batch, headless', () => {
    expectTypeOf(createSwarm).toBeFunction();
    expectTypeOf(createInMemorySwarmStore()).toHaveProperty('commit');
    expectTypeOf(createRounds).toBeFunction();
    expectTypeOf(evolve).toBeFunction();
    expectTypeOf(createInMemoryPopulationStore()).toHaveProperty('loadRun');
    expectTypeOf(bestOfN).toBeFunction();
    expectTypeOf(selfConsistency).toBeFunction();
    expectTypeOf(parallelAgents).toBeFunction();
    expectTypeOf(createRunManager({ store: createInMemoryRunStore() })).toHaveProperty('startRun');
    expectTypeOf(emitPlanUpdate).toBeFunction();
    expectTypeOf(emitActivity).toBeFunction();
    expectTypeOf(createFileRunStore).toBeFunction();
    expectTypeOf(createBrowserTools).toBeFunction();
    expectTypeOf(createPlaywrightBrowser).toBeFunction();
    expectTypeOf(createA2AHandler).toBeFunction();
    expectTypeOf(createA2AClient).toBeFunction();
    expectTypeOf(a2aText).toBeFunction();
    expectTypeOf(createBatchClient({ model, store: createMemoryBatchJobStore() })).toHaveProperty(
      'submit',
    );
    expectTypeOf(runHeadless).toBeFunction();
    expectTypeOf(inspectRun).toBeFunction();
    expectTypeOf(doctor).toBeFunction();
  });

  test('goals and schedules', () => {
    const goal = createGoal(
      { goalId: 'g', scope: 's', objective: 'Ship', criteria: [{ id: 'c', description: 'Done' }] },
      { now: 0 },
    );
    expectTypeOf(goal.goalId).toBeString();
    expectTypeOf(goal.status).toEqualTypeOf<GoalStatus>();
    const step = transitionGoal(
      goal,
      { type: 'cancel', reason: 'r' },
      { now: 1, expectedRevision: 1 },
    );
    expectTypeOf(step.record).toEqualTypeOf(goal);
    expectTypeOf(step.changed).toBeBoolean();
    expectTypeOf(createGoalEvent).toBeFunction();
    expectTypeOf(createInMemoryGoalStore()).toHaveProperty('list');
    expectTypeOf(parseGoal(serializeGoal(goal))).toEqualTypeOf(goal);
    expectTypeOf(nextOccurrence(parseCron('0 3 * * *'), 0)).toBeNumber();
    expectTypeOf(
      createScheduler({
        schedules: [{ id: 'n', cron: '0 3 * * *', run: () => {} }],
        catchUp: 'all',
      }),
    ).toHaveProperty('tick');
    expectTypeOf(handleSignal).toBeFunction();
  });
});

describe('persistence, chat and the UI wire', () => {
  test('durable checkpoints', async () => {
    const store = createInMemorySessionStore();
    const checkpoint: AgentCheckpoint | undefined = await store.load('r');
    if (checkpoint) {
      const copy: AgentCheckpoint = deserializeCheckpoint(serializeCheckpoint(checkpoint));
      expectTypeOf(copy.version).toEqualTypeOf<1>();
      expectTypeOf(copy.messages).toEqualTypeOf<Message[]>();
    }
    expectTypeOf(
      resumeFromCheckpoint(store, 'r', { model }),
    ).resolves.toExtend<GenerateTextResult>();
    expectTypeOf(
      resumeStreamFromCheckpoint(store, 'r', { model }),
    ).toEqualTypeOf<StreamChatResult>();
    expectTypeOf(resumeDeuzChatResponse).toBeFunction();
    expectTypeOf(createApprovalSigner({ secret: 's' })).toHaveProperty('verify');
  });

  test('chat helpers', () => {
    const ui: UIMessage[] = uiFromMessages(messages, () => 'id');
    const back: Message[] = canonicalFromUI(ui);
    expectTypeOf(back).toEqualTypeOf<Message[]>();
    const first = ui[0];
    if (first) {
      expectTypeOf(first.id).toBeString();
      expectTypeOf(first.content).toBeString();
      expectTypeOf(first.parts).toEqualTypeOf<UIMessagePart[] | undefined>();
    }
    const request = parseDeuzChatRequest({}, { maxMessages: 50, rejectSystemRole: true });
    expectTypeOf(request.messages).toEqualTypeOf<Message[]>();
    expectTypeOf(request.chatId).toEqualTypeOf<string | undefined>();
    const checked = validateChatRequest({});
    if (checked.ok) expectTypeOf(checked.request).toEqualTypeOf(request);
    const part: DeuzUIPart = { type: 'text-delta', text: 'hi' };
    const turn = sealAssistantTurn(applyUIPart(createAssistantTurn('m'), part));
    expectTypeOf(assistantMessageFromTurn(turn)).toEqualTypeOf<Message>();
    expectTypeOf(userMessageFromInput({ text: 'hi' })).toEqualTypeOf<Message>();
    const record: ChatRecord = deserializeChatRecord(
      serializeChatRecord({ chatId: 'c', scope: {}, messages, updatedAt: 0 }),
    );
    expectTypeOf(record.messages).toEqualTypeOf<Message[]>();
    expectTypeOf(createInMemoryChatStore()).toHaveProperty('listChats');
    expectTypeOf(createJsonlChatStore).toBeFunction();
  });

  test('the Deuz UI stream', async () => {
    const result = streamChat({ model, prompt: 'hi' });
    const writer = createDeuzStream(result, {
      messageId: 'm',
      generateId: () => 'id',
      wireVersion: 'v2',
    });
    expectTypeOf(writer.response).toEqualTypeOf<Response>();
    writer.writeData('progress', { pct: 50 });
    writer.close();
    expectTypeOf(
      toDeuzStreamResponse(result, {
        headers: {},
        store: createInMemoryStreamStateStore(),
        streamId: 's',
        onStoreError: (error) => expectTypeOf(error).toBeUnknown(),
      }),
    ).toEqualTypeOf<Response>();
    expectTypeOf(toDeuzTextStreamResponse(result)).toEqualTypeOf<Response>();
    expectTypeOf(toDeuzObjectStreamResponse).toBeFunction();
    expectTypeOf(
      toDeuzAgentStreamResponse(streamAgent({ model, prompt: 'hi' }), { runId: 'r' }),
    ).toEqualTypeOf<Response>();
    for await (const part of readDeuzStream(response, { onHttpError: 'error-part' })) {
      if (part.type === 'text-delta') expectTypeOf(part.text).toBeString();
    }
    expectTypeOf(connectDeuzStream).toBeFunction();
    expectTypeOf<'v1' | 'v2'>().toExtend<ReturnType<typeof negotiateDeuzStreamVersion>>();
    expectTypeOf(createInMemoryStreamStateStore({ maxStreams: 100 })).toHaveProperty('append');
    expectTypeOf<typeof DEUZ_STREAM_VERSION>().toEqualTypeOf<'v2'>();
    expectTypeOf<
      'start' | 'step-start' | 'step-finish' | 'text-delta' | 'reasoning-delta'
    >().toExtend<DeuzUIPart['type']>();
  });

  test('built-in memory and the store packs', () => {
    const store = createInMemoryMemoryStore();
    const memory: MemoryCallOptions = {
      seams: {
        store,
        embedder: createEmbedder(embeddingModel),
        llm: async () => '',
        clock: { now: () => 0, setTimeout: () => () => {} },
        generateId: () => 'id',
      },
      scope: { userId: 'u', chatId: 'c' },
      recall: { topK: 5, header: 'Memories:', scorer: 'default', maxChars: 2_000, expandLinks: 1 },
      extract: { infer: true },
      writePolicy: 'each-turn',
      sweep: 'on-extract',
    };
    expectTypeOf(generateText({ model, prompt: 'hi', memory })).resolves.toHaveProperty('memory');
    expectTypeOf(
      remember(messages, memory.scope, memory.seams, { infer: false, ttlMs: 1_000 }),
    ).resolves.toBeArray();
    expectTypeOf(
      recall({ scope: memory.scope, text: 'q', topK: 3 }, memory.seams),
    ).resolves.toBeArray();
    expectTypeOf(
      createMemoryTools({ scope: memory.scope, seams: memory.seams }),
    ).toExtend<ToolSet>();
    expectTypeOf(createMarkdownMemoryStore).toBeFunction();
    expectTypeOf(createSqliteStores({ path: ':memory:' })).toHaveProperty('memory');
    expectTypeOf(createPostgresStores).toBeFunction();
    expectTypeOf(createRedisStores).toBeFunction();
    expectTypeOf(createSqliteOpsStore({ path: ':memory:' })).toHaveProperty('claims');
    expectTypeOf(createPostgresOpsStore).toBeFunction();
    expectTypeOf(createRedisOpsStore).toBeFunction();
    expectTypeOf(createSqliteSwarmStore).toBeFunction();
    expectTypeOf(createPostgresSwarmStore).toBeFunction();
    expectTypeOf(createRedisSwarmStore).toBeFunction();
    expectTypeOf(createSqlitePopulationStore).toBeFunction();
  });
});

describe('tools, retrieval, observation and the remaining subpaths', () => {
  test('MCP, RAG, skills, compute and workspaces', () => {
    const client = createMcpClient({
      transport: { type: 'http', url: 'https://mcp.example/mcp', headers: {} },
      name: 'app',
      version: '1.0.0',
    });
    expectTypeOf(client).resolves.toHaveProperty('listTools');
    expectTypeOf(createMcpPool).toBeFunction();
    expectTypeOf(createStdioMcpClient).toBeFunction();
    expectTypeOf(createFileTokenStore).toBeFunction();
    expectTypeOf(createMcpServer).toBeFunction();
    expectTypeOf(serveMcpStdio).toBeFunction();
    expectTypeOf(retrieve).toBeFunction();
    expectTypeOf(chunkRecursive('text', { size: 100, overlap: 10 })).toBeArray();
    expectTypeOf(createMemoryVectorStore()).toHaveProperty('query');
    expectTypeOf(hybridRetrieve).toBeFunction();
    expectTypeOf(defaultNodeParserRegistry).toBeFunction();
    expectTypeOf(parseSkill).toBeFunction();
    expectTypeOf(createSkillRegistry).toBeFunction();
    expectTypeOf(nodeSkillSource).toBeFunction();
    expectTypeOf(codeActTool).toBeFunction();
    expectTypeOf(shellTool).toBeFunction();
    expectTypeOf(createNodeSandbox({})).toHaveProperty('runCode');
    expectTypeOf(createInMemoryWorkspace()).not.toBeAny();
    expectTypeOf(createWorkspaceTools).toBeFunction();
    expectTypeOf(createFileWorkspace).toBeFunction();
  });

  test('observation, testing and the duplicate subpath exports', () => {
    const memory = createMemoryObserver({ maxEvents: 100 });
    expectTypeOf(memory.events()).toEqualTypeOf<readonly ObserveEvent[]>();
    const observer = composeObservers(
      memory,
      createCallbackObserver((event) => expectTypeOf(event.type).toBeString()),
    );
    expectTypeOf(generateText({ model, prompt: 'hi', deps: { observer } })).resolves.toHaveProperty(
      'text',
    );
    expectTypeOf(createJsonlObserver).toBeFunction();
    expectTypeOf(createOtelObserver()).toHaveProperty('emit');
    expectTypeOf(createOtelTracer).toBeFunction();
    expectTypeOf(createMockModel({ responses: [{ text: 'hi' }] })).toEqualTypeOf<LanguageModel>();
    expectTypeOf(mockFetch).toBeFunction();
    expectTypeOf(runEval).toBeFunction();
    expectTypeOf(createPriceProviderSubpath).toEqualTypeOf(createPriceProvider);
    expectTypeOf(wrapModelSubpath).toEqualTypeOf(wrapModel);
    expectTypeOf(maxOutputLengthSubpath).toEqualTypeOf(maxOutputLength);
    expectTypeOf(useChat).toBeFunction();
    expectTypeOf(useObject).toBeFunction();
  });

  test('the edge entry re-exports the edge-safe surface', () => {
    expectTypeOf(edge.generateText).toEqualTypeOf(generateText);
    expectTypeOf(edge.streamChat).toEqualTypeOf(streamChat);
    expectTypeOf(edge.createAgent).toEqualTypeOf(createAgent);
    expectTypeOf(edge.uiFromMessages).toEqualTypeOf(uiFromMessages);
    expectTypeOf(edge.createInMemoryChatStore).toEqualTypeOf(createInMemoryChatStore);
    expectTypeOf(edge.createScheduler).toEqualTypeOf(createScheduler);
  });
});
