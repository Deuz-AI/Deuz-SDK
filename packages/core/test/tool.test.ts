import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { z } from 'zod';
import { tool, type InferToolInput, type InferToolOutput } from '../src/tool';
import { generateText } from '../src/index';
import { createMockModel } from '../src/testing';
import type { Tool, ToolSet, ToolExecuteContext } from '../src/types/tool';
import type { JSONSchema } from '../src/types/schema';

/** Minimal ctx for calling an `execute` directly (the loop builds the real one). */
const CTX: ToolExecuteContext = { toolCallId: 'call_1', messages: [] };

/** Raw JSON Schema path — zero-dep, no `@standard-community/standard-json` peer. */
const CITY_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

describe('tool() — schema types execute(args)', () => {
  it('infers a zod schema output as the first parameter of execute', async () => {
    // Only accepts the NARROWED shape: if `args` were `unknown` this line would
    // not compile, which is the whole point of 2.1.
    const format = (a: { city: string; days?: number }): string => `${a.city}/${a.days ?? 1}`;

    const getWeather = tool({
      description: 'Current weather for a city',
      parameters: z.object({ city: z.string(), days: z.number().optional() }),
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ city: string; days?: number | undefined }>();
        return format(args);
      },
    });

    expectTypeOf<InferToolInput<typeof getWeather>>().toEqualTypeOf<{
      city: string;
      days?: number | undefined;
    }>();
    expectTypeOf<InferToolOutput<typeof getWeather>>().toEqualTypeOf<string>();

    // …and it really runs.
    expect(await getWeather.execute!({ city: 'Paris', days: 2 }, CTX)).toBe('Paris/2');
  });

  it('infers the awaited result of an async execute', async () => {
    const lookup = tool({
      parameters: z.object({ id: z.string() }),
      execute: async (args) => ({ id: args.id, ok: true }),
    });
    expectTypeOf<InferToolOutput<typeof lookup>>().toEqualTypeOf<{ id: string; ok: boolean }>();
    await expect(lookup.execute!({ id: 'x' }, CTX)).resolves.toEqual({ id: 'x', ok: true });
  });

  it('degrades a raw JSON Schema to `unknown` args — never `any`', () => {
    const echo = tool({
      parameters: CITY_JSON_SCHEMA,
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<unknown>();
        // @ts-expect-error a raw JSON Schema carries no type info: `unknown`, not `any`.
        const bad: string = args;
        void bad;
        return JSON.stringify(args);
      },
    });
    expectTypeOf<InferToolInput<typeof echo>>().toEqualTypeOf<unknown>();
    expectTypeOf<InferToolOutput<typeof echo>>().toEqualTypeOf<string>();
    expect(echo.execute!({ city: 'Rome' }, CTX)).toBe('{"city":"Rome"}');
  });

  it('is a pure identity function — the returned object IS the input', () => {
    const def = {
      description: 'noop',
      parameters: CITY_JSON_SCHEMA,
      execute: () => 'ok',
    };
    // Referential identity proves zero runtime cost (no copy, no wrapper).
    expect(tool(def)).toBe(def);
    // Nothing is added or removed either.
    expect(Object.keys(tool(def))).toEqual(['description', 'parameters', 'execute']);
  });

  it('slots into a plain ToolSet unchanged (ToolSet stays Record<string, Tool>)', () => {
    const typed = tool({
      parameters: z.object({ city: z.string() }),
      execute: (args) => args.city.toUpperCase(),
    });
    // The assignment itself is the assertion — `Tool` is invariant in `Args`, so
    // this is exactly what a bare `Tool<{city:string}, string>` would reject.
    const tools: ToolSet = { typed };
    const asTool: Tool = typed;
    expect(Object.keys(tools)).toEqual(['typed']);
    expect(asTool.parameters).toBe(typed.parameters);
  });

  it('carries the non-inferred Tool fields through untouched', () => {
    const client = tool({
      description: 'client-side, no execute',
      parameters: CITY_JSON_SCHEMA,
      needsApproval: true,
      timeoutMs: 1_000,
      type: 'function',
    });
    expect(client.execute).toBeUndefined();
    expect(client.needsApproval).toBe(true);
    expect(client.timeoutMs).toBe(1_000);
    // No `execute` to infer from → both helpers fall back to `unknown`.
    expectTypeOf<InferToolOutput<typeof client>>().toEqualTypeOf<unknown>();
  });
});

describe('tool() end-to-end through the real generateText loop', () => {
  /** Two scripted turns: one tool call, then the final answer. */
  const script = () =>
    createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'getWeather', args: { city: 'Paris' } }] },
        { text: 'Sunny in Paris.' },
      ],
    });

  it('a raw-JSON-Schema tool() tool drives the deterministic mock model', async () => {
    const execute = vi.fn((args: unknown) => ({
      city: (args as { city: string }).city,
      temp: 22,
    }));
    const getWeather = tool({ parameters: CITY_JSON_SCHEMA, execute });

    const res = await generateText({
      model: script(),
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: { getWeather },
      maxSteps: 5,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ city: 'Paris' }); // parsed off the wire
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.steps).toHaveLength(2);
    expect(res.steps![0]!.toolResults[0]).toMatchObject({
      toolName: 'getWeather',
      result: { city: 'Paris', temp: 22 },
    });
  });

  it('a tool() tool and a plain-object tool behave identically end-to-end', async () => {
    const calls: string[] = [];
    const body = (args: unknown): { city: string } => {
      const city = (args as { city: string }).city;
      calls.push(city);
      return { city };
    };

    const wrapped = tool({ parameters: CITY_JSON_SCHEMA, execute: body });
    const plain: Tool = { parameters: CITY_JSON_SCHEMA, execute: body };

    const run = async (getWeather: Tool) =>
      generateText({
        model: script(),
        messages: [{ role: 'user', content: 'weather in Paris?' }],
        tools: { getWeather },
        maxSteps: 5,
      });

    const a = await run(wrapped);
    const b = await run(plain);

    expect(calls).toEqual(['Paris', 'Paris']);
    expect(a.text).toBe(b.text);
    expect(a.finishReason).toBe(b.finishReason);
    expect(a.usage).toEqual(b.usage);
    expect(a.steps!.map((s) => s.toolResults)).toEqual(b.steps!.map((s) => s.toolResults));
  });
});
