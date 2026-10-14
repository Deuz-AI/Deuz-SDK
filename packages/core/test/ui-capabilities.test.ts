/**
 * The server side of the capability handshake (2.4, spec §3.4 and §4.5). A
 * 2.4 client lists what it understands in an `x-deuz-capabilities` request
 * header; only then does the response announce what it supports, once in
 * the same response header and once as the stream's first frame (no event
 * id, never journaled). A 2.3 client sends no such header and gets the 2.3
 * stream byte for byte, headers included.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryDurableStreamStateStore,
  createInMemoryStreamStateStore,
  DEUZ_CAPABILITIES_HEADER,
  readDeuzStream,
  resumeDeuzStreamResponse,
  toDeuzStreamResponse,
  type DeuzUIPart,
  type StreamStateRecord,
  type ToDeuzStreamOptions,
} from '../src/ui';
import { applyUIPart, createAssistantTurn } from '../src/chat';
import { createInMemoryLeaseProvider } from '../src/ops';
import { immediateClock } from './fixtures/immediate-clock';
import { manualResult, sseFrames, textPart } from './fixtures/manual-stream';

const ASKING = new Request('https://app.test/api/chat', {
  method: 'POST',
  headers: { [DEUZ_CAPABILITIES_HEADER]: 'chat-snapshot-v1, durable-stream' },
});

async function respond(options: ToDeuzStreamOptions) {
  const manual = manualResult();
  const response = toDeuzStreamResponse(manual.result, { messageId: 'm', ...options });
  manual.push(textPart('hi'));
  manual.end();
  return { headers: [...response.headers], body: await response.text() };
}

describe('the capability handshake (server)', () => {
  it('leaves a 2.3 client’s stream byte for byte as it was, headers included', async () => {
    const before = await respond({});
    for (const request of [
      new Request('https://app.test/api/chat', { method: 'POST' }),
      new Headers(),
      '',
      '  ,  ',
      null,
    ])
      expect(await respond({ capabilities: { request, announce: ['message-ids'] } })).toEqual(
        before,
      );
  });

  it('announces in the response header and a first frame without an event id', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      messageId: 'm',
      store,
      streamId: 's',
      capabilities: { request: ASKING, announce: ['message-ids', 'chat-snapshot-v1'] },
    });
    manual.push(textPart('hi'));
    manual.end();
    expect(response.headers.get(DEUZ_CAPABILITIES_HEADER)).toBe('chat-snapshot-v1, message-ids');
    const frames = sseFrames(await response.text());
    expect(frames[0]).toEqual({
      data: JSON.stringify({
        type: 'capabilities',
        capabilities: ['chat-snapshot-v1', 'message-ids'],
      }),
    });
    // The journal and its numbers do not know the frame exists.
    expect(frames.slice(1).map((frame) => frame.id)).toEqual(['0', '1', '2']);
    const stored: StreamStateRecord[] = [];
    for await (const record of store.read('s')) stored.push(record);
    expect(stored.map((record) => record.part.type)).toEqual(['start', 'text-delta', 'done']);
  });

  it('reads the advertisement from a request, its headers or the header value', async () => {
    for (const request of [ASKING, ASKING.headers, 'durable-stream'])
      expect(
        (await respond({ capabilities: { request } })).headers.find(
          ([name]) => name === DEUZ_CAPABILITIES_HEADER,
        ),
      ).toEqual([DEUZ_CAPABILITIES_HEADER, '']);
  });

  it('sends the header but no new part to a wire v1 client', async () => {
    const { headers, body } = await respond({
      wireVersion: 'v1',
      capabilities: { request: ASKING, announce: ['message-ids'] },
    });
    expect(headers).toContainEqual([DEUZ_CAPABILITIES_HEADER, 'message-ids']);
    expect(body).not.toContain('capabilities');
  });

  it('announces durable-stream for a durable response', async () => {
    const time = immediateClock();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      messageId: 'm',
      streamId: 's',
      durable: {
        store: createInMemoryDurableStreamStateStore(),
        lease: { provider: createInMemoryLeaseProvider({ clock: time.clock }) },
        batch: { maxDelayMs: 0 },
        deps: { clock: time.clock },
      },
      capabilities: { request: ASKING },
    });
    manual.end();
    expect(response.headers.get(DEUZ_CAPABILITIES_HEADER)).toBe('durable-stream');
    const reading = response.text();
    for (let step = 0; step < 5; step++) await time.advance(1);
    const frames = sseFrames(await reading);
    expect(frames[0]!.data).toBe(
      JSON.stringify({ type: 'capabilities', capabilities: ['durable-stream'] }),
    );
    expect(frames.at(-1)).toEqual({ id: '1', data: '[DONE]' });
  });

  it('hands a client the frame first, and a chat turn ignores it', async () => {
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      messageId: 'm',
      capabilities: { request: ASKING, announce: ['message-ids'] },
    });
    manual.push(textPart('hi'));
    manual.end();
    const parts: DeuzUIPart[] = [];
    for await (const part of readDeuzStream(response)) parts.push(part);
    expect(parts[0]).toEqual({ type: 'capabilities', capabilities: ['message-ids'] });
    const turn = createAssistantTurn('m');
    expect(applyUIPart(turn, parts[0]!)).toEqual(turn);
  });

  it('refuses a capability that is not a lower-case token when the response is built', () => {
    const manual = manualResult();
    expect(() =>
      toDeuzStreamResponse(manual.result, {
        capabilities: { request: ASKING, announce: ['Message IDs'] },
      }),
    ).toThrow(TypeError);
  });

  it('answers on the resume endpoint too, durable-stream for a durable store', async () => {
    const durable = createInMemoryDurableStreamStateStore();
    await durable.commit({
      streamId: 's',
      token: 1,
      records: [
        { seq: 0, part: { type: 'start', messageId: 'm' } },
        { seq: 1, part: { type: 'done' } },
      ],
    });
    const plain = await resumeDeuzStreamResponse(durable, 's').text();
    const asked = resumeDeuzStreamResponse(durable, 's', {
      capabilities: { request: ASKING },
    });
    expect(asked.headers.get(DEUZ_CAPABILITIES_HEADER)).toBe('durable-stream');
    const body = await asked.text();
    expect(body).toBe(
      `data: ${JSON.stringify({ type: 'capabilities', capabilities: ['durable-stream'] })}\n\n` +
        plain,
    );
    // A legacy store announces only what the caller adds; no request header, no change.
    const legacy = createInMemoryStreamStateStore();
    legacy.append('s', 0, { type: 'done' });
    const unasked = resumeDeuzStreamResponse(legacy, 's', {
      capabilities: { request: null, announce: ['message-ids'] },
    });
    expect(unasked.headers.has(DEUZ_CAPABILITIES_HEADER)).toBe(false);
    expect(
      resumeDeuzStreamResponse(legacy, 's', {
        capabilities: { request: ASKING, announce: ['message-ids'] },
      }).headers.get(DEUZ_CAPABILITIES_HEADER),
    ).toBe('message-ids');
  });
});
