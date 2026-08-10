import { describe, it, expect } from 'vitest';
import { generateText, streamChat, agentTool } from '../src/index';
import { createMockModel } from '../src/testing';
import type { JSONSchema } from '../src/types/schema';
import type { Message } from '../src/types/message';
import type { ToolExecuteContext } from '../src/types/tool';
import type { StreamPart } from '../src/types/stream';

/** A live, non-serializable value — the SDK must forward it by REFERENCE. */
const CTX = { tenant: 'acme', db: { query: () => 'rows' } };

const USER: Message[] = [{ role: 'user', content: 'go' }];

const EMPTY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

async function drain(stream: AsyncIterable<StreamPart>): Promise<void> {
  for await (const _part of stream) void _part;
}

describe('runtimeContext threading', () => {
  it('reaches the tool execute context', async () => {
    const seen: unknown[] = [];
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'done' }],
    });
    await generateText({
      model,
      messages: USER,
      maxSteps: 5,
      runtimeContext: CTX,
      tools: {
        probe: {
          description: 'reads the request context',
          parameters: EMPTY_SCHEMA,
          execute: async (_args: unknown, ctx: ToolExecuteContext): Promise<string> => {
            seen.push(ctx.runtimeContext);
            return 'ok';
          },
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(CTX); // by reference, never a copy
  });

  it('reaches prepareStep, verifyStep and doneWhen', async () => {
    const seen: Record<string, unknown> = {};
    const model = createMockModel({ responses: [{ text: 'answer' }] });
    await generateText({
      model,
      messages: USER,
      runtimeContext: CTX,
      prepareStep: (ctx) => {
        seen.prepareStep = ctx.runtimeContext;
        return undefined;
      },
      doneWhen: (ctx) => {
        seen.doneWhen = ctx.runtimeContext;
        return true;
      },
      verifyStep: (ctx) => {
        seen.verifyStep = ctx.runtimeContext;
        return { ok: true };
      },
    });
    expect(seen).toEqual({ prepareStep: CTX, doneWhen: CTX, verifyStep: CTX });
  });

  it('reaches all three guardrail hooks', async () => {
    const seen: Record<string, unknown> = {};
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'done' }],
    });
    await generateText({
      model,
      messages: USER,
      maxSteps: 5,
      runtimeContext: CTX,
      tools: {
        probe: {
          description: 'x',
          parameters: EMPTY_SCHEMA,
          execute: async (): Promise<string> => 'ok',
        },
      },
      guardrails: {
        onInput: (ctx) => {
          seen.onInput = ctx.runtimeContext;
          return undefined;
        },
        onToolCall: (ctx) => {
          seen.onToolCall = ctx.runtimeContext;
          return undefined;
        },
        onOutput: (ctx) => {
          seen.onOutput = ctx.runtimeContext;
          return undefined;
        },
      },
    });
    expect(seen).toEqual({ onInput: CTX, onToolCall: CTX, onOutput: CTX });
  });

  it('reaches the streaming loop identically', async () => {
    const seen: Record<string, unknown> = {};
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'done' }],
    });
    const result = streamChat({
      model,
      messages: USER,
      maxSteps: 5,
      runtimeContext: CTX,
      tools: {
        probe: {
          description: 'x',
          parameters: EMPTY_SCHEMA,
          execute: async (_args: unknown, ctx: ToolExecuteContext): Promise<string> => {
            seen.tool = ctx.runtimeContext;
            return 'ok';
          },
        },
      },
      prepareStep: (ctx) => {
        seen.prepareStep = ctx.runtimeContext;
        return undefined;
      },
      guardrails: {
        onOutput: (ctx) => {
          seen.onOutput = ctx.runtimeContext;
          return undefined;
        },
      },
    });
    await drain(result.fullStream);
    expect(seen).toEqual({ tool: CTX, prepareStep: CTX, onOutput: CTX });
  });

  it('is INHERITED by a sub-agent (agentTool)', async () => {
    const seen: unknown[] = [];
    const childModel = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'child answer' }],
    });
    const parentModel = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'researcher', args: { prompt: 'dig' } }] },
        { text: 'parent answer' },
      ],
    });

    const res = await generateText({
      model: parentModel,
      messages: USER,
      maxSteps: 5,
      runtimeContext: CTX,
      tools: {
        researcher: agentTool({
          name: 'researcher',
          description: 'delegates',
          model: childModel,
          maxSteps: 5,
          tools: {
            probe: {
              description: 'reads the request context',
              parameters: EMPTY_SCHEMA,
              execute: async (_args: unknown, ctx: ToolExecuteContext): Promise<string> => {
                seen.push(ctx.runtimeContext);
                return 'ok';
              },
            },
          },
        }),
      },
    });

    expect(res.text).toBe('parent answer');
    expect(seen).toEqual([CTX]);
    expect(seen[0]).toBe(CTX);
  });

  it('is ABSENT (not undefined) from every context when the call omits it', async () => {
    const present: Record<string, boolean> = {};
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'done' }],
    });
    await generateText({
      model,
      messages: USER,
      maxSteps: 5,
      tools: {
        probe: {
          description: 'x',
          parameters: EMPTY_SCHEMA,
          execute: async (_args: unknown, ctx: ToolExecuteContext): Promise<string> => {
            present.tool = 'runtimeContext' in ctx;
            return 'ok';
          },
        },
      },
      prepareStep: (ctx) => {
        present.prepareStep = 'runtimeContext' in ctx;
        return undefined;
      },
      doneWhen: (ctx) => {
        present.doneWhen = 'runtimeContext' in ctx;
        return true;
      },
      verifyStep: (ctx) => {
        present.verifyStep = 'runtimeContext' in ctx;
        return { ok: true };
      },
      guardrails: {
        onInput: (ctx) => {
          present.onInput = 'runtimeContext' in ctx;
          return undefined;
        },
        onToolCall: (ctx) => {
          present.onToolCall = 'runtimeContext' in ctx;
          return undefined;
        },
        onOutput: (ctx) => {
          present.onOutput = 'runtimeContext' in ctx;
          return undefined;
        },
      },
    });
    expect(present).toEqual({
      tool: false,
      prepareStep: false,
      doneWhen: false,
      verifyStep: false,
      onInput: false,
      onToolCall: false,
      onOutput: false,
    });
  });

  it('is never copied into a checkpoint, chat record or observation event', async () => {
    // The opacity contract: the SDK must not serialize it anywhere. The tool
    // sees the live object, and nothing the run persists mentions it.
    const model = createMockModel({ responses: [{ text: 'done' }] });
    const secret = { apiToken: 'sk-live-do-not-persist' };
    const res = await generateText({
      model,
      messages: USER,
      runtimeContext: secret,
      doneWhen: () => true,
    });
    expect(JSON.stringify(res)).not.toContain('sk-live-do-not-persist');
  });
});
