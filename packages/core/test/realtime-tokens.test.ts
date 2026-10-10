import { describe, it, expect } from 'vitest';
import {
  createOpenAIClientSecret,
  createGeminiAuthToken,
  createOpenAIRealtime,
  createGeminiLive,
} from '../src/realtime';
import { tool } from '../src/tool';
import { AuthenticationError, InvalidRequestError } from '../src/errors';
import type { JSONSchema } from '../src/types/schema';
import { manualClock } from './fixtures/manual-clock';

const CITY: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

/** A fetch double that answers every request with `body` and records the request. */
function jsonFetch(
  body: unknown,
  status = 200,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const headersOf = (init: RequestInit) =>
  Object.fromEntries(
    Object.entries(init.headers as Record<string, string>).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );

describe('createOpenAIClientSecret', () => {
  it('POSTs /realtime/client_secrets with the session config and returns the ek_ value', async () => {
    const reply = {
      value: 'ek_68af',
      expires_at: 1_760_000_000,
      session: { id: 'sess_1', type: 'realtime', object: 'realtime.session' },
    };
    const { fetch, calls } = jsonFetch(reply);
    const secret = await createOpenAIClientSecret({
      model: createOpenAIRealtime({ apiKey: 'sk-server' })('gpt-realtime'),
      instructions: 'Be brief.',
      voice: 'marin',
      tools: { get_weather: tool({ description: 'Weather for a city', parameters: CITY }) },
      expiresInSeconds: 120,
      deps: { fetch },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!.init)).toMatchObject({
      authorization: 'Bearer sk-server',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      expires_after: { anchor: 'created_at', seconds: 120 },
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: 'Be brief.',
        audio: { output: { voice: 'marin' } },
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Weather for a city',
            parameters: CITY,
          },
        ],
      },
    });
    expect(secret).toEqual({ token: 'ek_68af', expiresAt: 1_760_000_000_000, raw: reply });
  });

  it('maps an HTTP failure onto the typed error taxonomy without leaking the key', async () => {
    const { fetch } = jsonFetch(
      { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
      401,
    );
    const failure = await createOpenAIClientSecret({
      model: createOpenAIRealtime({ apiKey: 'sk-secret-value' })('gpt-realtime'),
      deps: { fetch },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(JSON.stringify(failure)).not.toContain('sk-secret-value');
  });

  it('rejects a reply without a secret value', async () => {
    const { fetch } = jsonFetch({ expires_at: 1 });
    await expect(
      createOpenAIClientSecret({
        model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
        deps: { fetch },
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('needs a server-side API key', async () => {
    const { fetch, calls } = jsonFetch({});
    await expect(
      createOpenAIClientSecret({ model: createOpenAIRealtime()('gpt-realtime'), deps: { fetch } }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(0);
  });
});

describe('createGeminiAuthToken', () => {
  const MODEL = 'gemini-live-2.5-flash-preview';

  it('POSTs v1alpha/auth_tokens and locks the session setup into the token by default', async () => {
    const { clock } = manualClock(Date.UTC(2026, 9, 10, 12, 0, 0));
    const reply = { name: 'auth_tokens/xyz', expireTime: '2026-10-10T12:30:00Z', uses: 1 };
    const { fetch, calls } = jsonFetch(reply);
    const token = await createGeminiAuthToken({
      model: createGeminiLive({ apiKey: 'g-server' })(MODEL),
      instructions: 'Be brief.',
      outputModality: 'audio',
      uses: 1,
      expiresInSeconds: 1_800,
      newSessionExpiresInSeconds: 60,
      deps: { fetch, clock },
    });

    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1alpha/auth_tokens');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!.init)).toMatchObject({
      'x-goog-api-key': 'g-server',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      uses: 1,
      expireTime: '2026-10-10T12:30:00.000Z',
      newSessionExpireTime: '2026-10-10T12:01:00.000Z',
      bidiGenerateContentSetup: {
        model: `models/${MODEL}`,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
      },
    });
    expect(token).toEqual({
      token: 'auth_tokens/xyz',
      expiresAt: Date.UTC(2026, 9, 10, 12, 30, 0),
      raw: reply,
    });
  });

  it('sends no constraints when unlocked, and a field mask when only some fields are locked', async () => {
    const unlocked = jsonFetch({ name: 'auth_tokens/a' });
    await createGeminiAuthToken({
      model: createGeminiLive({ apiKey: 'g' })(MODEL),
      instructions: 'ignored when unlocked',
      lockConfig: false,
      deps: { fetch: unlocked.fetch },
    });
    expect(JSON.parse(String(unlocked.calls[0]!.init.body))).toEqual({});

    const masked = jsonFetch({ name: 'auth_tokens/b' });
    await createGeminiAuthToken({
      model: createGeminiLive({ apiKey: 'g' })(MODEL),
      instructions: 'Be brief.',
      lockConfig: ['systemInstruction', 'generationConfig.temperature'],
      deps: { fetch: masked.fetch },
    });
    expect(JSON.parse(String(masked.calls[0]!.init.body))).toEqual({
      bidiGenerateContentSetup: {
        model: `models/${MODEL}`,
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
      },
      fieldMask: 'systemInstruction,generationConfig.temperature',
    });
  });

  it('maps a rejected key onto AuthenticationError', async () => {
    const { fetch } = jsonFetch(
      {
        error: {
          code: 403,
          message: 'Method doesn’t allow unregistered callers',
          status: 'PERMISSION_DENIED',
        },
      },
      403,
    );
    await expect(
      createGeminiAuthToken({ model: createGeminiLive({ apiKey: 'g' })(MODEL), deps: { fetch } }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
