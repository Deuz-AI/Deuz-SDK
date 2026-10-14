/**
 * internal/capabilities.ts (2.4): the server side of the capability handshake.
 * A 2.4 server announces what it supports in one response header (and the
 * stream's first frame); a client uses only what was announced, so a new
 * `@deuz-sdk/react` against an older core falls back to the 2.3 behaviour.
 * The wire strings are a contract with `@deuz-sdk/react`, which keeps its own
 * copies (it never imports a new core symbol), so they are pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  DEUZ_CAPABILITIES,
  DEUZ_CAPABILITIES_HEADER,
  DEUZ_CAPABILITY,
  formatDeuzCapabilities,
  parseDeuzCapabilities,
} from '../src/internal/capabilities';

describe('capability wire strings', () => {
  it('pins the header name and every capability string', () => {
    expect(DEUZ_CAPABILITIES_HEADER).toBe('x-deuz-capabilities');
    expect(DEUZ_CAPABILITY).toEqual({
      messageIds: 'message-ids',
      chatSnapshot: 'chat-snapshot-v1',
      durableStream: 'durable-stream',
      conditionalChat: 'conditional-chat',
    });
    expect([...DEUZ_CAPABILITIES].sort()).toEqual(Object.values(DEUZ_CAPABILITY).sort());
  });

  it('keeps every capability a lower-case token a header can carry', () => {
    for (const capability of DEUZ_CAPABILITIES) expect(capability).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('formatDeuzCapabilities', () => {
  it('writes unique capabilities, sorted and comma-separated', () => {
    expect(
      formatDeuzCapabilities([
        DEUZ_CAPABILITY.durableStream,
        DEUZ_CAPABILITY.messageIds,
        DEUZ_CAPABILITY.durableStream,
      ]),
    ).toBe('durable-stream, message-ids');
    expect(formatDeuzCapabilities([])).toBe('');
  });

  it('refuses a token a header cannot carry', () => {
    expect(() => formatDeuzCapabilities(['message ids'])).toThrow(TypeError);
    expect(() => formatDeuzCapabilities(['a,b'])).toThrow(TypeError);
    expect(() => formatDeuzCapabilities([''])).toThrow(TypeError);
  });
});

describe('parseDeuzCapabilities', () => {
  it('reads the header off Headers, a Request or a Response', () => {
    const headers = new Headers({ [DEUZ_CAPABILITIES_HEADER]: 'message-ids, durable-stream' });
    const expected = new Set(['message-ids', 'durable-stream']);
    expect(parseDeuzCapabilities(headers)).toEqual(expected);
    expect(parseDeuzCapabilities(new Response(null, { headers }))).toEqual(expected);
    expect(parseDeuzCapabilities(new Request('https://example.test', { headers }))).toEqual(
      expected,
    );
  });

  it('round-trips what formatDeuzCapabilities wrote', () => {
    const value = formatDeuzCapabilities(DEUZ_CAPABILITIES);
    expect(parseDeuzCapabilities(value)).toEqual(new Set(DEUZ_CAPABILITIES));
  });

  it('is tolerant: case, spacing and empty items do not matter', () => {
    expect(parseDeuzCapabilities(' Message-IDs ,, durable-stream ,')).toEqual(
      new Set(['message-ids', 'durable-stream']),
    );
  });

  it('keeps tokens it does not know, for a newer server', () => {
    expect(parseDeuzCapabilities('message-ids, future-thing')).toEqual(
      new Set(['message-ids', 'future-thing']),
    );
  });

  it('reads no header as no capabilities: the 2.3 behaviour', () => {
    expect(parseDeuzCapabilities(new Headers()).size).toBe(0);
    expect(parseDeuzCapabilities(null).size).toBe(0);
    expect(parseDeuzCapabilities(undefined).size).toBe(0);
    expect(parseDeuzCapabilities('').size).toBe(0);
  });
});
