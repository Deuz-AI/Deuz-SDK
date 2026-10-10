/**
 * stop-details-wiring.test.ts (2.3, F16) — the provider's stop explanation on
 * the results the loops and shells build: each step of a tool loop, the
 * streaming loop's result, fallbackModels and wrapModel forwarding, and the
 * failed-input shells, which reject it like `finishReason`.
 *
 * Anthropic sends `stop_details` only with `stop_reason: 'refusal'` (Claude API
 * reference, cached 2026-10-06). Not live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateText, streamChat, streamObject } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { logging, wrapModel } from '../src/middleware';
import { runStreamToolLoop } from '../src/inference/stream-tool-loop';
import { stopDetailsFrom } from '../src/inference/run-step';
import { stopDetailsFrom as sharedStopDetailsFrom } from '../src/internal/stop-details';
import { mockFetch, mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';
import type { StepResult } from '../src/types/tool';

const REFUSAL = {
  type: 'refusal',
  category: 'cyber',
  explanation: 'The request asks for working malware.',
};

const start = {
  event: 'message_start',
  data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
};
const stop = { event: 'message_stop', data: { type: 'message_stop' } };

/** A turn that calls `lookup`. */
const toolTurn = sseEvents([
  start,
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu1', name: 'lookup', input: {} },
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
      usage: { output_tokens: 3 },
    },
  },
  stop,
]);

/** A text turn that ends with `stopReason` and, when given, its raw `stop_details`. */
function textTurn(text: string, stopReason: string, details?: unknown): string {
  return sseEvents([
    start,
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, ...(details ? { stop_details: details } : {}) },
        usage: { output_tokens: 3 },
      },
    },
    stop,
  ]);
}

const refused = textTurn('I can’t help with that.', 'refusal', REFUSAL);
const messages = [{ role: 'user' as const, content: 'hi' }];
const tools = {
  lookup: { parameters: { type: 'object' as const, properties: {} }, execute: () => 'ok' },
};

function claude(...turns: (string | (() => Response))[]) {
  const sequence = mockFetchSequence(
    turns.map((turn) => (typeof turn === 'string' ? () => sseResponse([turn]) : turn)),
  );
  return createAnthropic({ apiKey: 'k', fetch: sequence.fetch })('claude-opus-5-5');
}

const badRequest = () =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }),
    { status: 400 },
  );

// A refused turn never dispatches its tool calls (F16), so it is the terminal,
// text-only step: `onStepFinish` does not fire for it (documented), and the
// buffered loop exposes it on `result.steps`. The streaming loop's steps
// surface through its snapshot (native runs, durable checkpoints).
describe('StepResult.stopDetails', () => {
  it('generateText: each step carries its own stop explanation', async () => {
    const result = await generateText({
      model: claude(toolTurn, refused),
      messages,
      tools,
      maxSteps: 3,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps![0]).not.toHaveProperty('stopDetails');
    expect(result.steps![1]!.stopDetails).toEqual(REFUSAL);
    expect(result.stopDetails).toEqual(REFUSAL);
  });

  it('the streaming loop: each step carries its own stop explanation', async () => {
    let steps: StepResult[] = [];
    const result = runStreamToolLoop(
      { model: claude(toolTurn, refused), messages, tools, maxSteps: 3 },
      { onSnapshot: (snapshot) => (steps = snapshot.steps) },
    );
    await result.consume?.();
    expect(steps).toHaveLength(2);
    expect(steps[0]).not.toHaveProperty('stopDetails');
    expect(steps[1]!.stopDetails).toEqual(REFUSAL);
  });
});

describe('StreamChatResult.stopDetails on the loop and the shells', () => {
  it('the streaming loop resolves the last step’s explanation', async () => {
    const result = streamChat({ model: claude(toolTurn, refused), messages, tools, maxSteps: 3 });
    expect(await result.finishReason).toBe('content_filter');
    expect(await result.stopDetails).toEqual(REFUSAL);
  });

  it('the streaming loop resolves undefined when the last step was not explained', async () => {
    const result = streamChat({
      model: claude(toolTurn, textTurn('Done.', 'end_turn')),
      messages,
      tools,
      maxSteps: 3,
    });
    expect(await result.finishReason).toBe('stop');
    expect(result.stopDetails).toBeInstanceOf(Promise);
    expect(await result.stopDetails).toBeUndefined();
  });

  it('the streaming loop rejects with the run’s error when it fails', async () => {
    const result = streamChat({ model: claude(badRequest), messages, tools, maxRetries: 0 });
    const failure = await result.finishReason.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    await expect(result.stopDetails).rejects.toBe(failure);
  });

  it('fallbackModels forward the winning attempt’s explanation', async () => {
    const down = mockFetch(() => new Response('{}', { status: 500 }));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: down.fetch })('claude-opus-5-5'),
      fallbackModels: [claude(refused)],
      messages,
      maxRetries: 0,
    });
    expect(await result.stopDetails).toEqual(REFUSAL);
  });

  it('a middleware chain forwards the inner explanation', async () => {
    const wrapped = wrapModel(claude(refused), [logging()]);
    const result = wrapped.streamChat({ messages });
    expect(await result.stopDetails).toEqual(REFUSAL);
  });

  it('an invalid input rejects it like finishReason, on streamChat and streamObject', async () => {
    // `prompt` and `messages` together are an invalid input shape (G2: no throw).
    const invalid = { model: claude(refused), prompt: 'x', messages };
    const chat = streamChat(invalid as unknown as Parameters<typeof streamChat>[0]);
    const chatFailure = await chat.finishReason.catch((error: unknown) => error);
    expect(chatFailure).toBeInstanceOf(Error);
    await expect(chat.stopDetails).rejects.toBe(chatFailure);
    const object = streamObject({ ...invalid, schema: { type: 'object' } } as unknown as Parameters<
      typeof streamObject
    >[0]);
    const objectFailure = await object.finishReason.catch((error: unknown) => error);
    expect(objectFailure).toBeInstanceOf(Error);
    await expect(object.stopDetails).rejects.toBe(objectFailure);
  });
});

describe('one normalization', () => {
  it('the loops use the shared normalizer', () => {
    expect(stopDetailsFrom).toBe(sharedStopDetailsFrom);
  });
});
