/**
 * realtime/tokens.ts — mint browser-safe credentials SERVER SIDE (2.3).
 *
 * A browser cannot send WebSocket handshake headers, so it cannot use an API
 * key — and must never hold one. Your server calls one of these helpers with
 * its key and hands the short-lived result to the browser, which passes it as
 * `ephemeralToken` to `createRealtimeSession`. Both take the same
 * provider-neutral config as a session, so the token can carry (and on Gemini,
 * lock) exactly the configuration the browser will use.
 *
 * Plain `fetch` through `deps.fetch`; HTTP failures map onto the usual error
 * taxonomy (401/403 → `AuthenticationError`, …). NOT LIVE-VERIFIED: request
 * and response shapes come from the `openai` 7.32 (`realtime.clientSecrets`)
 * and `@google/genai` 2.28 (`tokens.create`) SDKs.
 */
import { InvalidRequestError, UnsupportedCapabilityError } from '../errors';
import { mapMediaError, readErrorBody } from '../internal/media-http';
import { resolveDependencies } from '../internal/resolve-deps';
import type { ResolvedDependencies } from '../types/deps';
import type { CallWarning } from '../types/methods';
import { obj, str } from './encoding';
import { geminiBaseURL, geminiSetup } from './gemini';
import { readRealtimeConfig, resolveApiKey } from './models';
import { openaiSessionConfig } from './openai';
import { buildWireTools } from './tools';
import type {
  CreateGeminiAuthTokenOptions,
  CreateOpenAIClientSecretOptions,
  RealtimeModel,
  RealtimeSurface,
  RealtimeToken,
} from './types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const KEY_HINT = 'Pass apiKey to the model factory or a deps.keyProvider — on the server only.';

function assertSurface(model: RealtimeModel, surface: RealtimeSurface, capability: string): void {
  if (model.surface === surface) return;
  throw new UnsupportedCapabilityError({
    provider: model.provider,
    capability,
    modelId: model.modelId,
    message: `${capability} needs a ${surface === 'openai-realtime' ? 'createOpenAIRealtime' : 'createGeminiLive'} model; got a '${model.surface}' model.`,
  });
}

/** Mapping warnings have no event stream here; they go to the logger. */
function logWarning(deps: ResolvedDependencies): (warning: CallWarning) => void {
  return (warning) => deps.logger.warn(warning.message, { setting: warning.setting });
}

async function post(
  deps: ResolvedDependencies,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<{ json: Record<string, unknown>; status: number }> {
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const error = obj(await readErrorBody(response)).error;
    // Google's envelope names the error in `status` ('PERMISSION_DENIED'), OpenAI's in `type`.
    const envelope = obj(error);
    const normalized =
      typeof error === 'object' && error !== null
        ? {
            error: {
              message: str(envelope.message),
              type: str(envelope.type) ?? str(envelope.status) ?? str(envelope.code),
            },
          }
        : { error };
    throw mapMediaError(provider, response.status, normalized, response.headers);
  }
  const json = obj(await response.json().catch(() => undefined));
  return { json, status: response.status };
}

/**
 * Mint an OpenAI Realtime client secret (`ek_…`) for a browser session:
 * `POST /v1/realtime/client_secrets` with the session configuration attached.
 * SERVER SIDE ONLY — it needs your API key.
 *
 * ```ts
 * // on the server
 * const { token } = await createOpenAIClientSecret({
 *   model: createOpenAIRealtime({ apiKey: process.env.OPENAI_API_KEY })('gpt-realtime'),
 *   instructions: 'Be brief.',
 *   expiresInSeconds: 120,
 * });
 * // in the browser
 * const session = createRealtimeSession({ model: createOpenAIRealtime()('gpt-realtime'), ephemeralToken: token });
 * ```
 *
 * The configuration is a default, not a lock: the browser's own
 * `session.update` can still change it. Not live-verified.
 */
export async function createOpenAIClientSecret(
  options: CreateOpenAIClientSecretOptions,
): Promise<RealtimeToken> {
  const { model } = options;
  assertSurface(model, 'openai-realtime', 'createOpenAIClientSecret');
  const deps = resolveDependencies(options.deps);
  const apiKey = await resolveApiKey(model, deps, KEY_HINT);
  const config = readRealtimeConfig(model);
  const warn = logWarning(deps);
  const tools = await buildWireTools(options.tools, warn);
  const body = {
    ...(options.expiresInSeconds !== undefined
      ? { expires_after: { anchor: 'created_at', seconds: options.expiresInSeconds } }
      : {}),
    session: { ...openaiSessionConfig(options, tools, warn), model: model.modelId },
  };
  const base = (config.baseURL ?? OPENAI_BASE_URL).replace(/\/+$/, '');
  const { json, status } = await post(
    deps,
    model.provider,
    `${base}/realtime/client_secrets`,
    { authorization: `Bearer ${apiKey}`, ...config.headers },
    body,
    options.signal,
  );
  const token = str(json.value);
  if (!token) {
    throw new InvalidRequestError({
      message: 'OpenAI answered the client-secret request without a secret value.',
      provider: model.provider,
      statusCode: status,
    });
  }
  return {
    token,
    expiresAt: typeof json.expires_at === 'number' ? json.expires_at * 1000 : undefined,
    raw: json,
  };
}

/**
 * Mint a Gemini Live auth token (`auth_tokens/…`) for a browser session:
 * `POST /v1alpha/auth_tokens`. SERVER SIDE ONLY — it needs your API key.
 *
 * By default (`lockConfig: true`) the model and the configuration given here
 * are locked into the token, so the browser cannot change them; see
 * `lockConfig` for the other modes. Times are computed on `deps.clock`.
 * Not live-verified.
 */
export async function createGeminiAuthToken(
  options: CreateGeminiAuthTokenOptions,
): Promise<RealtimeToken> {
  const { model } = options;
  assertSurface(model, 'gemini-live', 'createGeminiAuthToken');
  const deps = resolveDependencies(options.deps);
  const apiKey = await resolveApiKey(model, deps, KEY_HINT);
  const config = readRealtimeConfig(model);
  const at = (seconds: number) => new Date(deps.clock.now() + seconds * 1000).toISOString();

  const body: Record<string, unknown> = {};
  if (options.uses !== undefined) body.uses = options.uses;
  if (options.expiresInSeconds !== undefined) body.expireTime = at(options.expiresInSeconds);
  if (options.newSessionExpiresInSeconds !== undefined) {
    body.newSessionExpireTime = at(options.newSessionExpiresInSeconds);
  }
  const lock = options.lockConfig ?? true;
  // `[]` locks nothing, the same as `false`. A setup without a field mask locks
  // every field; with a mask, only the listed fields override the browser's setup.
  if (lock === true || (Array.isArray(lock) && lock.length > 0)) {
    const warn = logWarning(deps);
    const tools = await buildWireTools(options.tools, warn);
    body.bidiGenerateContentSetup = geminiSetup(model, options, tools, warn);
    if (Array.isArray(lock)) body.fieldMask = lock.join(',');
  }

  const { json, status } = await post(
    deps,
    model.provider,
    `${geminiBaseURL(config)}/v1alpha/auth_tokens`,
    { 'x-goog-api-key': apiKey, ...config.headers },
    body,
    options.signal,
  );
  const token = str(json.name);
  if (!token) {
    throw new InvalidRequestError({
      message: 'Gemini answered the auth-token request without a token name.',
      provider: model.provider,
      statusCode: status,
    });
  }
  const expiresAt = Date.parse(str(json.expireTime) ?? '');
  return { token, expiresAt: Number.isNaN(expiresAt) ? undefined : expiresAt, raw: json };
}
