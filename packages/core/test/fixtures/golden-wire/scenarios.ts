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
import { createVoyage } from '../../../src/voyage';
import { createYunwuChat, createYunwuEmbedding } from '../../../src/yunwu';
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
import { SECRET, jsonAnswer, turn, type ScriptStep, type Wire, type WireRequest } from './harness';

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
  | 'image-input';

const ALL: readonly ChatKind[] = [
  'generate-text',
  'stream-chat',
  'tool-round',
  'generate-object',
  'run-agent',
  'call-options',
  'image-input',
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
    kinds: ALL,
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
    kinds: ALL,
  },
  {
    name: 'openai-responses.gpt-5.4',
    wire: 'responses',
    model: (fetch) => createOpenAIResponses({ ...key, fetch })('gpt-5.4'),
    kinds: ALL,
  },
  {
    name: 'google-native.gemini-2.5-flash',
    wire: 'gemini',
    model: (fetch) => createGoogleNative({ ...key, fetch })('gemini-2.5-flash'),
    kinds: ALL,
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

/** Every golden scenario, in a stable order. */
export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  ...CHAT_TARGETS.flatMap((target) => target.kinds.map((kind) => chatScenario(target, kind))),
  ...EMBEDDING_CASES.map(embeddingScenario),
];
