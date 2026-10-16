import { describe, expect, it } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createGoogleNative } from '../src/google';
import { createVertexGoogleNative } from '../src/vertex';
import { runAgent } from '../src/agent-run';
import { createTurnContent } from '../src/inference/run-step';
import {
  applyUIPart,
  assistantMessageFromTurn,
  canonicalFromUI,
  createAssistantTurn,
  uiFromMessages,
} from '../src/chat';
import { readDeuzStream, toDeuzStreamResponse } from '../src/ui';
import type { Message, TextPart } from '../src/types/message';
import { mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';

// Synthetic wire shapes from Google's thought-signature contract, not live model acceptance.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
const signed = (text: string, signature = 'signature-A'): TextPart => ({
  type: 'text',
  text,
  providerMetadata: { google: { thoughtSignature: signature } },
});
const text = (value: string): TextPart => ({ type: 'text', text: value });
const sequences = [
  { name: 'late empty signature', parts: [text('answer'), signed('')] },
  {
    name: 'signed text between unsigned text',
    parts: [text('before'), signed('signed'), text('after')],
  },
  { name: 'different signatures', parts: [signed('A'), signed('B', 'signature-B')] },
  { name: 'separate parts with equal signature', parts: [signed('A'), signed('B')] },
  { name: 'only a signed empty part', parts: [signed('')] },
];
function wire(parts: TextPart[]) {
  return parts.map((part) => ({
    text: part.text,
    ...(part.providerMetadata
      ? {
          thoughtSignature: (part.providerMetadata.google as { thoughtSignature: string })
            .thoughtSignature,
        }
      : {}),
  }));
}
function response(parts: TextPart[]) {
  return () =>
    sseResponse([
      sseEvents(
        wire(parts).map((part, index) => ({
          data: {
            candidates: [
              {
                content: { role: 'model', parts: [part] },
                ...(index === parts.length - 1 ? { finishReason: 'STOP' } : {}),
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          },
        })),
      ),
    ]);
}

describe('signed text boundaries in canonical and UI accumulation', () => {
  it.each(sequences)('preserves $name through assembly and JSON/UI replay', ({ parts }) => {
    const before = JSON.stringify(parts);
    const turn = createTurnContent();
    let ui = createAssistantTurn('test-message');
    for (const part of parts) {
      const delta = { ...part, type: 'text-delta' as const };
      turn.text(delta);
      ui = applyUIPart(ui, delta);
    }
    const expected = { role: 'assistant', content: parts };
    expect(turn.assemble(new Map(), []).assistantMessage).toEqual(expected);
    expect(assistantMessageFromTurn(JSON.parse(JSON.stringify(ui)))).toEqual(expected);
    const history = [expected] as Message[];
    expect(canonicalFromUI(uiFromMessages(history, () => 'history-message'))).toEqual(history);
    expect(JSON.stringify(parts)).toBe(before);
    expect(ui.message.content).toBe(parts.map((p) => p.text).join(''));
  });

  it('still merges ordinary unsigned text and drops unsigned empty parts', () => {
    const turn = createTurnContent();
    turn.text({ type: 'text-delta', text: 'A' });
    turn.text({ type: 'text-delta', text: '' });
    turn.text({ type: 'text-delta', text: 'B' });
    expect(turn.assemble(new Map(), []).assistantMessage.content).toEqual([text('AB')]);
  });

  it('does not merge across a discarded tool when either side is signed', () => {
    const turn = createTurnContent();
    turn.text({ ...signed('left'), type: 'text-delta' });
    turn.tool('discarded');
    turn.text({ ...signed('right', 'signature-B'), type: 'text-delta' });
    expect(turn.assemble(new Map(), []).assistantMessage.content).toEqual([
      signed('left'),
      signed('right', 'signature-B'),
    ]);
  });
});

const providers = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-4-argon'].flatMap((modelId) => [
  {
    name: `Gemini ${modelId}`,
    create: (fetch: typeof globalThis.fetch) =>
      createGoogleNative({ apiKey: 'test-key', fetch })(modelId),
  },
  {
    name: `Vertex ${modelId}`,
    create: (fetch: typeof globalThis.fetch) =>
      createVertexGoogleNative({
        project: 'test-project',
        location: 'global',
        accessToken: 'test-token',
        fetch,
      })(modelId),
  },
]);
describe.each(providers)('$name signed text replay', ({ create }) => {
  it.each(['generateText', 'streamChat', 'runAgent'] as const)(
    '%s replays a late empty signed part without moving the signature',
    async (mode) => {
      const parts = [text('answer'), signed('')];
      const provider = mockFetchSequence([response(parts), response([text('next')])]);
      const model = create(provider.fetch);
      const initial: Message[] = [{ role: 'user', content: 'First turn' }];
      let messages: Message[];
      if (mode === 'generateText') {
        const result = await generateText({ model, messages: initial });
        messages = [...initial, ...result.response.messages];
      } else if (mode === 'runAgent') {
        const result = await runAgent({ model, messages: initial, maxSteps: 1 });
        expect(result.status).toBe('completed');
        messages = result.messages;
      } else {
        let turn = createAssistantTurn('streamed');
        for await (const frame of readDeuzStream(
          toDeuzStreamResponse(streamChat({ model, messages: initial })),
        ))
          turn = applyUIPart(turn, frame);
        messages = [...initial, assistantMessageFromTurn(turn)];
      }
      await generateText({
        model,
        messages: [...JSON.parse(JSON.stringify(messages)), { role: 'user', content: 'Next turn' }],
      });
      const body = JSON.parse(String(provider.calls[1]!.init!.body));
      expect(
        body.contents
          .filter((content: { role: string }) => content.role === 'model')
          .flatMap((content: { parts: unknown[] }) => content.parts),
      ).toEqual(wire(parts));
    },
  );
});
