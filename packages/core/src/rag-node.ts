/**
 * rag-node.ts — Node-leaning, optional-peer document parsers for RAG.
 * Exported as `@deuz-sdk/core/rag/node` (NOT bundled into the edge-safe core). Each
 * parser lazily imports a heavy optional peer (unpdf / mammoth / xlsx) so the
 * core stays zero-dependency; importing this module on the edge only fails if a
 * parser is actually invoked.
 *
 * Register them into a `ParserRegistry` from core and pass it to `parse()`:
 *   import { createParserRegistry, parse } from '@deuz-sdk/core/rag';
 *   import { defaultNodeParserRegistry } from '@deuz-sdk/core/rag/node';
 *   const doc = await parse(bytes, defaultNodeParserRegistry(), { hint: { filename } });
 */
import {
  createParserRegistry,
  csvToText,
  parseCsv,
  type DocBlock,
  type DocumentParser,
  type ParserRegistry,
} from './rag';

/** Slice a Uint8Array's backing buffer correctly (a subarray view must not be passed whole). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Convert mammoth HTML output into structural blocks for chunkBlocks. */
export function htmlToBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  // Lightweight tag walk — good enough to recover headings/paragraphs/lists.
  const re = /<(h[1-6]|p|li|pre)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1]!.toLowerCase();
    const text = m[2]!
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (!text) continue;
    if (tag.startsWith('h')) blocks.push({ type: 'heading', level: Number(tag[1]), text });
    else if (tag === 'li') blocks.push({ type: 'list', text });
    else if (tag === 'pre') blocks.push({ type: 'code', text });
    else blocks.push({ type: 'paragraph', text });
  }
  return blocks;
}

/** PDF via unpdf (serverless/edge-friendly pdf.js — the only edge-safe binary parser). */
export const pdfParser: DocumentParser = async ({ bytes }) => {
  const mod = (await import('unpdf' as string)) as unknown as {
    getDocumentProxy: (data: Uint8Array) => Promise<unknown>;
    extractText: (
      pdf: unknown,
      opts?: { mergePages?: boolean },
    ) => Promise<{ totalPages: number; text: string }>;
  };
  const pdf = await mod.getDocumentProxy(bytes);
  const { totalPages, text } = await mod.extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
};

/** DOCX via mammoth (.docx ONLY — legacy .doc is rejected upstream in parse()). */
export const docxParser: DocumentParser = async ({ bytes }) => {
  const mod = (await import('mammoth' as string)) as unknown as {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{
      value: string;
      messages: { message: string }[];
    }>;
  };
  const { value: html, messages } = await mod.convertToHtml({ arrayBuffer: toArrayBuffer(bytes) });
  const structure = htmlToBlocks(html);
  const text = structure.map((b) => b.text).join('\n\n');
  return {
    text,
    structure,
    ...(messages.length ? { warnings: messages.map((w) => w.message) } : {}),
  };
};

/** XLSX via SheetJS — pin a patched version (see openQuestions). Sheets → CSV/text. */
export const xlsxParser: DocumentParser = async ({ bytes }) => {
  const XLSX = (await import('xlsx' as string)) as unknown as {
    read: (
      data: Uint8Array,
      opts?: { type?: string },
    ) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: { sheet_to_csv: (ws: unknown) => string };
  };
  const wb = XLSX.read(bytes, { type: 'array' });
  const sections: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    sections.push(`# ${name}\n${csvToText(parseCsv(csv))}`);
  }
  return { text: sections.join('\n\n') };
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A registry pre-populated with the PDF / DOCX / XLSX parsers. */
export function defaultNodeParserRegistry(): ParserRegistry {
  return createParserRegistry({
    'application/pdf': pdfParser,
    [DOCX_MIME]: docxParser,
    [XLSX_MIME]: xlsxParser,
  });
}
