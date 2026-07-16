import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat, stepCountIs } from '../src/index';
import { createMockModel, runEval } from '../src/testing';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

describe('createMockModel + real generateText tool loop', () => {
  it('drives the real adapter + loop: tool gets parsed args, text and usage accumulate', async () => {
    const weather = vi.fn(async (args: unknown) => ({
      city: (args as { city: string }).city,
      temp: 22,
    }));
    const model = createMockModel({
      responses: [
        {
          toolCalls: [{ toolName: 'getWeather', args: { city: 'Paris' } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        { text: 'Sunny in Paris.', usage: { inputTokens: 20, outputTokens: 6 } },
      ],
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: { getWeather: { description: 'Get weather', parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
      stopWhen: stepCountIs(3),
    });

    expect(weather).toHaveBeenCalledTimes(1);
    expect(weather.mock.calls[0]![0]).toEqual({ city: 'Paris' }); // args parsed from wire JSON
    expect(res.steps).toHaveLength(2); // finished naturally before stepCountIs(3)
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.usage.totalTokens).toBe(41); // 15 + 26 across steps
    expect(res.steps![0]!.toolCalls[0]).toMatchObject({
      toolCallId: 'call_1', // deterministic id — never crypto
      toolName: 'getWeather',
    });
    expect(res.steps![0]!.finishReason).toBe('tool_calls');
  });

  it('stopWhen: stepCountIs(3) hard-stops an endless tool-caller at exactly 3 steps', async () => {
    const ping = vi.fn(async () => 'pong');
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'ping', args: {} }] }], // last entry repeats forever
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: { ping: { parameters: { type: 'object' }, execute: ping } },
      maxSteps: 10,
      stopWhen: stepCountIs(3),
    });

    expect(ping).toHaveBeenCalledTimes(3);
    expect(res.steps).toHaveLength(3);
    expect(res.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'stepCountIs' });
    // Ids stay unique ACROSS steps (monotonic per model instance).
    expect(res.steps!.map((s) => s.toolCalls[0]!.toolCallId)).toEqual([
      'call_1',
      'call_2',
      'call_3',
    ]);
    expect(res.usage.totalTokens).toBe(45); // 3 × default 15
  });
});

describe('createMockModel streaming (streamChat)', () => {
  it('text stream concatenates to the scripted string (2 deltas)', async () => {
    const model = createMockModel({ responses: [{ text: 'Hello world from mock!' }] });
    const result = streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    const chunks: string[] = [];
    for await (const c of result.textStream) chunks.push(c);

    expect(chunks.join('')).toBe('Hello world from mock!');
    expect(chunks).toHaveLength(2); // text split into 2 chunks
    expect(await result.finishReason).toBe('stop');
    expect((await result.usage).totalTokens).toBe(15); // default 10 in + 5 out
  });
});

describe('runEval', () => {
  it('scores pass/fail/throw cases in order and captures thrown messages', async () => {
    const report = await runEval(
      [
        { name: 'upper-a', input: 'a', expected: 'A' }, // default deep-equal → pass
        { name: 'forced-fail', input: 'b', check: () => false }, // custom check → fail
        { name: 'explodes', input: 'boom' }, // run throws → fail + error captured
      ],
      async (input: string) => {
        if (input === 'boom') throw new Error('exploded');
        return input.toUpperCase();
      },
    );

    expect(report.total).toBe(3);
    expect(report.passed).toBe(1);
    expect(report.score).toBeCloseTo(1 / 3);
    expect(report.results.map((r) => r.name)).toEqual(['upper-a', 'forced-fail', 'explodes']);
    expect(report.results[0]).toEqual({ name: 'upper-a', passed: true });
    expect(report.results[1]).toEqual({ name: 'forced-fail', passed: false });
    expect(report.results[2]).toMatchObject({ passed: false, error: 'exploded' });
  });

  it('returns score 0 for an empty case list (no division by zero)', async () => {
    const report = await runEval([], async (x: string) => x);
    expect(report).toEqual({ score: 0, total: 0, passed: 0, results: [] });
  });
});

describe('fixture shim (test/fixtures/sse re-exports src/testing)', () => {
  it('sseResponse still builds a streaming Response', async () => {
    const res = sseResponse(['data: {"x":1}\n\n']);
    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"x":1}\n\n');
  });
});
