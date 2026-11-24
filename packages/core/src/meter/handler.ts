/**
 * deuz meter (2.5): the fetch-style budget proxy. `createMeterHandler` answers
 * a `Request` the way the upstream provider would, after charging it to a
 * persistent `BudgetStore`:
 *
 *  1. The request body is read (capped) and its model, output cap and stream
 *     flag taken from it; credentials are never read, logged or recorded.
 *  2. A conservative estimate is reserved in every budget scope, all or none.
 *     A scope that cannot fit it answers 402 in the provider's error shape and
 *     nothing is forwarded.
 *  3. The request goes to the upstream with its auth headers untouched. The
 *     response streams back chunk by chunk, unchanged; usage is read from the
 *     bytes as they pass.
 *  4. When the response ends, the hold is settled with the measured usage, or
 *     with the estimate when no final usage was seen (fail-closed), or
 *     released when the upstream refused the request. One receipt follows.
 *
 * Known limit: a streamed response's usage is final only at its end, so a
 * request admitted just under the ceiling can finish above it. The overshoot
 * is bounded by how much one request's measured cost exceeds its estimate,
 * per request in flight at the ceiling; the next request is refused.
 * Edge-safe: no Node built-ins (the Node server lives in `meter/node`).
 */
import { createPriceProvider } from '../pricing';
import { resolveDependencies } from '../internal/resolve-deps';
import type { BudgetStoreReservation, PersistentBudgetScope } from '../types/budget-store';
import type { PriceProvider } from '../types/deps';
import type { Usage } from '../types/usage';
import { MeterError, meterReply } from './errors';
import type { MeterReplyKind } from './errors';
import { assertEstimateOptions, defaultMeterEstimate } from './estimate';
import { createJsonUsageReader, createSseUsageReader } from './usage';
import type { UsageReader } from './usage';
import type {
  MeterEstimate,
  MeterEstimateOptions,
  MeterEstimator,
  MeterHandler,
  MeterModelStats,
  MeterOptions,
  MeterOutcome,
  MeterProtocol,
  MeterReceipt,
  MeterReceiptSink,
  MeterRefusal,
  MeterRequestInfo,
  MeterSettlement,
  MeterStats,
  MeterUpstream,
  MeterUpstreamKind,
} from './types';

/** Anthropic Messages and OpenAI (Chat Completions and Responses), both mounted at the proxy root. */
export const DEFAULT_METER_UPSTREAMS: readonly MeterUpstream[] = Object.freeze([
  Object.freeze({ provider: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
  Object.freeze({ provider: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com' }),
] as const);

const DEFAULT_MAX_REQUEST_BYTES = 32 * 1_048_576;
const DEFAULT_MAX_RESPONSE_COPY_BYTES = 16 * 1_048_576;
/** Attempts at settling or releasing a hold before the failure is reported. */
const CLOSE_ATTEMPTS = 3;

/** Request headers never forwarded: hop-by-hop, framing and encoding the meter renegotiates. */
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  // `100-continue` is between the client and the listener; fetch refuses the header.
  'expect',
]);

/**
 * Response headers never relayed: hop-by-hop ones, and the encoding and
 * length of a body that `fetch` has already decoded.
 */
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

/** Headers hidden from host callbacks: anything that can carry a credential. */
const SECRET_HEADER = /authorization|api[-_]?key|cookie|token|secret|session|signature/i;

/** Where a request goes, and what the meter does with it. */
type Route =
  | { readonly kind: 'metered'; readonly protocol: MeterProtocol }
  | { readonly kind: 'free' }
  | { readonly kind: 'unmetered' };

interface NormalizedUpstream {
  readonly provider: string;
  readonly kind: MeterUpstreamKind;
  readonly baseUrl: string;
  readonly mount: string;
}

function classify(kind: MeterUpstreamKind, method: string, rest: string): Route {
  if (method !== 'POST') return { kind: 'free' };
  if (kind === 'anthropic') {
    if (rest.endsWith('/messages')) return { kind: 'metered', protocol: 'anthropic-messages' };
    if (rest.endsWith('/messages/count_tokens')) return { kind: 'free' };
    return { kind: 'unmetered' };
  }
  if (rest.endsWith('/chat/completions')) return { kind: 'metered', protocol: 'openai-chat' };
  if (rest.endsWith('/responses')) return { kind: 'metered', protocol: 'openai-responses' };
  if (rest.endsWith('/responses/input_tokens')) return { kind: 'free' };
  return { kind: 'unmetered' };
}

/**
 * Whether a request that both upstreams of a shared mount could take is
 * Anthropic's: it carries an `anthropic-*` header, or its path is under
 * `/api/` (Anthropic's unversioned endpoints; OpenAI's API lives under
 * `/v1`). Claude Code sends `HEAD /api/hello` with neither credentials nor
 * an `anthropic-version` header (seen live, Claude Code 2.1.331).
 */
function anthropicShaped(rest: string, headers: Headers): boolean {
  if (rest === '/api' || rest.startsWith('/api/')) return true;
  let found = false;
  headers.forEach((_value, name) => {
    if (name.startsWith('anthropic-')) found = true;
  });
  return found;
}

function normalizeUpstreams(upstreams: readonly MeterUpstream[]): readonly NormalizedUpstream[] {
  if (!Array.isArray(upstreams) || upstreams.length === 0)
    throw new MeterError('invalid_options', 'upstreams must be a nonempty array.');
  const seen = new Set<string>();
  return upstreams.map((upstream, index) => {
    const label = `upstreams[${index}]`;
    if (upstream === null || typeof upstream !== 'object')
      throw new MeterError('invalid_options', `${label} must be an object.`);
    if (typeof upstream.provider !== 'string' || upstream.provider === '')
      throw new MeterError('invalid_options', `${label}.provider must be a nonempty string.`);
    if (upstream.kind !== 'anthropic' && upstream.kind !== 'openai')
      throw new MeterError('invalid_options', `${label}.kind must be 'anthropic' or 'openai'.`);
    let url: URL;
    try {
      url = new URL(upstream.baseUrl);
    } catch {
      throw new MeterError('invalid_options', `${label}.baseUrl must be an absolute URL.`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash)
      throw new MeterError(
        'invalid_options',
        `${label}.baseUrl must be an http(s) URL without a query or fragment.`,
      );
    const mount = (upstream.mount ?? '').replace(/\/+$/, '');
    if (mount !== '' && !mount.startsWith('/'))
      throw new MeterError('invalid_options', `${label}.mount must be empty or start with '/'.`);
    const key = JSON.stringify([mount, upstream.kind]);
    if (seen.has(key))
      throw new MeterError(
        'invalid_options',
        `${label} repeats the ${upstream.kind} upstream at mount '${mount}'.`,
      );
    seen.add(key);
    return {
      provider: upstream.provider,
      kind: upstream.kind,
      baseUrl: upstream.baseUrl.replace(/\/+$/, ''),
      mount,
    };
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new MeterError('invalid_options', `${label} must be a positive integer.`);
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cap = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function outputCap(protocol: MeterProtocol, body: Record<string, unknown>): number | undefined {
  if (protocol === 'anthropic-messages') return cap(body.max_tokens);
  if (protocol === 'openai-chat') return cap(body.max_completion_tokens) ?? cap(body.max_tokens);
  return cap(body.max_output_tokens);
}

/** The body, at most `max` bytes of it; `undefined` when it is longer. */
async function readCapped(
  request: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) return undefined;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function forwardHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!DROP_REQUEST.has(name)) out.set(name, value);
  });
  return out;
}

function relayHeaders(headers: Headers, id: string | undefined): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name) && name !== 'set-cookie') out.set(name, value);
  });
  for (const cookie of headers.getSetCookie?.() ?? []) out.append('set-cookie', cookie);
  if (id !== undefined) out.set('x-deuz-meter-id', id);
  return out;
}

function visibleHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!SECRET_HEADER.test(name)) out[name] = value;
  });
  return out;
}

/**
 * Pass a body through unchanged, one chunk per pull (no read-ahead), feeding
 * each chunk to `onChunk`. `finish` runs once: at the end (before the client
 * sees it close), on a broken upstream, or when the client cancels.
 */
function passThrough(
  body: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: Uint8Array) => void,
  finishOnce: (how: 'end' | 'cancel' | 'error') => Promise<void>,
): ReadableStream<Uint8Array> | null {
  // A broken upstream and a cancelling client can both report the end.
  let finished: Promise<void> | undefined;
  const finish = (how: 'end' | 'cancel' | 'error') => (finished ??= finishOnce(how));
  if (!body) {
    void finish('end');
    return null;
  }
  const source = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await source.read();
        } catch (error) {
          await finish('error');
          controller.error(error);
          return;
        }
        if (result.done) {
          await finish('end');
          controller.close();
          return;
        }
        try {
          onChunk(result.value);
        } catch {
          // Reading usage is best effort: it never disturbs the bytes.
        }
        controller.enqueue(result.value);
      },
      async cancel(reason) {
        await source.cancel(reason).catch(() => undefined);
        await finish('cancel');
      },
    },
    { highWaterMark: 0 },
  );
}

interface Counters {
  requests: number;
  inFlight: number;
  completed: number;
  refused: number;
  upstreamErrors: number;
  aborted: number;
  failed: number;
  passthrough: number;
  tokens: number;
  usd: number;
  chargedUsd: number;
}

const roundUsd = (value: number): number => Math.round(value * 1e9) / 1e9;

/**
 * A fetch-style budget proxy (2.5). Point a harness's `ANTHROPIC_BASE_URL` or
 * `OPENAI_BASE_URL` at a server running `meter.fetch` (see
 * `createMeterProxy` in `@deuz-sdk/core/meter/node`, or any Fetch API host).
 * `fetch` never rejects: every failure becomes a provider-shaped error
 * response. Throws `MeterError` for invalid options.
 */
export function createMeterHandler(options: MeterOptions = {}): MeterHandler {
  if (options === null || typeof options !== 'object')
    throw new MeterError('invalid_options', 'Meter options must be an object.');
  const upstreams = normalizeUpstreams(options.upstreams ?? DEFAULT_METER_UPSTREAMS);
  const unknownPrice = options.unknownPrice ?? 'warn';
  if (unknownPrice !== 'warn' && unknownPrice !== 'reject')
    throw new MeterError('invalid_options', "unknownPrice must be 'warn' or 'reject'.");
  const unmeteredRoutes = options.unmeteredRoutes ?? 'reject';
  if (unmeteredRoutes !== 'reject' && unmeteredRoutes !== 'forward')
    throw new MeterError('invalid_options', "unmeteredRoutes must be 'reject' or 'forward'.");
  const budget = options.budget;
  if (
    budget !== undefined &&
    (budget === null ||
      typeof budget.store?.reserve !== 'function' ||
      (typeof budget.scopes !== 'function' && !Array.isArray(budget.scopes)))
  )
    throw new MeterError(
      'invalid_options',
      'budget needs a BudgetStore and scopes (an array or a function).',
    );
  const estimator: MeterEstimator | undefined =
    typeof options.estimate === 'function' ? options.estimate : undefined;
  const estimateOptions: MeterEstimateOptions =
    typeof options.estimate === 'object' && options.estimate !== null ? options.estimate : {};
  assertEstimateOptions(estimateOptions);
  const maxRequestBytes = positiveInteger(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
    'maxRequestBytes',
  );
  const maxResponseCopyBytes = positiveInteger(
    options.maxResponseCopyBytes,
    DEFAULT_MAX_RESPONSE_COPY_BYTES,
    'maxResponseCopyBytes',
  );
  const injectStreamUsage = options.injectStreamUsage ?? true;
  const sinks: readonly MeterReceiptSink[] =
    options.receipts === undefined
      ? []
      : typeof options.receipts === 'function'
        ? [options.receipts]
        : [...options.receipts];
  const priceProvider: PriceProvider = options.priceProvider ?? createPriceProvider();
  const deps = resolveDependencies(options.deps);
  const { clock, generateId } = deps;
  const upstreamFetch = deps.fetch;

  const startedAt = clock.now();
  const counters: Counters = {
    requests: 0,
    inFlight: 0,
    completed: 0,
    refused: 0,
    upstreamErrors: 0,
    aborted: 0,
    failed: 0,
    passthrough: 0,
    tokens: 0,
    usd: 0,
    chargedUsd: 0,
  };
  const byModel = new Map<string, { requests: number; tokens: number; usd: number }>();
  const unpriced = new Set<string>();
  const pending = new Set<Promise<unknown>>();

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };

  const report = (error: unknown, stage: Parameters<NonNullable<MeterOptions['onError']>>[1]) => {
    try {
      options.onError?.(error, stage);
    } catch {
      // A failing callback never changes an answer.
    }
  };
  const warn = (warning: Parameters<NonNullable<MeterOptions['onWarning']>>[0]) => {
    try {
      options.onWarning?.(warning);
    } catch {
      // Advisory only.
    }
  };

  function deliver(receipt: MeterReceipt): void {
    for (const sink of sinks)
      track(
        (async () => {
          try {
            await sink(receipt);
          } catch (error) {
            report(error, { stage: 'receipt', requestId: receipt.requestId });
          }
        })(),
      );
  }

  function record(receipt: MeterReceipt): void {
    const outcomeCounter: Record<MeterOutcome, keyof Counters> = {
      completed: 'completed',
      refused: 'refused',
      upstream_error: 'upstreamErrors',
      aborted: 'aborted',
      failed: 'failed',
    };
    counters[outcomeCounter[receipt.outcome]]++;
    if (receipt.usage) counters.tokens += receipt.usage.totalTokens;
    if (receipt.usd !== undefined) counters.usd = roundUsd(counters.usd + receipt.usd);
    if (receipt.charged) counters.chargedUsd = roundUsd(counters.chargedUsd + receipt.charged.usd);
    if (receipt.model !== undefined && receipt.protocol !== undefined) {
      const row = byModel.get(receipt.model) ?? { requests: 0, tokens: 0, usd: 0 };
      row.requests++;
      row.tokens += receipt.usage?.totalTokens ?? 0;
      row.usd = roundUsd(row.usd + (receipt.usd ?? 0));
      byModel.set(receipt.model, row);
    }
    deliver(receipt);
  }

  /** Settle or release a hold, retried; a conflict means it is already closed. */
  async function close(
    requestId: string,
    action: { settle: { tokens: number; usd: number } } | { release: true },
  ): Promise<boolean> {
    const store = budget?.store;
    if (!store) return true;
    for (let attempt = 1; ; attempt++) {
      try {
        if ('settle' in action) await store.settle(requestId, action.settle);
        else await store.release(requestId);
        return true;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'reservation_conflict') return true;
        if (attempt < CLOSE_ATTEMPTS) continue;
        report(error, { stage: 'settle' in action ? 'settle' : 'release', requestId });
        return false;
      }
    }
  }

  async function price(model: string, usage: Usage): Promise<number | undefined> {
    try {
      const usd = await priceProvider.priceUsage(model, usage);
      return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
    } catch (error) {
      report(error, { stage: 'settle' });
      return undefined;
    }
  }

  function markUnpriced(model: string, provider: string): void {
    if (unpriced.has(model)) return;
    unpriced.add(model);
    warn({ type: 'unpriced-model', model, provider });
  }

  function resolve(
    path: string,
    headers: Headers,
    method: string,
  ): { upstream: NormalizedUpstream; rest: string; route: Route } | undefined {
    let best: NormalizedUpstream[] = [];
    let length = -1;
    for (const upstream of upstreams) {
      const { mount } = upstream;
      if (mount !== '' && path !== mount && !path.startsWith(`${mount}/`)) continue;
      if (mount.length > length) {
        best = [upstream];
        length = mount.length;
      } else if (mount.length === length) best.push(upstream);
    }
    const first = best[0];
    if (!first) return undefined;
    const rest = path.slice(length);
    const routed = best.map((upstream) => ({
      upstream,
      rest,
      route: classify(upstream.kind, method, rest),
    }));
    if (routed.length === 1) return routed[0];
    if (method === 'POST') {
      const known = routed.find((item) => item.route.kind !== 'unmetered');
      if (known) return known;
    }
    const kind: MeterUpstreamKind = anthropicShaped(rest, headers) ? 'anthropic' : 'openai';
    return routed.find((item) => item.upstream.kind === kind) ?? routed[0];
  }

  /** Forward a request the meter does not charge (non-POST and free routes). */
  async function forwardFree(
    request: Request,
    target: string,
    kind: MeterUpstreamKind,
  ): Promise<Response> {
    counters.passthrough++;
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await readCapped(request, maxRequestBytes);
      if (!body)
        return meterReply(
          kind,
          'request_too_large',
          `the request body exceeds ${maxRequestBytes} bytes.`,
        );
    }
    try {
      const response = await upstreamFetch(target, {
        method: request.method,
        headers: forwardHeaders(request.headers),
        ...(body ? { body } : {}),
        signal: request.signal,
        redirect: 'manual',
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: relayHeaders(response.headers, undefined),
      });
    } catch (error) {
      report(error, { stage: 'upstream' });
      return meterReply(kind, 'upstream_unreachable', 'the upstream could not be reached.');
    }
  }

  async function handle(request: Request): Promise<Response> {
    const at = clock.now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const resolved = resolve(url.pathname, request.headers, method);
    if (!resolved)
      return meterReply(
        upstreams[0]?.kind ?? 'openai',
        'unmetered_route',
        `no upstream is mounted at ${url.pathname}.`,
      );
    const { upstream, rest, route } = resolved;
    const target = `${upstream.baseUrl}${rest}${url.search}`;
    if (route.kind === 'free') return forwardFree(request, target, upstream.kind);

    const id = generateId();
    const requestId = `meter:${id}`;
    counters.requests++;
    counters.inFlight++;
    let closed = false;
    const done = () => {
      if (!closed) {
        closed = true;
        counters.inFlight--;
      }
    };
    const base = {
      version: 1 as const,
      id,
      requestId,
      source: 'measured' as const,
      startedAt: at,
      provider: upstream.provider,
      route: url.pathname,
      method,
    };
    /** A receipt for a request the meter answered itself. */
    const answer = (
      reason: MeterReplyKind,
      message: string,
      fields: {
        outcome: MeterOutcome;
        protocol?: MeterProtocol;
        model?: string;
        stream?: boolean;
        estimate?: MeterEstimate;
        budgetKeys?: readonly string[];
        refusal?: MeterRefusal;
        priced?: boolean;
        settlement?: MeterSettlement;
        charged?: { tokens: number; usd: number };
      },
    ): Response => {
      const response = meterReply(upstream.kind, reason, message);
      response.headers.set('x-deuz-meter-id', id);
      const endedAt = clock.now();
      done();
      record({
        ...base,
        endedAt,
        durationMs: endedAt - at,
        ...(fields.protocol ? { protocol: fields.protocol } : {}),
        ...(fields.model !== undefined ? { model: fields.model } : {}),
        status: response.status,
        outcome: fields.outcome,
        stream: fields.stream ?? false,
        usageComplete: false,
        ...(fields.estimate ? { estimate: fields.estimate } : {}),
        settlement: fields.settlement ?? 'none',
        ...(fields.charged ? { charged: fields.charged } : {}),
        budgetKeys: fields.budgetKeys ?? [],
        ...(fields.refusal ? { refusal: fields.refusal } : {}),
        priced: fields.priced ?? false,
      });
      return response;
    };

    if (route.kind === 'unmetered' && unmeteredRoutes === 'reject')
      return answer(
        'unmetered_route',
        `POST ${url.pathname} is not a route the meter can charge, so it was not forwarded. Set unmeteredRoutes: 'forward' to send such requests on uncharged.`,
        { outcome: 'failed' },
      );

    const bytes = await readCapped(request, maxRequestBytes).catch(() => undefined);
    if (!bytes)
      return answer('request_too_large', `the request body exceeds ${maxRequestBytes} bytes.`, {
        outcome: 'failed',
      });

    if (route.kind === 'unmetered') {
      // Forwarded uncharged (unmeteredRoutes: 'forward'), with a receipt.
      let response: Response;
      try {
        response = await upstreamFetch(target, {
          method,
          headers: forwardHeaders(request.headers),
          body: bytes,
          signal: request.signal,
          redirect: 'manual',
        });
      } catch (error) {
        report(error, { stage: 'upstream', requestId });
        return answer('upstream_unreachable', 'the upstream could not be reached.', {
          outcome: request.signal.aborted ? 'aborted' : 'failed',
        });
      }
      const upstreamMs = clock.now() - at;
      const status = response.status;
      const stream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
      const body = passThrough(
        response.body,
        () => undefined,
        async (how) => {
          const endedAt = clock.now();
          done();
          record({
            ...base,
            endedAt,
            durationMs: endedAt - at,
            upstreamMs,
            status,
            outcome:
              status < 200 || status >= 300
                ? 'upstream_error'
                : how === 'end'
                  ? 'completed'
                  : 'aborted',
            stream,
            usageComplete: false,
            settlement: 'none',
            budgetKeys: [],
            ...upstreamRequestId(response.headers),
            priced: false,
          });
        },
      );
      return new Response(body, {
        status,
        statusText: response.statusText,
        headers: relayHeaders(response.headers, id),
      });
    }

    const protocol = route.protocol;
    const text = new TextDecoder('utf-8').decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed))
      return answer('invalid_request', 'the request body is not a JSON object.', {
        outcome: 'failed',
        protocol,
      });
    let body: Record<string, unknown> = parsed;
    const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'unknown';
    const stream = body.stream === true;
    const maxOutputTokens = outputCap(protocol, body);
    // Chat Completions bills `n` choices, each up to the output cap.
    const choices =
      protocol === 'openai-chat' && Number.isSafeInteger(body.n) && (body.n as number) > 1
        ? (body.n as number)
        : 1;
    let forwardBody: Uint8Array<ArrayBuffer> | string = bytes;
    if (
      protocol === 'openai-chat' &&
      stream &&
      injectStreamUsage &&
      !(isRecord(body.stream_options) && body.stream_options.include_usage === true)
    ) {
      body = {
        ...body,
        stream_options: {
          ...(isRecord(body.stream_options) ? body.stream_options : {}),
          include_usage: true,
        },
      };
      forwardBody = JSON.stringify(body);
    }
    const info: MeterRequestInfo = {
      id,
      provider: upstream.provider,
      protocol,
      model,
      route: url.pathname,
      stream,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      bodyChars: text.length,
      headers: visibleHeaders(request.headers),
    };

    let scopes: readonly PersistentBudgetScope[] = [];
    let estimate: MeterEstimate;
    try {
      if (budget)
        scopes = typeof budget.scopes === 'function' ? await budget.scopes(info) : budget.scopes;
      estimate = estimator
        ? await estimator(info, body)
        : await defaultMeterEstimate({
            body: text,
            model,
            maxOutputTokens,
            choices,
            options: estimateOptions,
            priceProvider,
          });
      if (
        !Number.isSafeInteger(estimate?.tokens) ||
        estimate.tokens < 0 ||
        (estimate.usd !== undefined && (!Number.isFinite(estimate.usd) || estimate.usd < 0))
      )
        throw new MeterError(
          'invalid_options',
          'An estimate needs a nonnegative integer of tokens and a nonnegative usd or undefined.',
        );
    } catch (error) {
      report(error, { stage: 'reserve', requestId });
      return answer('budget_unavailable', 'the request could not be estimated or scoped.', {
        outcome: 'failed',
        protocol,
        model,
        stream,
      });
    }
    const budgetKeys = scopes.map((scope) => scope.key);
    const priced = estimate.usd !== undefined;
    const context = { protocol, model, stream, estimate, budgetKeys, priced };

    if (!priced) {
      markUnpriced(model, upstream.provider);
      const refuses = scopes.some(
        (scope) =>
          scope.limits.usd !== undefined &&
          (unknownPrice === 'reject' || scope.limits.unknownPrice === 'reject'),
      );
      if (refuses)
        return answer(
          'unpriced_model',
          `${model} has no price, so a USD budget cannot admit it (unknownPrice: 'reject').`,
          { ...context, outcome: 'refused', refusal: { reason: 'unpriced_model' } },
        );
    }

    if (budget && scopes.length > 0) {
      let outcome: BudgetStoreReservation;
      try {
        outcome = await budget.store.reserve({
          requestId,
          modelId: model,
          tokens: estimate.tokens,
          // An unpriced call holds no USD; a USD-bounded scope still needs an amount.
          usd: estimate.usd ?? 0,
          scopes: scopes.map((scope) => ({
            key: scope.key,
            limits: {
              ...(scope.limits.tokens !== undefined ? { tokens: scope.limits.tokens } : {}),
              ...(scope.limits.usd !== undefined ? { usd: scope.limits.usd } : {}),
            },
            ...(scope.window ? { window: scope.window } : {}),
          })),
        });
      } catch (error) {
        report(error, { stage: 'reserve', requestId });
        return answer('budget_unavailable', 'the budget store could not admit the request.', {
          ...context,
          outcome: 'failed',
        });
      }
      if (!outcome.admitted) {
        const amount = (value: number) =>
          outcome.dimension === 'usd' ? `$${value.toFixed(4)}` : `${value} tokens`;
        // Admission is by estimate: a budget with room left can still refuse
        // one request, and saying "exhausted" then contradicts the balance.
        const state =
          outcome.committed >= outcome.limit ? 'is exhausted' : 'cannot cover this request';
        return answer(
          'budget_exceeded',
          `budget ${outcome.key} ${state}: ${amount(outcome.committed)} of ${amount(outcome.limit)} committed, and this request needs up to ${amount(outcome.dimension === 'usd' ? (estimate.usd ?? 0) : estimate.tokens)} (its estimate). The request was not sent.`,
          {
            ...context,
            outcome: 'refused',
            refusal: {
              reason: 'budget_exceeded',
              key: outcome.key,
              dimension: outcome.dimension,
              limit: outcome.limit,
              committed: outcome.committed,
            },
          },
        );
      }
    }
    const held = budget !== undefined && scopes.length > 0;

    let response: Response;
    // A client already gone is never forwarded: nothing was sent, so nothing is owed.
    const goneBeforeSend = request.signal.aborted;
    try {
      response = await upstreamFetch(target, {
        method,
        headers: forwardHeaders(request.headers),
        body: forwardBody,
        signal: request.signal,
        redirect: 'manual',
      });
    } catch (error) {
      const aborted = request.signal.aborted;
      let settlement: MeterSettlement = 'none';
      let charged: { tokens: number; usd: number } | undefined;
      if (held && aborted && !goneBeforeSend) {
        // The client went away after the request was sent: the provider may
        // still bill it, so the hold is charged (fail-closed), as for a
        // client that disconnects mid-stream.
        charged = { tokens: estimate.tokens, usd: estimate.usd ?? 0 };
        settlement = (await close(requestId, { settle: charged })) ? 'estimate' : 'held';
        warn({
          type: 'usage-missing',
          requestId,
          model,
          detail: 'the client went away before the response began',
        });
      } else if (held) {
        settlement = (await close(requestId, { release: true })) ? 'released' : 'held';
      }
      report(error, { stage: 'upstream', requestId });
      return answer('upstream_unreachable', 'the upstream could not be reached.', {
        ...context,
        outcome: aborted ? 'aborted' : 'failed',
        settlement,
        ...(settlement === 'estimate' && charged ? { charged } : {}),
      });
    }
    const upstreamMs = clock.now() - at;
    const status = response.status;
    const ok = status >= 200 && status < 300;
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    // ChatGPT's Codex backend streams /responses with no content-type at all,
    // so a streamed request whose reply does not say JSON is read as SSE.
    const sse =
      contentType.includes('text/event-stream') || (stream && !contentType.includes('json') && ok);
    const reader: UsageReader | undefined = !ok
      ? undefined
      : sse
        ? createSseUsageReader(protocol)
        : createJsonUsageReader(protocol, maxResponseCopyBytes);

    const finish = (how: 'end' | 'cancel' | 'error') =>
      track(
        (async () => {
          if (how === 'end') reader?.end();
          const reading = reader?.read() ?? { complete: false, errored: false };
          const usage = reading.usage;
          const usd = usage ? await price(model, usage) : undefined;
          if (usage && usd === undefined) markUnpriced(model, upstream.provider);
          let settlement: MeterSettlement = 'none';
          let charged: { tokens: number; usd: number } | undefined;
          if (!ok || (reading.errored && !usage)) {
            // Refused upstream, or an error before any usage: nothing billed.
            if (held)
              settlement = (await close(requestId, { release: true })) ? 'released' : 'held';
          } else {
            if (reading.complete && usage) {
              charged = { tokens: usage.totalTokens, usd: usd ?? 0 };
              settlement = 'measured';
            } else {
              // Fail-closed: no final usage, so the hold is billed, or what was
              // seen when that is more.
              charged = {
                tokens: Math.max(estimate.tokens, usage?.totalTokens ?? 0),
                usd: Math.max(estimate.usd ?? 0, usd ?? 0),
              };
              settlement = 'estimate';
              warn({
                type: 'usage-missing',
                requestId,
                model,
                detail:
                  how === 'end'
                    ? 'the response ended without a final usage report'
                    : 'the response did not reach its end',
              });
            }
            if (!held) settlement = 'none';
            else if (!(await close(requestId, { settle: charged }))) settlement = 'held';
          }
          const endedAt = clock.now();
          done();
          record({
            ...base,
            endedAt,
            durationMs: endedAt - at,
            upstreamMs,
            protocol,
            model,
            status,
            outcome: !ok ? 'upstream_error' : how === 'end' ? 'completed' : 'aborted',
            stream: sse,
            ...(usage ? { usage } : {}),
            usageComplete: reading.complete,
            ...(usd !== undefined ? { usd } : {}),
            estimate,
            settlement,
            ...(settlement === 'measured' || settlement === 'estimate' ? { charged } : {}),
            budgetKeys,
            ...upstreamRequestId(response.headers),
            priced: usage ? usd !== undefined : priced,
          });
        })(),
      );

    const relayed = passThrough(response.body, (chunk) => reader?.push(chunk), finish);
    return new Response(relayed, {
      status,
      statusText: response.statusText,
      headers: relayHeaders(response.headers, id),
    });
  }

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      try {
        return await handle(request);
      } catch (error) {
        // Unreachable by design; a meter bug still answers like a provider.
        report(error, { stage: 'upstream' });
        return meterReply(
          'openai',
          'upstream_unreachable',
          'the meter failed to handle the request.',
        );
      }
    },
    stats(): MeterStats {
      const models: Record<string, MeterModelStats> = {};
      for (const [model, row] of byModel) models[model] = { ...row };
      return { startedAt, ...counters, byModel: models, unpricedModels: [...unpriced] };
    },
    async flush(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  });
}

function upstreamRequestId(headers: Headers): { upstreamRequestId?: string } {
  const value = headers.get('request-id') ?? headers.get('x-request-id');
  return value ? { upstreamRequestId: value } : {};
}
