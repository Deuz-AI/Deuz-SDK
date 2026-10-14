/**
 * The tar the Docker runner writes for `docker cp` staging and reads back from
 * an artifact copy (2.4). Interop with the real engine is covered by the
 * gated docker-live tests; here the format rules: names ustar cannot hold go
 * in a PAX record, owners and modes are written as given, content is padded
 * to blocks, and the reader hands over or skips entries without buffering
 * what it skips.
 */
import { describe, expect, it } from 'vitest';
import {
  createTarParser,
  tarArchive,
  tarArchiveSize,
  TarFormatError,
  type TarHeader,
} from '../src/compute/docker/tar';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Reads every entry, feeding the archive `chunk` bytes at a time. */
function readAll(archive: Uint8Array, chunk = archive.byteLength) {
  const entries: { header: TarHeader; content: string }[] = [];
  let parts: Uint8Array[] = [];
  const parser = createTarParser({
    entry: () => {
      parts = [];
      return 'read';
    },
    data: (_header, data) => parts.push(data.slice()),
    end: (header) => {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.byteLength;
      }
      entries.push({ header, content: text(all) });
    },
  });
  for (let offset = 0; offset < archive.byteLength; offset += chunk)
    parser.write(archive.subarray(offset, offset + chunk));
  parser.finish();
  return entries;
}

describe('tarArchive', () => {
  const longName = `deep/${'n'.repeat(140)}.txt`;
  const archive = tarArchive([
    { path: 'workspace', type: 'directory', uid: 10001, gid: 10001 },
    { path: 'workspace/a b.txt', type: 'file', content: bytes('hello'), uid: 10001, gid: 10001 },
    {
      path: 'workspace/çalışma ğüş 😀.txt',
      type: 'file',
      content: bytes('ünïcode'),
      uid: 10001,
      gid: 10002,
      mode: 0o600,
    },
    { path: longName, type: 'file', content: bytes('x'.repeat(513)), uid: 1, gid: 1 },
    { path: 'workspace/link', type: 'symlink', linkName: '/etc/passwd', uid: 0, gid: 0 },
  ]);

  it('is block aligned and ends with two zero blocks', () => {
    expect(archive.byteLength % 512).toBe(0);
    expect(archive.subarray(-1024).every((b) => b === 0)).toBe(true);
  });

  it('round-trips names, types, owners, modes and content, whole or one byte at a time', () => {
    for (const chunk of [archive.byteLength, 1, 700]) {
      const entries = readAll(archive, chunk);
      expect(entries.map((e) => [e.header.name, e.header.type])).toEqual([
        ['workspace/', 'directory'],
        ['workspace/a b.txt', 'file'],
        ['workspace/çalışma ğüş 😀.txt', 'file'],
        [longName, 'file'],
        ['workspace/link', 'symlink'],
      ]);
      expect(entries[0]!.header).toMatchObject({ uid: 10001, gid: 10001, mode: 0o755 });
      expect(entries[1]).toMatchObject({ content: 'hello', header: { size: 5, mode: 0o644 } });
      expect(entries[2]).toMatchObject({ content: 'ünïcode', header: { gid: 10002, mode: 0o600 } });
      expect(entries[3]!.content).toBe('x'.repeat(513));
      expect(entries[4]!.header.linkName).toBe('/etc/passwd');
    }
  });

  it('estimates its own size from above', () => {
    const entries = [
      { path: 'a', size: 3 },
      { path: 'çok uzun '.repeat(20), size: 1000 },
    ];
    const built = tarArchive(
      entries.map((e) => ({
        path: e.path,
        type: 'file' as const,
        content: new Uint8Array(e.size),
        uid: 0,
        gid: 0,
      })),
    );
    expect(tarArchiveSize(entries)).toBeGreaterThanOrEqual(built.byteLength);
    expect(tarArchiveSize(entries)).toBeLessThan(built.byteLength + 4096);
  });
});

describe('createTarParser', () => {
  const archive = tarArchive([
    { path: 'big.bin', type: 'file', content: new Uint8Array(5000).fill(7), uid: 0, gid: 0 },
    { path: 'wanted.txt', type: 'file', content: bytes('yes'), uid: 0, gid: 0 },
    { path: 'hard', type: 'hardlink', linkName: 'wanted.txt', uid: 0, gid: 0 },
  ]);

  it('never hands over the content of a skipped entry', () => {
    const seen: string[] = [];
    let handed = 0;
    const parser = createTarParser({
      entry: (header) => {
        seen.push(`${header.name}:${header.type}`);
        return header.name === 'wanted.txt' ? 'read' : 'skip';
      },
      data: (_header, data) => {
        handed += data.byteLength;
      },
    });
    for (let offset = 0; offset < archive.byteLength; offset += 300)
      parser.write(archive.subarray(offset, offset + 300));
    parser.finish();
    expect(seen).toEqual(['big.bin:file', 'wanted.txt:file', 'hard:hardlink']);
    expect(handed).toBe(3);
  });

  it('stops at the first entry when told to, and refuses further input', () => {
    const seen: string[] = [];
    const parser = createTarParser({
      entry: (header) => {
        seen.push(header.name);
        return 'stop';
      },
    });
    expect(parser.write(archive)).toBe(false);
    expect(seen).toEqual(['big.bin']);
    expect(() => parser.finish()).not.toThrow();
  });

  it('throws on a corrupt header and on an archive cut short', () => {
    const corrupt = archive.slice();
    corrupt[10] = corrupt[10]! ^ 0xff;
    expect(() => createTarParser({ entry: () => 'read' }).write(corrupt)).toThrow(TarFormatError);
    const parser = createTarParser({ entry: () => 'read' });
    parser.write(archive.subarray(0, 1000));
    expect(() => parser.finish()).toThrow(TarFormatError);
  });
});
