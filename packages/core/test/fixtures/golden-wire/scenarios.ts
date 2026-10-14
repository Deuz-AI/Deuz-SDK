/**
 * The golden wire scenarios (2.4, W0A): default calls through every provider
 * factory that builds an HTTP request, with every 2.4 feature left at its
 * default. Each scenario's requests were recorded from 2.3.0 into
 * `2.3.0/<id>.json`; `golden-wire.test.ts` replays them on the current code.
 *
 * A scenario id is the fixture file name, so removing or renaming one fails the
 * test (the fixture would be left without a scenario). Add new scenarios, and
 * record them under a new release directory; never edit a 2.3.0 file.
 */
import { generateText, streamChat, generateObject } from '../../../src/generate';
import { embed, embedMany } from '../../../src/inference/embed';
import { runAgent } from '../../../src/agent-run';
import { createAnthropic } from '../../../src/anthropic';
import { createOpenAI, createOpenAIResponses, createOpenAIEmbedding } from '../../../src/openai';
import { createGoogle, createGoogleNative, createGoogleEmbedding } from '../../../src/google';
import {
  createVertexAnthropic,
  createVertexGoogle,
  createVertexGoogleNative,
} from '../../../src/vertex';
import { createAzure } from '../../../src/azure';
import { createBedrock } from '../../../src/bedrock';
import { createXai } from '../../../src/xai';
import { createVoyage, createVoyageReranker } from '../../../src/voyage';
import { createCohereReranker } from '../../../src/rag';
import {
  createYunwuChat,
  createYunwuEmbedding,
  createYunwuImage,
  createYunwuVideo,
} from '../../../src/yunwu';
import { createImageProvider, generateImage } from '../../../src/image';
import { createElevenLabs, createOpenAISpeech, generateSpeech } from '../../../src/speech';
import { createDeepgram, createOpenAITranscription, transcribe } from '../../../src/transcription';
import { createVideoProvider, submitVideo } from '../../../src/video';
import { submitImagine } from '../../../src/midjourney';
import { createGeminiCache, uploadFile } from '../../../src/google-extras';
import { createBatchClient } from '../../../src/batch/client';
import type { BatchRequest } from '../../../src/batch/types';
import {
  createEmbedder,
  createInMemoryMemoryStore,
  type MemoryCallOptions,
} from '../../../src/memory';
import {
  createCerebras,
  createCohere,
  createDeepInfra,
  createDeepSeek,
  createFireworks,
  createGLM,
  createGroq,
  createHyperbolic,
  createLMStudio,
  createMiniMax,
  createMistral,
  createMoonshot,
  createNvidia,
  createOllama,
  createOpenAICompatible,
  createOpenRouter,
  createPerplexity,
  createQwen,
  createSambaNova,
  createTogether,
} from '../../../src/providers-compat';
import type { Dependencies } from '../../../src/types/deps';
import type { EmbeddingModel, LanguageModel } from '../../../src/types/model';
import type { Message } from '../../../src/types/message';
import type { ToolSet } from '../../../src/types/tool';
import type { AgentToolSet } from '../../../src/types/agent-run';
import type { JSONSchema } from '../../../src/types/schema';
import {
  FIXED_NOW,
  SECRET,
  bytesAnswer,
  jsonAnswer,
  turn,
  type ScriptStep,
  type Wire,
  type WireRequest,
} from './harness';

export interface GoldenScenario {
  /** The fixture file name, without `.json`. */
  id: string;
  /** The provider's answers, one per request. */
  script: readonly ScriptStep[];
  /** Make the call(s) with the recording `fetch` and fresh deterministic `deps`. */
  run(fetch: typeof globalThis.fetch, deps: Dependencies): Promise<void>;
}

// ---------------------------------------------------------------------------
// Call inputs shared by every chat scenario.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = 'You are a concise assistant.';

const HISTORY: Message[] = [
  { role: 'user', content: 'What is 2 + 2?' },
  { role: 'assistant', content: '4' },
  { role: 'user', content: 'And 3 + 3?' },
];

const CITY_PARAMETERS: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string', description: 'The city name.' } },
  required: ['city'],
  additionalProperties: false,
};

const WEATHER_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' }, tempC: { type: 'number' } },
  required: ['city', 'tempC'],
  additionalProperties: false,
};

const weather = async (args: { city: string }) => ({ city: args.city, tempC: 21, sky: 'clear' });

const TOOLS: ToolSet = {
  get_weather: {
    description: 'Current weather for a city.',
    parameters: CITY_PARAMETERS,
    execute: (args) => weather(args as { city: string }),
  },
};

const AGENT_TOOLS: AgentToolSet = {
  get_weather: {
    description: 'Current weather for a city.',
    parameters: CITY_PARAMETERS,
    execute: (args: { city: string }) => weather(args),
  },
};

/** A 1×1 transparent PNG, base64. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const IMAGE_MESSAGES: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      { type: 'image', image: PIXEL_PNG, mediaType: 'image/png' },
    ],
  },
];

/** One reasoning block of each family: a wire replays only its own. */
const REASONING_HISTORY: Message[] = [
  { role: 'user', content: 'Where should I travel?' },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: 'Weighing the options.',
        signature: 'sig-anthropic',
        source: 'anthropic',
      },
      {
        type: 'reasoning',
        text: 'b3BhcXVl',
        signature: 'rs_golden',
        encrypted: true,
        source: 'openai',
      },
      {
        type: 'reasoning',
        text: 'Considering seasons.',
        signature: 'sig-google',
        source: 'google',
      },
      { type: 'text', text: 'Paris.' },
    ],
  },
  { role: 'user', content: 'Why?' },
];

/** Two finished tool rounds and a new question, for the compaction layers. */
const TOOL_HISTORY: Message[] = [
  { role: 'user', content: 'What is the weather in Paris?' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_paris', name: 'get_weather', input: { city: 'Paris' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', toolUseId: 'call_paris', result: { city: 'Paris', tempC: 21 } },
    ],
  },
  { role: 'assistant', content: 'It is 21 °C in Paris.' },
  { role: 'user', content: 'And in Rome?' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_rome', name: 'get_weather', input: { city: 'Rome' } }],
  },
  {
    role: 'tool',
    content: [{ type: 'tool_result', toolUseId: 'call_rome', result: { city: 'Rome', tempC: 25 } }],
  },
  { role: 'assistant', content: 'It is 25 °C in Rome.' },
  { role: 'user', content: 'Which city is warmer?' },
];

/**
 * A compaction that always fires (a fixed huge token count) and only prunes
 * tool results. Compaction runs in the tool loop, so the call offers a tool.
 */
const COMPACTION = {
  keepRecentSteps: 1,
  layers: ['prune-tool-results' as const],
  countTokens: () => 10_000_000,
};

/** The same, with the summarize layer only: one summary side call before the step. */
const SUMMARY_COMPACTION = { ...COMPACTION, layers: ['summarize' as const] };

/**
 * Memory recall over one stored fact. The fact's vector equals the query's
 * (cosine 1, same model and dimensions), so it is recalled under every recall
 * rule; extraction is off, so the only provider calls are the query embedding
 * and the model calls.
 */
async function memoryOptions(
  fetch: typeof globalThis.fetch,
  deps: Dependencies,
): Promise<MemoryCallOptions> {
  const store = createInMemoryMemoryStore();
  await store.upsert([
    {
      id: 'mem_golden',
      text: 'The user prefers temperatures in Celsius.',
      hash: 'hash_golden',
      kind: 'semantic',
      scope: { userId: 'golden-user' },
      embedding: [0.1, 0.2, 0.3],
      embeddingModelId: 'text-embedding-3-small',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    },
  ]);
  const embedding = createOpenAIEmbedding({ ...key, fetch })('text-embedding-3-small');
  let next = 0;
  return {
    seams: {
      store,
      embedder: createEmbedder(embedding, { deps }),
      llm: async () => '',
      clock: deps.clock!,
      generateId: () => `mem_${++next}`,
    },
    scope: { userId: 'golden-user' },
    extract: false,
  };
}

const CALL = { name: 'get_weather', args: '{"city":"Paris"}' };
const OBJECT_JSON = '{"city":"Paris","tempC":21}';

/** Answer an object call by its strategy: a forced `weather` tool, or JSON text. */
const objectAnswer =
  (wire: Wire) =>
  (request: WireRequest): string =>
    request.body?.includes('"weather"') && request.body.includes('"tools"')
      ? turn(wire, { call: { name: 'weather', args: OBJECT_JSON } })
      : turn(wire, { text: OBJECT_JSON });

async function drain(stream: AsyncIterable<{ type: string; error?: unknown }>): Promise<void> {
  for await (const part of stream) if (part.type === 'error') throw part.error;
}

// ---------------------------------------------------------------------------
// Chat targets.
// ---------------------------------------------------------------------------

type ChatKind =
  | 'generate-text'
  | 'stream-chat'
  | 'tool-round'
  | 'generate-object'
  | 'run-agent'
  | 'call-options'
  | 'image-input'
  | 'reasoning-replay'
  | 'compaction'
  | 'compaction-summary'
  | 'memory-recall'
  | 'run-agent-memory';

const ALL: readonly ChatKind[] = [
  'generate-text',
  'stream-chat',
  'tool-round',
  'generate-object',
  'run-agent',
  'call-options',
  'image-input',
];
/**
 * The main wires also run with the 2.3 features a caller switches on (memory
 * recall, compaction) and with replayed reasoning: a 2.4 process with its own
 * new features off must send these exactly as 2.3 did.
 */
const FEATURED: readonly ChatKind[] = [
  ...ALL,
  'reasoning-replay',
  'compaction',
  'compaction-summary',
  'memory-recall',
  'run-agent-memory',
];
/** Named compatible hosts with a pinned registry row: a plain call and a tool round. */
const HOST: readonly ChatKind[] = ['generate-text', 'tool-round'];
/** Hosts without a registry row (tools off by default): a plain call only. */
const PLAIN: readonly ChatKind[] = ['generate-text'];

interface ChatTarget {
  /** `<factory>.<model>`, file-name safe. */
  name: string;
  wire: Wire;
  model: (fetch: typeof globalThis.fetch) => LanguageModel;
  kinds: readonly ChatKind[];
}

const key = { apiKey: SECRET };

const CHAT_TARGETS: readonly ChatTarget[] = [
  {
    name: 'anthropic.claude-sonnet-4-5',
    wire: 'anthropic',
    model: (fetch) => createAnthropic({ ...key, fetch })('claude-sonnet-4-5'),
    kinds: FEATURED,
  },
  {
    name: 'anthropic.claude-opus-5-5',
    wire: 'anthropic',
    model: (fetch) => createAnthropic({ ...key, fetch })('claude-opus-5-5'),
    kinds: ALL,
  },
  {
    name: 'openai-chat.gpt-5.5',
    wire: 'chat',
    model: (fetch) => createOpenAI({ ...key, fetch })('gpt-5.5'),
    kinds: FEATURED,
  },
  {
    name: 'openai-responses.gpt-5.4',
    wire: 'responses',
    model: (fetch) => createOpenAIResponses({ ...key, fetch })('gpt-5.4'),
    kinds: FEATURED,
  },
  {
    name: 'google-native.gemini-2.5-flash',
    wire: 'gemini',
    model: (fetch) => createGoogleNative({ ...key, fetch })('gemini-2.5-flash'),
    kinds: FEATURED,
  },
  {
    name: 'google-native.gemini-3.1-pro',
    wire: 'gemini',
    model: (fetch) => createGoogleNative({ ...key, fetch })('gemini-3.1-pro'),
    kinds: ALL,
  },
  {
    name: 'google-compat.gemini-2.5-flash',
    wire: 'chat',
    model: (fetch) => createGoogle({ ...key, fetch })('gemini-2.5-flash'),
    kinds: ALL,
  },
  {
    name: 'vertex-anthropic.claude-sonnet-4-5',
    wire: 'anthropic',
    model: (fetch) =>
      createVertexAnthropic({
        project: 'golden-project',
        location: 'us-east5',
        accessToken: SECRET,
        fetch,
      })('claude-sonnet-4-5'),
    kinds: ALL,
  },
  {
    name: 'vertex-google.gemini-2.5-flash',
    wire: 'chat',
    model: (fetch) =>
      createVertexGoogle({
        project: 'golden-project',
        location: 'us-central1',
        accessToken: SECRET,
        fetch,
      })('google/gemini-2.5-flash'),
    kinds: ALL,
  },
  {
    name: 'vertex-google-native.gemini-2.5-flash',
    wire: 'gemini',
    model: (fetch) =>
      createVertexGoogleNative({
        project: 'golden-project',
        location: 'global',
        accessToken: SECRET,
        fetch,
      })('gemini-2.5-flash'),
    kinds: ALL,
  },
  {
    name: 'azure.gpt-5.5',
    wire: 'chat',
    model: (fetch) => createAzure({ ...key, resourceName: 'golden-resource', fetch })('gpt-5.5'),
    kinds: ALL,
  },
  {
    name: 'bedrock.openai.gpt-oss-120b',
    wire: 'chat',
    model: (fetch) => createBedrock({ ...key, region: 'us-west-2', fetch })('openai.gpt-oss-120b'),
    kinds: ALL,
  },
  {
    name: 'xai.grok-4.3',
    wire: 'chat',
    model: (fetch) => createXai({ ...key, fetch })('grok-4.3'),
    kinds: ALL,
  },
  {
    name: 'openai-compatible.gateway-model',
    wire: 'chat',
    model: (fetch) =>
      createOpenAICompatible({
        ...key,
        id: 'golden-gateway',
        baseURL: 'https://gateway.example.test/v1',
        capabilities: { tools: true },
        fetch,
      })('gateway-model'),
    kinds: ALL,
  },
  {
    name: 'openai-compatible-responses.gateway-model',
    wire: 'responses',
    model: (fetch) =>
      createOpenAICompatible({
        ...key,
        id: 'golden-gateway',
        surface: 'responses',
        baseURL: 'https://gateway.example.test/v1',
        fetch,
      })('gateway-model'),
    kinds: PLAIN,
  },
  {
    name: 'groq.llama-4-maverick',
    wire: 'chat',
    model: (fetch) => createGroq({ ...key, fetch })('llama-4-maverick'),
    kinds: HOST,
  },
  {
    name: 'deepseek.deepseek-v3.2',
    wire: 'chat',
    model: (fetch) => createDeepSeek({ ...key, fetch })('deepseek-v3.2'),
    kinds: HOST,
  },
  {
    name: 'deepseek.deepseek-v4-pro',
    wire: 'chat',
    model: (fetch) => createDeepSeek({ ...key, fetch })('deepseek-v4-pro'),
    kinds: HOST,
  },
  {
    name: 'mistral.mistral-large-latest',
    wire: 'chat',
    model: (fetch) => createMistral({ ...key, fetch })('mistral-large-latest'),
    kinds: HOST,
  },
  {
    name: 'moonshot.kimi-k2',
    wire: 'chat',
    model: (fetch) => createMoonshot({ ...key, fetch })('kimi-k2'),
    kinds: HOST,
  },
  {
    name: 'qwen.qwen3-max',
    wire: 'chat',
    model: (fetch) => createQwen({ ...key, fetch })('qwen3-max'),
    kinds: HOST,
  },
  {
    name: 'glm.glm-4.6',
    wire: 'chat',
    model: (fetch) => createGLM({ ...key, fetch })('glm-4.6'),
    kinds: HOST,
  },
  {
    name: 'minimax.minimax-m2',
    wire: 'chat',
    model: (fetch) => createMiniMax({ ...key, fetch })('minimax-m2'),
    kinds: HOST,
  },
  {
    name: 'perplexity.sonar-pro',
    wire: 'chat',
    model: (fetch) => createPerplexity({ ...key, fetch })('sonar-pro'),
    kinds: PLAIN,
  },
  {
    name: 'cohere.command-a-03-2025',
    wire: 'chat',
    model: (fetch) => createCohere({ ...key, fetch })('command-a-03-2025'),
    kinds: HOST,
  },
  {
    name: 'deepinfra.deepseek-ai-DeepSeek-V3.2',
    wire: 'chat',
    model: (fetch) => createDeepInfra({ ...key, fetch })('deepseek-ai/DeepSeek-V3.2'),
    kinds: HOST,
  },
  {
    name: 'nvidia.meta-llama-4-maverick-17b-128e-instruct',
    wire: 'chat',
    model: (fetch) => createNvidia({ ...key, fetch })('meta/llama-4-maverick-17b-128e-instruct'),
    kinds: HOST,
  },
  {
    name: 'sambanova.Meta-Llama-3.3-70B-Instruct',
    wire: 'chat',
    model: (fetch) => createSambaNova({ ...key, fetch })('Meta-Llama-3.3-70B-Instruct'),
    kinds: HOST,
  },
  {
    name: 'hyperbolic.moonshotai-Kimi-K2-Instruct',
    wire: 'chat',
    model: (fetch) => createHyperbolic({ ...key, fetch })('moonshotai/Kimi-K2-Instruct'),
    kinds: HOST,
  },
  {
    name: 'together.unpinned-model',
    wire: 'chat',
    model: (fetch) => createTogether({ ...key, fetch })('unpinned-model'),
    kinds: PLAIN,
  },
  {
    name: 'openrouter.unpinned-model',
    wire: 'chat',
    model: (fetch) => createOpenRouter({ ...key, fetch })('unpinned-model'),
    kinds: PLAIN,
  },
  {
    name: 'cerebras.unpinned-model',
    wire: 'chat',
    model: (fetch) => createCerebras({ ...key, fetch })('unpinned-model'),
    kinds: PLAIN,
  },
  {
    name: 'fireworks.unpinned-model',
    wire: 'chat',
    model: (fetch) => createFireworks({ ...key, fetch })('unpinned-model'),
    kinds: PLAIN,
  },
  {
    // Keyless local host: the placeholder bearer token is part of the wire.
    name: 'ollama.qwen3',
    wire: 'chat',
    model: (fetch) => createOllama({ fetch })('qwen3'),
    kinds: PLAIN,
  },
  {
    name: 'lmstudio.local-model',
    wire: 'chat',
    model: (fetch) => createLMStudio({ fetch })('local-model'),
    kinds: PLAIN,
  },
  {
    name: 'yunwu.gpt-5.2',
    wire: 'chat',
    model: (fetch) => createYunwuChat({ ...key, fetch })('gpt-5.2'),
    kinds: HOST,
  },
];

function chatScenario(target: ChatTarget, kind: ChatKind): GoldenScenario {
  const { wire } = target;
  const id = `${target.name}.${kind}`;
  switch (kind) {
    case 'generate-text':
      return {
        id,
        script: [turn(wire, { text: 'Hello.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({ model, instructions: INSTRUCTIONS, prompt: 'Say hello.', deps });
        },
      };
    case 'stream-chat':
      return {
        id,
        script: [turn(wire, { text: '6' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await drain(streamChat({ model, messages: HISTORY, deps }).fullStream);
        },
      };
    case 'tool-round':
      return {
        id,
        script: [turn(wire, { call: CALL }), turn(wire, { text: 'It is 21 °C in Paris.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({
            model,
            prompt: 'What is the weather in Paris?',
            tools: TOOLS,
            maxSteps: 2,
            deps,
          });
        },
      };
    case 'generate-object':
      return {
        id,
        script: [objectAnswer(wire)],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateObject({
            model,
            prompt: 'Report the weather in Paris.',
            schema: WEATHER_SCHEMA,
            schemaName: 'weather',
            deps,
          });
        },
      };
    case 'call-options':
      // The documented sampling and effort options a 2.3 caller sets by hand.
      return {
        id,
        script: [turn(wire, { text: 'Hello.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({
            model,
            prompt: 'Say hello.',
            temperature: 0.2,
            topP: 0.9,
            maxOutputTokens: 256,
            stopSequences: ['END'],
            effort: 'low',
            deps,
          });
        },
      };
    case 'image-input':
      return {
        id,
        script: [turn(wire, { text: 'A transparent pixel.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({ model, messages: IMAGE_MESSAGES, deps });
        },
      };
    case 'reasoning-replay':
      return {
        id,
        script: [turn(wire, { text: 'Because of the museums.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({ model, messages: REASONING_HISTORY, deps });
        },
      };
    case 'compaction':
      return {
        id,
        script: [turn(wire, { text: 'Rome.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({
            model,
            messages: TOOL_HISTORY,
            tools: TOOLS,
            compaction: COMPACTION,
            deps,
          });
        },
      };
    case 'compaction-summary':
      return {
        id,
        script: [turn(wire, { text: 'Paris 21 °C, Rome 25 °C.' }), turn(wire, { text: 'Rome.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({
            model,
            messages: TOOL_HISTORY,
            tools: TOOLS,
            compaction: SUMMARY_COMPACTION,
            deps,
          });
        },
      };
    case 'memory-recall':
      return {
        id,
        script: [openaiShaped(1), turn(wire, { text: 'Hello.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          await generateText({
            model,
            prompt: 'What is the weather in Paris?',
            memory: await memoryOptions(fetch, deps),
            deps,
          });
        },
      };
    case 'run-agent-memory':
      return {
        id,
        script: [openaiShaped(1), turn(wire, { call: CALL }), turn(wire, { text: 'It is 21 °C.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          const result = await runAgent({
            model,
            prompt: 'What is the weather in Paris?',
            tools: AGENT_TOOLS,
            memory: await memoryOptions(fetch, deps),
            deps,
          });
          if (result.status !== 'completed') {
            throw new Error(`golden-wire: ${id} ended ${result.status}`);
          }
        },
      };
    case 'run-agent':
      return {
        id,
        script: [turn(wire, { call: CALL }), turn(wire, { text: 'It is 21 °C in Paris.' })],
        async run(fetch, deps) {
          const model = target.model(fetch);
          const result = await runAgent({
            model,
            instructions: INSTRUCTIONS,
            prompt: 'What is the weather in Paris?',
            tools: AGENT_TOOLS,
            deps,
          });
          if (result.status !== 'completed') {
            throw new Error(`golden-wire: ${id} ended ${result.status}`);
          }
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Embedding targets.
// ---------------------------------------------------------------------------

const vectors = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ index, embedding: [0.1, 0.2, 0.3] }));

const openaiShaped = (count: number) =>
  jsonAnswer({
    object: 'list',
    data: vectors(count),
    usage: { prompt_tokens: 4 * count, total_tokens: 4 * count },
  });

const geminiShaped = (count: number) =>
  jsonAnswer({ embeddings: Array.from({ length: count }, () => ({ values: [0.1, 0.2, 0.3] })) });

const DOCUMENTS = ['Paris is the capital of France.', 'Rome is the capital of Italy.'];

interface EmbeddingCase {
  id: string;
  script: readonly ScriptStep[];
  model: (fetch: typeof globalThis.fetch) => EmbeddingModel;
  call: (model: EmbeddingModel, deps: Dependencies) => Promise<unknown>;
}

const EMBEDDING_CASES: readonly EmbeddingCase[] = [
  {
    id: 'openai-embedding.text-embedding-3-small.embed',
    script: [openaiShaped(1)],
    model: (fetch) => createOpenAIEmbedding({ ...key, fetch })('text-embedding-3-small'),
    call: (model, deps) => embed({ model, value: 'golden query', deps }),
  },
  {
    id: 'openai-embedding.text-embedding-3-large.embed-many',
    script: [openaiShaped(2)],
    model: (fetch) => createOpenAIEmbedding({ ...key, fetch })('text-embedding-3-large'),
    call: (model, deps) => embedMany({ model, values: DOCUMENTS, dimensions: 256, deps }),
  },
  {
    id: 'google-embedding.gemini-embedding-001.embed',
    script: [geminiShaped(1)],
    model: (fetch) => createGoogleEmbedding({ ...key, fetch })('gemini-embedding-001'),
    call: (model, deps) => embed({ model, value: 'golden query', taskType: 'search_query', deps }),
  },
  {
    id: 'google-embedding.gemini-embedding-001.embed-many',
    script: [geminiShaped(2)],
    model: (fetch) => createGoogleEmbedding({ ...key, fetch })('gemini-embedding-001'),
    call: (model, deps) =>
      embedMany({
        model,
        values: DOCUMENTS,
        taskType: 'search_document',
        title: 'Capitals',
        deps,
      }),
  },
  {
    id: 'voyage.voyage-3.5.embed',
    script: [openaiShaped(1)],
    model: (fetch) => createVoyage({ ...key, fetch })('voyage-3.5'),
    call: (model, deps) => embed({ model, value: 'golden query', taskType: 'search_query', deps }),
  },
  {
    id: 'voyage.voyage-3.5-lite.embed-many',
    script: [openaiShaped(2)],
    model: (fetch) => createVoyage({ ...key, fetch })('voyage-3.5-lite'),
    call: (model, deps) =>
      embedMany({ model, values: DOCUMENTS, taskType: 'search_document', deps }),
  },
  {
    id: 'yunwu-embedding.text-embedding-3-small.embed',
    script: [openaiShaped(1)],
    model: (fetch) => createYunwuEmbedding({ ...key, fetch })('text-embedding-3-small'),
    call: (model, deps) => embed({ model, value: 'golden query', deps }),
  },
];

function embeddingScenario(entry: EmbeddingCase): GoldenScenario {
  return {
    id: entry.id,
    script: entry.script,
    async run(fetch, deps) {
      await entry.call(entry.model(fetch), deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Media, rerank and relay requests.
// ---------------------------------------------------------------------------

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

const CANDIDATES = [
  { text: DOCUMENTS[0]!, index: 0, score: 0.5 },
  { text: DOCUMENTS[1]!, index: 1, score: 0.4 },
];

const rerankResults = [
  { index: 1, relevance_score: 0.9 },
  { index: 0, relevance_score: 0.2 },
];

const MEDIA_SCENARIOS: readonly GoldenScenario[] = [
  {
    id: 'image.gpt-image-1.generate-image',
    script: [jsonAnswer({ created: 0, data: [{ url: 'https://images.example.test/1.png' }] })],
    async run(fetch, deps) {
      const model = createImageProvider({ ...key, fetch })('gpt-image-1');
      await generateImage({ model, prompt: 'A lighthouse at dusk.', size: '1024x1024', deps });
    },
  },
  {
    id: 'yunwu-image.gpt-image-1.5.generate-image',
    script: [jsonAnswer({ created: 0, data: [{ b64_json: 'aGVsbG8=' }] })],
    async run(fetch, deps) {
      const model = createYunwuImage({ ...key, fetch })('gpt-image-1.5');
      await generateImage({
        model,
        prompt: 'A lighthouse at dusk.',
        responseFormat: 'b64_json',
        deps,
      });
    },
  },
  {
    id: 'openai-speech.gpt-4o-mini-tts.generate-speech',
    script: [bytesAnswer(AUDIO, 'audio/mpeg')],
    async run(fetch, deps) {
      const model = createOpenAISpeech({ ...key, fetch })('gpt-4o-mini-tts');
      await generateSpeech({ model, text: 'Hello there.', voice: 'alloy', deps });
    },
  },
  {
    id: 'elevenlabs.eleven_multilingual_v2.generate-speech',
    script: [bytesAnswer(AUDIO, 'audio/mpeg')],
    async run(fetch, deps) {
      const model = createElevenLabs({ ...key, fetch })('eleven_multilingual_v2');
      await generateSpeech({ model, text: 'Hello there.', voice: 'golden-voice', deps });
    },
  },
  {
    id: 'openai-transcription.whisper-1.transcribe',
    script: [jsonAnswer({ text: 'Hello there.' })],
    async run(fetch, deps) {
      const model = createOpenAITranscription({ ...key, fetch })('whisper-1');
      await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg', language: 'en', deps });
    },
  },
  {
    id: 'deepgram.nova-3.transcribe',
    script: [
      jsonAnswer({
        metadata: { request_id: 'golden', duration: 1 },
        results: {
          channels: [{ alternatives: [{ transcript: 'Hello there.', confidence: 0.9 }] }],
        },
      }),
    ],
    async run(fetch, deps) {
      const model = createDeepgram({ ...key, fetch })('nova-3');
      await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg', language: 'en', deps });
    },
  },
  {
    id: 'video.sora-2.submit-video',
    script: [jsonAnswer({ id: 'video_golden', status: 'queued', model: 'sora-2' })],
    async run(fetch, deps) {
      const model = createVideoProvider({ ...key, fetch })('sora-2');
      await submitVideo({ model, prompt: 'Waves at night.', size: '1280x720', seconds: 8, deps });
    },
  },
  {
    id: 'yunwu-video.veo3.submit-video',
    script: [jsonAnswer({ id: 'video_golden', status: 'queued', model: 'veo3' })],
    async run(fetch, deps) {
      const model = createYunwuVideo({ ...key, fetch })('veo3');
      await submitVideo({ model, prompt: 'Waves at night.', deps });
    },
  },
  {
    id: 'midjourney.submit-imagine',
    script: [jsonAnswer({ code: 1, description: 'Submit success', result: 'task_golden' })],
    async run(fetch, deps) {
      await submitImagine({ ...key, fetch, prompt: 'A lighthouse at dusk --ar 16:9', deps });
    },
  },
  {
    id: 'google-extras.create-gemini-cache',
    script: [jsonAnswer({ name: 'cachedContents/golden', model: 'models/gemini-2.5-flash' })],
    async run(fetch, deps) {
      await createGeminiCache({
        ...key,
        fetch,
        deps,
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'A long shared document.' }] }],
        systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
        ttl: '600s',
        displayName: 'golden',
      });
    },
  },
  {
    id: 'google-extras-vertex.create-gemini-cache',
    script: [jsonAnswer({ name: 'cachedContents/golden', model: 'gemini-2.5-flash' })],
    async run(fetch, deps) {
      await createGeminiCache({
        accessToken: SECRET,
        vertex: { project: 'golden-project', location: 'us-central1' },
        fetch,
        deps,
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'A long shared document.' }] }],
      });
    },
  },
  {
    id: 'google-extras.upload-file',
    script: [
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload.example.test/session/golden' },
        }),
      jsonAnswer({ file: { name: 'files/golden', uri: 'https://files.example.test/golden' } }),
    ],
    async run(fetch, deps) {
      await uploadFile({
        ...key,
        fetch,
        deps,
        bytes: new TextEncoder().encode('%PDF-1.4 golden'),
        mimeType: 'application/pdf',
        displayName: 'golden.pdf',
      });
    },
  },
  {
    id: 'voyage-rerank.rerank-2.5.rerank',
    script: [jsonAnswer({ object: 'list', data: rerankResults, usage: { total_tokens: 20 } })],
    async run(fetch, deps) {
      await createVoyageReranker({ ...key, fetch, deps }).rerank('capital of Italy', CANDIDATES, 2);
    },
  },
  {
    id: 'cohere-rerank.rerank-v4.0-pro.rerank',
    script: [jsonAnswer({ id: 'golden', results: rerankResults })],
    async run(fetch, deps) {
      await createCohereReranker({ ...key, fetch, deps }).rerank('capital of Italy', CANDIDATES, 1);
    },
  },
];

// ---------------------------------------------------------------------------
// Batch submission (the requests a batch job is created with).
// ---------------------------------------------------------------------------

const BATCH_REQUESTS: BatchRequest[] = [
  { id: 'q1', prompt: 'One?', maxOutputTokens: 64 },
  { id: 'q2', instructions: 'Answer in French.', prompt: 'Two?' },
];

const anthropicBatch = jsonAnswer({
  id: 'msgbatch_golden',
  type: 'message_batch',
  processing_status: 'in_progress',
  request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  created_at: '2026-01-02T03:04:05Z',
  expires_at: '2026-01-03T03:04:05Z',
  ended_at: null,
  cancel_initiated_at: null,
  archived_at: null,
  results_url: null,
});

const openaiFile = jsonAnswer({
  id: 'file-golden',
  object: 'file',
  purpose: 'batch',
  status: 'processed',
  bytes: 512,
});

const openaiBatch = (endpoint: string) =>
  jsonAnswer({
    id: 'batch_golden',
    object: 'batch',
    endpoint,
    input_file_id: 'file-golden',
    completion_window: '24h',
    status: 'validating',
    created_at: 1_767_323_045,
    expires_at: 1_767_409_445,
    request_counts: { total: 2, completed: 0, failed: 0 },
  });

const geminiBatch = jsonAnswer({
  name: 'batches/golden',
  metadata: {
    '@type': 'type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch',
    model: 'models/gemini-2.5-flash',
    state: 'BATCH_STATE_PENDING',
    createTime: '2026-01-02T03:04:05Z',
  },
});

function batchScenario(
  id: string,
  script: readonly ScriptStep[],
  model: (fetch: typeof globalThis.fetch) => LanguageModel,
): GoldenScenario {
  return {
    id,
    script,
    async run(fetch, deps) {
      await createBatchClient({ model: model(fetch), deps }).submit(BATCH_REQUESTS);
    },
  };
}

const BATCH_SCENARIOS: readonly GoldenScenario[] = [
  batchScenario('batch.anthropic.claude-sonnet-4-5.submit', [anthropicBatch], (fetch) =>
    createAnthropic({ ...key, fetch })('claude-sonnet-4-5'),
  ),
  batchScenario(
    'batch.openai-chat.gpt-5.5.submit',
    [openaiFile, openaiBatch('/v1/chat/completions')],
    (fetch) => createOpenAI({ ...key, fetch })('gpt-5.5'),
  ),
  batchScenario(
    'batch.openai-responses.gpt-5.4.submit',
    [openaiFile, openaiBatch('/v1/responses')],
    (fetch) => createOpenAIResponses({ ...key, fetch })('gpt-5.4'),
  ),
  batchScenario('batch.google-native.gemini-2.5-flash.submit', [geminiBatch], (fetch) =>
    createGoogleNative({ ...key, fetch })('gemini-2.5-flash'),
  ),
];

/** Every golden scenario, in a stable order. */
export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  ...CHAT_TARGETS.flatMap((target) => target.kinds.map((kind) => chatScenario(target, kind))),
  ...EMBEDDING_CASES.map(embeddingScenario),
  ...MEDIA_SCENARIOS,
  ...BATCH_SCENARIOS,
];
