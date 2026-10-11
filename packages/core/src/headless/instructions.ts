/**
 * Project instructions for headless runs (2.3 preview, 23.8): the text of the
 * project's AGENTS.md / CLAUDE.md files as one system message, under a byte
 * cap. Pure and edge-safe: the Node entry finds and reads the files.
 */

/** Where `loadProjectInstructions` looks, and how much it reads (2.3 preview). */
export interface ProjectInstructionsOptions {
  /**
   * The outermost directory searched: `dir` itself or one of its ancestors.
   * Default: the nearest directory, from `dir` upwards, that holds a `.git`
   * entry; without one, only `dir`.
   */
  root?: string;
  /**
   * The most UTF-8 bytes of file text the message carries, across all files.
   * Files nearest `dir` are kept whole first; an outer file over the cap is
   * cut (at a character boundary) or left out. Default 32 768.
   */
  maxBytes?: number;
  /** The files read in each directory, in this order. Default `['AGENTS.md', 'CLAUDE.md']`. */
  fileNames?: readonly string[];
}

/** One instruction file found (2.3 preview). */
export interface ProjectInstructionFile {
  /** Absolute path. */
  path: string;
  /** Path from the root, `/`-separated. */
  relativePath: string;
  /** The file's text in UTF-8 bytes (byte-order mark and surrounding whitespace removed). */
  bytes: number;
  /** How much of it the message carries: less when cut, 0 when left out. */
  includedBytes: number;
  truncated: boolean;
}

/** What `loadProjectInstructions` found (2.3 preview). */
export interface ProjectInstructions {
  /** The root the search started from. */
  root: string;
  /** The files in message order, outermost first. A file that repeats an earlier one's text is not listed. */
  files: ProjectInstructionFile[];
  /** The system message; absent when no file has text. */
  message?: { role: 'system'; content: string };
}

export const DEFAULT_INSTRUCTION_FILES: readonly string[] = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
]);
export const DEFAULT_INSTRUCTION_BYTES = 32_768;

/** One file's text, as read. */
export interface InstructionSource {
  path: string;
  relativePath: string;
  text: string;
}

const HEADER =
  'Project instructions, from the instruction files between the project root and the working directory, outermost first. Where two disagree, follow the later one: it is nearer the working directory.';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The first `limit` bytes of `bytes`, never ending inside a UTF-8 sequence. */
function cut(bytes: Uint8Array, limit: number): Uint8Array {
  let end = Math.min(limit, bytes.length);
  // A continuation byte (10xxxxxx) at the cut means a character straddles it.
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/**
 * Build the message from sources ordered outermost first. Repeated text
 * (CLAUDE.md that copies AGENTS.md, a symlink) is kept once; empty files are
 * skipped; the byte cap goes to the innermost files first.
 */
export function renderProjectInstructions(
  root: string,
  sources: readonly InstructionSource[],
  maxBytes: number,
): ProjectInstructions {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('maxBytes must be a positive integer.');
  const seen = new Set<string>();
  const kept: { source: InstructionSource; bytes: Uint8Array }[] = [];
  for (const source of sources) {
    const text = (source.text.charCodeAt(0) === 0xfeff ? source.text.slice(1) : source.text).trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    kept.push({ source, bytes: encoder.encode(text) });
  }
  let remaining = maxBytes;
  const included = new Array<Uint8Array>(kept.length);
  for (let i = kept.length - 1; i >= 0; i--) {
    included[i] = cut(kept[i]!.bytes, remaining);
    remaining -= included[i]!.length;
  }
  const files: ProjectInstructionFile[] = kept.map(({ source, bytes }, i) => ({
    path: source.path,
    relativePath: source.relativePath,
    bytes: bytes.length,
    includedBytes: included[i]!.length,
    truncated: included[i]!.length < bytes.length,
  }));
  const blocks = kept.flatMap(({ source, bytes }, i) => {
    const part = included[i]!;
    if (part.length === 0) return [];
    const rest = bytes.length - part.length;
    const body =
      decoder.decode(part) + (rest > 0 ? `\n[truncated: ${rest} more bytes not loaded]` : '');
    return [
      `<project_instructions path="${source.relativePath}">\n${body}\n</project_instructions>`,
    ];
  });
  return {
    root,
    files,
    ...(blocks.length > 0
      ? { message: { role: 'system' as const, content: [HEADER, ...blocks].join('\n\n') } }
      : {}),
  };
}
