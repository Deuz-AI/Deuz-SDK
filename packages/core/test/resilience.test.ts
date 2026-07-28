import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMockModel } from '../src/testing';
import { createInMemoryChatStore } from '../src/chat';
import { TimeoutError } from '../src/errors';
import type { Clock } from '../src/types/deps';
import type { StreamPart } from '../src/types/stream';
import type { ToolSet } from '../src/types/tool';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents } from './fixtures/sse';

/** Fire short (backoff) timers fast; never fire the long ttft/total timers. */
function fastClock(): Clock {
  return {
    now: () => 0,
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

interface ArmedTimer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * A fully controlled injected clock (never `vi.useFakeTimers`, per CLAUDE.md):
 * every timer is recorded with the ms it was armed for, and fired only on demand.
 * That is what makes the timeout layers assertable — the layer under test is
 * identified by the duration the SDK asked for.
 */
function controlledClock(): {
  clock: Clock;
  armed: () => number[];
  fire: (ms: number) => boolean;
} {
  const timers: ArmedTimer[] = [];
  const clock: Clock = {
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer: ArmedTimer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    clock,
    armed: () => timers.map((t) => t.ms),
    fire(ms) {
      let fired = false;
      for (const timer of timers) {
        if (timer.cancelled || timer.ms !== ms) continue;
        timer.cancelled = true;
        timer.fn();
        fired = true;
      }
      return fired;
    },
  };
}

/**
 * A 200 response whose SSE body never delivers a byte until an abort errors it —
 * which is what a real transport does to an in-flight body read. Lets a test
 * hold the stream open while it fires the ttft/total timer.
 */
function hangingFetch(): { fetch: typeof fetch; dialed: Promise<void> } {
  let markDialed!: () => void;
  const dialed = new Promise<void>((resolve) => {
    markDialed = resolve;
  });
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          'abort',
          () => {
            controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      },
    });
    markDialed();
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  return { fetch: fn, dialed };
}

const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };

const OK_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function errorResponse(status: number, type: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: type } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sequenceFetch(responses: (() => Response)[]): {
  fetch: typeof fetch;
  count: () => number;
} {
  let i = 0;
  const fn = (async () => {
    const make = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return make();
  }) as typeof fetch;
  return { fetch: fn, count: () => i };
}

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) void _;
  })();
}

describe('resilience', () => {
  it('retries a 529 overload then succeeds', async () => {
    const { fetch, count } = sequenceFetch([
      () => errorResponse(529, 'overloaded_error'),
      () => sseResponse([OK_STREAM]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok');
    expect(await result.finishReason).toBe('stop');
    expect(count()).toBe(2); // one retry
  });

  it('does NOT retry a 400 invalid_request', async () => {
    const { fetch, count } = sequenceFetch([() => errorResponse(400, 'invalid_request_error')]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await drain(result.fullStream); // error part, no throw
    await expect(result.usage).rejects.toMatchObject({ code: 'invalid_request' });
    expect(count()).toBe(1); // no retry
  });

  it('a user abort resolves finishReason "aborted" (no retry, no throw on fullStream)', async () => {
    const controller = new AbortController();
    const abortFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted)
        throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
      return sseResponse([OK_STREAM]);
    }) as typeof fetch;

    controller.abort();
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: abortFetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await drain(result.fullStream);
    expect(await result.finishReason).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// 1.9 (2.3a): `options.timeout` — the four layers. Before this, DEFAULT_TIMEOUTS
// was a module constant with NO override path, so a 300s total ceiling on a
// 25-30s serverless budget was a dead number.
// ---------------------------------------------------------------------------

describe('timeout layers (1.9)', () => {
  const anthropic = (fetch: typeof globalThis.fetch) =>
    createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');

  it('arms exactly the 1.8 defaults when `timeout` is absent', async () => {
    const clock = controlledClock();
    const result = streamChat({
      model: anthropic((async () => sseResponse([OK_STREAM])) as typeof fetch),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok');
    expect(await result.finishReason).toBe('stop');
    // total armed first, then ttft (createTimeout's order) — DEFAULT_TIMEOUTS.
    expect(clock.armed()).toEqual([300_000, 60_000]);
  });

  it('`timeout: 5000` is shorthand for `{ totalMs: 5000 }`', async () => {
    const run = async (timeout: number | { totalMs: number }): Promise<number[]> => {
      const clock = controlledClock();
      const result = streamChat({
        model: anthropic((async () => sseResponse([OK_STREAM])) as typeof fetch),
        messages: [{ role: 'user', content: 'hi' }],
        timeout,
        deps: { clock: clock.clock, generateId: () => 'fixed-id' },
      });
      await drain(result.textStream);
      return clock.armed();
    };
    expect(await run(5_000)).toEqual([5_000, 60_000]);
    expect(await run({ totalMs: 5_000 })).toEqual(await run(5_000));
  });

  it('ttftMs expiry FAILS the run with a TimeoutError (never "aborted")', async () => {
    const clock = controlledClock();
    const { fetch, dialed } = hangingFetch();
    const result = streamChat({
      model: anthropic(fetch),
      messages: [{ role: 'user', content: 'hi' }],
      timeout: { ttftMs: 1_000 },
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    });
    const drained = drain(result.fullStream); // error part, no throw
    await dialed;
    expect(clock.armed()).toEqual([300_000, 1_000]); // total default kept, ttft overridden
    expect(clock.fire(1_000)).toBe(true);
    await drained;
    await expect(result.usage).rejects.toBeInstanceOf(TimeoutError);
    await expect(result.usage).rejects.toMatchObject({ layer: 'ttft' });
    await expect(result.finishReason).rejects.toBeInstanceOf(TimeoutError);
  });

  it('totalMs expiry FAILS the run; `ttftMs: 0` disables the ttft layer', async () => {
    const clock = controlledClock();
    const { fetch, dialed } = hangingFetch();
    const result = streamChat({
      model: anthropic(fetch),
      messages: [{ role: 'user', content: 'hi' }],
      timeout: { ttftMs: 0, totalMs: 2_000 },
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    });
    const drained = drain(result.fullStream);
    await dialed;
    expect(clock.armed()).toEqual([2_000]); // no ttft timer at all
    expect(clock.fire(2_000)).toBe(true);
    await drained;
    await expect(result.usage).rejects.toMatchObject({ code: 'timeout', layer: 'total' });
  });

  it('a user abort still resolves "aborted" with partial usage — the two paths stay distinct', async () => {
    const clock = controlledClock();
    const controller = new AbortController();
    const { fetch, dialed } = hangingFetch();
    const result = streamChat({
      model: anthropic(fetch),
      messages: [{ role: 'user', content: 'hi' }],
      timeout: { ttftMs: 1_000, totalMs: 2_000 },
      signal: controller.signal,
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    });
    const drained = drain(result.fullStream);
    await dialed;
    controller.abort();
    await drained;
    expect(await result.finishReason).toBe('aborted');
    expect((await result.usage).totalTokens).toBe(0); // partial usage, RESOLVED
  });

  it('stepMs expiry fails the agentic loop after its tools ran', async () => {
    const clock = controlledClock();
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = streamChat({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'slow', args: {} }] }, { text: 'unreachable' }],
      }),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        slow: {
          description: 'blocks until released',
          parameters: EMPTY_SCHEMA,
          execute: async () => {
            toolStarted();
            await blocked;
            return 'done';
          },
        },
      },
      maxSteps: 3,
      timeout: { stepMs: 1_000 },
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    });
    const parts: StreamPart[] = [];
    const drained = (async () => {
      for await (const part of result.fullStream) parts.push(part);
    })();
    await started;
    expect(clock.fire(1_000)).toBe(true); // the step deadline, not ttft/total
    release();
    await drained;
    await expect(result.usage).rejects.toBeInstanceOf(TimeoutError);
    await expect(result.usage).rejects.toThrow(/Agentic step timed out/);
    // The step layer is MACHINE-READABLE (1.9): it used to borrow 'total', which
    // was indistinguishable from a real per-call ceiling.
    await expect(result.usage).rejects.toMatchObject({ code: 'timeout', layer: 'step' });
    expect(parts.some((p) => p.type === 'error')).toBe(true);
    // The tool DID run — the step is failed at its boundary, not mid-execution.
    expect(parts.some((p) => p.type === 'step-start')).toBe(true);
  });

  it('a loop without stepMs arms no step timer (1.8 behaviour unchanged)', async () => {
    const clock = controlledClock();
    const result = streamChat({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'now', args: {} }] }, { text: 'ok' }],
      }),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        now: { description: 'instant', parameters: EMPTY_SCHEMA, execute: () => 'done' },
      },
      maxSteps: 3,
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    });
    await drain(result.fullStream);
    expect(await result.finishReason).toBe('stop');
    // Two model calls × (total, ttft) and nothing else.
    expect(clock.armed()).toEqual([300_000, 60_000, 300_000, 60_000]);
  });
});

// ---------------------------------------------------------------------------
// 1.9 (finishing pass): `timeout.stepMs` in the BUFFERED loop. It was wired
// into stream-tool-loop.ts only, so `generateText` with tools accepted the
// option and silently did nothing with it — exactly the silent-failure class
// this release set out to close. Both loops must enforce the same input, and a
// step expiry must stay distinguishable from a per-call ceiling (`layer:
// 'step'`, never 'total') and from a user cancel (`finishReason: 'aborted'`).
// ---------------------------------------------------------------------------

describe('timeout.stepMs — loop parity (1.9)', () => {
  const anthropic = (fetch: typeof globalThis.fetch) =>
    createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');

  /** A `slow` tool that blocks until `release()`, announcing when it STARTED. */
  function slowTool(): { tools: ToolSet; started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      tools: {
        slow: {
          description: 'blocks until released',
          parameters: EMPTY_SCHEMA,
          execute: async () => {
            markStarted();
            await blocked;
            return 'done';
          },
        },
      },
      started,
      release,
    };
  }

  interface SlowStepRun {
    error?: unknown;
    text: string;
    armed: number[];
  }

  /**
   * Drive ONE slow step through the chosen loop, firing the step deadline (when
   * armed) while the tool is still executing — the only moment at which the
   * "expired while the tools ran" path is reachable, since a timer cannot abort
   * a running tool. Returns the failure (undefined when the run completed), the
   * final text, and every timer the SDK armed.
   */
  async function runSlowStep(
    loop: 'generateText' | 'streamChat',
    timeout?: { stepMs: number },
  ): Promise<SlowStepRun> {
    const clock = controlledClock();
    const { tools, started, release } = slowTool();
    const call = {
      // Turn 1 calls `slow`; turn 2 is only reached when nothing cut the loop.
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'slow', args: {} }] }, { text: 'unreachable' }],
      }),
      messages: [{ role: 'user' as const, content: 'go' }],
      tools,
      maxSteps: 3,
      ...(timeout ? { timeout } : {}),
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    };
    const choreograph = (async () => {
      await started;
      if (timeout) expect(clock.fire(timeout.stepMs)).toBe(true);
      release();
    })();

    if (loop === 'generateText') {
      const settled = await generateText(call).then(
        (res): SlowStepRun => ({ text: res.text, armed: [] }),
        (error: unknown): SlowStepRun => ({ error, text: '', armed: [] }),
      );
      await choreograph;
      return { ...settled, armed: clock.armed() };
    }
    const result = streamChat(call);
    let text = '';
    let error: unknown;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text;
      else if (part.type === 'error') error ??= part.error;
    }
    await choreograph;
    return { text, ...(error !== undefined ? { error } : {}), armed: clock.armed() };
  }

  it('generateText FAILS a slow step once `timeout.stepMs` expires', async () => {
    const { error, text } = await runSlowStep('generateText', { stepMs: 1_000 });
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ code: 'timeout', layer: 'step' });
    expect((error as Error).message).toMatch(/Agentic step timed out/);
    expect(text).toBe(''); // turn 2 never ran
  });

  it('the SAME slow step completes with NO `timeout`, arming no step timer (1.8 unchanged)', async () => {
    const { error, text, armed } = await runSlowStep('generateText');
    expect(error).toBeUndefined();
    expect(text).toBe('unreachable'); // the loop continued to turn 2
    // Two model calls × (total, ttft) and nothing else — no step deadline exists.
    expect(armed).toEqual([300_000, 60_000, 300_000, 60_000]);
  });

  it('BOTH loops fail the same slow step identically — same layer, same message, same timers', async () => {
    const shape = (
      run: SlowStepRun,
    ): { isTimeout: boolean; code: unknown; layer: unknown; message: unknown } => ({
      isTimeout: run.error instanceof TimeoutError,
      code: (run.error as TimeoutError).code,
      layer: (run.error as TimeoutError).layer,
      message: (run.error as Error).message,
    });
    const buffered = await runSlowStep('generateText', { stepMs: 1_000 });
    const streaming = await runSlowStep('streamChat', { stepMs: 1_000 });

    expect(shape(buffered)).toEqual(shape(streaming));
    expect(shape(buffered)).toEqual({
      isTimeout: true,
      code: 'timeout',
      layer: 'step',
      message: 'Agentic step timed out (step, 1000ms).',
    });
    // Neither loop reached turn 2, and both armed the deadline BEFORE the model
    // call's own ttft/total — the same option can never mean two things.
    expect(buffered.text).toBe('');
    expect(streaming.text).toBe('');
    expect(buffered.armed).toEqual(streaming.armed);
    expect(buffered.armed).toEqual([1_000, 300_000, 60_000]);
  });

  it('a stepMs expiry DURING the model call fails both loops (the failSignal path)', async () => {
    const run = async (loop: 'generateText' | 'streamChat'): Promise<unknown> => {
      const clock = controlledClock();
      const { fetch, dialed } = hangingFetch();
      const call = {
        model: anthropic(fetch),
        messages: [{ role: 'user' as const, content: 'go' }],
        tools: {
          slow: { description: 'never reached', parameters: EMPTY_SCHEMA, execute: () => 'done' },
        },
        maxSteps: 3,
        // ttft/total DISABLED, so the step deadline is the only armed timer and
        // the failure can only come from it.
        timeout: { ttftMs: 0, totalMs: 0, stepMs: 1_000 },
        deps: { clock: clock.clock, generateId: () => 'fixed-id' },
      };
      if (loop === 'generateText') {
        const running = generateText(call).then(
          () => undefined,
          (err: unknown) => err,
        );
        await dialed;
        expect(clock.armed()).toEqual([1_000]);
        expect(clock.fire(1_000)).toBe(true);
        return running;
      }
      const result = streamChat(call);
      const drained = drain(result.fullStream); // error part, never a throw (G2)
      await dialed;
      expect(clock.armed()).toEqual([1_000]);
      expect(clock.fire(1_000)).toBe(true);
      await drained;
      return result.usage.then(
        () => undefined,
        (err: unknown) => err,
      );
    };
    const buffered = await run('generateText');
    const streaming = await run('streamChat');
    for (const error of [buffered, streaming]) {
      expect(error).toBeInstanceOf(TimeoutError);
      // The pump recovers the reason we armed instead of misreading the
      // transport's bare AbortError as a user cancel.
      expect(error).toMatchObject({ code: 'timeout', layer: 'step' });
    }
    expect((buffered as Error).message).toBe((streaming as Error).message);
  });

  it('a per-call `totalMs` expiry inside the SAME loop still reports layer "total"', async () => {
    const clock = controlledClock();
    const { fetch, dialed } = hangingFetch();
    const running = generateText({
      model: anthropic(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        slow: { description: 'never reached', parameters: EMPTY_SCHEMA, execute: () => 'done' },
      },
      maxSteps: 3,
      timeout: { totalMs: 2_000, stepMs: 9_000 },
      deps: { clock: clock.clock, generateId: () => 'fixed-id' },
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await dialed;
    // Step deadline first, then the model call's total/ttft.
    expect(clock.armed()).toEqual([9_000, 2_000, 60_000]);
    expect(clock.fire(2_000)).toBe(true);
    await expect(running).resolves.toBeInstanceOf(TimeoutError);
    await expect(running).resolves.toMatchObject({ code: 'timeout', layer: 'total' });
  });

  it('a user abort during a step resolves "aborted" with partial usage — never a TimeoutError', async () => {
    /** One tool-calling turn (usage 3 in / 2 out) naming the `cancel` tool. */
    const CANCEL_TOOL_CALL = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'cancel' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 2 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const run = async (
      loop: 'generateText' | 'streamChat',
    ): Promise<{ finishReason: string; totalTokens: number }> => {
      const clock = controlledClock();
      const controller = new AbortController();
      // Turn 1 answers with the tool call; the tool presses stop, so turn 2's
      // fetch sees an already-aborted signal (what a real transport does).
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted)
          throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
        return sseResponse([CANCEL_TOOL_CALL]);
      }) as typeof fetch;
      const call = {
        model: anthropic(fetchImpl),
        messages: [{ role: 'user' as const, content: 'go' }],
        tools: {
          cancel: {
            description: 'the user presses stop while this runs',
            parameters: EMPTY_SCHEMA,
            execute: () => {
              controller.abort();
              return 'stopped';
            },
          },
        },
        maxSteps: 3,
        // ARMED but never fired: an abort must not be reported as a timeout
        // merely because a step deadline exists.
        timeout: { stepMs: 1_000 },
        signal: controller.signal,
        deps: { clock: clock.clock, generateId: () => 'fixed-id' },
      };
      if (loop === 'generateText') {
        const res = await generateText(call);
        return { finishReason: res.finishReason, totalTokens: res.usage.totalTokens };
      }
      const result = streamChat(call);
      await drain(result.fullStream);
      return {
        finishReason: await result.finishReason,
        totalTokens: (await result.usage).totalTokens,
      };
    };

    const buffered = await run('generateText');
    const streaming = await run('streamChat');
    expect(buffered.finishReason).toBe('aborted');
    expect(streaming.finishReason).toBe('aborted');
    expect(buffered.totalTokens).toBeGreaterThan(0); // partial usage, RESOLVED
    expect(buffered).toEqual(streaming); // the two loops agree
  });
});

// ---------------------------------------------------------------------------
// 1.9 (2.10b): `abortSignal` — the deprecated AI SDK alias. It used to be
// silently ignored inside a spread object, so pressing stop did nothing.
// ---------------------------------------------------------------------------

describe('abortSignal alias (1.9)', () => {
  /** Rejects with the signal's reason when the call is already aborted. */
  const abortAwareFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted)
      throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    return sseResponse([OK_STREAM]);
  }) as typeof fetch;

  const model = createAnthropic({ apiKey: 'k', fetch: abortAwareFetch })('claude-opus-4-8');
  const deps = { clock: fastClock(), generateId: () => 'fixed-id' };

  it('aborts the call', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: controller.signal,
      deps,
    });
    await drain(result.fullStream);
    expect(await result.finishReason).toBe('aborted');
  });

  it('works when carried in by a SPREAD object (the silent-drop bug)', async () => {
    const controller = new AbortController();
    controller.abort();
    // Excess-property checks only fire on literals, so before 1.9 this compiled
    // AND was ignored.
    const migrated = { abortSignal: controller.signal };
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ...migrated,
      deps,
    });
    await drain(result.fullStream);
    expect(await result.finishReason).toBe('aborted');
  });

  it('`signal` WINS when both are set', async () => {
    const live = new AbortController(); // never aborted
    const stale = new AbortController();
    stale.abort();
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      signal: live.signal,
      abortSignal: stale.signal,
      deps,
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok'); // the aborted alias was NOT merged in
    expect(await result.finishReason).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// 1.9 (2.4): consume(). The pump is lazy (G2) — with no consumer the terminal
// effects (onFinish, chat persistence, checkpoints, memory extraction) never ran.
// ---------------------------------------------------------------------------

describe('consume() (1.9)', () => {
  function okModel() {
    const fetch = (async () => sseResponse([OK_STREAM])) as typeof globalThis.fetch;
    return createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
  }

  it('fires the terminal effects with NO iteration by the caller', async () => {
    const onFinish = vi.fn();
    const onUsage = vi.fn();
    const result = streamChat({
      model: okModel(),
      messages: [{ role: 'user', content: 'hi' }],
      onFinish,
      onUsage,
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    expect(onFinish).not.toHaveBeenCalled(); // lazy: nothing accessed yet

    await expect(result.consume?.()).resolves.toBeUndefined();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(await result.finishReason).toBe('stop');
  });

  it('drains the agentic loop far enough for chat persistence (which runs AFTER the last part)', async () => {
    const inner = createInMemoryChatStore();
    const saves = vi.fn(inner.saveChat);
    const store = { ...inner, saveChat: saves };
    const result = streamChat({
      model: createMockModel({ responses: [{ text: 'hi' }] }),
      messages: [{ role: 'user', content: 'yo' }],
      chat: { store, chatId: 'c1', scope: { userId: 'u1' } },
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    expect(await store.loadChat('c1')).toBeUndefined();
    await result.consume?.();
    expect((await store.loadChat('c1'))?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
    // Terminal effects fire ONCE even if consume() is called again.
    await result.consume?.();
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it('NEVER rejects on a failing stream — the error goes to onError', async () => {
    const { fetch } = sequenceFetch([() => errorResponse(400, 'invalid_request_error')]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    const errors: unknown[] = [];
    await expect(result.consume?.({ onError: (e) => errors.push(e) })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'invalid_request' });
    // Still on the rejected promises — consume() reports, it does not swallow.
    await expect(result.usage).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('swallows the failure when no onError is given, and an onError that throws cannot escape', async () => {
    const { fetch } = sequenceFetch([() => errorResponse(400, 'invalid_request_error')]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await expect(result.consume?.()).resolves.toBeUndefined();
    await expect(
      result.consume?.({
        onError: () => {
          throw new Error('handler blew up');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('is safe to call twice — terminal effects fire once', async () => {
    const onFinish = vi.fn();
    const result = streamChat({
      model: okModel(),
      messages: [{ role: 'user', content: 'hi' }],
      onFinish,
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await Promise.all([result.consume?.(), result.consume?.()]);
    await result.consume?.(); // and again, sequentially
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('consume() and a fullStream iteration BOTH see every part', async () => {
    const result = streamChat({
      model: okModel(),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    const parts: StreamPart[] = [];
    const iterated = (async () => {
      for await (const part of result.fullStream) parts.push(part);
    })();
    await result.consume?.();
    await iterated;
    const text = parts
      .filter((p): p is Extract<StreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('ok'); // the drain stole nothing
    expect(parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  });

  it('a LATE consume() (after usage was awaited) still reports the failure', async () => {
    const { fetch } = sequenceFetch([() => errorResponse(400, 'invalid_request_error')]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await expect(result.usage).rejects.toMatchObject({ code: 'invalid_request' });
    const errors: unknown[] = [];
    await expect(result.consume?.({ onError: (e) => errors.push(e) })).resolves.toBeUndefined();
    expect(errors[0]).toMatchObject({ code: 'invalid_request' });
  });
});
