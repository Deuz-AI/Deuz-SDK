/**
 * ui-text-signature.test.ts (2.3, the W2a hand-off to G2) — a Gemini thought
 * signature on a plain TEXT part rides the UI wire.
 *
 * Wave 2a kept such a signature on the canonical text part
 * (`providerMetadata.google.thoughtSignature`, often streamed in a final chunk
 * whose text is empty) and sent it back on the next request, but the UI wire's
 * `text-delta` frame dropped it, so the history `useChat` posts went back
 * without it. Gemini does not enforce text signatures, but its reasoning may
 * degrade without them (not live-verified). Offline: replayed Gemini wire.
 */
import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/index';
import { createGoogleNative } from '../src/google';
import {
  applyUIPart,
  assistantMessageFromTurn,
  canonicalFromUI,
  createAssistantTurn,
  uiFromMessages,
  type AssistantTurnState,
} from '../src/chat';
import { readDeuzStream, toDeuzStreamResponse, type DeuzUIPart } from '../src/ui';
import { mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import type { Message } from '../src/types/message';

const geminiTurn = (chunks: Record<string, unknown>[][]) =>
  sseEvents(
    chunks.map((parts, i) => ({
      data: {
        candidates: [
          {
            content: { role: 'model', parts },
            ...(i === chunks.length - 1 ? { finishReason: 'STOP' } : {}),
          },
        ],
        ...(i === chunks.length - 1
          ? { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }
          : {}),
      },
    })),
  );

const META = { google: { thoughtSignature: 'TS_TEXT' } };

function fold(parts: DeuzUIPart[]): AssistantTurnState {
  let turn = createAssistantTurn('m');
  for (const part of parts) turn = applyUIPart(turn, part);
  return turn;
}

describe('a Gemini text signature over the UI wire', () => {
  it('rides the text-delta frame and goes back on the next request', async () => {
    const provider = mockFetchSequence([
      // The signature arrives in a final chunk whose text is empty.
      () =>
        sseResponse([
          geminiTurn([
            [{ text: 'Paris is ' }, { text: 'the capital.' }],
            [{ text: '', thoughtSignature: 'TS_TEXT' }],
          ]),
        ]),
      () => sseResponse([geminiTurn([[{ text: 'Yes.' }]])]),
    ]);
    const model = createGoogleNative({ apiKey: 'k', fetch: provider.fetch })(
      'gemini-3.1-pro-preview',
    );
    const history: Message[] = [{ role: 'user', content: 'capital of France?' }];
    const frames: DeuzUIPart[] = [];
    for await (const frame of readDeuzStream(
      toDeuzStreamResponse(streamChat({ model, messages: [...history] })),
    ))
      frames.push(frame);
    expect(frames.filter((f) => f.type === 'text-delta').at(-1)).toMatchObject({
      providerMetadata: META,
    });
    const turn = fold(frames);
    expect(turn.message.content).toBe('Paris is the capital.');
    expect(turn.message.parts?.filter((p) => p.type === 'text')).toEqual([
      { type: 'text', text: 'Paris is the capital.', state: 'done', providerMetadata: META },
    ]);
    const answer = assistantMessageFromTurn(turn);
    expect(answer).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Paris is the capital.', providerMetadata: META }],
    });

    history.push(answer, { role: 'user', content: 'sure?' });
    const posted = JSON.parse(JSON.stringify(history)) as Message[];
    for await (const _ of readDeuzStream(
      toDeuzStreamResponse(streamChat({ model, messages: posted })),
    ))
      void _;
    const second = JSON.parse(String(provider.calls[1]!.init!.body)) as {
      contents: { role: string; parts: Record<string, unknown>[] }[];
    };
    expect(second.contents.find((c) => c.role === 'model')!.parts).toEqual([
      { text: 'Paris is the capital.', thoughtSignature: 'TS_TEXT' },
    ]);
  });

  it('the history projections keep it, and a text without one is still a string', () => {
    const history: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'A.', providerMetadata: META }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'B.' },
    ];
    let n = 0;
    const ui = uiFromMessages(history, () => `id-${n++}`);
    expect(ui[1]!.parts).toEqual([
      { type: 'text', text: 'A.', state: 'done', providerMetadata: META },
    ]);
    expect(canonicalFromUI(ui)).toEqual(history);
  });

  it('ignores metadata that is not a plain object', () => {
    const turn = fold([
      { type: 'text-delta', text: 'Hi', providerMetadata: 'nope' } as unknown as DeuzUIPart,
    ]);
    expect(turn.message.parts?.[0]).not.toHaveProperty('providerMetadata');
    expect(assistantMessageFromTurn(turn)).toEqual({ role: 'assistant', content: 'Hi' });
  });
});
