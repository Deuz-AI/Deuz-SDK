import { describe, expect, it } from 'vitest';
import {
  applySearchReplace,
  EvolvePatchError,
  extractFullRewrite,
  parseEvolveBlocks,
  parseSearchReplace,
} from '../src/evolve/patch';

const program = [
  'import math',
  '# EVOLVE-BLOCK-START',
  'def score(x):',
  '    return x + 1',
  '# EVOLVE-BLOCK-END',
  '',
  'def run():',
  '    return score(1)',
  '',
].join('\n');

const diff = (search: string, replace: string) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe('parseEvolveBlocks', () => {
  it('finds the evolvable regions between the marker lines', () => {
    const parsed = parseEvolveBlocks(program);
    expect(parsed.implicit).toBe(false);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]!.content).toBe('def score(x):\n    return x + 1\n');
    expect(program.slice(parsed.blocks[0]!.start, parsed.blocks[0]!.end)).toBe(
      parsed.blocks[0]!.content,
    );
    expect(parsed.frozen.join('')).toBe(program.replace(parsed.blocks[0]!.content, ''));
  });

  it('accepts any comment syntax around the marker token and several blocks', () => {
    const source =
      '// EVOLVE-BLOCK-START\nconst a = 1;\n// EVOLVE-BLOCK-END\nx\n/* EVOLVE-BLOCK-START */\nb\n/* EVOLVE-BLOCK-END */';
    const parsed = parseEvolveBlocks(source);
    expect(parsed.blocks.map((block) => block.content)).toEqual(['const a = 1;\n', 'b\n']);
  });

  it('treats a program without markers as one implicit evolvable block', () => {
    const parsed = parseEvolveBlocks('x = 1\n');
    expect(parsed.implicit).toBe(true);
    expect(parsed.blocks).toEqual([{ index: 0, start: 0, end: 6, content: 'x = 1\n' }]);
  });

  it('handles CRLF line endings', () => {
    const parsed = parseEvolveBlocks('a\r\n# EVOLVE-BLOCK-START\r\nb\r\n# EVOLVE-BLOCK-END\r\n');
    expect(parsed.blocks[0]!.content).toBe('b\r\n');
  });

  it.each([
    ['nested start', '# EVOLVE-BLOCK-START\n# EVOLVE-BLOCK-START\n# EVOLVE-BLOCK-END\n'],
    ['end without start', 'a\n# EVOLVE-BLOCK-END\n'],
    ['unterminated block', '# EVOLVE-BLOCK-START\na\n'],
  ])('rejects %s with a typed error', (_label, source) => {
    expect(() => parseEvolveBlocks(source)).toThrow(EvolvePatchError);
    try {
      parseEvolveBlocks(source);
    } catch (error) {
      expect((error as EvolvePatchError).code).toBe('invalid_markers');
    }
  });
});

describe('parseSearchReplace', () => {
  it('parses several blocks and ignores prose around them', () => {
    const text = `Here is the change:\n${diff('a', 'b')}\nand\n${diff('c\nd', '')}\nDone.`;
    expect(parseSearchReplace(text)).toEqual([
      { search: 'a', replace: 'b' },
      { search: 'c\nd', replace: '' },
    ]);
  });

  it('rejects text with no blocks and malformed blocks', () => {
    expect(() => parseSearchReplace('no diff here')).toThrow(
      expect.objectContaining({ code: 'no_blocks' }),
    );
    expect(() => parseSearchReplace('<<<<<<< SEARCH\na\n=======\nb\n')).toThrow(
      expect.objectContaining({ code: 'malformed_diff' }),
    );
    expect(() => parseSearchReplace('<<<<<<< SEARCH\na\n>>>>>>> REPLACE')).toThrow(
      expect.objectContaining({ code: 'malformed_diff' }),
    );
  });

  it('accepts CRLF diffs', () => {
    expect(
      parseSearchReplace('<<<<<<< SEARCH\r\na\r\n=======\r\nb\r\n>>>>>>> REPLACE\r\n'),
    ).toEqual([{ search: 'a', replace: 'b' }]);
  });
});

describe('applySearchReplace', () => {
  it('applies a diff inside the evolve block', () => {
    const next = applySearchReplace(program, diff('    return x + 1', '    return x * 2'));
    expect(next).toBe(program.replace('return x + 1', 'return x * 2'));
  });

  it('applies several blocks in order, each against the updated source', () => {
    const next = applySearchReplace(
      program,
      `${diff('return x + 1', 'return x + 2')}\n${diff('return x + 2', 'return x + 3')}`,
    );
    expect(next).toContain('return x + 3');
  });

  it('rejects a SEARCH that does not match', () => {
    expect(() => applySearchReplace(program, diff('return y', 'return z'))).toThrow(
      expect.objectContaining({ name: 'EvolvePatchError', code: 'not_found' }),
    );
  });

  it('rejects a SEARCH that only matches frozen code', () => {
    expect(() => applySearchReplace(program, diff('return score(1)', 'return 0'))).toThrow(
      expect.objectContaining({ code: 'outside_evolve_block' }),
    );
  });

  it('rejects an ambiguous SEARCH', () => {
    const source = '# EVOLVE-BLOCK-START\nx = 1\nx = 1\n# EVOLVE-BLOCK-END\n';
    expect(() => applySearchReplace(source, diff('x = 1', 'x = 2'))).toThrow(
      expect.objectContaining({ code: 'ambiguous' }),
    );
  });

  it('counts only matches inside blocks, so a frozen duplicate is not ambiguous', () => {
    const source = 'x = 1\n# EVOLVE-BLOCK-START\nx = 1\n# EVOLVE-BLOCK-END\n';
    expect(applySearchReplace(source, diff('x = 1', 'x = 2'))).toBe(
      'x = 1\n# EVOLVE-BLOCK-START\nx = 2\n# EVOLVE-BLOCK-END\n',
    );
  });

  it('rejects a SEARCH that spans a marker', () => {
    expect(() =>
      applySearchReplace(program, diff('    return x + 1\n# EVOLVE-BLOCK-END', 'oops')),
    ).toThrow(expect.objectContaining({ code: 'outside_evolve_block' }));
  });

  it('rejects an empty SEARCH and a REPLACE that smuggles markers', () => {
    expect(() => applySearchReplace(program, diff('', 'x'))).toThrow(
      expect.objectContaining({ code: 'empty_search' }),
    );
    expect(() =>
      applySearchReplace(program, diff('return x + 1', '# EVOLVE-BLOCK-END\nevil()')),
    ).toThrow(expect.objectContaining({ code: 'marker_in_replace' }));
  });

  it('works on a whole program without markers', () => {
    expect(applySearchReplace('a = 1\n', diff('a = 1', 'a = 2'))).toBe('a = 2\n');
  });
});

describe('extractFullRewrite', () => {
  it('takes the last fenced code block and keeps frozen code intact', () => {
    const rewritten = program.replace('return x + 1', 'return x ** 2');
    const text = `Thoughts\n\`\`\`python\n${rewritten}\`\`\`\n`;
    expect(extractFullRewrite(program, text)).toBe(rewritten);
  });

  it('rejects a rewrite that changes frozen code', () => {
    const text = '```\n' + program.replace('return score(1)', 'return 0') + '```';
    expect(() => extractFullRewrite(program, text)).toThrow(
      expect.objectContaining({ code: 'frozen_changed' }),
    );
  });

  it('rejects a rewrite with a different number of blocks', () => {
    expect(() => extractFullRewrite(program, '```\nimport math\n```')).toThrow(
      expect.objectContaining({ code: 'frozen_changed' }),
    );
  });

  it('uses the whole reply when there is no fence and the program has no markers', () => {
    expect(extractFullRewrite('a = 1\n', 'a = 3\n')).toBe('a = 3\n');
  });

  it('rejects an empty rewrite', () => {
    expect(() => extractFullRewrite('a = 1\n', '```\n```')).toThrow(
      expect.objectContaining({ code: 'empty_rewrite' }),
    );
  });
});
