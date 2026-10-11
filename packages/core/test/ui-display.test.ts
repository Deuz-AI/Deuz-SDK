/**
 * ui-display.test.ts (2.3, roadmap 23.5) — what a chat UI shows of a turn.
 *
 * - A refusal's `stopDetails` (F16) reached the finish parts' provider
 *   metadata but not the UI wire: a client saw `finishReason:
 *   'content_filter'` and nothing about why. It now rides the `finish` and
 *   `step-finish` frames and lands on the turn.
 * - How a tool call ended (`ToolCallOutcome`, wave 2a) reached the canonical
 *   `tool-state` / `tool-result` parts but not the UI wire or `UIToolCall`.
 * - Claude's thinking display modes: under `'omitted'` a block is an empty,
 *   signed block, and it stays exactly that (nothing is invented); under
 *   `'updates'` the progress notes are the block's text. The shapes follow
 *   `@anthropic-ai/sdk` 0.133.0's beta types (`display: 'summarized' |
 *   'omitted' | 'updates'`, still `thinking_delta` text); not live-verified.
 *
 * Offline: replayed Anthropic wire and the mock model.
 */
import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import {
  applyUIPart,
  assistantMessageFromTurn,
  canonicalFromUI,
  createAssistantTurn,
  type AssistantTurnState,
} from '../src/chat';
import { createMockModel } from '../src/testing';
import { readDeuzStream, toDeuzStreamResponse, type DeuzUIPart } from '../src/ui';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

const REFUSAL = { type: 'refusal', category: 'cyber', explanation: 'Not that.' };
const parameters = { type: 'object' as const, properties: {} };

function fold(parts: DeuzUIPart[], turn = createAssistantTurn('m')): AssistantTurnState {
  for (const part of parts) turn = applyUIPart(turn, part);
  return turn;
}

async function wire(response: Response): Promise<DeuzUIPart[]> {
  const parts: DeuzUIPart[] = [];
  for await (const part of readDeuzStream(response)) parts.push(part);
  return parts;
}

type Block =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'text'; text: string };

/** One Anthropic Messages turn, block by block, with the given stop. */
function claudeTurn(blocks: Block[], stop: string, stopDetails?: unknown): string {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    },
  ];
  blocks.forEach((block, index) => {
    const delta = (d: unknown) =>
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: d },
      });
    if (block.type === 'thinking') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
      });
      if (block.text) delta({ type: 'thinking_delta', thinking: block.text });
      delta({ type: 'signature_delta', signature: block.signature });
    } else {
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      });
      delta({ type: 'text_delta', text: block.text });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: {
        stop_reason: stop,
        ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}),
      },
      usage: { output_tokens: 3 },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return sseEvents(events);
}

function claude(body: string) {
  const { fetch } = mockFetch(() => sseResponse([body]));
  return createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5');
}

describe('a refusal on the UI wire (F16)', () => {
  it('the finish and step-finish frames carry stopDetails, and the turn shows them', async () => {
    const result = streamChat({
      model: claude(claudeTurn([{ type: 'text', text: 'No.' }], 'refusal', REFUSAL)),
      messages: [{ role: 'user', content: 'x' }],
      tools: { noop: { description: 'n', parameters, execute: () => 'ok' } },
    });
    const parts = await wire(toDeuzStreamResponse(result));
    const finish = parts.find((p) => p.type === 'finish');
    const stepFinish = parts.find((p) => p.type === 'step-finish');
    expect(finish).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL });
    expect(stepFinish).toMatchObject({ stopDetails: REFUSAL });
    const turn = fold(parts);
    expect(turn.finishReason).toBe('content_filter');
    expect(turn.stopDetails).toEqual(REFUSAL);
  });

  it('a finish without an explanation carries none', async () => {
    const parts = await wire(
      toDeuzStreamResponse(
        streamChat({
          model: claude(claudeTurn([{ type: 'text', text: 'Hi.' }], 'end_turn')),
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    expect(parts.find((p) => p.type === 'finish')).not.toHaveProperty('stopDetails');
    expect(fold(parts)).not.toHaveProperty('stopDetails');
  });

  it('redacts a secret-looking token in the explanation on the way out', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const parts = await wire(
      toDeuzStreamResponse(
        streamChat({
          model: claude(
            claudeTurn([{ type: 'text', text: 'No.' }], 'refusal', {
              type: 'refusal',
              explanation: `It quoted ${secret}.`,
            }),
          ),
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    expect(JSON.stringify(parts)).not.toContain(secret);
    expect(fold(parts).stopDetails?.explanation).toMatch(/^It quoted \*\*\*\*/);
  });

  it('ignores a malformed explanation from the wire (the reducer is total)', () => {
    expect(
      fold([
        {
          type: 'finish',
          finishReason: 'content_filter',
          usage: { totalTokens: 1 } as never,
          stopDetails: { type: 7 } as never,
        },
      ]),
    ).not.toHaveProperty('stopDetails');
    expect(
      fold([
        {
          type: 'finish',
          finishReason: 'content_filter',
          usage: { totalTokens: 1 } as never,
          stopDetails: { type: 'refusal', category: 3, explanation: null } as never,
        },
      ]).stopDetails,
    ).toEqual({ type: 'refusal', explanation: null });
  });
});

describe('ToolCallOutcome on the UI wire (2.3)', () => {
  it('a thrown tool reaches the UI call as tool-error; success carries none', async () => {
    const result = streamChat({
      model: createMockModel({
        responses: [
          {
            toolCalls: [
              { toolName: 'boom', id: 'b1', args: {} },
              { toolName: 'fine', id: 'f1', args: {} },
            ],
          },
          { text: 'done' },
        ],
      }),
      messages: [{ role: 'user', content: 'x' }],
      tools: {
        boom: {
          description: 'b',
          parameters,
          execute: () => {
            throw new Error('kaput');
          },
        },
        fine: { description: 'f', parameters, execute: () => 'ok' },
      },
    });
    const parts = await wire(toDeuzStreamResponse(result));
    expect(parts.find((p) => p.type === 'tool-result' && p.toolCallId === 'b1')).toMatchObject({
      isError: true,
      outcome: 'tool-error',
    });
    expect(
      parts.find((p) => p.type === 'tool-state' && p.toolCallId === 'b1' && p.state === 'error'),
    ).toMatchObject({ outcome: 'tool-error' });
    expect(parts.find((p) => p.type === 'tool-result' && p.toolCallId === 'f1')).not.toHaveProperty(
      'outcome',
    );
    const calls = fold(parts).message.toolCalls ?? [];
    expect(calls.find((c) => c.toolCallId === 'b1')).toMatchObject({ outcome: 'tool-error' });
    expect(calls.find((c) => c.toolCallId === 'f1')).not.toHaveProperty('outcome');
  });

  it('a gated call reads approval-pending, and the latest state wins', async () => {
    const result = streamChat({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'pay', id: 'p1', args: {} }] }],
      }),
      messages: [{ role: 'user', content: 'x' }],
      tools: { pay: { description: 'p', parameters, needsApproval: true, execute: () => 'paid' } },
    });
    const parts = await wire(toDeuzStreamResponse(result));
    const pending = fold(parts);
    expect(pending.message.toolCalls?.[0]).toMatchObject({
      toolCallId: 'p1',
      runState: 'awaiting-approval',
      outcome: 'approval-pending',
    });
    const ran = fold(
      [
        { type: 'tool-state', toolCallId: 'p1', toolName: 'pay', state: 'executing' },
        { type: 'tool-result', toolCallId: 'p1', toolName: 'pay', output: 'paid' },
      ],
      pending,
    );
    expect(ran.message.toolCalls?.[0]).not.toHaveProperty('outcome');
  });

  it('ignores an outcome the client does not know', () => {
    const turn = fold([
      { type: 'tool-call', toolCallId: 't', toolName: 'n', input: {} },
      {
        type: 'tool-state',
        toolCallId: 't',
        state: 'error',
        outcome: 'meltdown',
      } as unknown as DeuzUIPart,
    ]);
    expect(turn.message.toolCalls?.[0]).not.toHaveProperty('outcome');
    expect(turn.message.toolCalls?.[0]).toMatchObject({ runState: 'error' });
  });
});

describe('thinking display modes', () => {
  it("an 'omitted' block stays an empty signed block; an 'updates' note is the block's text", async () => {
    const result = streamChat({
      model: claude(
        claudeTurn(
          [
            { type: 'thinking', signature: 'S-omitted' },
            { type: 'thinking', text: 'Reading the config…', signature: 'S-updates' },
            { type: 'text', text: 'Done.' },
          ],
          'end_turn',
        ),
      ),
      messages: [{ role: 'user', content: 'x' }],
    });
    const turn = fold(await wire(toDeuzStreamResponse(result)));
    const reasoning = (turn.message.parts ?? []).filter((p) => p.type === 'reasoning');
    expect(reasoning).toEqual([
      expect.objectContaining({ text: '', signature: 'S-omitted', state: 'done' }),
      expect.objectContaining({ text: 'Reading the config…', signature: 'S-updates' }),
    ]);
    // The readable text is the notes alone: an omitted block adds nothing to it.
    expect(turn.message.reasoning).toBe('Reading the config…');
    // Both blocks ride back unchanged, the empty one included (F21).
    const blocks = (assistantMessageFromTurn(turn).content as Array<{ type: string }>).filter(
      (p) => p.type === 'reasoning',
    );
    expect(blocks).toEqual([
      { type: 'reasoning', text: '', signature: 'S-omitted', source: 'anthropic' },
      {
        type: 'reasoning',
        text: 'Reading the config…',
        signature: 'S-updates',
        source: 'anthropic',
      },
    ]);
    expect(canonicalFromUI([turn.message])[0]!.content).toEqual(
      assistantMessageFromTurn(turn).content,
    );
  });
});
