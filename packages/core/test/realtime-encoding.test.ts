import { describe, it, expect } from 'vitest';
import { decodeBase64, deepMerge, encodeBase64, toBytes } from '../src/realtime/encoding';
import { frameText } from '../src/realtime/websocket';

describe('realtime audio framing', () => {
  it('round-trips frames larger than one String.fromCharCode chunk', () => {
    // 100 000 bytes spans several 32 KiB chunks; every byte value appears.
    const bytes = new Uint8Array(100_000).map((_, index) => (index * 7) % 256);
    const encoded = encodeBase64(bytes);
    expect(encoded).toHaveLength(Math.ceil(bytes.length / 3) * 4);
    expect(decodeBase64(encoded)).toEqual(bytes);
  });

  it('views any binary input without copying it', () => {
    const buffer = new ArrayBuffer(8);
    const samples = new Int16Array(buffer, 2, 2);
    samples.set([1, -1]);
    const view = toBytes(samples);
    expect(view.buffer).toBe(buffer);
    expect([...view]).toEqual([1, 0, 255, 255]);
    expect(toBytes(buffer).byteLength).toBe(8);
  });

  it('reads text, ArrayBuffer, typed-array and Blob frames', async () => {
    const json = '{"ok":true}';
    const bytes = new TextEncoder().encode(json);
    expect(frameText(json)).toBe(json);
    expect(frameText(bytes.buffer)).toBe(json);
    expect(frameText(bytes)).toBe(json);
    await expect(frameText(new Blob([bytes]))).resolves.toBe(json);
  });
});

describe('providerOptions deep merge', () => {
  it('merges objects, lets arrays, scalars and null replace, and skips undefined', () => {
    const base = {
      audio: { input: { turn_detection: { type: 'server_vad' } }, output: { voice: 'marin' } },
      tools: [1],
    };
    expect(
      deepMerge(base, {
        audio: { input: { turn_detection: null }, output: { voice: undefined, speed: 1.2 } },
        tools: [],
      }),
    ).toEqual({
      audio: { input: { turn_detection: null }, output: { voice: 'marin', speed: 1.2 } },
      tools: [],
    });
    // The mapped object is never mutated.
    expect(base.audio.input.turn_detection).toEqual({ type: 'server_vad' });
  });

  it('ignores an own __proto__ key instead of re-parenting the merged object', () => {
    const override = JSON.parse('{"__proto__": {"injected": true}, "instructions": "x"}') as Record<
      string,
      unknown
    >;
    const merged = deepMerge({ type: 'realtime' }, override);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as { injected?: unknown }).injected).toBeUndefined();
    expect(merged).toEqual({ type: 'realtime', instructions: 'x' });
  });
});
