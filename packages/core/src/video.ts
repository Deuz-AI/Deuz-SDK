/**
 * video.ts — asynchronous video generation (2.0).
 *
 * The wire is the OpenAI **Videos** shape, which the relays that actually serve
 * Sora / Veo / Kling / Hailuo (Yunwu by default) mirror:
 *
 * ```
 * POST {baseURL}/videos              → create a job   → { id, status }
 * GET  {baseURL}/videos/{id}         → poll the job   → { id, status, progress, … }
 * GET  {baseURL}/videos/{id}/content → download bytes → video/mp4
 * ```
 *
 * Video is inherently async — a clip takes tens of seconds to minutes — so there
 * is no synchronous counterpart to `generateImage`. The shape is the same
 * submit → poll → finish state machine `midjourney.ts` runs, and
 * `generateVideo` is the one-call convenience over all three steps.
 *
 * PURE + edge-safe: HTTP through the injected `deps.fetch`, the poll delay
 * through `deps.clock.setTimeout` (no ambient timers), the API key through
 * `deps.keyProvider` / factory config / `ClientConfig.apiKeys` — never read from
 * the environment, never hardcoded.
 *
 * TOLERANT BY DESIGN: relays diverge on both the path and the field names, so
 * the task response is NORMALIZED (`succeeded` → `completed`, `'42%'` → `42`,
 * four spellings of the result URL) and the relay root is a setting —
 * `createVideoProvider({ baseURL })` — not a constant.
 */
import type { LanguageModel } from './types/model';
import type { Clock, Dependencies, ResolvedDependencies } from './types/deps';
import { attachConfig, readConfig } from './internal/config-symbol';
import { readClientContext, type ClientContext } from './internal/client-context';
import { resolveDependencies } from './internal/resolve-deps';
import { observeOperation } from './internal/observe-runtime';
import { readErrorBody, mapMediaError } from './internal/media-http';
import { APICallError, AuthenticationError, TimeoutError, AbortError } from './errors';

/** A video model descriptor — its own kind, like `ImageModel` (`surface: 'video'`). */
export interface VideoModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: 'video';
}

export type VideoProvider = (modelId: string) => VideoModel;

export interface VideoProviderSettings {
  apiKey?: string;
  /** Relay root INCLUDING the API version segment. Default `https://yunwu.ai/v1`. */
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Logical provider id used for key/baseURL resolution. Default `'yunwu'`. */
  provider?: string;
}

/** Yunwu is the default host because it is the relay that actually serves these models. */
const DEFAULT_VIDEO_BASE_URL = 'https://yunwu.ai/v1';

/**
 * Generic OpenAI-Videos-shaped video provider factory. The descriptor carries the
 * factory settings on a private symbol (same trick as the chat/image providers)
 * so the public `VideoModel` shape stays clean and the key never leaks via
 * enumeration.
 */
export function createVideoProvider(settings: VideoProviderSettings = {}): VideoProvider {
  const provider = settings.provider ?? 'yunwu';
  return (modelId: string): VideoModel =>
    attachConfig({ provider, modelId, surface: 'video' } as unknown as LanguageModel, {
      provider,
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      fetch: settings.fetch,
      headers: settings.headers,
    }) as unknown as VideoModel;
}

/**
 * Canonical job status. The four members are what the SDK normalizes TO; the
 * open `(string & {})` arm keeps an unrecognized relay status readable instead of
 * silently rewriting it (and autocompletes the four in an editor).
 */
export type VideoTaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | (string & {});

/** A normalized video job record. `raw` is always the untouched relay JSON. */
export interface VideoTask {
  id: string;
  status: VideoTaskStatus;
  /** 0-100. Parsed from a number OR a `'42%'` string. */
  progress?: number;
  model?: string;
  /** Clip length as the relay reports it (a string on the OpenAI wire, e.g. `'8'`). */
  seconds?: string;
  /** e.g. `'1280x720'`. */
  size?: string;
  /** Result URL on a completed job. */
  url?: string;
  /** Why a failed job failed. */
  failReason?: string;
  raw: unknown;
}

/** Shared config for every video call. */
export interface VideoConfig {
  /**
   * A descriptor from `createVideoProvider` / `createYunwuVideo` / `yunwu.video()`.
   * Its factory settings (key, baseURL, fetch, headers) are read off the private
   * symbol, so passing the model to `fetchVideoTask`/`waitForVideo`/`downloadVideo`
   * is enough to address the same relay the job was submitted to.
   */
  model?: VideoModel;
  apiKey?: string;
  /** Relay root INCLUDING the API version segment. Default `https://yunwu.ai/v1`. */
  baseURL?: string;
  /** Logical provider id for key/baseURL resolution. Default the model's, else `'yunwu'`. */
  provider?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  deps?: Dependencies;
}

interface ResolvedVideo {
  provider: string;
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  deps: ResolvedDependencies;
}

/**
 * G1 precedence: `deps.keyProvider` → the call's own `apiKey`, else the factory
 * config on the descriptor → `ClientConfig.apiKeys` → `AuthenticationError`
 * (thrown BEFORE any network request). Factory `fetch` wins over `deps.fetch`.
 */
async function resolveVideo(cfg: VideoConfig): Promise<ResolvedVideo> {
  const deps = resolveDependencies(cfg.deps);
  const clientContext: ClientContext | undefined = readClientContext(cfg);
  const config = cfg.model ? readConfig(cfg.model as unknown as LanguageModel) : undefined;
  const provider = cfg.provider ?? config?.provider ?? cfg.model?.provider ?? 'yunwu';

  let apiKey: string | undefined;
  if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(provider)) ?? undefined;
  if (!apiKey) apiKey = cfg.apiKey ?? config?.apiKey;
  if (!apiKey) apiKey = clientContext?.apiKeys?.[provider];
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for video provider '${provider}'. Pass it to the factory, the call, ClientConfig.apiKeys, or a deps.keyProvider.`,
      provider,
    });
  }

  const baseURL = (
    cfg.baseURL ??
    config?.baseURL ??
    clientContext?.baseUrls?.[provider] ??
    DEFAULT_VIDEO_BASE_URL
  ).replace(/\/+$/, '');

  return {
    provider,
    apiKey,
    baseURL,
    headers: { ...config?.headers, ...cfg.headers },
    fetch: cfg.fetch ?? config?.fetch ?? deps.fetch,
    deps,
  };
}

// ===================================================================
// Response normalization — the tolerant half of this module
// ===================================================================

/**
 * Relay status spellings → the canonical four. Anything not listed passes
 * through verbatim (the `(string & {})` arm of {@link VideoTaskStatus}).
 * `cancelled` maps to `failed` deliberately: it is terminal, and leaving it
 * unmapped would make `waitForVideo` poll a dead job until `timeoutMs`.
 */
const STATUS_ALIASES: Readonly<Record<string, VideoTaskStatus>> = {
  succeeded: 'completed',
  success: 'completed',
  complete: 'completed',
  done: 'completed',
  processing: 'in_progress',
  running: 'in_progress',
  'in-progress': 'in_progress',
  generating: 'in_progress',
  pending: 'queued',
  queuing: 'queued',
  waiting: 'queued',
  failure: 'failed',
  error: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
};

/** Statuses at which polling stops. A failed job is RETURNED, never thrown. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

function normalizeStatus(raw: unknown): VideoTaskStatus {
  if (typeof raw !== 'string' || raw === '') return 'queued';
  const key = raw.toLowerCase();
  return STATUS_ALIASES[key] ?? key;
}

/** A number stays a number; `'42%'` / `'42'` become `42`; anything else is dropped. */
function normalizeProgress(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseFloat(raw.replace('%', '').trim());
  return Number.isFinite(n) ? n : undefined;
}

function asString(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return undefined;
}

/** The relay envelope, spelled every way the relays actually spell it. */
interface RawVideoTask {
  id?: string;
  task_id?: string;
  taskId?: string;
  status?: unknown;
  state?: unknown;
  progress?: unknown;
  model?: unknown;
  seconds?: unknown;
  duration?: unknown;
  size?: unknown;
  url?: unknown;
  video_url?: unknown;
  output?: { url?: unknown } | null;
  data?: { url?: unknown }[] | null;
  error?: { message?: string } | string | null;
  fail_reason?: unknown;
  failReason?: unknown;
}

function normalizeTask(json: RawVideoTask, fallbackId: string): VideoTask {
  const url =
    asString(json.url) ??
    asString(json.video_url) ??
    asString(json.output?.url) ??
    asString(json.data?.[0]?.url);
  const errObj = typeof json.error === 'object' && json.error ? json.error : undefined;
  const failReason =
    errObj?.message ??
    (typeof json.error === 'string' ? json.error : undefined) ??
    asString(json.fail_reason) ??
    asString(json.failReason);
  const progress = normalizeProgress(json.progress);
  const seconds = asString(json.seconds) ?? asString(json.duration);
  const model = asString(json.model);
  const size = asString(json.size);

  return {
    id: json.id ?? json.task_id ?? json.taskId ?? fallbackId,
    status: normalizeStatus(json.status ?? json.state),
    ...(progress !== undefined ? { progress } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(failReason !== undefined ? { failReason } : {}),
    raw: json,
  };
}

// ===================================================================
// submit
// ===================================================================

/**
 * A reference image/clip for image-to-video and remix flows. A bare `Blob`/`File`
 * is sent as-is; raw bytes need a `mediaType` so the relay can tell a PNG from
 * an MP4. Passing one switches the submit body from JSON to `multipart/form-data`.
 */
export type VideoInputReference =
  | Blob
  | { data: Blob | Uint8Array | ArrayBuffer; mediaType?: string; filename?: string };

export interface SubmitVideoOptions extends VideoConfig {
  model: VideoModel;
  prompt: string;
  /** e.g. `'1280x720'`, `'720x1280'`. Provider-dependent. */
  size?: string;
  /** Clip length in seconds; coerced to a string on the wire (the OpenAI shape). */
  seconds?: number | string;
  /** Reference image/clip → the request becomes multipart. */
  inputReference?: VideoInputReference;
  /**
   * Extra wire fields merged into the body (`seed`, `aspect_ratio`, `resolution`,
   * … — whatever the relay documents). The canonical fields above ALWAYS win, so
   * this can never silently retarget the model or the prompt.
   */
  providerOptions?: Record<string, unknown>;
}

function extensionFor(mediaType: string): string {
  const subtype = mediaType.split(';')[0]?.split('/')[1];
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype : 'bin';
}

function toReferencePart(ref: VideoInputReference): { blob: Blob; filename: string } {
  if (ref instanceof Blob) {
    // `File` (a Blob subclass) already carries a name; a plain Blob does not.
    const named = (ref as { name?: unknown }).name;
    const filename =
      typeof named === 'string' && named ? named : `input_reference.${extensionFor(ref.type)}`;
    return { blob: ref, filename };
  }
  const mediaType =
    ref.mediaType ?? (ref.data instanceof Blob ? ref.data.type : 'application/octet-stream');
  const blob =
    ref.data instanceof Blob
      ? ref.data
      : // A declared `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which the DOM
        // lib's `BlobPart` (ArrayBuffer-backed views only) rejects on paper.
        new Blob([ref.data as BlobPart], { type: mediaType || undefined });
  return {
    blob,
    filename: ref.filename ?? `input_reference.${extensionFor(mediaType || blob.type)}`,
  };
}

function buildSubmitInit(options: SubmitVideoOptions, r: ResolvedVideo): RequestInit {
  const auth: Record<string, string> = { authorization: `Bearer ${r.apiKey}`, ...r.headers };
  const extras = Object.entries(options.providerOptions ?? {}).filter(([, v]) => v !== undefined);

  if (options.inputReference !== undefined) {
    const form = new FormData();
    // providerOptions first so the canonical `set`s below overwrite them.
    for (const [k, v] of extras) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    form.set('model', options.model.modelId);
    form.set('prompt', options.prompt);
    if (options.size !== undefined) form.set('size', options.size);
    if (options.seconds !== undefined) form.set('seconds', String(options.seconds));
    const { blob, filename } = toReferencePart(options.inputReference);
    form.set('input_reference', blob, filename);
    // NO content-type header — `fetch` writes the multipart boundary itself.
    return { method: 'POST', headers: auth, body: form, signal: options.signal };
  }

  const body: Record<string, unknown> = Object.fromEntries(extras);
  body.model = options.model.modelId;
  body.prompt = options.prompt;
  if (options.size !== undefined) body.size = options.size;
  if (options.seconds !== undefined) body.seconds = String(options.seconds);

  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
    signal: options.signal,
  };
}

/** Submit a generation job → the initial (usually `queued`) task to poll. */
export async function submitVideo(options: SubmitVideoOptions): Promise<VideoTask> {
  const r = await resolveVideo(options);
  return observeOperation(r.deps, 'video', 'video.submit', {}, async () => {
    const response = await r.fetch(`${r.baseURL}/videos`, buildSubmitInit(options, r));
    if (!response.ok) {
      throw mapMediaError(
        r.provider,
        response.status,
        await readErrorBody(response),
        response.headers,
        `Video submit failed (HTTP ${response.status}).`,
      );
    }
    const task = normalizeTask((await response.json()) as RawVideoTask, '');
    if (!task.id) {
      // Nothing to poll — a relay that accepted the job but named no id is broken
      // (same contract midjourney.ts's `toSubmitResult` enforces).
      throw new APICallError({
        message: `Video submit returned no task id${task.failReason ? ` (${task.failReason})` : ''}.`,
        provider: r.provider,
        statusCode: 200,
        isRetryable: false,
      });
    }
    return task;
  });
}

// ===================================================================
// fetch + poll + download
// ===================================================================

/** Fetch one job by id. Returns `null` when the relay reports it does not exist. */
export async function fetchVideoTask(
  taskId: string,
  cfg: VideoConfig = {},
): Promise<VideoTask | null> {
  const r = await resolveVideo(cfg);
  const response = await r.fetch(`${r.baseURL}/videos/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${r.apiKey}`, ...r.headers },
    signal: cfg.signal,
  });
  // An unknown job is "no", not an error — the same contract `fetchTask` has in
  // midjourney.ts. The body is still drained so the connection can be reused.
  if (response.status === 404) {
    await readErrorBody(response);
    return null;
  }
  if (!response.ok) {
    throw mapMediaError(
      r.provider,
      response.status,
      await readErrorBody(response),
      response.headers,
      `Video task fetch failed (HTTP ${response.status}).`,
    );
  }
  const json = (await response.json()) as RawVideoTask | null;
  if (!json || (!json.id && !json.task_id && !json.taskId && !json.status && !json.state)) {
    return null;
  }
  return normalizeTask(json, taskId);
}

/** Poll cadence + progress reporting, shared by `waitForVideo` and `generateVideo`. */
export interface VideoPollOptions {
  /** Poll interval (ms). Default 5000 — clips are minutes, not seconds. */
  pollIntervalMs?: number;
  /** Overall timeout (ms). Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Called on every poll with the latest task snapshot. */
  onProgress?: (task: VideoTask) => void;
}

export interface WaitForVideoOptions extends VideoConfig, VideoPollOptions {}

/**
 * Poll `fetchVideoTask` until the job reaches a terminal status (`completed` or
 * `failed`) or times out. A FAILED job is RETURNED, not thrown — the failure is
 * the model's, not the transport's, and `failReason` is the useful part
 * (`waitForTask` in midjourney.ts sets the same precedent).
 */
export async function waitForVideo(
  taskId: string,
  options: WaitForVideoOptions = {},
): Promise<VideoTask> {
  const r = await resolveVideo(options);
  // Observation (1.6): one operation spanning the whole poll (per-tick signals
  // stay on the existing onProgress hook — no event spam).
  return observeOperation(r.deps, 'video', 'video.wait', {}, () =>
    waitForVideoCore(taskId, options, r),
  );
}

async function waitForVideoCore(
  taskId: string,
  options: WaitForVideoOptions,
  r: ResolvedVideo,
): Promise<VideoTask> {
  const interval = options.pollIntervalMs ?? 5000;
  const timeout = options.timeoutMs ?? 600_000;
  const start = r.deps.clock.now();

  for (;;) {
    if (options.signal?.aborted) throw new AbortError();
    const task = await fetchVideoTask(taskId, options);
    if (task) {
      options.onProgress?.(task);
      if (TERMINAL_STATUSES.has(task.status)) return task;
    }
    if (r.deps.clock.now() - start >= timeout) {
      throw new TimeoutError('total', `Video task '${taskId}' did not finish within ${timeout}ms.`);
    }
    await sleepOrAbort(interval, r.deps.clock, options.signal);
  }
}

/**
 * One poll gap. The abort listener is registered AND removed around this single
 * wait: the loop runs for the whole `timeoutMs` (10 minutes by default, one turn
 * every 5s), and a listener left behind per turn accumulates on the CALLER's
 * signal — a leak the caller cannot see, which Node reports as a
 * MaxListenersExceededWarning long before a long job finishes.
 */
function sleepOrAbort(ms: number, clock: Clock, signal: AbortSignal | undefined): Promise<void> {
  let onAbort: (() => void) | undefined;
  return new Promise<void>((resolve, reject) => {
    const cancel = clock.setTimeout(() => resolve(), ms);
    if (!signal) return;
    onAbort = (): void => {
      cancel();
      reject(new AbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }).finally(() => {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

export interface DownloadedVideo {
  video: Uint8Array;
  /** From the response `content-type` (parameters stripped). Falls back to `video/mp4`. */
  mediaType: string;
}

/** Download a finished job's bytes (`GET {baseURL}/videos/{id}/content`). */
export async function downloadVideo(
  taskId: string,
  cfg: VideoConfig = {},
): Promise<DownloadedVideo> {
  const r = await resolveVideo(cfg);
  return observeOperation(r.deps, 'video', 'video.download', {}, async () => {
    const response = await r.fetch(`${r.baseURL}/videos/${encodeURIComponent(taskId)}/content`, {
      method: 'GET',
      headers: { authorization: `Bearer ${r.apiKey}`, ...r.headers },
      signal: cfg.signal,
    });
    if (!response.ok) {
      throw mapMediaError(
        r.provider,
        response.status,
        await readErrorBody(response),
        response.headers,
        `Video download failed (HTTP ${response.status}).`,
      );
    }
    const mediaType = (response.headers.get('content-type') ?? 'video/mp4').split(';')[0]!.trim();
    return {
      video: new Uint8Array(await response.arrayBuffer()),
      mediaType: mediaType || 'video/mp4',
    };
  });
}

// ===================================================================
// convenience
// ===================================================================

export interface GenerateVideoOptions extends SubmitVideoOptions, VideoPollOptions {
  /** Also fetch the finished clip's bytes. Default `false` — a URL is usually enough. */
  download?: boolean;
}

export interface GenerateVideoResult {
  task: VideoTask;
  /** Present only when `download: true` and the job completed. */
  video?: Uint8Array;
  mediaType?: string;
}

/**
 * Submit → poll → (optionally) download, in one call. A job that fails resolves
 * with `task.status === 'failed'` and a `failReason`; only transport failures,
 * a timeout, or an abort reject.
 */
export async function generateVideo(options: GenerateVideoOptions): Promise<GenerateVideoResult> {
  const submitted = await submitVideo(options);
  // Some relays finish tiny jobs synchronously — do not open a poll for nothing.
  const task = TERMINAL_STATUSES.has(submitted.status)
    ? submitted
    : await waitForVideo(submitted.id, options);

  if (!options.download || task.status !== 'completed') return { task };
  const { video, mediaType } = await downloadVideo(task.id, options);
  return { task, video, mediaType };
}
