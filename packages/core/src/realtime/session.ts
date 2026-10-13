/**
 * realtime/session.ts — `createRealtimeSession`: one live speech-to-speech
 * session over a provider WebSocket (2.3).
 *
 * The session is provider-neutral. It owns the socket and its lifecycle, the
 * listeners and `events()`, tool execution (`tools.ts`), usage totals and
 * pricing (`usage.ts`); the provider's mapping module (`openai.ts`,
 * `gemini.ts`) owns every wire shape behind the `RealtimeProtocol` seam.
 *
 * Two orderings are guaranteed:
 *
 * - Inbound: socket events (open, message, error, close) are handled one at a
 *   time, in arrival order — even when a frame is a Blob that decodes
 *   asynchronously, and even when a socket dispatches an answer synchronously
 *   from inside `send()` (outgoing sends hold the queue).
 * - Outbound: events reach listeners in the order they were produced. An
 *   asynchronous price provider reserves its place, so `usage` still comes
 *   before the `response-done` that follows it.
 *
 * Edge-safe: Web APIs only; timers come from `deps.clock`, ids from
 * `deps.generateId`. NOT LIVE-VERIFIED against either provider.
 */
import { AbortError, AuthenticationError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { redactString } from '../internal/redact';
import type { UsageMeta } from '../types/deps';
import type { CallWarning } from '../types/methods';
import { RealtimeError } from './errors';
import { encodeBase64, isPlainObject, isPromiseLike, toBytes } from './encoding';
import { geminiLiveProtocol } from './gemini';
import { readRealtimeConfig, resolveApiKey } from './models';
import { openaiRealtimeProtocol } from './openai';
import type {
  CodecSink,
  DecodedUsage,
  ProviderMessage,
  RealtimeCodec,
  RealtimeConnection,
  RealtimeCredential,
  RealtimeProtocol,
  WireTool,
} from './protocol';
import { buildWireTools, createToolRunner, type ToolRunner } from './tools';
import type {
  RealtimeEvent,
  RealtimeEventType,
  RealtimeResponseStatus,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeSessionStatus,
  RealtimeSurface,
  RealtimeUsageTotals,
  RealtimeWebSocket,
} from './types';
import {
  addTokens,
  addUsage,
  emptyTokens,
  emptyUsage,
  priceTokens,
  roundUsd,
  toUsage,
} from './usage';
import { defaultWebSocketFactory, frameText } from './websocket';

/** One mapping module per wire. */
const PROTOCOLS: Readonly<Record<RealtimeSurface, RealtimeProtocol>> = {
  'openai-realtime': openaiRealtimeProtocol,
  'gemini-live': geminiLiveProtocol,
};

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const CLIENT_CLOSE = { code: 1000, reason: 'client closed' } as const;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function usageReason(status: RealtimeResponseStatus | undefined): UsageMeta['reason'] {
  if (status === 'cancelled') return 'aborted';
  if (status === 'failed') return 'error';
  return 'finished';
}

interface Subscriber {
  type: RealtimeEventType | '*';
  listener: (event: RealtimeEvent) => void;
}

interface EventStream {
  push(event: RealtimeEvent): void;
  end(): void;
}

/** A slot in the outbox: its events, or `undefined` while an async step produces them. */
interface Slot {
  events: RealtimeEvent[] | undefined;
}

/**
 * Open a realtime session — OpenAI Realtime or Gemini Live, picked by the
 * model descriptor (`createOpenAIRealtime`, `createGeminiLive`). Nothing is
 * dialed until `connect()`.
 *
 * Server side, authenticate with the model factory's `apiKey` (or
 * `deps.keyProvider`) — Node >= 22, Deno and Bun send it as a handshake header.
 * In a browser, pass an `ephemeralToken` minted by your server.
 *
 * NOT LIVE-VERIFIED: both wires were derived from the providers' official SDK
 * types and tested against a scripted fake socket only.
 */
export function createRealtimeSession(options: RealtimeSessionOptions): RealtimeSession {
  const { model } = options;
  const known = PROTOCOLS[model.surface] as RealtimeProtocol | undefined;
  if (!known) {
    throw new RealtimeError({
      kind: 'connect-failed',
      message: `Unknown realtime model surface '${String(model.surface)}'. Build the model with createOpenAIRealtime or createGeminiLive.`,
    });
  }
  const protocol: RealtimeProtocol = known;
  const deps = resolveDependencies(options.deps);
  const openSocket = options.deps?.webSocket ?? defaultWebSocketFactory;
  const audioFormat = protocol.audioFormat(options);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let status: RealtimeSessionStatus = 'idle';
  let sessionId: string | undefined;
  let socket: RealtimeWebSocket | undefined;
  let codec: RealtimeCodec | undefined;
  let tools: ToolRunner | undefined;
  /** The credential in use — scrubbed out of every message the session writes. */
  let secret: string | undefined;
  /** We asked the socket to close (the `session-closed` initiator). */
  let closeRequested = false;
  /** A fatal error was already reported; the close that follows adds no second one. */
  let fatalReported = false;
  let interruptWarned = false;
  const unpricedWarned = new Set<string>();
  const totals: RealtimeUsageTotals = {
    usage: emptyUsage(),
    tokens: emptyTokens(),
    costUsd: undefined,
  };

  let connectAttempt: Deferred<void> | undefined;
  let connectSettled = false;
  let cancelConnectTimer: () => void = () => {};
  const closed = deferred<void>();
  let closedResolved = false;
  const resolveClosed = () => {
    if (closedResolved) return;
    closedResolved = true;
    closed.resolve();
  };

  function scrub(text: string): string {
    let out = text;
    if (secret) {
      out = out.split(secret).join('[redacted]');
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.split(encoded).join('[redacted]');
    }
    return redactString(out);
  }

  function realtimeError(
    kind: RealtimeError['kind'],
    message: string,
    extra: { upstreamType?: string; closeCode?: number; cause?: unknown } = {},
  ): RealtimeError {
    return new RealtimeError({ kind, message: scrub(message), provider: model.provider, ...extra });
  }

  // --- outbound events -----------------------------------------------------------------

  const subscribers = new Set<Subscriber>();
  const streams = new Set<EventStream>();
  const outbox: Slot[] = [];
  let delivering = false;
  /** `session-closed` is queued: nothing may follow it. */
  let finalQueued = false;

  function deliver(event: RealtimeEvent): void {
    for (const subscriber of [...subscribers]) {
      if (subscriber.type !== '*' && subscriber.type !== event.type) continue;
      try {
        subscriber.listener(event);
      } catch (error) {
        // A listener bug must not take the session down, nor starve the others.
        deps.logger.error('A realtime event listener threw.', {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const stream of [...streams]) stream.push(event);
    if (event.type === 'session-closed') {
      for (const stream of [...streams]) stream.end();
      resolveClosed();
    }
  }

  function drain(): void {
    if (delivering) return;
    delivering = true;
    try {
      while (outbox.length > 0 && outbox[0]!.events !== undefined) {
        for (const event of outbox.shift()!.events!) deliver(event);
      }
    } finally {
      delivering = false;
    }
  }

  function emit(...events: RealtimeEvent[]): void {
    if (finalQueued) return;
    if (events.some((event) => event.type === 'session-closed')) finalQueued = true;
    outbox.push({ events });
    drain();
  }

  /** Reserve the next place in the event order for events an async step will produce. */
  function emitLater(pending: Promise<RealtimeEvent[]>): void {
    if (finalQueued) return;
    const slot: Slot = { events: undefined };
    outbox.push(slot);
    pending.then(
      (events) => {
        slot.events = events;
        drain();
      },
      (error: unknown) => {
        deps.logger.error('A realtime event could not be produced.', {
          error: error instanceof Error ? error.message : String(error),
        });
        slot.events = [];
        drain();
      },
    );
  }

  function warn(warning: CallWarning): void {
    emit({ type: 'warning', warning });
  }

  function createStream(): AsyncIterableIterator<RealtimeEvent> {
    const queue: RealtimeEvent[] = [];
    let ended = false;
    let waiting: ((result: IteratorResult<RealtimeEvent>) => void) | undefined;
    const stream: EventStream = {
      push(event) {
        if (ended) return;
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve({ value: event, done: false });
        } else queue.push(event);
      },
      end() {
        if (ended) return;
        ended = true;
        streams.delete(stream);
        if (waiting && queue.length === 0) {
          const resolve = waiting;
          waiting = undefined;
          resolve({ value: undefined, done: true });
        }
      },
    };
    if (status === 'closed') ended = true;
    else streams.add(stream);
    const iterator: AsyncIterableIterator<RealtimeEvent> = {
      next() {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
        if (ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      return() {
        stream.end();
        queue.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  // --- inbound queue -------------------------------------------------------------------

  const inbound: (() => void | Promise<void>)[] = [];
  let inboundBusy = false;
  let holds = 0;

  function pump(): void {
    if (inboundBusy || holds > 0) return;
    while (inbound.length > 0) {
      const job = inbound.shift()!;
      inboundBusy = true;
      let result: void | Promise<void>;
      try {
        result = job();
      } catch (error) {
        deps.logger.error('A realtime socket event could not be handled.', {
          error: error instanceof Error ? error.message : String(error),
        });
        result = undefined;
      }
      if (isPromiseLike<void>(result)) {
        const resume = () => {
          inboundBusy = false;
          pump();
        };
        result.then(resume, resume);
        return;
      }
      inboundBusy = false;
    }
  }

  function enqueue(job: () => void | Promise<void>): void {
    inbound.push(job);
    pump();
  }

  /** Run `fn` with the inbound queue held: a frame dispatched meanwhile waits its turn. */
  function hold<T>(fn: () => T): T {
    holds++;
    try {
      return fn();
    } finally {
      holds--;
      if (holds === 0) pump();
    }
  }

  // --- sending ----------------------------------------------------------------------------

  function transmit(messages: ProviderMessage[]): void {
    const target = socket;
    if (!target || messages.length === 0) return;
    hold(() => {
      for (const message of messages) target.send(JSON.stringify(message));
    });
  }

  /**
   * A send the session decided on itself (deferred `response.create`, tool
   * results). Nobody awaits it, so a failure, building the messages or on the
   * socket, is reported as a non-fatal `error` event: the model never got them.
   */
  function transmitQuietly(
    kind: RealtimeError['kind'],
    action: string,
    build: () => ProviderMessage[],
  ): void {
    if (status !== 'open') return;
    try {
      transmit(build());
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      deps.logger.warn('A realtime message could not be sent.', { error: scrub(detail) });
      emit({
        type: 'error',
        fatal: false,
        error: realtimeError(kind, `Could not ${action}: ${detail}`, { cause }),
      });
    }
  }

  function assertOpen(action: string): RealtimeCodec {
    if (status !== 'open' || !codec) {
      throw realtimeError(
        'not-connected',
        `Cannot ${action}: the realtime session is ${status}. ` +
          (status === 'idle' || status === 'connecting'
            ? 'Await connect() first.'
            : 'Sessions are single-use — create a new one.'),
      );
    }
    return codec;
  }

  /** Public sends: a socket that refuses the frame surfaces as `not-connected`. */
  function send(action: string, messages: ProviderMessage[]): void {
    try {
      transmit(messages);
    } catch (cause) {
      throw realtimeError(
        'not-connected',
        `Cannot ${action}: the socket refused the message (${cause instanceof Error ? cause.message : String(cause)}).`,
        { cause },
      );
    }
  }

  // --- usage -------------------------------------------------------------------------------

  function priced(
    event: Extract<RealtimeEvent, { type: 'usage' }>,
    usd: number | undefined,
  ): RealtimeEvent[] {
    if (usd === undefined) {
      if (unpricedWarned.has(model.modelId)) return [event];
      unpricedWarned.add(model.modelId);
      return [
        {
          type: 'warning',
          warning: {
            type: 'unpriced-model',
            setting: 'priceProvider',
            message:
              `Realtime model '${model.modelId}' has no price for every modality it used ` +
              `('${model.modelId}' for text, 'audio:${model.modelId}' for audio, 'image:${model.modelId}' for images), ` +
              'so its USD cost is not counted; token usage still is. Add rows with realtimePriceTable().',
          },
        },
        event,
      ];
    }
    totals.costUsd = roundUsd((totals.costUsd ?? 0) + usd);
    return [{ ...event, costUsd: usd }];
  }

  function recordUsage(
    decoded: DecodedUsage,
    meta: { responseId?: string; status?: RealtimeResponseStatus },
  ): void {
    const usage = toUsage(decoded);
    const tokens = decoded.tokens;
    totals.usage = addUsage(totals.usage, usage);
    totals.tokens = addTokens(totals.tokens, tokens);
    try {
      deps.onUsage?.(usage, { model: model.modelId, reason: usageReason(meta.status) });
    } catch (error) {
      deps.logger.error('deps.onUsage threw.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const event = {
      type: 'usage' as const,
      ...(meta.responseId ? { responseId: meta.responseId } : {}),
      usage,
      tokens,
    };
    const provider = deps.priceProvider;
    if (!provider) {
      emit(event);
      return;
    }
    const usd = priceTokens(provider, model.modelId, tokens);
    if (isPromiseLike<number | undefined>(usd)) {
      emitLater(Promise.resolve(usd).then((value) => priced(event, value)));
    } else emit(...priced(event, usd));
  }

  // --- what the codec reports ------------------------------------------------------------

  const sink: CodecSink = {
    ready(id) {
      if (status !== 'connecting' || connectSettled) return;
      connectSettled = true;
      cancelConnectTimer();
      sessionId = id;
      status = 'open';
      emit({ type: 'session-ready', ...(id ? { sessionId: id } : {}) });
      connectAttempt?.resolve();
    },
    emit(event) {
      if (status !== 'closed') emit(event);
    },
    send(message) {
      const name = typeof message.type === 'string' ? message.type : 'a message';
      transmitQuietly('not-connected', `send ${name}`, () => [message]);
    },
    providerError({ message, upstreamType }) {
      const error = realtimeError('provider', message, upstreamType ? { upstreamType } : {});
      if (status === 'connecting') failConnect(error);
      else if (status !== 'closed') emit({ type: 'error', error, fatal: false });
    },
    usage(decoded, meta) {
      if (status !== 'closed') recordUsage(decoded, meta);
    },
    toolCalls(calls, responseId) {
      if (status === 'open') tools?.dispatch(calls, responseId);
    },
    cancelToolCalls(ids, reason) {
      if (status === 'closed') return;
      // A provider cancellation only concerns calls that are still pending.
      const toolCallIds = reason === 'provider' ? (tools?.cancel(ids) ?? []) : ids;
      if (toolCallIds.length > 0) emit({ type: 'tool-call-cancelled', toolCallIds, reason });
    },
    warn(warning) {
      if (status !== 'closed') warn(warning);
    },
    generateId: () => deps.generateId(),
  };

  // --- lifecycle -----------------------------------------------------------------------------

  function finalize(close: { code: number; reason: string; initiator: 'client' | 'server' }): void {
    if (status === 'closed') return;
    cancelConnectTimer();
    options.signal?.removeEventListener('abort', onAbort);
    tools?.close();
    try {
      codec?.closed();
    } catch (error) {
      deps.logger.error('The realtime codec failed to flush on close.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    status = 'closed';
    emit({ type: 'session-closed', ...close });
  }

  /** Close without a `session-closed` event: no socket was ever created. */
  function finishUnopened(): void {
    cancelConnectTimer();
    options.signal?.removeEventListener('abort', onAbort);
    status = 'closed';
    for (const stream of [...streams]) stream.end();
    resolveClosed();
  }

  function requestClose(code: number, reason: string): void {
    if (status === 'closed') return;
    status = 'closing';
    closeRequested = true;
    tools?.close();
    if (!socket) {
      finishUnopened();
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      finalize({ code: 1006, reason: '', initiator: 'client' });
    }
  }

  /**
   * The connect attempt failed. Before a socket exists this only rejects
   * `connect()`; after, the failure is also a fatal `error` event and the
   * socket is closed (unless it is already going down).
   */
  function failConnect(
    error: unknown,
    {
      emitError = true,
      closeSocket = true,
      closeReason = 'connect failed',
    }: { emitError?: boolean; closeSocket?: boolean; closeReason?: string } = {},
  ): void {
    if (!connectAttempt || connectSettled) return;
    connectSettled = true;
    cancelConnectTimer();
    connectAttempt.reject(error);
    if (!socket) {
      finishUnopened();
      return;
    }
    if (emitError && error instanceof RealtimeError && !fatalReported) {
      fatalReported = true;
      emit({ type: 'error', error, fatal: true });
    }
    if (closeSocket) requestClose(CLIENT_CLOSE.code, closeReason);
    else if (status === 'connecting') status = 'closing';
  }

  function onAbort(): void {
    if (status === 'connecting') {
      failConnect(
        new AbortError('The realtime session was aborted.', { cause: options.signal?.reason }),
        { closeReason: 'aborted' },
      );
    } else if (status === 'open') requestClose(CLIENT_CLOSE.code, 'aborted');
  }

  // --- socket events (run through the inbound queue) -------------------------------------

  function onOpen(): void {
    if (status !== 'connecting' || !codec) return;
    try {
      transmit(codec.setup());
    } catch (cause) {
      failConnect(
        realtimeError(
          'connect-failed',
          `Could not send the ${protocol.label} session setup: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
    }
  }

  function onText(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      message = undefined;
    }
    if (!isPlainObject(message)) {
      emit({
        type: 'error',
        fatal: false,
        error: realtimeError(
          'invalid-message',
          `Ignored a ${protocol.label} frame that is not a JSON object.`,
        ),
      });
      return;
    }
    if (options.rawEvents) emit({ type: 'raw', message });
    try {
      codec?.receive(message);
    } catch (cause) {
      emit({
        type: 'error',
        fatal: false,
        error: realtimeError(
          'invalid-message',
          `Could not decode a ${protocol.label} message: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      });
    }
  }

  function onMessage(event: unknown): void | Promise<void> {
    if (status === 'closed') return;
    const text = frameText(fields(event).data);
    if (typeof text === 'string') {
      onText(text);
      return;
    }
    return text.then(
      (decoded) => {
        if (status !== 'closed') onText(decoded);
      },
      (cause: unknown) => {
        emit({
          type: 'error',
          fatal: false,
          error: realtimeError('invalid-message', 'Could not read a binary realtime frame.', {
            cause,
          }),
        });
      },
    );
  }

  function onSocketError(event: unknown): void {
    if (status === 'closed' || status === 'closing') return;
    const raw = fields(event);
    const cause = raw.error instanceof Error ? raw.error : undefined;
    const detail = typeof raw.message === 'string' && raw.message ? raw.message : cause?.message;
    const error = realtimeError(
      'transport',
      `The ${protocol.label} WebSocket failed${detail ? `: ${detail}` : '.'}`,
      cause ? { cause } : {},
    );
    // The socket closes right after an error event; the close needs no second error.
    if (status === 'connecting') {
      failConnect(error, { closeSocket: false });
      return;
    }
    fatalReported = true;
    status = 'closing';
    emit({ type: 'error', error, fatal: true });
  }

  function onSocketClose(event: unknown): void {
    if (status === 'closed') return;
    const raw = fields(event);
    const code = typeof raw.code === 'number' ? raw.code : 1005;
    const reason = scrub(typeof raw.reason === 'string' ? raw.reason : '');
    const describe = `(code ${code}${reason ? `: ${reason}` : ''})`;
    if (status === 'connecting') {
      failConnect(
        realtimeError(
          'closed',
          `${protocol.label} closed the connection before the session was ready ${describe}.`,
          { closeCode: code },
        ),
        { closeSocket: false },
      );
    } else if (!closeRequested && code !== 1000 && !fatalReported) {
      fatalReported = true;
      emit({
        type: 'error',
        fatal: true,
        error: realtimeError('closed', `${protocol.label} closed the connection ${describe}.`, {
          closeCode: code,
        }),
      });
    }
    finalize({ code, reason, initiator: closeRequested ? 'client' : 'server' });
  }

  // --- connect -------------------------------------------------------------------------------

  async function resolveCredential(): Promise<RealtimeCredential> {
    const token = options.ephemeralToken;
    if (token !== undefined) {
      const value = typeof token === 'function' ? await token() : token;
      if (typeof value !== 'string' || value === '') {
        throw new AuthenticationError({
          message: 'ephemeralToken resolved to an empty value.',
          provider: model.provider,
        });
      }
      secret = value;
      return { kind: 'ephemeral', value };
    }
    const apiKey = await resolveApiKey(
      model,
      deps,
      'Server side, pass apiKey to the model factory or a deps.keyProvider; in a browser, pass an ephemeralToken minted by your server.',
    );
    secret = apiKey;
    return { kind: 'api-key', value: apiKey };
  }

  function connectFailed(cause: unknown, connection: RealtimeConnection): RealtimeError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const hint = connection.headers
      ? ' A browser cannot send WebSocket handshake headers, so it cannot authenticate with an API key: ' +
        'mint an ephemeral token on your server (createOpenAIClientSecret / createGeminiAuthToken) and pass it ' +
        'as ephemeralToken, or pass deps.webSocket with a socket that can send headers.'
      : '';
    return realtimeError(
      'connect-failed',
      `Could not open the ${protocol.label} WebSocket: ${detail}.${hint}`,
      { cause },
    );
  }

  /** A step before the socket exists failed: `connect()` still rejects with a RealtimeError. */
  function preparationFailed(cause: unknown, what: string): RealtimeError {
    if (cause instanceof RealtimeError) return cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return realtimeError('connect-failed', `Could not ${what}: ${detail}`, { cause });
  }

  async function dial(): Promise<void> {
    try {
      const credential = await resolveCredential();
      if (status !== 'connecting') return;
      let wireTools: WireTool[];
      try {
        wireTools = await buildWireTools(options.tools, warn);
      } catch (cause) {
        throw preparationFailed(cause, 'declare the session tools');
      }
      if (status !== 'connecting') return;
      let connection: RealtimeConnection;
      try {
        connection = protocol.connection(model, readRealtimeConfig(model), credential);
      } catch (cause) {
        throw preparationFailed(cause, `prepare the ${protocol.label} connection (check baseURL)`);
      }
      codec = protocol.createCodec({ model, config: options, tools: wireTools, sink });
      tools = createToolRunner({
        tools: options.tools,
        approveToolCall: options.approveToolCall,
        ...('runtimeContext' in options
          ? { runtimeContext: { value: options.runtimeContext } }
          : {}),
        deps,
        emit,
        flush: (outcomes) => {
          const wire = codec;
          if (!wire) return;
          const names = outcomes.map((outcome) => outcome.call.toolName).join(', ');
          transmitQuietly('tool', `send the tool results (${names})`, () =>
            wire.toolResults(outcomes),
          );
        },
      });
      let opened: RealtimeWebSocket;
      try {
        opened = openSocket(connection.url, {
          ...(connection.protocols ? { protocols: connection.protocols } : {}),
          ...(connection.headers ? { headers: connection.headers } : {}),
        });
      } catch (cause) {
        throw cause instanceof RealtimeError ? cause : connectFailed(cause, connection);
      }
      socket = opened;
      try {
        // JSON in binary frames (Gemini) then arrives as an ArrayBuffer, not a Blob.
        opened.binaryType = 'arraybuffer';
      } catch {
        // A socket without a settable binaryType still works: frameText reads Blobs.
      }
      opened.addEventListener('open', () => enqueue(onOpen));
      opened.addEventListener('message', (event) => enqueue(() => onMessage(event)));
      opened.addEventListener('error', (event) => enqueue(() => onSocketError(event)));
      opened.addEventListener('close', (event) => enqueue(() => onSocketClose(event)));
    } catch (error) {
      failConnect(error);
    }
  }

  function connect(): Promise<void> {
    if (status === 'open') return Promise.resolve();
    if (status === 'connecting' && connectAttempt) return connectAttempt.promise;
    if (status !== 'idle') {
      return Promise.reject(
        realtimeError(
          'closed',
          'This realtime session is closed. Sessions are single-use: create a new one to reconnect.',
        ),
      );
    }
    status = 'connecting';
    connectAttempt = deferred<void>();
    const attempt = connectAttempt.promise;
    // The timeout covers the whole attempt, token fetch included. 0 or Infinity
    // disables it (a host timer would clamp Infinity to 1 ms).
    if (connectTimeoutMs > 0 && Number.isFinite(connectTimeoutMs)) {
      cancelConnectTimer = deps.clock.setTimeout(() => {
        failConnect(
          realtimeError(
            'connect-timeout',
            `${protocol.label} did not accept the session within ${connectTimeoutMs} ms.`,
          ),
          { closeReason: 'connect timeout' },
        );
      }, connectTimeoutMs);
    }
    if (options.signal?.aborted) {
      failConnect(
        new AbortError('The realtime session was aborted.', { cause: options.signal.reason }),
      );
      return attempt;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void dial();
    return attempt;
  }

  function close(): Promise<void> {
    if (status === 'idle') finishUnopened();
    else if (status === 'connecting') {
      failConnect(realtimeError('closed', 'The session was closed before it connected.'), {
        emitError: false,
        closeSocket: false,
      });
      requestClose(CLIENT_CLOSE.code, CLIENT_CLOSE.reason);
    } else if (status === 'open') requestClose(CLIENT_CLOSE.code, CLIENT_CLOSE.reason);
    return closed.promise;
  }

  // --- the public object -------------------------------------------------------------------

  function on(type: RealtimeEventType | '*', listener: (event: RealtimeEvent) => void): () => void {
    const subscriber: Subscriber = { type, listener };
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }

  return {
    model,
    get status() {
      return status;
    },
    get sessionId() {
      return sessionId;
    },
    audioFormat,
    get usage(): RealtimeUsageTotals {
      return {
        usage: { ...totals.usage },
        tokens: {
          text: { ...totals.tokens.text },
          audio: { ...totals.tokens.audio },
          image: { ...totals.tokens.image },
        },
        costUsd: totals.costUsd,
      };
    },
    connect,
    close,
    on: on as RealtimeSession['on'],
    events: createStream,
    appendAudio(audio) {
      const wire = assertOpen('append audio');
      send('append audio', wire.appendAudio(encodeBase64(toBytes(audio))));
    },
    commitAudio() {
      send('commit audio', assertOpen('commit audio').commitAudio());
    },
    sendText(text, sendOptions) {
      send('send text', assertOpen('send text').sendText(text, sendOptions?.respond !== false));
    },
    createResponse() {
      send('create a response', assertOpen('create a response').createResponse());
    },
    interrupt(interruptOptions) {
      const messages = assertOpen('interrupt').interrupt(interruptOptions?.playedMs);
      if (messages) {
        send('interrupt', messages);
        return;
      }
      if (interruptWarned) return;
      interruptWarned = true;
      warn({
        type: 'unsupported-setting',
        setting: 'interrupt',
        message: `${protocol.label} has no client-side interrupt; it stops by itself when the user speaks. Nothing was sent.`,
      });
    },
    sendToolResult(toolCallId, result, resultOptions) {
      assertOpen('send a tool result');
      tools!.resolveClientCall(toolCallId, result, resultOptions?.isError === true);
    },
    sendRaw(message) {
      assertOpen('send a raw message');
      send('send a raw message', [message]);
    },
  };
}

/**
 * The fields of a socket event. DOM events are class instances (their fields
 * are prototype getters), so `encoding.obj`, which accepts plain objects only,
 * would read them as empty.
 */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
