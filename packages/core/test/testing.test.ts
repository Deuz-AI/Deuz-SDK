import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat, stepCountIs } from '../src/index';
import { createMockModel, runEval, runGradedEval } from '../src/testing';
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

describe('runGradedEval (partial credit)', () => {
  it('gives 2/3 for 3 subtasks with 2 passing, and names the failure', async () => {
    const report = await runGradedEval(
      [
        {
          name: 'summary',
          input: 'abc',
          subtasks: [
            { name: 'is upper', check: (out) => out === 'ABC' },
            { check: (out) => typeof out === 'string' }, // default label
            { name: 'has a digit', check: (out) => /\d/.test(String(out)) },
          ],
        },
      ],
      async (input: string) => input.toUpperCase(),
    );

    expect(report.results[0]).toEqual({
      name: 'summary',
      score: 2 / 3,
      passed: 2,
      total: 3,
      failures: ['has a digit'],
    });
    expect(report.score).toBeCloseTo(2 / 3);
  });

  it('honours weights, and coerces a 0/negative/NaN weight to 1', async () => {
    const report = await runGradedEval(
      [
        {
          name: 'weighted',
          input: 1,
          subtasks: [
            { name: 'big', check: () => true, weight: 3 },
            { name: 'small', check: () => false, weight: 1 },
          ],
        },
        {
          name: 'bad-weights',
          input: 1,
          subtasks: [
            { name: 'zero', check: () => true, weight: 0 },
            { name: 'nan', check: () => false, weight: Number.NaN },
            { name: 'negative', check: () => false, weight: -5 },
          ],
        },
      ],
      async () => 'out',
    );

    expect(report.results[0]!.score).toBe(0.75); // 3 of 4 weight
    expect(report.results[0]!.passed).toBe(1); // count stays unweighted
    expect(report.results[1]!.score).toBeCloseTo(1 / 3); // all three fell back to weight 1
    expect(report.score).toBeCloseTo((0.75 + 1 / 3) / 2); // mean over cases
  });

  it('reports a throwing subtask as a failure instead of crashing the run', async () => {
    const report = await runGradedEval(
      [
        {
          name: 'boom',
          input: 1,
          subtasks: [
            { name: 'ok', check: () => true },
            {
              name: 'explodes',
              check: () => {
                throw new Error('kaput');
              },
            },
          ],
        },
      ],
      async () => 'out',
    );

    expect(report.results[0]).toEqual({
      name: 'boom',
      score: 0.5,
      passed: 1,
      total: 2,
      failures: ['explodes: kaput'],
    });
  });

  it('scores a throwing run 0 with the message on `error` (subtasks never run)', async () => {
    const check = vi.fn(() => true);
    const report = await runGradedEval(
      [{ name: 'dead', input: 'boom', subtasks: [{ check }, { check }] }],
      async (input: string) => {
        if (input === 'boom') throw new Error('exploded');
        return input;
      },
    );

    expect(report.results[0]).toEqual({
      name: 'dead',
      score: 0,
      passed: 0,
      total: 2,
      failures: [],
      error: 'exploded',
    });
    expect(check).not.toHaveBeenCalled();
    expect(report.score).toBe(0);
  });

  it('scores a case with NO subtasks 0 and never invokes `run` (explicit choice)', async () => {
    const run = vi.fn(async () => 'out');
    const report = await runGradedEval([{ name: 'empty', input: 1, subtasks: [] }], run);

    // 0, not 1: an empty case asserts nothing, and a vacuous pass would let a
    // typo'd fixture silently inflate the suite.
    expect(report.results[0]).toEqual({
      name: 'empty',
      score: 0,
      passed: 0,
      total: 0,
      failures: [],
      error: 'no subtasks',
    });
    expect(report.score).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns score 0 for an empty case list, like runEval', async () => {
    expect(await runGradedEval([], async (x: string) => x)).toEqual({ score: 0, results: [] });
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
