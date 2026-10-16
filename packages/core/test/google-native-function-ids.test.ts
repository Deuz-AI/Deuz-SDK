import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/index';
import { createGoogleNative } from '../src/google';
import { createVertexGoogleNative } from '../src/vertex';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import type { Message, ToolUsePart } from '../src/types/message';
import { mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';

type WirePart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args: unknown };
  functionResponse?: { id?: string; name: string; response: unknown };
};

function reply(parts: WirePart[]) {
  return () =>
    sseResponse([
      sseEvents([
        {
          data: {
            candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          },
        },
      ]),
    ]);
}

function call(key: string, id?: string, thoughtSignature?: string): WirePart {
  return {
    functionCall: { name: 'lookup', args: { key }, ...(id !== undefined ? { id } : {}) },
    ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
  };
}

function wireParts(init: RequestInit | undefined): WirePart[] {
  const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: WirePart[] }> };
  return body.contents.flatMap((content) => content.parts);
}

function toolUses(messages: Message[]): ToolUsePart[] {
  return messages.flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.filter((part): part is ToolUsePart => part.type === 'tool_use'),
  );
}

function dependencies() {
  let id = 0;
  return { generateId: () => `sdk-${++id}` };
}

const parameters = {
  type: 'object',
  properties: { key: { type: 'string' } },
  required: ['key'],
} as const;

const providers = [
  {
    name: 'Gemini API',
    create: (fetch: typeof globalThis.fetch) =>
      createGoogleNative({ apiKey: 'test-api-key', fetch })('gemini-2.5-flash'),
  },
  {
    name: 'Vertex AI',
    create: (fetch: typeof globalThis.fetch) =>
      createVertexGoogleNative({
        project: 'test-project',
        location: 'global',
        accessToken: 'test-access-token',
        fetch,
      })('gemini-2.5-flash'),
  },
];

describe.each(providers)('$name native function-call IDs', ({ create }) => {
  it.each([undefined, 'signature-A'])(
    'preserves the provider ID independently of signature %s',
    async (signature) => {
      const { fetch } = mockFetchSequence([reply([call('A', 'provider-A', signature)])]);
      const result = await generateText({
        model: create(fetch),
        prompt: 'Look up A',
        deps: dependencies(),
      });
      const [tool] = toolUses(result.response.messages);
      expect(tool?.id).toMatch(/^sdk-/);
      expect(tool?.providerMetadata).toEqual({
        google: {
          functionCallId: 'provider-A',
          ...(signature ? { thoughtSignature: signature } : {}),
        },
      });
    },
  );

  it.each([
    { name: 'one signed call', parts: [call('A', 'provider-A', 'signature-A')] },
    { name: 'ID without a signature', parts: [call('A', 'provider-A')] },
    {
      name: 'parallel calls with the same name',
      parts: [call('A', 'provider-A', 'signature-A'), call('B', 'provider-B')],
    },
    { name: 'a signed call without an ID', parts: [call('A', undefined, 'signature-A')] },
    { name: 'a call without an ID or signature', parts: [call('A')] },
    { name: 'mixed ID presence', parts: [call('A', 'provider-A'), call('B')] },
  ])('round-trips $name without inventing IDs', async ({ parts }) => {
    const { fetch, calls } = mockFetchSequence([reply(parts), reply([{ text: 'done' }])]);
    const execute = vi.fn((input: unknown) => input);
    const result = await runAgent({
      model: create(fetch),
      prompt: 'Look up records',
      deps: dependencies(),
      maxSteps: 3,
      tools: { lookup: { parameters, execute } },
    });
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(parts.length);
    expect(calls).toHaveLength(2);
    const sent = wireParts(calls[1]!.init);
    expect(sent.filter((part) => part.functionCall)).toEqual(parts);
    expect(sent.filter((part) => part.functionResponse)).toEqual(
      parts.map((part) => ({
        functionResponse: {
          ...(part.functionCall!.id !== undefined ? { id: part.functionCall!.id } : {}),
          name: 'lookup',
          response: part.functionCall!.args,
        },
      })),
    );
  });

  it('keeps recycled provider IDs separate across native agent steps', async () => {
    const { fetch, calls } = mockFetchSequence([
      reply([call('first', 'provider-reused')]),
      reply([call('second', 'provider-reused')]),
      reply([{ text: 'done' }]),
    ]);
    const execute = vi.fn((input: unknown) => input);
    const result = await runAgent({
      model: create(fetch),
      prompt: 'Look up twice',
      deps: dependencies(),
      maxSteps: 4,
      session: {
        store: createInMemoryAgentRunStore(),
        runId: 'recycled-provider-id',
        scope: 'test',
      },
      tools: { lookup: { parameters, execute } },
    });
    expect(result.status).toBe('completed');
    expect(execute.mock.calls.map(([input]) => input)).toEqual([
      { key: 'first' },
      { key: 'second' },
    ]);
    const uses = toolUses(result.messages);
    expect(uses).toHaveLength(2);
    expect(new Set(uses.map((part) => part.id)).size).toBe(2);
    for (const part of uses) expect(part.id).toMatch(/^sdk-/);
    expect(wireParts(calls[2]!.init).filter((part) => part.functionResponse)).toEqual([
      { functionResponse: { id: 'provider-reused', name: 'lookup', response: { key: 'first' } } },
      { functionResponse: { id: 'provider-reused', name: 'lookup', response: { key: 'second' } } },
    ]);
  });

  it('matches reordered tool results by canonical ID after serializing messages', async () => {
    const parts = [call('A', 'provider-A', 'signature-A'), call('B', 'provider-B')];
    const { fetch, calls } = mockFetchSequence([reply(parts), reply([{ text: 'done' }])]);
    const model = create(fetch);
    const first = await generateText({ model, prompt: 'Look up records', deps: dependencies() });
    const messages = JSON.parse(JSON.stringify(first.response.messages)) as Message[];
    const uses = toolUses(messages);
    messages.push({
      role: 'tool',
      content: [...uses].reverse().map((part) => ({
        type: 'tool_result',
        toolUseId: part.id,
        result: part.input,
      })),
    });
    const before = JSON.stringify(messages);
    await generateText({ model, messages, deps: dependencies() });
    const sent = wireParts(calls[1]!.init);
    expect(sent.filter((part) => part.functionCall)).toEqual(parts);
    expect(sent.filter((part) => part.functionResponse)).toEqual([
      { functionResponse: { id: 'provider-B', name: 'lookup', response: { key: 'B' } } },
      { functionResponse: { id: 'provider-A', name: 'lookup', response: { key: 'A' } } },
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('preserves IDs through a serialized checkpoint and approval resume without repeating completed work', async () => {
    const firstCall = call('A', 'provider-A', 'signature-A');
    const gate: WirePart = {
      functionCall: { name: 'gate', args: {}, id: 'provider-gate' },
      thoughtSignature: 'signature-gate',
    };
    const { fetch, calls } = mockFetchSequence([
      reply([firstCall]),
      reply([gate]),
      reply([{ text: 'done' }]),
    ]);
    const store = createInMemoryAgentRunStore();
    const execute = vi.fn((input: unknown) => input);
    const approve = vi.fn(() => ({ approved: true }));
    const options = {
      model: create(fetch),
      prompt: 'Look up then ask permission',
      deps: dependencies(),
      maxSteps: 4,
      session: { store, runId: 'provider-id-resume', scope: 'test' },
      tools: {
        lookup: { parameters, execute },
        gate: {
          parameters: { type: 'object' as const, properties: {} },
          needsApproval: true,
          execute: approve,
        },
      },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    if (first.status !== 'suspended') throw new Error('Expected approval suspension');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
    const saved = await store.load('provider-id-resume');
    expect(saved).toBeDefined();
    // Cross a JSON persistence boundary while retaining the store's revision checks.
    const restored: typeof store = {
      ...store,
      async load(runId) {
        const envelope = await store.load(runId);
        return envelope ? JSON.parse(JSON.stringify(envelope)) : envelope;
      },
    };
    const result = await resumeAgent({
      ...options,
      session: { ...options.session, store: restored },
      approvalResponses: [{ approvalId: first.pendingApprovals[0]!.approvalId, approved: true }],
    });
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    const sent = wireParts(calls[2]!.init);
    expect(sent.filter((part) => part.functionCall)).toEqual([firstCall, gate]);
    expect(sent.filter((part) => part.functionResponse)).toEqual([
      { functionResponse: { id: 'provider-A', name: 'lookup', response: { key: 'A' } } },
      { functionResponse: { id: 'provider-gate', name: 'gate', response: { approved: true } } },
    ]);
  });
});
