/**
 * evolve/patch.ts — the pure program-editing layer of `./evolve` (2.2).
 *
 * AlphaEvolve's contract: only the code between `EVOLVE-BLOCK-START` and
 * `EVOLVE-BLOCK-END` marker lines may change, and a model edits it with
 * `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks. Everything here is
 * strict on purpose: a patch that does not apply exactly once inside an
 * evolvable region is a typed rejection, never a best-effort guess, because a
 * silently misplaced edit corrupts the frozen harness the evaluator trusts.
 *
 * Edge-safe: string operations only.
 */

export type EvolvePatchErrorCode =
  | 'invalid_markers'
  | 'no_blocks'
  | 'malformed_diff'
  | 'empty_search'
  | 'marker_in_replace'
  | 'not_found'
  | 'outside_evolve_block'
  | 'ambiguous'
  | 'empty_rewrite'
  | 'frozen_changed';

export class EvolvePatchError extends Error {
  readonly name = 'EvolvePatchError';

  constructor(
    readonly code: EvolvePatchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One evolvable region; `start`/`end` are offsets of `content` inside the source. */
export interface EvolveBlock {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

export interface ParsedEvolveSource {
  readonly blocks: readonly EvolveBlock[];
  /**
   * The frozen text around the blocks, marker lines included: `frozen[i]`
   * precedes `blocks[i]` and the last entry follows the last block.
   */
  readonly frozen: readonly string[];
  /** No markers: the whole program is one evolvable block. */
  readonly implicit: boolean;
}

export interface SearchReplaceBlock {
  readonly search: string;
  readonly replace: string;
}

const START = 'EVOLVE-BLOCK-START';
const END = 'EVOLVE-BLOCK-END';

function lines(source: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline < 0 ? source.length : newline + 1;
    out.push({ text: source.slice(start, end), start, end });
    start = end;
  }
  return out;
}

/** Locate the evolvable regions. A program with no markers is one implicit block. */
export function parseEvolveBlocks(source: string): ParsedEvolveSource {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const blocks: EvolveBlock[] = [];
  const frozen: string[] = [];
  let open: number | undefined;
  let frozenStart = 0;
  for (const line of lines(source)) {
    if (line.text.includes(START)) {
      if (open !== undefined || line.text.includes(END))
        throw new EvolvePatchError('invalid_markers', 'Nested EVOLVE-BLOCK-START marker.');
      open = line.end;
      frozen.push(source.slice(frozenStart, line.end));
    } else if (line.text.includes(END)) {
      if (open === undefined)
        throw new EvolvePatchError('invalid_markers', 'EVOLVE-BLOCK-END without a start marker.');
      blocks.push({
        index: blocks.length,
        start: open,
        end: line.start,
        content: source.slice(open, line.start),
      });
      open = undefined;
      frozenStart = line.start;
    }
  }
  if (open !== undefined)
    throw new EvolvePatchError('invalid_markers', 'Unterminated EVOLVE-BLOCK-START marker.');
  if (!blocks.length) {
    return {
      blocks: [{ index: 0, start: 0, end: source.length, content: source }],
      frozen: ['', ''],
      implicit: true,
    };
  }
  frozen.push(source.slice(frozenStart));
  return { blocks, frozen, implicit: false };
}

const SEARCH_LINE = /^<{7} SEARCH\s*$/;
const DIVIDER_LINE = /^={7}\s*$/;
const REPLACE_LINE = /^>{7} REPLACE\s*$/;

/** Parse the SEARCH/REPLACE blocks of a model reply; prose around them is ignored. */
export function parseSearchReplace(text: string): SearchReplaceBlock[] {
  const rows = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: SearchReplaceBlock[] = [];
  let state: 'prose' | 'search' | 'replace' = 'prose';
  let search: string[] = [];
  let replace: string[] = [];
  for (const row of rows) {
    if (state === 'prose') {
      if (SEARCH_LINE.test(row)) {
        state = 'search';
        search = [];
      } else if (DIVIDER_LINE.test(row) || REPLACE_LINE.test(row)) {
        throw new EvolvePatchError('malformed_diff', 'Diff marker outside a SEARCH block.');
      }
    } else if (state === 'search') {
      if (DIVIDER_LINE.test(row)) {
        state = 'replace';
        replace = [];
      } else if (SEARCH_LINE.test(row) || REPLACE_LINE.test(row)) {
        throw new EvolvePatchError('malformed_diff', 'SEARCH block without a ======= divider.');
      } else search.push(row);
    } else if (REPLACE_LINE.test(row)) {
      blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      state = 'prose';
    } else if (SEARCH_LINE.test(row) || DIVIDER_LINE.test(row)) {
      throw new EvolvePatchError('malformed_diff', 'REPLACE block without a closing marker.');
    } else replace.push(row);
  }
  if (state !== 'prose') throw new EvolvePatchError('malformed_diff', 'Unterminated diff block.');
  if (!blocks.length) throw new EvolvePatchError('no_blocks', 'No SEARCH/REPLACE blocks found.');
  return blocks;
}

function occurrences(source: string, search: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(search); at >= 0; at = source.indexOf(search, at + 1))
    found.push(at);
  return found;
}

/**
 * Apply a SEARCH/REPLACE diff. Blocks apply in order, each against the source
 * the previous one produced; each SEARCH must occur exactly once inside an
 * evolvable region, else an {@link EvolvePatchError}.
 */
export function applySearchReplace(source: string, diff: string): string {
  const crlf = source.includes('\r\n');
  let current = source;
  for (const block of parseSearchReplace(diff)) {
    const search = crlf ? block.search.replace(/\n/g, '\r\n') : block.search;
    const replace = crlf ? block.replace.replace(/\n/g, '\r\n') : block.replace;
    if (!search.length) throw new EvolvePatchError('empty_search', 'SEARCH text is empty.');
    if (replace.includes(START) || replace.includes(END))
      throw new EvolvePatchError('marker_in_replace', 'REPLACE text contains an evolve marker.');
    const { blocks } = parseEvolveBlocks(current);
    const all = occurrences(current, search);
    if (!all.length) throw new EvolvePatchError('not_found', 'SEARCH text was not found.');
    const inside = all.filter((at) =>
      blocks.some((region) => at >= region.start && at + search.length <= region.end),
    );
    if (!inside.length)
      throw new EvolvePatchError(
        'outside_evolve_block',
        'SEARCH text matches only outside the evolve blocks.',
      );
    if (inside.length > 1)
      throw new EvolvePatchError(
        'ambiguous',
        `SEARCH text matches ${inside.length} times inside the evolve blocks.`,
      );
    const at = inside[0]!;
    current = current.slice(0, at) + replace + current.slice(at + search.length);
  }
  return current;
}

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const finalBreak = (text: string) =>
  text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : '';

/**
 * Read a full-program rewrite from a model reply: the last fenced code block,
 * else the whole reply. The frozen code must survive byte-for-byte (line
 * endings aside) and the block count must not change. The rewrite takes the
 * parent's final newline, or its absence: the prompt shows the parent without
 * one and a fence always adds one, so a single final line break is not a change.
 */
export function extractFullRewrite(parent: string, text: string): string {
  const fenced = [...text.matchAll(FENCE)];
  const reply = fenced.length ? fenced[fenced.length - 1]![1]! : text;
  if (!reply.trim().length) throw new EvolvePatchError('empty_rewrite', 'The rewrite is empty.');
  const tail = finalBreak(reply);
  const eol = tail || (reply.includes('\r\n') ? '\r\n' : '\n');
  const program = reply.slice(0, reply.length - tail.length) + (finalBreak(parent) ? eol : '');
  const before = parseEvolveBlocks(parent);
  if (before.implicit) return program;
  const after = parseEvolveBlocks(program);
  if (
    after.implicit ||
    after.frozen.length !== before.frozen.length ||
    after.frozen.some((segment, index) => lf(segment) !== lf(before.frozen[index]!))
  ) {
    throw new EvolvePatchError(
      'frozen_changed',
      'The rewrite changed code outside the evolve blocks.',
    );
  }
  return program;
}
