import { describe, it, expect } from 'vitest';
import { resolveModelProfile, type ModelProfile } from '../src/model-profile';
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
import type { LanguageModel } from '../src/types/model';
import type { CallWarning } from '../src/types/methods';
import type { WireToolRequest } from '../src/adapters/types';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

// ===================================================================
// 2.3 — model profiles (roadmap 5.4). Facts are verified against Anthropic's
// API reference (cached 2026-10-06) or research-dated (roadmap 5.3,
// 2026-10-09); none is live-verified.
// ===================================================================

/** A profile is a pure read: any network call is a bug. */
const noNetwork = (() => {
  throw new Error('a model profile must never touch the network');
}) as unknown as typeof fetch;

const ANTHROPIC_KEY = 'sk-ant-profile-secret';
const OPENAI_KEY = 'sk-profile-secret';
const anthropic = createAnthropic({ apiKey: ANTHROPIC_KEY, fetch: noNetwork });
const responses = createOpenAIResponses({ apiKey: OPENAI_KEY, fetch: noNetwork });
const chat = createOpenAI({ apiKey: OPENAI_KEY, fetch: noNetwork });
const native = createGoogleNative({ apiKey: 'AIza-profile', fetch: noNetwork });
const compatGoogle = createGoogle({ apiKey: 'AIza-profile', fetch: noNetwork });
const deepseek = createDeepSeek({ apiKey: 'k', fetch: noNetwork });
const kimi = createKimi({ apiKey: 'k', fetch: noNetwork });
const glm = createGLM({ apiKey: 'k', fetch: noNetwork });
const ollama = createOllama({ fetch: noNetwork });

/** The 16 ids roadmap 5.1 tracks, each on the wire its section names first. */
const TRACKED: [string, LanguageModel][] = [
  ['gpt-6.1-sol', responses('gpt-6.1-sol')],
  ['gpt-6-astra', responses('gpt-6-astra')],
  ['gpt-6-luna', responses('gpt-6-luna')],
  ['claude-fable-5-1', anthropic('claude-fable-5-1')],
  ['claude-opus-5-5', anthropic('claude-opus-5-5')],
  ['claude-sonnet-5-5', anthropic('claude-sonnet-5-5')],
  ['claude-haiku-5-5', anthropic('claude-haiku-5-5')],
  ['gemini-3.8-flash', native('gemini-3.8-flash')],
  ['gemini-3.1-pro-preview', native('gemini-3.1-pro-preview')],
  ['deepseek-flash', deepseek('deepseek-flash')],
  ['deepseek-v4-pro', deepseek('deepseek-v4-pro')],
  ['deepseek-v4-flash', deepseek('deepseek-v4-flash')],
  ['kimi-k3', kimi('kimi-k3')],
  ['kimi-k2.7-code', kimi('kimi-k2.7-code')],
  ['glm-5.3', glm('glm-5.3')],
  ['Qwen/Qwen3-Coder-Next', ollama('Qwen/Qwen3-Coder-Next')],
];

const CLAUDE_5 = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const ALL_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const clampsOf = (profile: ModelProfile, setting: string) =>
  profile.clamps.filter((c) => c.setting === setting);

describe('resolveModelProfile: the 16 tracked ids (2.3, roadmap 5.1/5.4)', () => {
  it('each resolves to a pinned profile with its source and check date — never live-verified', () => {
    for (const [id, model] of TRACKED) {
      const profile = resolveModelProfile(model);
      expect(profile.match, id).toBe('exact');
      expect(profile.requestedId, id).toBe(id);
      expect(profile.provider, id).toBe(model.provider);
      expect(profile.protocol, id).toBe(model.surface);
      expect(profile.liveVerified, id).toBe(false);
      expect(profile.sourceUrl, id).toMatch(/^https:\/\//);
      expect(profile.checkedAt, id).toMatch(/^2026-10-0[69]$/);
    }
  });

  it('a profile is a pure read: no network, no key, frozen all the way down', () => {
    for (const [id, model] of TRACKED) {
      const profile = resolveModelProfile(model);
      const json = JSON.stringify(profile);
      expect(json, id).not.toContain(ANTHROPIC_KEY);
      expect(json, id).not.toContain(OPENAI_KEY);
      expect(Object.isFrozen(profile), id).toBe(true);
      expect(Object.isFrozen(profile.capabilities), id).toBe(true);
      expect(Object.isFrozen(profile.effort.levels), id).toBe(true);
      expect(Object.isFrozen(profile.clamps), id).toBe(true);
      expect(
        profile.clamps.every((c) => Object.isFrozen(c)),
        id,
      ).toBe(true);
    }
    const profile = resolveModelProfile(anthropic('claude-opus-5-5'));
    expect(() => {
      (profile as { status: string }).status = 'preview';
    }).toThrow(TypeError);
    // A fresh copy every time: nothing shared to poison.
    expect(resolveModelProfile(anthropic('claude-opus-5-5'))).not.toBe(profile);
  });
});

describe('Claude 5.x profiles (verified against Anthropic’s API reference, cached 2026-10-06)', () => {
  it('limits, status and the shared request rules', () => {
    for (const id of CLAUDE_5) {
      const profile = resolveModelProfile(anthropic(id));
      expect(profile.status, id).toBe('stable');
      expect(profile.checkedAt, id).toBe('2026-10-06');
      expect(profile.limits, id).toEqual({
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        defaultOutputCap: 128_000,
      });
      expect(profile.capabilities, id).toEqual({
        tools: 'supported',
        vision: 'supported',
        reasoning: 'supported',
        structuredOutput: 'supported',
        caching: 'supported',
        // Not stated by the source → unknown, never a guessed "unsupported".
        nativePdf: 'unknown',
        audio: 'unknown',
      });
      expect(profile.effort.field, id).toBe('output_config.effort');
      expect(profile.effort.levels, id).toEqual(ALL_LEVELS);
      expect(profile.sampling.handling, id).toBe('stripped');
      expect(profile.prefill, id).toBe('unsupported');
      expect(profile.refusal, id).toBe('stop-reason');
      expect(profile.thinking.replay, id).toBe('thinking-blocks');
      expect(profile.cache, id).toEqual({ mode: 'breakpoints', promptCaching: 'supported' });
      expect(profile.usage.reasoningInclusive, id).toBe(true);
      // No effort level is changed: all five are real values.
      expect(
        clampsOf(profile, 'effort').filter((c) => c.from !== 'none'),
        id,
      ).toEqual([]);
      // Sampling is stripped and reported.
      expect(clampsOf(profile, 'temperature'), id).toEqual([
        { setting: 'temperature', from: '*', to: 'dropped', warning: 'unsupported-setting' },
      ]);
    }
  });

  it("per model: thinking modes, the 'none' mapping, sampling rule, forced tool_choice", () => {
    const fable = resolveModelProfile(anthropic('claude-fable-5-1'));
    expect(fable.thinking).toMatchObject({ mode: 'always', types: ['adaptive'] });
    expect(fable.effort.none).toBe('lowest');
    expect(fable.sampling.accepted).toBe('none');
    expect(fable.forcedToolChoice).toBe('unsupported');

    const opus = resolveModelProfile(anthropic('claude-opus-5-5'));
    expect(opus.thinking).toMatchObject({ mode: 'always', types: ['adaptive'] });
    expect(opus.effort).toMatchObject({ none: 'lowest', default: 'medium' });
    expect(opus.sampling.accepted).toBe('none');
    expect(opus.forcedToolChoice).toBe('unsupported');

    const sonnet = resolveModelProfile(anthropic('claude-sonnet-5-5'));
    expect(sonnet.thinking).toMatchObject({
      mode: 'default',
      types: ['adaptive', 'between_tools'],
    });
    expect(sonnet.effort).toMatchObject({ none: 'thinking-between-tools', default: 'high' });
    expect(sonnet.sampling.accepted).toBe('defaults-only');
    expect(sonnet.forcedToolChoice).toBe('unsupported');

    const haiku = resolveModelProfile(anthropic('claude-haiku-5-5'));
    expect(haiku.thinking).toMatchObject({ mode: 'default', types: ['adaptive', 'disabled'] });
    expect(haiku.effort).toMatchObject({ none: 'thinking-disabled', default: 'medium' });
    expect(haiku.sampling.accepted).toBe('defaults-only');
    expect(haiku.sampling.rule).toContain('never both');
    expect(haiku.forcedToolChoice).toBe('supported');
  });

  it('the clamps name every changed value and its warning', () => {
    const opus = resolveModelProfile(anthropic('claude-opus-5-5'));
    expect(opus.clamps).toEqual([
      { setting: 'effort', from: 'none', to: 'low', warning: 'clamped-setting' },
      { setting: 'temperature', from: '*', to: 'dropped', warning: 'unsupported-setting' },
      { setting: 'topP', from: '*', to: 'dropped', warning: 'unsupported-setting' },
      { setting: 'toolChoice', from: "'required'", to: 'auto', warning: 'clamped-setting' },
      { setting: 'toolChoice', from: "{ type: 'tool' }", to: 'auto', warning: 'clamped-setting' },
    ]);
    // Haiku 5.5 takes a forced choice and turns thinking off for 'none' — neither is a clamp.
    const haiku = resolveModelProfile(anthropic('claude-haiku-5-5'));
    expect(clampsOf(haiku, 'toolChoice')).toEqual([]);
    expect(clampsOf(haiku, 'effort')).toEqual([]);
  });

  it('an unknown id in the 5.x family: the family rules, its facts left unknown', () => {
    const profile = resolveModelProfile(anthropic('claude-opus-9-9'));
    expect(profile.match).toBe('family');
    expect(profile.status).toBe('unknown');
    expect(Object.values(profile.capabilities).every((s) => s === 'unknown')).toBe(true);
    expect(profile.thinking).toMatchObject({ mode: 'always', types: ['adaptive'] });
    expect(profile.effort).toMatchObject({ field: 'output_config.effort', none: 'lowest' });
    expect(profile.forcedToolChoice).toBe('unsupported');
    expect(profile.prefill).toBe('unsupported');
    expect(profile.sampling.handling).toBe('stripped');
    // The limit is unknown for this id; the request still carries the family's cap.
    expect(profile.limits).toEqual({ defaultOutputCap: 128_000 });
    expect(profile.notes.join(' ')).toContain('Claude 5.x');
  });
});

describe('OpenAI profiles (research 2026-10-09, not live-verified)', () => {
  it('gpt-6.1-sol: documented limits and levels; tools on Responses only; none → low', () => {
    for (const model of [responses('gpt-6.1-sol'), chat('gpt-6.1-sol')]) {
      const profile = resolveModelProfile(model);
      expect(profile.limits).toEqual({
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        defaultOutputCap: 128_000,
      });
      expect(profile.effort).toMatchObject({ levels: ALL_LEVELS, none: 'lowest' });
      expect(profile.thinking.mode).toBe('always');
      expect(profile.toolProtocols).toEqual(['responses']);
      expect(clampsOf(profile, 'effort')).toEqual([
        { setting: 'effort', from: 'none', to: 'low', warning: 'clamped-setting' },
      ]);
      // What the source does not state stays unknown.
      expect(profile.capabilities.vision).toBe('unknown');
      expect(profile.capabilities.structuredOutput).toBe('unknown');
    }
    expect(resolveModelProfile(responses('gpt-6.1-sol')).effort.field).toBe('reasoning.effort');
    expect(resolveModelProfile(chat('gpt-6.1-sol')).effort.field).toBe('reasoning_effort');
  });

  it('gpt-6-astra / gpt-6-luna: undocumented limits are unknown and no cap is sent', () => {
    for (const id of ['gpt-6-astra', 'gpt-6-luna']) {
      const profile = resolveModelProfile(responses(id));
      expect(profile.limits, id).toEqual({ defaultOutputCap: 'omitted' });
      expect(profile.capabilities.vision, id).toBe('unknown');
      expect(profile.capabilities.reasoning, id).toBe('supported');
    }
    expect(resolveModelProfile(responses('gpt-6-luna')).effort.none).toBe('send');
    expect(resolveModelProfile(responses('gpt-6-luna')).thinking.mode).toBe('default');
  });

  it("a legacy pinned row mirrors the registry: gpt-5.4 clamps 'max' to 'xhigh'", () => {
    const profile = resolveModelProfile(responses('gpt-5.4'));
    expect(profile).toMatchObject({ match: 'exact', status: 'unknown', liveVerified: false });
    expect(profile.sourceUrl).toBeUndefined();
    expect(profile.capabilities.vision).toBe('supported');
    expect(profile.effort).toMatchObject({
      field: 'reasoning.effort',
      levels: ['low', 'medium', 'high', 'xhigh'],
      none: 'send',
    });
    expect(clampsOf(profile, 'effort')).toEqual([
      { setting: 'effort', from: 'max', to: 'xhigh', warning: 'clamped-setting' },
    ]);
    expect(profile.thinking.replay).toBe('encrypted-reasoning');
    expect(profile.cache.mode).toBe('implicit');
  });
});

describe('Gemini profiles', () => {
  it('gemini-3.8-flash: GA, thinking low/medium/high (default medium), no way to turn it off', () => {
    const profile = resolveModelProfile(native('gemini-3.8-flash'));
    expect(profile.status).toBe('stable');
    expect(profile.effort).toEqual({
      field: 'thinkingConfig.thinkingLevel',
      levels: ['low', 'medium', 'high'],
      default: 'medium',
      none: 'lowest',
    });
    expect(profile.thinking).toMatchObject({ mode: 'always', replay: 'thought-signatures' });
    expect(clampsOf(profile, 'effort')).toEqual([
      { setting: 'effort', from: 'xhigh', to: 'high', warning: 'clamped-setting' },
      { setting: 'effort', from: 'max', to: 'high', warning: 'clamped-setting' },
      { setting: 'effort', from: 'none', to: 'low', warning: 'clamped-setting' },
    ]);
    expect(profile.limits).toEqual({ defaultOutputCap: 'omitted' });
    expect(profile.usage.reasoningInclusive).toBe(false); // thoughts are counted apart
  });

  it('gemini-3.1-pro-preview is a preview profile on both wires; the native one takes low/high only', () => {
    expect(resolveModelProfile(native('gemini-3.1-pro-preview')).status).toBe('preview');
    expect(resolveModelProfile(compatGoogle('gemini-3.1-pro-preview')).status).toBe('preview');
    const profile = resolveModelProfile(native('gemini-3.1-pro-preview'));
    expect(profile.effort.levels).toEqual(['low', 'high']);
    expect(clampsOf(profile, 'effort').map((c) => `${c.from}→${c.to}`)).toEqual([
      'medium→low',
      'xhigh→high',
      'max→high',
    ]);
  });

  it('an alias that was shut down: gemini-3-pro is deprecated and resolves to 3.1 Pro Preview', () => {
    expect(resolveModelProfile(native('gemini-3-pro'))).toMatchObject({
      status: 'deprecated',
      resolvedId: 'gemini-3.1-pro-preview',
    });
  });
});

describe('compat-host profiles (research 2026-10-09, not live-verified)', () => {
  it('DeepSeek: documented resolution, the three output limits kept apart', () => {
    expect(resolveModelProfile(deepseek('deepseek-flash')).resolvedId).toBe('V4.1-Flash');
    const pro = resolveModelProfile(deepseek('deepseek-v4-pro'));
    expect(pro.resolvedId).toBe('V4-Pro-0813');
    // Provider maximum, default request cap and context window are separate facts.
    expect(pro.limits).toEqual({ maxOutput: 65_536, defaultOutputCap: 8_192 });
    expect(pro.effort.none).toBe('omit');
    expect(pro.thinking).toMatchObject({ mode: 'always', replay: 'reasoning-content' });
    expect(pro.forcedToolChoice).toBe('unsupported');
    expect(pro.capabilities.structuredOutput).toBe('unsupported');
    expect(clampsOf(pro, 'effort')).toContainEqual({
      setting: 'effort',
      from: 'none',
      to: 'dropped',
      warning: 'unsupported-setting',
    });
    expect(resolveModelProfile(deepseek('deepseek-v4-flash')).notes.join(' ')).toContain(
      'legacy alias',
    );
  });

  it('Kimi K3 and K2.7 Code, GLM 5.3: effort semantics per model', () => {
    const k3 = resolveModelProfile(kimi('kimi-k3'));
    expect(k3.effort).toEqual({
      field: 'reasoning_effort',
      levels: ['low', 'high', 'max'],
      default: 'max',
      none: 'lowest',
    });
    expect(k3.thinking.mode).toBe('always');
    expect(clampsOf(k3, 'effort').map((c) => `${c.from}→${c.to}`)).toEqual([
      'medium→low',
      'xhigh→high',
      'none→low',
    ]);

    const code = resolveModelProfile(kimi('kimi-k2.7-code'));
    expect(code.effort).toEqual({ levels: [], none: 'omit' });
    expect(code.thinking.mode).toBe('always');
    expect(clampsOf(code, 'effort')).toHaveLength(6); // every level and 'none': dropped
    expect(clampsOf(code, 'effort').every((c) => c.warning === 'unsupported-setting')).toBe(true);

    const z = resolveModelProfile(glm('glm-5.3'));
    expect(z.capabilities.vision).toBe('unsupported'); // documented text-only
    expect(z.effort).toMatchObject({ levels: ['low', 'high', 'max'], default: 'max' });
    expect(z.notes.join(' ')).toContain('baseURL');
  });

  it('Qwen3-Coder-Next: non-thinking on any host, 262_144 context, engine-dependent tools', () => {
    const hosts = [
      ollama('Qwen/Qwen3-Coder-Next'),
      createLMStudio({ fetch: noNetwork })('Qwen/Qwen3-Coder-Next'),
      createOpenAICompatible({ id: 'vllm', baseURL: 'http://gpu:8000/v1', fetch: noNetwork })(
        'Qwen/Qwen3-Coder-Next',
      ),
    ];
    for (const model of hosts) {
      const profile = resolveModelProfile(model);
      expect(profile.provider).toBe(model.provider);
      expect(profile.capabilities.reasoning).toBe('unsupported');
      expect(profile.capabilities.tools).toBe('unknown');
      expect(profile.thinking).toMatchObject({ mode: 'never', replay: 'none' });
      expect(profile.effort).toEqual({ levels: [], none: 'model-default' });
      expect(profile.limits).toEqual({ contextWindow: 262_144, defaultOutputCap: 'omitted' });
    }
  });
});

describe('unknown ids and caller claims', () => {
  it('a fallback row is all unknown: no limits, no status, no source', () => {
    const together = createOpenAICompatible({
      id: 'together',
      baseURL: 'https://api.together.xyz/v1',
      apiKey: 'k',
      fetch: noNetwork,
    });
    const profile = resolveModelProfile(together('acme/never-heard-of-it'));
    expect(profile.match).toBe('fallback');
    expect(profile.status).toBe('unknown');
    expect(Object.values(profile.capabilities).every((s) => s === 'unknown')).toBe(true);
    expect(profile.limits).toEqual({ defaultOutputCap: 'omitted' });
    expect(profile.thinking).toMatchObject({ mode: 'unknown', replay: 'unknown' });
    expect(profile.sourceUrl).toBeUndefined();
    expect(profile.notes.join(' ')).toContain('conservative');

    // Anthropic requires max_tokens, so its fallback cap is sent — and named.
    const claude = resolveModelProfile(anthropic('claude-unreleased-9'));
    expect(claude.limits).toEqual({ defaultOutputCap: 4_096 });
  });

  it('a factory capabilities claim is reported as the caller’s word', () => {
    const profile = resolveModelProfile(
      createOllama({ fetch: noNetwork, capabilities: { tools: true, maxOutput: 32_000 } })(
        'my-finetune:latest',
      ),
    );
    expect(profile.capabilities.tools).toBe('supported');
    expect(profile.capabilities.vision).toBe('unknown');
    expect(profile.limits).toEqual({ maxOutput: 32_000, defaultOutputCap: 32_000 });
    // A claim also overrides a documented gap.
    const qwen = resolveModelProfile(
      createOllama({ fetch: noNetwork, capabilities: { tools: true } })('Qwen/Qwen3-Coder-Next'),
    );
    expect(qwen.capabilities.tools).toBe('supported');
  });
});

// -------------------------------------------------------------------
// The profile predicts what a request does; this checks the prediction
// against the real pump for every effort value, so the two cannot drift.
// -------------------------------------------------------------------

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

const TOOLS: WireToolRequest = {
  tools: [{ name: 'echo', parameters: { type: 'object', properties: {} } }],
  toolChoice: 'required',
};

/** Rebuild the same descriptor on a recording fetch, then run one request. */
async function realRequest(
  make: (fetch: typeof globalThis.fetch) => LanguageModel,
  options: { effort?: string; temperature?: number },
  tools?: WireToolRequest,
): Promise<{ body: Record<string, unknown>; warnings: CallWarning[] }> {
  let surface: LanguageModel['surface'] = 'anthropic';
  const { fetch, calls } = mockFetch(() => sseResponse([BODIES[surface]]));
  const model = make(fetch);
  surface = model.surface;
  const result = runStream(
    {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ...(options as object),
    },
    tools ? { tools } : {},
  );
  for await (const _ of result.fullStream) void _;
  return {
    body: JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>,
    warnings: await result.warnings!,
  };
}

/** Read the effort a request carried, at the profile's own field path. */
function wireEffort(body: Record<string, unknown>, field: string | undefined): unknown {
  if (field === undefined) return undefined;
  const path = field.startsWith('thinkingConfig.') ? `generationConfig.${field}` : field;
  return path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], body);
}

const CROSS_CHECK: [string, (fetch: typeof globalThis.fetch) => LanguageModel][] = [
  ...TRACKED.map(([id, model]): [string, (fetch: typeof globalThis.fetch) => LanguageModel] => [
    id,
    (fetch) => {
      switch (model.provider) {
        case 'anthropic':
          return createAnthropic({ apiKey: 'k', fetch })(id);
        case 'openai':
          return createOpenAIResponses({ apiKey: 'k', fetch })(id);
        case 'google':
          return createGoogleNative({ apiKey: 'AIza-k', fetch })(id);
        case 'deepseek':
          return createDeepSeek({ apiKey: 'k', fetch })(id);
        case 'moonshot':
          return createKimi({ apiKey: 'k', fetch })(id);
        case 'glm':
          return createGLM({ apiKey: 'k', fetch })(id);
        default:
          return createOllama({ fetch })(id);
      }
    },
  ]),
  // Legacy wires with their own clamps, the family fallback and a plain fallback.
  ['claude-opus-4-6', (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-6')],
  ['claude-opus-9-9', (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-opus-9-9')],
  ['gemini-2.5-pro', (fetch) => createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-pro')],
  ['gpt-5.4', (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4')],
  ['gpt-6.1-sol (chat)', (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-6.1-sol')],
  ['gpt-6.2-unreleased', (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-6.2')],
];

describe('the profile predicts the request (cross-check against the real pump)', () => {
  it('every effort value: same clamp, same warning, same wire value', async () => {
    for (const [label, make] of CROSS_CHECK) {
      const profile = resolveModelProfile(make(noNetwork));
      for (const effort of [...ALL_LEVELS, 'none']) {
        const { body, warnings } = await realRequest(make, { effort });
        const reported = warnings.filter((w) => w.setting === 'effort');
        const predicted = profile.clamps.filter((c) => c.setting === 'effort' && c.from === effort);
        const where = `${label} effort=${effort}`;
        expect(
          reported.map((w) => w.type),
          where,
        ).toEqual(predicted.map((c) => c.warning));
        const sent = wireEffort(body, profile.effort.field);
        const clamp = predicted[0];
        if (clamp?.to === 'dropped') {
          expect(sent, where).toBeUndefined();
        } else if (clamp && /^[a-z]+$/.test(clamp.to)) {
          expect(sent, where).toBe(clamp.to);
        } else if (clamp) {
          expect(`${profile.effort.field} ${String(sent)}`, where).toBe(clamp.to);
        } else if (effort !== 'none' && profile.effort.levels.length > 0) {
          expect(sent === effort || typeof sent === 'number', where).toBe(true);
        }
      }
    }
  });

  it('sampling and forced tool choice: same handling as the profile says', async () => {
    for (const [label, make] of CROSS_CHECK) {
      const profile = resolveModelProfile(make(noNetwork));
      const { body, warnings } = await realRequest(make, { temperature: 0.2 });
      const sentTemperature =
        profile.protocol === 'native'
          ? (body.generationConfig as Record<string, unknown>).temperature
          : body.temperature;
      const stripped = profile.sampling.handling === 'stripped';
      expect(sentTemperature, label).toBe(stripped ? undefined : 0.2);
      expect(
        warnings.some((w) => w.setting === 'temperature'),
        label,
      ).toBe(stripped);

      if (profile.toolProtocols && !profile.toolProtocols.includes(profile.protocol)) continue;
      const forced = await realRequest(make, {}, TOOLS);
      const always = clampsOf(profile, 'toolChoice').filter((c) => c.when === undefined);
      expect(
        forced.warnings.filter((w) => w.setting === 'toolChoice').map((w) => w.type),
        label,
      ).toEqual(always.length > 0 ? ['clamped-setting'] : []);
    }
  });
});
