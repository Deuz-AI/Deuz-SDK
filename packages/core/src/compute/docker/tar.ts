/**
 * The tar the Docker runner speaks (2.4): `docker cp` takes a tar archive on
 * stdin to stage files and writes one on stdout to read an artifact. Only what
 * those two need is here: a POSIX ustar writer (PAX `path` records for names
 * ustar cannot hold) and an incremental reader that never buffers an entry it
 * was told to skip. Pure: bytes in, bytes out.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The entry types the runner writes and tells apart when it reads. */
export type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';

/** One entry to write. */
export interface TarEntryInput {
  /** A relative path with forward slashes; a directory's trailing `/` is added. */
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink';
  /** A file's content. */
  content?: Uint8Array;
  /** A link's target. */
  linkName?: string;
  /** Default 0o644 for files and links, 0o755 for directories. */
  mode?: number;
  uid: number;
  gid: number;
  /** Seconds since the epoch. Default 0. */
  mtime?: number;
}

const TYPE_FLAG: Record<TarEntryInput['type'], string> = {
  file: '0',
  hardlink: '1',
  symlink: '2',
  directory: '5',
};

function octal(value: number, width: number): string {
  // width - 1 digits and a NUL, the form every reader accepts.
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function writeString(block: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = encoder.encode(value);
  block.set(bytes.subarray(0, width), offset);
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++)
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  return sum;
}

function header(name: string, typeFlag: string, size: number, entry: TarEntryInput): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, name);
  const mode = entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644);
  writeString(block, 100, 8, octal(mode, 8));
  writeString(block, 108, 8, octal(entry.uid, 8));
  writeString(block, 116, 8, octal(entry.gid, 8));
  writeString(block, 124, 12, octal(size, 12));
  writeString(block, 136, 12, octal(Math.max(0, Math.floor(entry.mtime ?? 0)), 12));
  writeString(block, 156, 1, typeFlag);
  if (entry.linkName !== undefined && typeFlag !== 'x')
    writeString(block, 157, 100, entry.linkName);
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 263, 2, '00');
  writeString(block, 148, 8, checksum(block).toString(8).padStart(6, '0') + '\0 ');
  return block;
}

/** A PAX record `"<len> <key>=<value>\n"`, where `<len>` counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).byteLength;
  let length = bodyLength + 1;
  while (length !== bodyLength + String(length).length) length = bodyLength + String(length).length;
  return `${length}${body}`;
}

/** Whether ustar's 100-byte name field holds `name` as it is (ASCII, short). */
function fitsUstar(name: string): boolean {
  return /^[\x20-\x7e]*$/.test(name) && name.length <= 100;
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/**
 * A ustar archive of `entries`, in order, ended by two zero blocks. A name
 * that is not short printable ASCII (or a link target) gets a PAX record, so
 * any UTF-8 path survives `docker cp`.
 */
export function tarArchive(entries: readonly TarEntryInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const push = (part: Uint8Array): void => {
    parts.push(part);
    total += part.byteLength;
  };
  for (const entry of entries) {
    const name =
      entry.type === 'directory' && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    const content = entry.type === 'file' ? (entry.content ?? new Uint8Array()) : undefined;
    const size = content?.byteLength ?? 0;
    let records = '';
    if (!fitsUstar(name)) records += paxRecord('path', name);
    if (entry.linkName !== undefined && !fitsUstar(entry.linkName))
      records += paxRecord('linkpath', entry.linkName);
    if (records !== '') {
      const pax = encoder.encode(records);
      push(header('PaxHeader', 'x', pax.byteLength, { ...entry, linkName: undefined }));
      push(pax);
      push(new Uint8Array(padding(pax.byteLength)));
    }
    // The ustar name is a fallback for readers without PAX: printable ASCII.
    const fallback = name.replace(/[^\x20-\x7e]/g, '_').slice(-100);
    push(header(fallback, TYPE_FLAG[entry.type], size, entry));
    if (content) {
      push(content);
      push(new Uint8Array(padding(size)));
    }
  }
  push(new Uint8Array(BLOCK * 2));
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return archive;
}

/** The size the archive of these entries will have, without building it. */
export function tarArchiveSize(entries: readonly { path: string; size: number }[]): number {
  let total = BLOCK * 2;
  for (const entry of entries) {
    // Generous for the PAX record: one block of header and one of records
    // more than a long path needs.
    if (!fitsUstar(entry.path)) total += BLOCK * 2 + encoder.encode(entry.path).byteLength;
    total += BLOCK + entry.size + padding(entry.size);
  }
  return total;
}

/** A header read from an archive. */
export interface TarHeader {
  /** The path, from a PAX or GNU long-name record when there is one. */
  name: string;
  type: TarEntryType;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  linkName: string;
}

/** What to do with an entry's content: hand it over, drop it, or end the read. */
export type TarEntryDecision = 'read' | 'skip' | 'stop';

export interface TarParserHandlers {
  entry(header: TarHeader): TarEntryDecision;
  /** Content chunks of an entry the handler chose to read. */
  data?(header: TarHeader, chunk: Uint8Array): void;
  /** The end of an entry the handler chose to read. */
  end?(header: TarHeader): void;
}

export interface TarParser {
  /** Feeds bytes; false once a handler stopped the read or the archive ended. */
  write(chunk: Uint8Array): boolean;
  /** Throws when the archive stopped in the middle of an entry. */
  finish(): void;
}

/** A malformed or truncated archive. */
export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarFormatError';
  }
}

function readString(block: Uint8Array, offset: number, width: number): string {
  const field = block.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readNumber(block: Uint8Array, offset: number, width: number): number {
  const field = block.subarray(offset, offset + width);
  if ((field[0]! & 0x80) !== 0) {
    // base-256: big-endian, the top bit of the first byte is the marker.
    let value = field[0]! & 0x7f;
    for (let index = 1; index < width; index++) value = value * 256 + field[index]!;
    return value;
  }
  const text = readString(block, offset, width).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`Malformed tar number field: ${text}`);
  return parseInt(text, 8);
}

function typeOf(flag: string): TarEntryType {
  switch (flag) {
    case '0':
    case '\0':
    case '':
    case '7':
      return 'file';
    case '1':
      return 'hardlink';
    case '2':
      return 'symlink';
    case '5':
      return 'directory';
    default:
      return 'other';
  }
}

function parsePax(bytes: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(decoder.decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length <= 0)
      throw new TarFormatError('Malformed PAX record');
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * An incremental tar reader: feed it chunks as they arrive. Each entry's
 * header goes to `entry`, which decides whether its content is read (handed
 * to `data` chunk by chunk, then `end`), skipped (never buffered) or whether
 * the read stops. PAX (`x`, `g`) and GNU long-name (`L`, `K`) records are
 * folded into the header that follows them. A bad header checksum throws.
 */
export function createTarParser(handlers: TarParserHandlers): TarParser {
  let buffer = new Uint8Array(0);
  let state: 'header' | 'content' | 'meta' | 'done' = 'header';
  let current: TarHeader | undefined;
  let decision: TarEntryDecision = 'skip';
  let remaining = 0;
  let pad = 0;
  let meta: { kind: string; bytes: Uint8Array[]; size: number } | undefined;
  let pending: { path?: string; linkpath?: string; size?: number } = {};

  const take = (count: number): Uint8Array => {
    const part = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    return part;
  };

  const startEntry = (block: Uint8Array): void => {
    const stored = readNumber(block, 148, 8);
    if (stored !== checksum(block)) throw new TarFormatError('Tar header checksum mismatch');
    const flag = readString(block, 156, 1);
    const size = readNumber(block, 124, 12);
    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      meta = { kind: flag, bytes: [], size };
      remaining = size;
      pad = padding(size);
      state = 'meta';
      return;
    }
    const prefix = readString(block, 345, 155);
    const baseName = readString(block, 0, 100);
    const ustarName =
      prefix !== '' && readString(block, 257, 5) === 'ustar' ? `${prefix}/${baseName}` : baseName;
    current = {
      name: pending.path ?? ustarName,
      type: typeOf(flag),
      size: pending.size ?? size,
      mode: readNumber(block, 100, 8),
      uid: readNumber(block, 108, 8),
      gid: readNumber(block, 116, 8),
      linkName: pending.linkpath ?? readString(block, 157, 100),
    };
    pending = {};
    const hasContent = current.type === 'file' || current.type === 'other';
    remaining = hasContent ? current.size : 0;
    pad = padding(remaining);
    decision = handlers.entry(current);
    if (decision === 'stop') {
      state = 'done';
      return;
    }
    state = 'content';
  };

  const finishMeta = (): void => {
    const all = new Uint8Array(meta!.size);
    let offset = 0;
    for (const part of meta!.bytes) {
      all.set(part, offset);
      offset += part.byteLength;
    }
    if (meta!.kind === 'x') {
      const records = parsePax(all);
      if (records.path !== undefined) pending.path = records.path;
      if (records.linkpath !== undefined) pending.linkpath = records.linkpath;
      if (records.size !== undefined) pending.size = Number(records.size);
    } else if (meta!.kind === 'L') {
      pending.path = readString(all, 0, all.byteLength);
    } else if (meta!.kind === 'K') {
      pending.linkpath = readString(all, 0, all.byteLength);
    }
    meta = undefined;
  };

  const step = (): boolean => {
    switch (state) {
      case 'header': {
        if (buffer.byteLength < BLOCK) return false;
        const block = take(BLOCK);
        if (block.every((byte) => byte === 0)) {
          state = 'done';
          return false;
        }
        startEntry(block);
        return true;
      }
      case 'meta':
      case 'content': {
        if (remaining > 0) {
          if (buffer.byteLength === 0) return false;
          const part = take(Math.min(remaining, buffer.byteLength));
          remaining -= part.byteLength;
          if (state === 'meta') meta!.bytes.push(part.slice());
          else if (decision === 'read') handlers.data?.(current!, part);
          if (remaining > 0) return false;
        }
        if (pad > 0) {
          if (buffer.byteLength === 0) return false;
          const skipped = take(Math.min(pad, buffer.byteLength));
          pad -= skipped.byteLength;
          if (pad > 0) return false;
        }
        if (state === 'meta') finishMeta();
        else if (decision === 'read') handlers.end?.(current!);
        state = 'header';
        return true;
      }
      case 'done':
        return false;
    }
  };

  return {
    write(chunk) {
      if (state === 'done') return false;
      const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.byteLength);
      buffer = merged;
      while (step()) {
        /* keep consuming */
      }
      return state !== 'done';
    },
    finish() {
      if (state === 'done') return;
      if (state === 'header' && buffer.byteLength === 0) return;
      throw new TarFormatError('The tar archive ended in the middle of an entry');
    },
  };
}
