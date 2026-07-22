import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import { createAzure } from '../src/azure';
import { createBedrock } from '../src/bedrock';
import { createKimi, createMoonshot } from '../src/providers-compat';
import { readConfig } from '../src/internal/config-symbol';
import { InvalidRequestError } from '../src/errors';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const CC = sseEvents([
  { data: { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] } },
  { data: { choices: [{ delta: { content: ' Azure' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } } },
  { data: '[DONE]' },
]);

describe('createAzure', () => {
  it('builds deployment URL + api-version query + api-key auth', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC]));
    const result = streamChat({
      model: createAzure({
        apiKey: 'azure-key',
        resourceName: 'my-resource',
        apiVersion: '2024-12-01-preview',
        fetch,
      })('gpt-4o'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('Hi Azure');
    expect(await result.finishReason).toBe('stop');

    expect(calls[0]!.url).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-12-01-preview',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['api-key']).toBe('azure-key');
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o');
  });

  it('uses Bearer when auth: bearer (Entra)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC]));
    const result = streamChat({
      model: createAzure({
        apiKey: 'entra-token',
        resourceName: 'my-resource',
        auth: 'bearer',
        fetch,
      })('gpt-4o'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _ of result.textStream) {
      /* drain */
    }
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer entra-token');
    expect(headers['api-key']).toBeUndefined();
  });

  it('throws when neither resourceName nor baseURL is set', () => {
    expect(() => createAzure({ apiKey: 'k' })('gpt-4o')).toThrow(InvalidRequestError);
  });

  it('honors baseURL override (Foundry / proxy)', () => {
    const model = createAzure({
      apiKey: 'k',
      baseURL: 'https://my-foundry.example/openai/v1',
    })('deploy-a');
    const cfg = readConfig(model)!;
    expect(cfg.baseURL).toBe('https://my-foundry.example/openai/v1');
    expect(cfg.query).toEqual({ 'api-version': '2024-12-01-preview' });
    expect(cfg.authHeader).toBe('api-key');
  });
});

describe('createBedrock', () => {
  it('hits Mantle OpenAI-compat URL with Bearer auth', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC]));
    const result = streamChat({
      model: createBedrock({
        apiKey: 'bedrock-bearer',
        region: 'us-west-2',
        fetch,
      })('openai.gpt-oss-120b'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('Hi Azure');

    expect(calls[0]!.url).toBe(
      'https://bedrock-mantle.us-west-2.api.aws/openai/v1/chat/completions',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer bedrock-bearer');
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.model).toBe('openai.gpt-oss-120b');
  });

  it('defaults region to us-east-1', () => {
    const cfg = readConfig(createBedrock({ apiKey: 'k' })('m'))!;
    expect(cfg.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1');
  });
});

describe('createKimi alias', () => {
  it('shares moonshot provider id and host settings', () => {
    const viaKimi = readConfig(
      createKimi({ apiKey: 'k', baseURL: 'https://example.test/v1' })('kimi-k2'),
    )!;
    const viaMoon = readConfig(
      createMoonshot({ apiKey: 'k', baseURL: 'https://example.test/v1' })('kimi-k2'),
    )!;
    expect(viaKimi.provider).toBe('moonshot');
    expect(viaKimi.baseURL).toBe(viaMoon.baseURL);
    expect(viaKimi.apiKey).toBe(viaMoon.apiKey);
  });
});
