/**
 * context/sha256.ts (2.4): `compileContext` is synchronous and pure, yet its
 * manifest carries `sha256:<hex>` digests of working-memory items. The
 * synchronous digest must therefore be the very digest WebCrypto gives
 * (`internal/digest.ts`), byte for byte, at every padding boundary.
 */
import { describe, expect, it } from 'vitest';
import { sha256Digest } from '../src/internal/digest';
import { sha256DigestSync } from '../src/context/sha256';

describe('sha256DigestSync', () => {
  it('matches the published SHA-256 test vectors', () => {
    expect(sha256DigestSync('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256DigestSync('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('equals the WebCrypto digest across padding boundaries and Unicode', async () => {
    const inputs = [
      'a'.repeat(55),
      'b'.repeat(56),
      'c'.repeat(63),
      'd'.repeat(64),
      'e'.repeat(65),
      'f'.repeat(119),
      'g'.repeat(120),
      'h'.repeat(1000),
      'İstanbul — 漢字 😀 \u0000 tail',
    ];
    for (const input of inputs) expect(sha256DigestSync(input)).toBe(await sha256Digest(input));
  });

  it('hashes bytes as given', async () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) & 0xff);
    expect(sha256DigestSync(bytes)).toBe(await sha256Digest(bytes));
  });
});
