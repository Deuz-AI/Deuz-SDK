/**
 * midjourney.ts — async Midjourney generation via the midjourney-proxy API
 * (Faz 4). The standard mj-proxy contract: submit a task → poll the task by id →
 * (optionally) run U/V/reroll actions on the returned buttons → receive a final
 * `imageUrl`. Works with any mj-proxy-compatible relay (Yunwu by default).
 *
 * PURE + edge-safe: HTTP through injected `deps.fetch`; the poll delay uses
 * `deps.clock.setTimeout` (no ambient timers); the API key is injected via
 * `deps.keyProvider` / config / `ClientConfig.apiKeys` — never hardcoded.
 */
import type { LanguageModel } from './types/model';
import type { Dependencies, ResolvedDependencies } from './types/deps';
import { attachConfig } from './internal/config-symbol';
import { readClientContext, type ClientContext } from './internal/client-context';
import { resolveDependencies } from './internal/resolve-deps';
import { observeOperation } from './internal/observe-runtime';
import { parseRetryAfterMs } from './internal/http';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  OverloadedError,
  RateLimitError,
  TimeoutError,
  AbortError,
  type DeuzError,
} from './errors';

const DEFAULT_MJ_BASE_URL = 'https://yunwu.ai';

export type MidjourneyStatus =
  | 'NOT_START'
  | 'SUBMITTED'
  | 'IN_PROGRESS'
  | 'FAILURE'
  | 'SUCCESS'
  | 'MODAL'
  | 'CANCEL';

/** An action button on a finished task (U1-4 upscale, V1-4 variation, reroll, …). */
export interface MidjourneyButton {
  customId: string;
  emoji: string;
  label: string;
  type?: number;
  style?: number;
}

/** A midjourney-proxy task record. */
export interface MidjourneyTask {
  id: string;
  action?: string;
  status: MidjourneyStatus;
  prompt?: string;
  promptEn?: string;
  description?: string;
  /** Final (or in-progress preview) image URL. */
  imageUrl?: string;
  /** e.g. "0%" … "100%". */
  progress?: string;
  failReason?: string;
  submitTime?: number;
  startTime?: number;
  finishTime?: number;
  buttons?: MidjourneyButton[];
  properties?: Record<string, unknown>;
}

/** Shared config for every mj-proxy call. */
export interface MidjourneyConfig {
  apiKey?: string;
  /** Relay root (no trailing slash, NO `/v1`). Default `https://yunwu.ai`. */
  baseURL?: string;
  /** Logical provider id for key/baseURL resolution. Default 'yunwu'. */
  provider?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  deps?: Dependencies;
}

interface ResolvedMj {
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  deps: ResolvedDependencies;
}

async function resolveMj(cfg: MidjourneyConfig): Promise<ResolvedMj> {
  const deps = resolveDependencies(cfg.deps);
  const clientContext: ClientContext | undefined = readClientContext(cfg);
  const provider = cfg.provider ?? 'yunwu';

  let apiKey: string | undefined;
  if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(provider)) ?? undefined;
  if (!apiKey) apiKey = cfg.apiKey;
  if (!apiKey) {
    apiKey = clientContext?.apiKeys?.[provider as keyof NonNullable<ClientContext['apiKeys']>] as
      | string
      | undefined;
  }
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for Midjourney provider '${provider}'. Pass it to the call, ClientConfig.apiKeys, or a deps.keyProvider.`,
      provider,
    });
  }

  const baseURL = (
    cfg.baseURL ??
    clientContext?.baseUrls?.[provider] ??
    DEFAULT_MJ_BASE_URL
  ).replace(/\/+$/, '');
  return { apiKey, baseURL, headers: cfg.headers ?? {}, fetch: cfg.fetch ?? deps.fetch, deps };
}

async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function mapError(status: number, body: unknown, headers: Headers): DeuzError {
  const env = (body ?? {}) as {
    error?: { message?: string; type?: string } | string;
    message?: string;
    description?: string;
  };
  const errObj = typeof env.error === 'object' ? env.error : undefined;
  const message =
    errObj?.message ??
    (typeof env.error === 'string' ? env.error : undefined) ??
    env.message ??
    env.description ??
    `Midjourney request failed (HTTP ${status}).`;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = { message, provider: 'midjourney', upstreamType: errObj?.type, retryAfterMs };
  if (status === 401 || status === 403)
    return new AuthenticationError({ ...base, statusCode: status });
  if (status === 404) return new ModelNotFoundError({ ...base, statusCode: 404 });
  if (status === 429) return new RateLimitError({ ...base, statusCode: 429 });
  if (status === 529) return new OverloadedError({ ...base, statusCode: 529 });
  if (status >= 400 && status < 500)
    return new InvalidRequestError({ ...base, statusCode: status });
  return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
}

interface MjSubmitResponse {
  /** mj-proxy: 1 = submitted, 21 = existed/queued, others = error. */
  code?: number;
  description?: string;
  /** The new task id. */
  result?: string;
  properties?: Record<string, unknown>;
}

export interface SubmitResult {
  taskId: string;
  code: number;
  description?: string;
  raw: unknown;
}

async function mjPost(path: string, body: unknown, r: ResolvedMj): Promise<MjSubmitResponse> {
  const response = await r.fetch(`${r.baseURL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${r.apiKey}`,
      ...r.headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw mapError(response.status, await readErrorBody(response), response.headers);
  return (await response.json()) as MjSubmitResponse;
}

function toSubmitResult(json: MjSubmitResponse): SubmitResult {
  const taskId = json.result;
  if (!taskId) {
    throw new APICallError({
      message: `Midjourney submit returned no task id (code ${json.code}: ${json.description ?? ''}).`,
      provider: 'midjourney',
      statusCode: 200,
      isRetryable: false,
    });
  }
  return { taskId, code: json.code ?? 0, description: json.description, raw: json };
}

// --- submit endpoints ---

export interface SubmitImagineOptions extends MidjourneyConfig {
  prompt: string;
  /** base64 data-URLs of reference images (vary/blend seeds). */
  base64Array?: string[];
  /** Webhook URL the relay calls on task completion. */
  notifyHook?: string;
  /** Opaque caller state echoed back on the task. */
  state?: string;
}

/** Submit an imagine task → returns the task id to poll. */
export async function submitImagine(options: SubmitImagineOptions): Promise<SubmitResult> {
  const r = await resolveMj(options);
  return observeOperation(r.deps, 'midjourney', 'midjourney.submit-imagine', {}, async () => {
    const body: Record<string, unknown> = { prompt: options.prompt };
    if (options.base64Array?.length) body.base64Array = options.base64Array;
    if (options.notifyHook) body.notifyHook = options.notifyHook;
    if (options.state) body.state = options.state;
    return toSubmitResult(await mjPost('/mj/submit/imagine', body, r));
  });
}

export interface SubmitActionOptions extends MidjourneyConfig {
  taskId: string;
  /** A `customId` from the parent task's `buttons` (e.g. an upscale/variation). */
  customId: string;
}

/** Run a U/V/reroll action via a button `customId` from a finished task. */
export async function submitAction(options: SubmitActionOptions): Promise<SubmitResult> {
  const r = await resolveMj(options);
  return observeOperation(r.deps, 'midjourney', 'midjourney.submit-action', {}, async () =>
    toSubmitResult(
      await mjPost('/mj/submit/action', { taskId: options.taskId, customId: options.customId }, r),
    ),
  );
}

export interface SubmitBlendOptions extends MidjourneyConfig {
  base64Array: string[];
  /** 'PORTRAIT' | 'SQUARE' | 'LANDSCAPE'. */
  dimensions?: string;
  notifyHook?: string;
}

/** Blend 2-5 images into one. */
export async function submitBlend(options: SubmitBlendOptions): Promise<SubmitResult> {
  const r = await resolveMj(options);
  return observeOperation(
    r.deps,
    'midjourney',
    'midjourney.submit-blend',
    { itemCount: options.base64Array.length },
    async () => {
      const body: Record<string, unknown> = { base64Array: options.base64Array };
      if (options.dimensions) body.dimensions = options.dimensions;
      if (options.notifyHook) body.notifyHook = options.notifyHook;
      return toSubmitResult(await mjPost('/mj/submit/blend', body, r));
    },
  );
}

export interface SubmitDescribeOptions extends MidjourneyConfig {
  /** base64 data-URL of the image to describe. */
  base64: string;
  notifyHook?: string;
}

/** Describe an image → prompt suggestions (the result text is on the finished task). */
export async function submitDescribe(options: SubmitDescribeOptions): Promise<SubmitResult> {
  const r = await resolveMj(options);
  return observeOperation(r.deps, 'midjourney', 'midjourney.submit-describe', {}, async () => {
    const body: Record<string, unknown> = { base64: options.base64 };
    if (options.notifyHook) body.notifyHook = options.notifyHook;
    return toSubmitResult(await mjPost('/mj/submit/describe', body, r));
  });
}

// --- fetch + poll ---

/** Fetch a task by id. Returns null when the relay reports the task does not exist. */
export async function fetchTask(
  taskId: string,
  cfg: MidjourneyConfig,
): Promise<MidjourneyTask | null> {
  const r = await resolveMj(cfg);
  const response = await r.fetch(`${r.baseURL}/mj/task/${encodeURIComponent(taskId)}/fetch`, {
    method: 'GET',
    headers: { authorization: `Bearer ${r.apiKey}`, ...r.headers },
  });
  if (!response.ok)
    throw mapError(response.status, await readErrorBody(response), response.headers);
  const json = (await response.json()) as
    | (MidjourneyTask & { code?: number; description?: string })
    | null;
  // mj-proxy returns `null` (or a {code:4} envelope) for an unknown task.
  if (!json || (json.code !== undefined && !json.status)) return null;
  return json;
}

const TERMINAL: ReadonlySet<MidjourneyStatus> = new Set(['SUCCESS', 'FAILURE', 'CANCEL']);

export interface WaitForTaskOptions extends MidjourneyConfig {
  /** Poll interval (ms). Default 3000. */
  pollIntervalMs?: number;
  /** Overall timeout (ms). Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Called on every poll with the latest task snapshot. */
  onProgress?: (task: MidjourneyTask) => void;
}

/** Poll `fetchTask` until the task reaches a terminal status (or times out). */
export async function waitForTask(
  taskId: string,
  options: WaitForTaskOptions = {},
): Promise<MidjourneyTask> {
  const r = await resolveMj(options);
  // Observation (1.6): one operation spanning the whole poll (per-tick
  // signals stay on the existing onProgress hook — no event spam).
  return observeOperation(r.deps, 'midjourney', 'midjourney.wait', {}, () =>
    waitForTaskCore(taskId, options, r),
  );
}

async function waitForTaskCore(
  taskId: string,
  options: WaitForTaskOptions,
  r: Awaited<ReturnType<typeof resolveMj>>,
): Promise<MidjourneyTask> {
  const interval = options.pollIntervalMs ?? 3000;
  const timeout = options.timeoutMs ?? 300_000;
  const start = r.deps.clock.now();

  for (;;) {
    if (options.signal?.aborted) throw new AbortError();
    const task = await fetchTask(taskId, options);
    if (task) {
      options.onProgress?.(task);
      if (TERMINAL.has(task.status)) return task;
    }
    if (r.deps.clock.now() - start >= timeout) {
      throw new TimeoutError(
        'total',
        `Midjourney task '${taskId}' did not finish within ${timeout}ms.`,
      );
    }
    await new Promise<void>((resolve, reject) => {
      const cancel = r.deps.clock.setTimeout(() => resolve(), interval);
      options.signal?.addEventListener(
        'abort',
        () => {
          cancel();
          reject(new AbortError());
        },
        { once: true },
      );
    });
  }
}

export interface ImagineAndWaitOptions extends SubmitImagineOptions, WaitForTaskOptions {}

/** Convenience: submit an imagine task and poll it to completion. */
export async function imagine(options: ImagineAndWaitOptions): Promise<MidjourneyTask> {
  const { taskId } = await submitImagine(options);
  return waitForTask(taskId, options);
}

/** Optional descriptor factory (parallels the other providers; carries config on the symbol). */
export interface MidjourneyProvider {
  (modelId?: string): { provider: string; modelId: string; surface: 'midjourney' };
}

export function createMidjourney(
  settings: Omit<MidjourneyConfig, 'deps' | 'signal'> = {},
): MidjourneyProvider {
  return (modelId = 'midjourney') =>
    attachConfig(
      {
        provider: settings.provider ?? 'yunwu',
        modelId,
        surface: 'midjourney',
      } as unknown as LanguageModel,
      {
        provider: settings.provider ?? 'yunwu',
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    ) as unknown as { provider: string; modelId: string; surface: 'midjourney' };
}
