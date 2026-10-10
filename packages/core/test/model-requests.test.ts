import { describe, it, expect } from 'vitest';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogle, createGoogleNative } from '../src/google';
import {
  createDeepSeek,
  createGLM,
  createKimi,
  createLMStudio,
  createOllama,
  createOpenAICompatible,
} from '../src/providers-compat';
import { runStream } from '../src/core/inference';
import { generateObject } from '../src/index';
import { InvalidRequestError } from '../src/errors';
import type { LanguageModel } from '../src/types/model';
import type { CommonCallOptions } from '../src/types/config';
import type { WireToolRequest } from '../src/adapters/types';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

// ===================================================================
// 2.3 (F08, F14, F20, F26) — a request snapshot for each of the 16 model ids
// roadmap 5.1 tracks, plus the other wires the 2.2.0 matrix exercised
// (docs/research/repro-2.2.0/c-models/t1-matrix). Every row is the rule set
// of roadmap 5.2 (Anthropic, verified against the API reference cached
// 2026-10-06) or 5.3 (research-dated 2026-10-09). NOT live-verified: these
// pin what the SDK sends, not what a provider answers.
// ===================================================================

type Make = (fetch: typeof globalThis.fetch) => LanguageModel;

const BODIES: Record<LanguageModel['surface'], string> = {
  anthropic: sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 1 } } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]),
  chat_completions: sseEvents([
    { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
    { data: '[DONE]' },
  ]),
  responses: sseEvents([
    {
      event: 'response.completed',
      data: { type: 'response.completed', response: { status: 'completed', usage: {} } },
    },
  ]),
  native: sseEvents([
    {
      data: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
    },
  ]),
};

/** The request fields the model rules govern (t1-matrix's pick, plus top_p and tools). */
const PICK = [
  'max_output_tokens',
  'max_tokens',
  'max_completion_tokens',
  'reasoning',
  'reasoning_effort',
  'include',
  'store',
  'thinking',
  'output_config',
  'temperature',
  'top_p',
  'tool_choice',
  'generationConfig',
  'toolConfig',
] as const;

interface Snapshot {
  /** Path (and query) of the request URL. */
  url: string;
  wire: Record<string, unknown>;
  /** `type:setting` of every warning the call reported. */
  warnings: string[];
}

async function snapshot(
  make: Make,
  options: Partial<CommonCallOptions>,
  tools?: WireToolRequest,
): Promise<Snapshot | { error: unknown }> {
  let surface: LanguageModel['surface'] = 'anthropic';
  const { fetch, calls } = mockFetch(() => sseResponse([BODIES[surface]]));
  const model = make(fetch);
  surface = model.surface;
  const result = runStream(
    { ...options, model, messages: [{ role: 'user', content: 'hi' }] },
    tools ? { tools } : {},
  );
  let error: unknown;
  for await (const part of result.fullStream) if (part.type === 'error') error = part.error;
  if (error !== undefined) return { error };
  const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
  const wire: Record<string, unknown> = {};
  for (const key of PICK) if (key in body) wire[key] = body[key];
  return {
    url: calls[0]!.url.replace(/^https?:\/\/[^/]+/, ''),
    wire,
    warnings: (await result.warnings!).map((w) => `${w.type}${w.setting ? `:${w.setting}` : ''}`),
  };
}

const anthropic: (id: string) => Make = (id) => (fetch) =>
  createAnthropic({ apiKey: 'k', fetch })(id);
const responses: (id: string) => Make = (id) => (fetch) =>
  createOpenAIResponses({ apiKey: 'k', fetch })(id);
const chat: (id: string) => Make = (id) => (fetch) => createOpenAI({ apiKey: 'k', fetch })(id);
const native: (id: string) => Make = (id) => (fetch) =>
  createGoogleNative({ apiKey: 'AIza-k', fetch })(id);
const googleCompat: (id: string) => Make = (id) => (fetch) =>
  createGoogle({ apiKey: 'AIza-k', fetch })(id);
const deepseek: (id: string) => Make = (id) => (fetch) =>
  createDeepSeek({ apiKey: 'k', fetch })(id);
const kimi: (id: string) => Make = (id) => (fetch) => createKimi({ apiKey: 'k', fetch })(id);
const glm: (id: string) => Make = (id) => (fetch) => createGLM({ apiKey: 'k', fetch })(id);

const QWEN = 'Qwen/Qwen3-Coder-Next';
const ENCRYPTED = ['reasoning.encrypted_content'];
const TEMP_DROPPED = 'unsupported-setting:temperature';
const EFFORT_CLAMPED = 'clamped-setting:effort';
const EFFORT_DROPPED = 'unsupported-setting:effort';

/**
 * One row per (model id, wire): the request for `effort` high and max, each
 * with `temperature: 0.2`. `max` is only listed where it differs from `high`
 * by more than the level itself.
 */
const MATRIX: {
  label: string;
  make: Make;
  url: string;
  high: Omit<Snapshot, 'url'>;
  max: Omit<Snapshot, 'url'>;
}[] = [
  // --- OpenAI Responses: stateless (F20), sampling stripped, Sol keeps 'max' (F08) ---
  {
    label: 'gpt-6.1-sol',
    make: responses('gpt-6.1-sol'),
    url: '/v1/responses',
    high: {
      wire: {
        max_output_tokens: 128_000,
        reasoning: { effort: 'high' },
        store: false,
        include: ENCRYPTED,
      },
      warnings: [TEMP_DROPPED],
    },
    max: {
      wire: {
        max_output_tokens: 128_000,
        reasoning: { effort: 'max' },
        store: false,
        include: ENCRYPTED,
      },
      warnings: [TEMP_DROPPED],
    },
  },
  ...(['gpt-6-astra', 'gpt-6-luna'] as const).map((id) => ({
    label: id,
    make: responses(id),
    url: '/v1/responses',
    // Output limit undocumented: no cap. 'max' is not documented → xhigh, reported.
    high: {
      wire: { reasoning: { effort: 'high' }, store: false, include: ENCRYPTED },
      warnings: [TEMP_DROPPED],
    },
    max: {
      wire: { reasoning: { effort: 'xhigh' }, store: false, include: ENCRYPTED },
      warnings: [TEMP_DROPPED, EFFORT_CLAMPED],
    },
  })),
  {
    label: 'gpt-6.1-sol (Chat Completions, tool-less)',
    make: chat('gpt-6.1-sol'),
    url: '/v1/chat/completions',
    high: {
      wire: { max_completion_tokens: 128_000, reasoning_effort: 'high' },
      warnings: [TEMP_DROPPED],
    },
    max: {
      wire: { max_completion_tokens: 128_000, reasoning_effort: 'max' },
      warnings: [TEMP_DROPPED],
    },
  },

  // --- Claude 5.x (F14): only output_config.effort — no thinking, no sampling ---
  ...['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({
    label: id,
    make: anthropic(id),
    url: '/v1/messages',
    high: {
      wire: { max_tokens: 128_000, output_config: { effort: 'high' } },
      warnings: [TEMP_DROPPED],
    },
    max: {
      wire: { max_tokens: 128_000, output_config: { effort: 'max' } },
      warnings: [TEMP_DROPPED],
    },
  })),

  // --- Gemini ---
  {
    // GA; thinking low/medium/high, no output cap invented.
    label: 'gemini-3.8-flash',
    make: native('gemini-3.8-flash'),
    url: '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    high: {
      wire: {
        generationConfig: {
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
        },
      },
      warnings: [],
    },
    max: {
      wire: {
        generationConfig: {
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
        },
      },
      warnings: [EFFORT_CLAMPED],
    },
  },
  {
    // No compat row: the conservative fallback, which no longer sends a 4096 cap.
    label: 'gemini-3.8-flash (OpenAI-compat)',
    make: googleCompat('gemini-3.8-flash'),
    url: '/v1beta/openai/chat/completions',
    high: { wire: { temperature: 0.2 }, warnings: ['unknown-model', EFFORT_DROPPED] },
    max: { wire: { temperature: 0.2 }, warnings: ['unknown-model', EFFORT_DROPPED] },
  },
  {
    label: 'gemini-3.1-pro-preview',
    make: native('gemini-3.1-pro-preview'),
    url: '/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
    high: {
      wire: {
        generationConfig: {
          maxOutputTokens: 64_000,
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
        },
      },
      warnings: [],
    },
    max: {
      wire: {
        generationConfig: {
          maxOutputTokens: 64_000,
          temperature: 0.2,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
        },
      },
      warnings: [EFFORT_CLAMPED],
    },
  },
  {
    label: 'gemini-3.1-pro-preview (OpenAI-compat, no reasoning there)',
    make: googleCompat('gemini-3.1-pro-preview'),
    url: '/v1beta/openai/chat/completions',
    high: { wire: { max_tokens: 64_000, temperature: 0.2 }, warnings: [EFFORT_DROPPED] },
    max: { wire: { max_tokens: 64_000, temperature: 0.2 }, warnings: [EFFORT_DROPPED] },
  },

  // --- DeepSeek ---
  {
    label: 'deepseek-flash',
    make: deepseek('deepseek-flash'),
    url: '/v1/chat/completions',
    high: { wire: { reasoning_effort: 'high', temperature: 0.2 }, warnings: [] },
    max: { wire: { reasoning_effort: 'xhigh', temperature: 0.2 }, warnings: [EFFORT_CLAMPED] },
  },
  ...(['deepseek-v4-pro', 'deepseek-v4-flash'] as const).map((id) => ({
    label: id,
    make: deepseek(id),
    url: '/v1/chat/completions',
    high: {
      wire: { max_tokens: 8_192, reasoning_effort: 'high', temperature: 0.2 },
      warnings: [],
    },
    max: {
      wire: { max_tokens: 8_192, reasoning_effort: 'xhigh', temperature: 0.2 },
      warnings: [EFFORT_CLAMPED],
    },
  })),

  // --- Kimi, Z.ai ---
  {
    label: 'kimi-k3',
    make: kimi('kimi-k3'),
    url: '/v1/chat/completions',
    high: { wire: { reasoning_effort: 'high', temperature: 0.2 }, warnings: [] },
    max: { wire: { reasoning_effort: 'max', temperature: 0.2 }, warnings: [] },
  },
  {
    label: 'kimi-k2.7-code',
    make: kimi('kimi-k2.7-code'),
    url: '/v1/chat/completions',
    high: { wire: { temperature: 0.2 }, warnings: [EFFORT_DROPPED] },
    max: { wire: { temperature: 0.2 }, warnings: [EFFORT_DROPPED] },
  },
  {
    label: 'glm-5.3',
    make: glm('glm-5.3'),
    url: '/api/paas/v4/chat/completions',
    high: { wire: { reasoning_effort: 'high', temperature: 0.2 }, warnings: [] },
    max: { wire: { reasoning_effort: 'max', temperature: 0.2 }, warnings: [] },
  },

  // --- Open weights, on each documented host ---
  ...(
    [
      ['ollama', (fetch: typeof globalThis.fetch) => createOllama({ fetch })(QWEN)],
      ['lmstudio', (fetch: typeof globalThis.fetch) => createLMStudio({ fetch })(QWEN)],
      [
        'vllm',
        (fetch: typeof globalThis.fetch) =>
          createOpenAICompatible({
            id: 'vllm',
            baseURL: 'http://localhost:8000/v1',
            apiKeyOptional: true,
            fetch,
          })(QWEN),
      ],
    ] as const
  ).map(([host, make]) => ({
    label: `${QWEN} via ${host}`,
    make,
    url: '/v1/chat/completions',
    high: { wire: { temperature: 0.2 }, warnings: [EFFORT_DROPPED] },
    max: { wire: { temperature: 0.2 }, warnings: [EFFORT_DROPPED] },
  })),
];

describe('request snapshots per model id (2.3 — not live-verified)', () => {
  it('covers the 16 tracked ids', () => {
    const ids = new Set(MATRIX.map((row) => row.label.split(' ')[0]));
    expect([...ids].sort()).toEqual(
      [
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6-luna',
        'claude-fable-5-1',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
        'gemini-3.8-flash',
        'gemini-3.1-pro-preview',
        'deepseek-flash',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'kimi-k3',
        'kimi-k2.7-code',
        'glm-5.3',
        QWEN,
      ].sort(),
    );
  });

  for (const row of MATRIX) {
    it(`${row.label}: effort high / max, temperature 0.2`, async () => {
      for (const effort of ['high', 'max'] as const) {
        const got = await snapshot(row.make, { effort, temperature: 0.2 });
        expect(got, `${row.label} effort=${effort}`).toEqual({ url: row.url, ...row[effort] });
      }
    });
  }
});

describe('forced tool choice per model id (2.3, F14 — not live-verified)', () => {
  const FORCED: WireToolRequest = {
    tools: [{ name: 'echo', parameters: { type: 'object', properties: {} } }],
    toolChoice: 'required',
  };

  it('Fable 5.1 / Opus 5.5 / Sonnet 5.5 send auto, reported; Haiku 5.5 is forced', async () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      const got = await snapshot(anthropic(id), {}, FORCED);
      expect(got, id).toEqual({
        url: '/v1/messages',
        wire: { max_tokens: 128_000, tool_choice: { type: 'auto' } },
        warnings: ['clamped-setting:toolChoice'],
      });
    }
    expect(await snapshot(anthropic('claude-haiku-5-5'), {}, FORCED)).toEqual({
      url: '/v1/messages',
      wire: { max_tokens: 128_000, tool_choice: { type: 'any' } },
      warnings: [],
    });
  });

  it('DeepSeek V4 sends auto, reported: it rejects a forced tool_choice in thinking mode', async () => {
    // A live-verified rejection ("Thinking mode does not support this
    // tool_choice", test/live/deepseek.live.test.ts) that the rows now state.
    for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
      for (const toolChoice of ['required', { type: 'tool', toolName: 'echo' }] as const) {
        const got = await snapshot(deepseek(id), {}, { ...FORCED, toolChoice });
        expect(got, id).toEqual({
          url: '/v1/chat/completions',
          wire: { max_tokens: 8_192 },
          warnings: ['clamped-setting:toolChoice'],
        });
      }
    }
  });

  it("DeepSeek V4: generateObject mode 'tool' runs the json strategy, reported", async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([
        sseEvents([
          { data: { choices: [{ delta: { content: '{"a":"x"}' }, finish_reason: 'stop' }] } },
          { data: '[DONE]' },
        ]),
      ]),
    );
    const result = await generateObject({
      model: createDeepSeek({ apiKey: 'k', fetch })('deepseek-v4-pro'),
      prompt: 'hi',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      },
      mode: 'tool',
    });
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBeUndefined();
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
    const modes = (result.warnings ?? []).filter((w) => w.setting === 'mode');
    expect(modes.map((w) => w.type)).toEqual(['clamped-setting']);
  });

  it('every other tracked id keeps the forced choice on its wire', async () => {
    const cases: [string, Make, Record<string, unknown>][] = [
      ['gpt-6.1-sol', responses('gpt-6.1-sol'), { tool_choice: 'required' }],
      ['gpt-6-astra', responses('gpt-6-astra'), { tool_choice: 'required' }],
      ['gpt-6-luna', responses('gpt-6-luna'), { tool_choice: 'required' }],
      [
        'gemini-3.8-flash',
        native('gemini-3.8-flash'),
        { toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
      ],
      [
        'gemini-3.1-pro-preview',
        native('gemini-3.1-pro-preview'),
        { toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
      ],
      // No source states the V4 rejection for deepseek-flash, so it is not assumed.
      ['deepseek-flash', deepseek('deepseek-flash'), { tool_choice: 'required' }],
      ['kimi-k3', kimi('kimi-k3'), { tool_choice: 'required' }],
      ['glm-5.3', glm('glm-5.3'), { tool_choice: 'required' }],
    ];
    for (const [id, make, expected] of cases) {
      const got = await snapshot(make, {}, FORCED);
      expect('wire' in got && got.wire, id).toMatchObject(expected);
      expect('warnings' in got && got.warnings, id).toEqual([]);
    }
  });

  it('gpt-6.1-sol on Chat Completions: a tool request is refused before any network call', async () => {
    const got = await snapshot(chat('gpt-6.1-sol'), {}, FORCED);
    expect('error' in got && got.error).toBeInstanceOf(InvalidRequestError);
  });
});
