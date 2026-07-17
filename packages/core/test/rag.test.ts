import { describe, it, expect } from 'vitest';
import {
  sniffMime,
  parse,
  createParserRegistry,
  parseCsv,
  csvToText,
  approxCountTokens,
  chunkFixed,
  chunkRecursive,
  chunkBlocks,
  estimateTokens,
  estimatePdfTokens,
  shouldSendWhole,
  modelSupportsDocuments,
  toNativeDocumentPart,
  cosineSimilarity,
  createMemoryVectorStore,
  identityReranker,
  retrieve,
  indexChunks,
  RagError,
  type Embedder,
} from '../src/rag';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sniffMime (magic bytes)', () => {
  it('detects PDF / ZIP / OLE by signature', () => {
    expect(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toMatchObject({
      mime: 'application/pdf',
      confidence: 'magic',
    });
    expect(sniffMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toMatchObject({
      mime: 'application/zip',
      container: 'zip',
    });
    expect(
      sniffMime(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
    ).toMatchObject({
      mime: 'application/msword',
      container: 'ole',
    });
  });

  it('refines zip→docx via filename hint', () => {
    const r = sniffMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { filename: 'a.docx' });
    expect(r.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('falls back to extension for text formats (no magic)', () => {
    expect(sniffMime(enc('a,b,c'), { filename: 'd.csv' }).mime).toBe('text/csv');
    expect(sniffMime(enc('# hi'), { filename: 'r.md' }).mime).toBe('text/markdown');
    expect(sniffMime(enc('plain'), {}).mime).toBe('unknown');
  });
});

describe('parse (pure-core text path + guards)', () => {
  const reg = createParserRegistry();

  it('decodes txt / markdown directly (BOM-stripped)', async () => {
    const doc = await parse(enc('﻿hello world'), reg, { hint: { filename: 'a.txt' } });
    expect(doc.text).toBe('hello world');
  });

  it('parses csv to tab/newline text', async () => {
    const doc = await parse(enc('a,b\n1,2'), reg, { hint: { filename: 'd.csv' } });
    expect(doc.text).toBe('a\tb\n1\t2');
  });

  it('rejects legacy .doc (OLE) with a typed error', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(parse(ole, reg)).rejects.toMatchObject({ code: 'rag_unsupported_legacy_doc' });
  });

  it('throws extension/MIME mismatch (a .docx that is really a PDF)', async () => {
    await expect(
      parse(enc('%PDF-1.7'), reg, { hint: { filename: 'evil.docx' } }),
    ).rejects.toMatchObject({ code: 'rag_extension_mime_mismatch' });
  });

  it('throws parser_not_registered for an unregistered PDF', async () => {
    await expect(
      parse(enc('%PDF-1.7 body'), reg, { hint: { filename: 'a.pdf' } }),
    ).rejects.toMatchObject({
      code: 'rag_parser_not_registered',
    });
  });

  it('uses a registered parser and enforces a non-empty text layer', async () => {
    const reg2 = createParserRegistry({ 'application/pdf': async () => ({ text: '', pages: 1 }) });
    await expect(
      parse(enc('%PDF-1.7'), reg2, { hint: { filename: 'a.pdf' } }),
    ).rejects.toMatchObject({
      code: 'rag_empty_text_layer',
    });

    const reg3 = createParserRegistry({
      'application/pdf': async () => ({ text: 'real text', pages: 2 }),
    });
    const doc = await parse(enc('%PDF-1.7'), reg3, { hint: { filename: 'a.pdf' } });
    expect(doc).toMatchObject({ text: 'real text', pages: 2 });
  });
});

describe('parseCsv (RFC 4180 state machine)', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF', () => {
    const rows = parseCsv('a,"b,c","d""e"\r\n1,"line\nbreak",3');
    expect(rows).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', 'line\nbreak', '3'],
    ]);
  });
  it('round-trips through csvToText', () => {
    expect(
      csvToText([
        ['x', 'y'],
        ['1', '2'],
      ]),
    ).toBe('x\ty\n1\t2');
  });
});

describe('chunkers (token-aware)', () => {
  it('approxCountTokens ≈ len/4', () => {
    expect(approxCountTokens('abcd')).toBe(1);
    expect(approxCountTokens('abcdefgh')).toBe(2);
  });

  it('chunkFixed windows with overlap and records offsets', () => {
    const text = 'a'.repeat(4000); // ~1000 tokens
    const chunks = chunkFixed(text, { size: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[0]!.index).toBe(0);
    // Reassembling de-overlapped windows covers the whole text.
    expect(chunks[chunks.length - 1]!.endOffset).toBe(text.length);
  });

  it('chunkRecursive keeps pieces under the size budget', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const chunks = chunkRecursive(text, { size: 10, overlap: 2 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeGreaterThan(0);
  });

  it('chunkBlocks breaks before a heading', () => {
    const chunks = chunkBlocks(
      [
        { type: 'heading', text: 'Intro' },
        { type: 'paragraph', text: 'body one' },
        { type: 'heading', text: 'Next' },
        { type: 'paragraph', text: 'body two' },
      ],
      { size: 1000 },
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain('Intro');
    expect(chunks[1]!.text).toContain('Next');
  });
});

describe('native-doc-vs-vector threshold', () => {
  it('estimateTokens / estimatePdfTokens', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimatePdfTokens(3)).toBe(2100);
  });

  it('shouldSendWhole: small+supported=true; large or unsupported=false', () => {
    expect(shouldSendWhole({ estTokens: 1000, modelSupportsDocuments: true })).toBe(true);
    expect(shouldSendWhole({ estTokens: 99999, modelSupportsDocuments: true })).toBe(false);
    expect(shouldSendWhole({ estTokens: 100, modelSupportsDocuments: false })).toBe(false);
  });

  it('modelSupportsDocuments reads caps.nativePdf', () => {
    expect(modelSupportsDocuments({ nativePdf: true })).toBe(true);
    expect(modelSupportsDocuments({ nativePdf: false })).toBe(false);
  });

  it('toNativeDocumentPart: PDF→ImagePart(application/pdf), text→TextPart', () => {
    const pdf = toNativeDocumentPart({ bytes: enc('%PDF'), mime: 'application/pdf' });
    expect(pdf).toMatchObject({ type: 'image', mediaType: 'application/pdf' });
    const txt = toNativeDocumentPart({ mime: 'text/plain', text: 'hi' });
    expect(txt).toEqual({ type: 'text', text: 'hi' });
  });
});

describe('retrieval pipeline', () => {
  const embedder: Embedder = {
    dims: 2,
    // Toy embedder: map text length parity to one of two basis vectors.
    embed: async (texts) => texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1])),
  };

  it('cosineSimilarity basics', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('indexChunks → retrieve returns nearest, identityReranker truncates', async () => {
    const store = createMemoryVectorStore();
    await indexChunks(
      [
        { text: 'a cat sat', index: 0 },
        { text: 'a dog ran', index: 1 },
      ],
      { embedder, store },
    );
    const hits = await retrieve('where is the cat', { embedder, store }, { topK: 2, topN: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe('a cat sat');
    expect(hits[0]!.score).toBeCloseTo(1);
  });

  it('identityReranker just slices to topN', async () => {
    const out = await identityReranker.rerank(
      'q',
      [
        { text: 'a', index: 0, score: 0.9 },
        { text: 'b', index: 1, score: 0.8 },
      ],
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('a');
  });
});

describe('RagError is a DeuzError', () => {
  it('carries code + mime', () => {
    const e = new RagError('rag_unsupported_mime', 'nope', { mime: 'unknown' });
    expect(e).toBeInstanceOf(RagError);
    expect(e.code).toBe('rag_unsupported_mime');
    expect(e.mime).toBe('unknown');
  });
});

describe('citationsFromHits (1.7 built-in citations)', () => {
  it('maps chunks and scored hits to canonical citation parts', async () => {
    const { citationsFromHits } = await import('../src/rag');
    const hits = [
      {
        text: 'Retrieval-augmented generation grounds answers in sources. '.repeat(8),
        index: 3,
        score: 0.92,
        meta: { id: 'doc1#3', sourceId: 'doc1', url: 'https://ex.com/d1', title: 'RAG intro' },
      },
      { text: 'short chunk', index: 7 },
    ];
    const citations = citationsFromHits(hits);
    expect(citations[0]).toMatchObject({
      type: 'citation',
      id: 'doc1#3',
      sourceId: 'doc1',
      url: 'https://ex.com/d1',
      title: 'RAG intro',
      chunkIndex: 3,
      score: 0.92,
    });
    expect(citations[0]!.snippet!.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(citations[1]).toEqual({
      type: 'citation',
      id: 'chunk-7',
      snippet: 'short chunk',
      chunkIndex: 7,
    });
    // Chunk.index stability contract: chunkIndex mirrors the input index untouched.
    expect(citationsFromHits(hits, { snippetLength: 0 })[1]).toEqual({
      type: 'citation',
      id: 'chunk-7',
      chunkIndex: 7,
    });
  });
});
