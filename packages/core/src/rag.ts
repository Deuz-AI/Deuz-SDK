/**
 * rag.ts — PURE, edge-safe Retrieval-Augmented-Generation primitives (Faz 3).
 *
 * Everything here is Web-API-only and zero-dependency: MIME magic-byte sniffing,
 * a CSV state machine, token-aware chunkers, the native-doc-vs-vector threshold
 * policy, and a retrieval pipeline whose every stateful stage (parser, embedder,
 * vector store, reranker) is an injected seam. The HEAVY binary parsers
 * (unpdf / mammoth / xlsx) live in `@deuz-sdk/core/rag/node` and are registered into
 * a `ParserRegistry` — core never imports a parser library.
 */
import type { Part } from './types/message';
import type { CitationPart } from './types/stream';
import type { ModelCapabilities } from './core/registry';
import { DeuzError } from './errors';

// ===================================================================
// Typed errors
// ===================================================================

export type RagErrorCode =
  | 'rag_unsupported_legacy_doc'
  | 'rag_unsupported_mime'
  | 'rag_empty_text_layer'
  | 'rag_parser_not_registered'
  | 'rag_extension_mime_mismatch';

export class RagError extends DeuzError {
  readonly code: RagErrorCode;
  readonly mime?: DocMime | 'unknown';
  constructor(
    code: RagErrorCode,
    message: string,
    options?: { mime?: DocMime | 'unknown'; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.code = code;
    this.mime = options?.mime;
  }
}

// ===================================================================
// MIME sniffing (magic bytes — NEVER trust the file extension)
// ===================================================================

export type DocMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/csv'
  | 'text/plain'
  | 'text/markdown'
  | 'application/msword'
  | 'application/zip';

export type Container = 'zip' | 'ole' | 'none';

export interface SniffResult {
  mime: DocMime | 'unknown';
  confidence: 'magic' | 'guess';
  container: Container;
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

function mimeFromExtension(filename: string | undefined): DocMime | undefined {
  const ext = filename?.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'csv':
      return 'text/csv';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
    case 'text':
      return 'text/plain';
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:
      return undefined;
  }
}

/**
 * Sniff a document's MIME from its magic bytes; hints only break ties for
 * extension-less text formats. NOTE: core cannot tell docx from xlsx (both are
 * ZIP) — it returns `application/zip`; the node registry disambiguates via the
 * filename hint or the OOXML container manifest.
 */
export function sniffMime(
  bytes: Uint8Array,
  hint?: { filename?: string; declaredMime?: string },
): SniffResult {
  // %PDF
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { mime: 'application/pdf', confidence: 'magic', container: 'none' };
  }
  // ZIP / OOXML (PK\x03\x04, also empty 05 06 / spanned 07 08)
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    // Use the filename to refine docx vs xlsx; otherwise coarse zip.
    const ext = mimeFromExtension(hint?.filename);
    if (
      ext === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      return { mime: ext, confidence: 'guess', container: 'zip' };
    }
    return { mime: 'application/zip', confidence: 'magic', container: 'zip' };
  }
  // OLE / CFBF (legacy .doc/.xls) — D0 CF 11 E0 A1 B1 1A E1
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: 'application/msword', confidence: 'magic', container: 'ole' };
  }

  // No magic: fall back to extension / declared MIME for text formats.
  const byExt = mimeFromExtension(hint?.filename);
  if (byExt === 'text/csv' || byExt === 'text/markdown' || byExt === 'text/plain') {
    return { mime: byExt, confidence: 'guess', container: 'none' };
  }
  const declared = hint?.declaredMime as DocMime | undefined;
  if (declared === 'text/csv' || declared === 'text/markdown' || declared === 'text/plain') {
    return { mime: declared, confidence: 'guess', container: 'none' };
  }
  return { mime: 'unknown', confidence: 'guess', container: 'none' };
}

// ===================================================================
// Parser registry — heavy impls injected from @deuz-sdk/core/rag/node.
// ===================================================================

export type DocBlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'code';

export interface DocBlock {
  type: DocBlockType;
  level?: number;
  text: string;
}

export interface ParsedDocument {
  text: string;
  pages?: number;
  structure?: DocBlock[];
  warnings?: string[];
}

export type DocumentParser = (input: {
  bytes: Uint8Array;
  mime: DocMime;
}) => Promise<ParsedDocument>;

export interface ParserRegistry {
  get(mime: DocMime): DocumentParser | undefined;
  register(mime: DocMime, parser: DocumentParser): void;
  has(mime: DocMime): boolean;
}

export function createParserRegistry(
  initial?: Partial<Record<DocMime, DocumentParser>>,
): ParserRegistry {
  const map = new Map<DocMime, DocumentParser>(
    initial ? (Object.entries(initial) as [DocMime, DocumentParser][]) : [],
  );
  return {
    get: (mime) => map.get(mime),
    register: (mime, parser) => {
      map.set(mime, parser);
    },
    has: (mime) => map.has(mime),
  };
}

const TEXT_DECODER = new TextDecoder('utf-8');

/** Strip a UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse a document's bytes to text. Text formats (txt/markdown/csv) are handled
 * PURELY in core; binary formats need a parser registered from `./rag/node`.
 * Throws a typed `RagError` for legacy `.doc`, extension/MIME mismatch,
 * unregistered binary MIMEs, or an empty PDF text layer.
 */
export async function parse(
  bytes: Uint8Array,
  registry: ParserRegistry,
  opts?: { hint?: { filename?: string; declaredMime?: string }; minTextChars?: number },
): Promise<ParsedDocument> {
  const sniff = sniffMime(bytes, opts?.hint);

  // Reject a renamed/malicious upload: declared/extension implies X but magic says Y.
  const declared =
    mimeFromExtension(opts?.hint?.filename) ?? (opts?.hint?.declaredMime as DocMime | undefined);
  if (
    declared &&
    sniff.confidence === 'magic' &&
    sniff.mime !== 'unknown' &&
    sniff.mime !== 'application/zip' &&
    declared !== sniff.mime &&
    // zip-family declared (docx/xlsx) against a zip container is fine
    !(sniff.container === 'zip' && declared.includes('openxmlformats'))
  ) {
    throw new RagError(
      'rag_extension_mime_mismatch',
      `File claims '${declared}' but its bytes are '${sniff.mime}'.`,
      { mime: sniff.mime },
    );
  }

  if (sniff.mime === 'application/msword') {
    throw new RagError(
      'rag_unsupported_legacy_doc',
      'Legacy .doc (OLE) is not supported. Convert to .docx or PDF.',
      { mime: 'application/msword' },
    );
  }

  // Pure-core text path.
  if (sniff.mime === 'text/plain' || sniff.mime === 'text/markdown') {
    return { text: stripBom(TEXT_DECODER.decode(bytes)) };
  }
  if (sniff.mime === 'text/csv') {
    const text = stripBom(TEXT_DECODER.decode(bytes));
    return { text: csvToText(parseCsv(text)) };
  }

  // Binary path → registered parser required.
  const mime = sniff.mime === 'application/zip' ? guessZipMime(opts?.hint) : sniff.mime;
  if (mime === 'unknown') {
    throw new RagError('rag_unsupported_mime', 'Could not determine a supported document type.', {
      mime: 'unknown',
    });
  }
  const parser = registry.get(mime);
  if (!parser) {
    throw new RagError(
      'rag_parser_not_registered',
      `No parser registered for '${mime}'. Import @deuz-sdk/core/rag/node and register one.`,
      { mime },
    );
  }
  const parsed = await parser({ bytes, mime });
  const min = opts?.minTextChars ?? 1;
  if (parsed.text.trim().length < min) {
    throw new RagError(
      'rag_empty_text_layer',
      'Document parsed to an empty text layer (scanned PDF?). OCR is required.',
      { mime },
    );
  }
  return parsed;
}

function guessZipMime(hint?: { filename?: string }): DocMime | 'unknown' {
  const ext = mimeFromExtension(hint?.filename);
  if (
    ext === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return ext;
  }
  return 'unknown';
}

// ===================================================================
// CSV parser (PURE, RFC 4180 state machine)
// ===================================================================

export function parseCsv(text: string, opts?: { delimiter?: string }): string[][] {
  const delim = opts?.delimiter ?? ',';
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      // Handle \r\n as one line break.
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush the final field/row (unless the input was empty / ended on a newline).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Render CSV rows to a readable text block (tab-joined cells, newline rows). */
export function csvToText(rows: string[][]): string {
  return rows.map((r) => r.join('\t')).join('\n');
}

// ===================================================================
// Tokenizer seam + chunkers (all PURE)
// ===================================================================

export type CountTokens = (s: string) => number;

/** Cheap default token estimate (~4 chars/token). Inject a real tokenizer for accuracy. */
export const approxCountTokens: CountTokens = (s) => Math.ceil(s.length / 4);

export interface Chunk {
  text: string;
  index: number;
  startOffset?: number;
  endOffset?: number;
  meta?: Record<string, unknown>;
}

export interface ChunkOptions {
  /** Target chunk size in the SAME unit as `countTokens` (default: tokens). */
  size?: number;
  /** Overlap between consecutive chunks (same unit). */
  overlap?: number;
  countTokens?: CountTokens;
}

export const DEFAULT_CHUNK_OPTIONS = { size: 512, overlap: 64 } as const;
export const DEFAULT_SEPARATORS: readonly string[] = ['\n\n\n', '\n\n', '\n', '. ', ' ', ''];

/** Fixed-size sliding window with overlap (token-aware). */
export function chunkFixed(text: string, o?: ChunkOptions): Chunk[] {
  const size = o?.size ?? DEFAULT_CHUNK_OPTIONS.size;
  const overlap = Math.min(o?.overlap ?? DEFAULT_CHUNK_OPTIONS.overlap, size - 1);
  const count = o?.countTokens ?? approxCountTokens;
  if (!text) return [];

  // Approximate chars-per-unit so we can window over the string.
  const charsPerUnit = text.length / Math.max(1, count(text));
  const stepChars = Math.max(1, Math.floor((size - overlap) * charsPerUnit));
  const winChars = Math.max(1, Math.floor(size * charsPerUnit));

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + winChars);
    const slice = text.slice(start, end);
    chunks.push({ text: slice, index: index++, startOffset: start, endOffset: end });
    if (end >= text.length) break;
    start += stepChars;
  }
  return chunks;
}

/**
 * Recursive/structure-aware split: only recurse into the separator hierarchy
 * when a piece exceeds the size budget; pack pieces up to the budget, then add
 * overlap. Falls back to `chunkFixed` for an oversized atomic piece.
 */
export function chunkRecursive(
  text: string,
  o?: ChunkOptions & { separators?: string[] },
): Chunk[] {
  const size = o?.size ?? DEFAULT_CHUNK_OPTIONS.size;
  const overlap = o?.overlap ?? DEFAULT_CHUNK_OPTIONS.overlap;
  const count = o?.countTokens ?? approxCountTokens;
  const separators = o?.separators ?? [...DEFAULT_SEPARATORS];
  if (!text) return [];

  const pieces = splitRecursive(text, separators, size, count);

  // Pack pieces greedily up to `size`, carrying `overlap` into the next chunk.
  const chunks: Chunk[] = [];
  let buf = '';
  let index = 0;
  const flush = (): void => {
    if (!buf) return;
    chunks.push({ text: buf, index: index++ });
    // Carry overlap (tail of the flushed buffer, by char approximation).
    if (overlap > 0) {
      const charsPerUnit = buf.length / Math.max(1, count(buf));
      const tailChars = Math.min(buf.length, Math.floor(overlap * charsPerUnit));
      buf = buf.slice(buf.length - tailChars);
    } else {
      buf = '';
    }
  };
  for (const piece of pieces) {
    if (count(buf + piece) > size && buf) flush();
    buf += piece;
  }
  if (buf.trim()) chunks.push({ text: buf, index: index++ });
  return chunks;
}

function splitRecursive(
  text: string,
  separators: string[],
  size: number,
  count: CountTokens,
): string[] {
  if (count(text) <= size) return [text];
  const [sep, ...rest] = separators;
  if (sep === undefined || sep === '') {
    // No separators left — hard-split by chars.
    return chunkFixed(text, { size, overlap: 0, countTokens: count }).map((c) => c.text);
  }
  const parts = text.split(sep);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    // Re-attach the separator to every piece EXCEPT the last — split() removed
    // it, and the final piece had no trailing separator in the original text.
    const withSep = i < parts.length - 1 ? parts[i]! + sep : parts[i]!;
    if (withSep === '') continue;
    if (count(withSep) > size) out.push(...splitRecursive(withSep, rest, size, count));
    else out.push(withSep);
  }
  return out;
}

/** Chunk pre-parsed structural blocks, never splitting across a heading boundary before packing. */
export function chunkBlocks(blocks: DocBlock[], o?: ChunkOptions): Chunk[] {
  const size = o?.size ?? DEFAULT_CHUNK_OPTIONS.size;
  const count = o?.countTokens ?? approxCountTokens;
  const chunks: Chunk[] = [];
  let buf = '';
  let index = 0;
  for (const block of blocks) {
    const piece = block.text + '\n\n';
    if (block.type === 'heading' && buf) {
      chunks.push({ text: buf.trim(), index: index++ });
      buf = '';
    }
    if (count(buf + piece) > size && buf) {
      chunks.push({ text: buf.trim(), index: index++ });
      buf = '';
    }
    buf += piece;
  }
  if (buf.trim()) chunks.push({ text: buf.trim(), index: index++ });
  return chunks;
}

// ===================================================================
// Native-doc-vs-vector threshold (PURE policy over ModelCapabilities)
// ===================================================================

export function estimateTokens(text: string, countTokens?: CountTokens): number {
  return (countTokens ?? approxCountTokens)(text);
}

/** Rough PDF token estimate (~700 tokens/page). */
export function estimatePdfTokens(pages: number): number {
  return pages * 700;
}

export interface SendWholeInput {
  estTokens: number;
  /** True if the model can ingest the document directly (caps.nativePdf etc.). */
  modelSupportsDocuments: boolean;
  contextWindow?: number;
  /** Below this, send the whole doc (default 6000 — headroom under ~8K). */
  thresholdTokens?: number;
}

/** Decide whether to attach the whole document vs chunk+embed+retrieve. */
export function shouldSendWhole(input: SendWholeInput): boolean {
  const threshold = input.thresholdTokens ?? 6000;
  if (!input.modelSupportsDocuments) return false;
  if (input.estTokens > threshold) return false;
  if (input.contextWindow !== undefined && input.estTokens >= input.contextWindow) return false;
  return true;
}

/** Read the document-support flag off a capability row (native PDF ingestion). */
export function modelSupportsDocuments(caps: Pick<ModelCapabilities, 'nativePdf'>): boolean {
  return caps.nativePdf;
}

/**
 * Build a canonical Part carrying a whole document. PDFs ride as an ImagePart
 * with `mediaType:'application/pdf'` (adapters map it to their document block);
 * extracted text rides as a TextPart.
 */
export function toNativeDocumentPart(doc: {
  bytes?: Uint8Array;
  mime: DocMime;
  text?: string;
}): Part {
  if (doc.text !== undefined) return { type: 'text', text: doc.text };
  if (doc.bytes && doc.mime === 'application/pdf') {
    return { type: 'image', image: doc.bytes, mediaType: 'application/pdf' };
  }
  // Fallback: decode bytes as text.
  return { type: 'text', text: doc.bytes ? TEXT_DECODER.decode(doc.bytes) : '' };
}

// ===================================================================
// Retrieval pipeline (every stateful stage is a seam)
// ===================================================================

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dims: number;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

export interface VectorStore {
  upsert(items: EmbeddedChunk[]): Promise<void>;
  query(vector: number[], topK: number): Promise<ScoredChunk[]>;
}

export interface Reranker {
  rerank(query: string, candidates: ScoredChunk[], topN: number): Promise<ScoredChunk[]>;
}

/**
 * Default reranker: keep the highest-scoring candidates, truncate to topN
 * (a real cross-encoder rerank is DEFERRED). Sorts defensively so it does not
 * rely on the upstream store already being score-ordered.
 */
export const identityReranker: Reranker = {
  rerank: async (_query, candidates, topN) =>
    [...candidates].sort((a, b) => b.score - a.score).slice(0, topN),
};

export interface CitationOptions {
  /** Max snippet characters carried on the part (default 200; 0 = no snippet). */
  snippetLength?: number;
}

/**
 * Built-in RAG citations (1.7): map retrieve/rerank hits to canonical
 * `citation` stream parts — send them alongside the answer via
 * `createDeuzStream(...).writeData` or emit through your own pipeline.
 * `Chunk.index` rides `chunkIndex` (stable across BM25 indexing and RRF
 * fusion, so citations stay aligned with `hybridRetrieve` results);
 * `meta.id`/`meta.sourceId`/`meta.url`/`meta.title` are picked up when
 * present.
 */
export function citationsFromHits(
  hits: ReadonlyArray<Chunk | ScoredChunk>,
  options: CitationOptions = {},
): CitationPart[] {
  const snippetLength = options.snippetLength ?? 200;
  const metaString = (chunk: Chunk, key: string): string | undefined => {
    const value = chunk.meta?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  return hits.map((chunk) => {
    const snippet =
      snippetLength > 0
        ? chunk.text.length > snippetLength
          ? `${chunk.text.slice(0, snippetLength)}…`
          : chunk.text
        : undefined;
    return {
      type: 'citation' as const,
      id: metaString(chunk, 'id') ?? `chunk-${chunk.index}`,
      ...(metaString(chunk, 'sourceId') ? { sourceId: metaString(chunk, 'sourceId') } : {}),
      ...(metaString(chunk, 'url') ? { url: metaString(chunk, 'url') } : {}),
      ...(metaString(chunk, 'title') ? { title: metaString(chunk, 'title') } : {}),
      ...(snippet ? { snippet } : {}),
      chunkIndex: chunk.index,
      ...('score' in chunk ? { score: chunk.score } : {}),
    };
  });
}

/** Pure cosine similarity (edge-safe). 0 on mismatch / zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pure in-memory cosine vector store — reference impl for tests/examples ONLY. */
export function createMemoryVectorStore(): VectorStore {
  const items: EmbeddedChunk[] = [];
  return {
    async upsert(newItems) {
      items.push(...newItems);
    },
    async query(vector, topK) {
      return items
        .map<ScoredChunk>((it) => ({ ...it, score: cosineSimilarity(vector, it.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
}

export interface RetrieveDeps {
  embedder: Embedder;
  store: VectorStore;
  reranker?: Reranker;
}

export interface RetrieveOptions {
  topK?: number;
  topN?: number;
}

/** Embed the query → vector search (topK) → rerank (topN). */
export async function retrieve(
  query: string,
  deps: RetrieveDeps,
  o?: RetrieveOptions,
): Promise<ScoredChunk[]> {
  const topK = o?.topK ?? 8;
  const topN = o?.topN ?? topK;
  const [vector] = await deps.embedder.embed([query]);
  if (!vector) return [];
  const candidates = await deps.store.query(vector, topK);
  const reranker = deps.reranker ?? identityReranker;
  return reranker.rerank(query, candidates, topN);
}

/** Embed chunks and upsert them into the store. */
export async function indexChunks(
  chunks: Chunk[],
  deps: { embedder: Embedder; store: VectorStore },
): Promise<void> {
  if (chunks.length === 0) return;
  const vectors = await deps.embedder.embed(chunks.map((c) => c.text));
  const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, embedding: vectors[i] ?? [] }));
  await deps.store.upsert(embedded);
}

// ===================================================================
// Hybrid search — BM25 (lexical) + dense (vector), fused with RRF.
//
// Dense embeddings catch paraphrase / semantic similarity; BM25 catches exact
// terms, IDs, and rare tokens a vector model blurs ("clause 17", a SKU, a name).
// Reciprocal Rank Fusion merges the two RANKINGS (not raw scores, which live on
// different scales) — robust and parameter-light. All pure / edge-safe.
// ===================================================================

const WORD_RE = /[a-z0-9]+/g;

/** Lowercase + split into alphanumeric tokens (diacritics folded). */
export function tokenize(text: string): string[] {
  const folded = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return folded.match(WORD_RE) ?? [];
}

export interface Bm25Options {
  /** Term-frequency saturation (default 1.5). */
  k1?: number;
  /** Length-normalization strength 0..1 (default 0.75). */
  b?: number;
  /** Custom tokenizer (default `tokenize`). */
  tokenize?: (text: string) => string[];
}

/**
 * A prebuilt BM25 index over a fixed chunk set. Construct once, `search()` many
 * times. Pure in-memory; no I/O. For large/persistent corpora, back the lexical
 * stage with your own search engine and implement the same `search` shape.
 */
export interface Bm25Index {
  search(query: string, topK: number): ScoredChunk[];
  readonly size: number;
}

/** Build a BM25 index over `chunks` (Okapi BM25). */
export function createBm25Index(chunks: Chunk[], options: Bm25Options = {}): Bm25Index {
  const k1 = options.k1 ?? 1.5;
  const b = options.b ?? 0.75;
  const tok = options.tokenize ?? tokenize;

  const docTokens = chunks.map((c) => tok(c.text));
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((s, n) => s + n, 0) / Math.max(1, docLen.length);

  // term → document frequency; and per-doc term-frequency maps.
  const df = new Map<string, number>();
  const tf: Map<string, number>[] = docTokens.map((tokens) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return m;
  });

  const N = chunks.length;
  const idf = (term: string): number => {
    const n = df.get(term) ?? 0;
    // BM25 idf with +1 floor so common terms never go negative.
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  return {
    size: N,
    search(query, topK) {
      const qTerms = [...new Set(tok(query))];
      const scored: ScoredChunk[] = [];
      for (let i = 0; i < N; i++) {
        const len = docLen[i]!;
        let score = 0;
        for (const term of qTerms) {
          const f = tf[i]!.get(term);
          if (!f) continue;
          const denom = f + k1 * (1 - b + (b * len) / (avgLen || 1));
          score += idf(term) * ((f * (k1 + 1)) / denom);
        }
        if (score > 0) scored.push({ ...chunks[i]!, score });
      }
      return scored.sort((a, b2) => b2.score - a.score).slice(0, topK);
    },
  };
}

/** Identify a chunk across rankings — its `index` (stable per chunk set). */
function chunkKey(c: Chunk): number {
  return c.index;
}

export interface RrfOptions {
  /** RRF damping constant (default 60 — the canonical value). */
  k?: number;
  /** Keep the top N fused results (default: all). */
  topN?: number;
}

/**
 * Reciprocal Rank Fusion: merge several ranked lists into one. Each list votes
 * `1 / (k + rank)` for every chunk; votes sum across lists. Order within each
 * input list is what matters — raw scores are ignored (they're incomparable
 * across BM25 vs cosine). Returns chunks with their fused `score`.
 */
export function reciprocalRankFusion(
  rankings: ScoredChunk[][],
  options: RrfOptions = {},
): ScoredChunk[] {
  const k = options.k ?? 60;
  const fused = new Map<number, ScoredChunk>();
  const score = new Map<number, number>();

  for (const ranking of rankings) {
    ranking.forEach((chunk, rank) => {
      const key = chunkKey(chunk);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + rank + 1));
      if (!fused.has(key)) fused.set(key, chunk);
    });
  }

  const out = [...fused.values()]
    .map((c) => ({ ...c, score: score.get(chunkKey(c))! }))
    .sort((a, b2) => b2.score - a.score);
  return options.topN ? out.slice(0, options.topN) : out;
}

export interface HybridRetrieveDeps extends RetrieveDeps {
  /** Lexical index (BM25). Build once with `createBm25Index(chunks)`. */
  bm25: Bm25Index;
}

export interface HybridRetrieveOptions extends RetrieveOptions {
  /** Candidates pulled from EACH stage before fusion (default `topK`). */
  perStageK?: number;
  /** RRF damping (default 60). */
  rrfK?: number;
}

/**
 * Hybrid retrieve: run the dense (vector) and lexical (BM25) stages in parallel,
 * fuse their rankings with RRF, then rerank (default: identity/truncate). This
 * is the recommended default for mixed natural-language + exact-term queries.
 */
export async function hybridRetrieve(
  query: string,
  deps: HybridRetrieveDeps,
  o?: HybridRetrieveOptions,
): Promise<ScoredChunk[]> {
  const topN = o?.topN ?? o?.topK ?? 8;
  const perStage = o?.perStageK ?? o?.topK ?? 8;

  const [vector] = await deps.embedder.embed([query]);
  const [dense, lexical] = await Promise.all([
    vector ? deps.store.query(vector, perStage) : Promise.resolve([] as ScoredChunk[]),
    Promise.resolve(deps.bm25.search(query, perStage)),
  ]);

  const fused = reciprocalRankFusion([dense, lexical], { k: o?.rrfK });
  const reranker = deps.reranker ?? identityReranker;
  return reranker.rerank(query, fused, topN);
}
