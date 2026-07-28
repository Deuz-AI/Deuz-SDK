import { describe, it, expect, vi } from 'vitest';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { filePart, imagePart } from '../src/parts';
import { toNativeDocumentPart } from '../src/rag';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';
import type { Logger } from '../src/types/deps';

// ===================================================================
// Golden-replay: every assertion here is on the REQUEST BODY. The point of
// 2.6 is that a document reaches the wire in the shape that wire accepts —
// the response is irrelevant, so each wire gets a one-event finish fixture.
// ===================================================================

const ANTHROPIC_DONE = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const CC_DONE = sseEvents([
  { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
  { data: '[DONE]' },
]);

const RESPONSES_DONE = sseEvents([
  {
    event: 'response.output_text.delta',
    data: { type: 'response.output_text.delta', delta: 'ok' },
  },
  {
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
    },
  },
]);

const GEMINI_DONE = sseEvents([
  {
    data: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  },
]);

/** 4 bytes standing in for a PDF; base64 `JVBERg==` (`%PDF`). */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const PDF_B64 = 'JVBERg==';
/** 3 bytes standing in for a PNG; base64 `iVBO`. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e]);

/** Parse a recorded request body. Untyped on purpose — every assertion below
 *  is a structural `toEqual` against a wire shape, not a typed API. */
function body(call: { init?: RequestInit }) {
  return JSON.parse(String(call.init!.body));
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

// ===================================================================
// filePart() — the discoverable carrier
// ===================================================================

describe('filePart / imagePart', () => {
  it('filePart returns the locked-union ImagePart carrier verbatim', () => {
    expect(filePart({ data: PDF_BYTES, mediaType: 'application/pdf' })).toEqual({
      type: 'image',
      image: PDF_BYTES,
      mediaType: 'application/pdf',
    });
  });

  it('imagePart omits mediaType when not supplied (adapters derive it)', () => {
    expect(imagePart({ data: 'aGk=' })).toEqual({ type: 'image', image: 'aGk=' });
    expect(imagePart({ data: 'aGk=', mediaType: 'image/png' })).toEqual({
      type: 'image',
      image: 'aGk=',
      mediaType: 'image/png',
    });
  });
});

// ===================================================================
// A PDF produces the right block on each of the four wires
// ===================================================================

describe('PDF input — per-wire document block', () => {
  it('anthropic: a `document` block with a base64 source', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        {
          role: 'user',
          content: [
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
            { type: 'text', text: 'Summarise this.' },
          ],
        },
      ],
    });
    expect(body(calls[0]!).messages[0].content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
      },
      { type: 'text', text: 'Summarise this.' },
    ]);
  });

  it('openai responses: an `input_file` block with filename + file_data data: URL', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([RESPONSES_DONE]));
    await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise this.' },
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
          ],
        },
      ],
    });
    expect(body(calls[0]!).input[0].content).toEqual([
      { type: 'input_text', text: 'Summarise this.' },
      {
        type: 'input_file',
        filename: 'document.pdf',
        file_data: `data:application/pdf;base64,${PDF_B64}`,
      },
    ]);
  });

  it('chat completions: a `file` block with filename + file_data data: URL', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise this.' },
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
          ],
        },
      ],
    });
    expect(body(calls[0]!).messages[0].content).toEqual([
      { type: 'text', text: 'Summarise this.' },
      {
        type: 'file',
        file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` },
      },
    ]);
  });

  it('gemini native: inlineData carries the mimeType through unchanged', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([GEMINI_DONE]));
    await generateText({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [
        {
          role: 'user',
          content: [
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
            { type: 'text', text: 'Summarise this.' },
          ],
        },
      ],
    });
    expect(body(calls[0]!).contents[0].parts).toEqual([
      { inlineData: { mimeType: 'application/pdf', data: PDF_B64 } },
      { text: 'Summarise this.' },
    ]);
  });

  it('a base64 STRING + mediaType works the same as raw bytes', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        { role: 'user', content: [filePart({ data: PDF_B64, mediaType: 'application/pdf' })] },
      ],
    });
    expect(body(calls[0]!).messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
    });
  });

  it('a data: URL PDF is classified from its own prefix', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', image: `data:application/pdf;base64,${PDF_B64}` }],
        },
      ],
    });
    expect(body(calls[0]!).messages[0].content[0]).toEqual({
      type: 'file',
      file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` },
    });
  });
});

// ===================================================================
// REGRESSION: ordinary images must be byte-identical to 1.8
// ===================================================================

describe('ordinary images are untouched (regression)', () => {
  const IMAGE_CASES = [
    { name: 'raw bytes + mediaType', part: imagePart({ data: PNG_BYTES, mediaType: 'image/png' }) },
    { name: 'https URL', part: imagePart({ data: 'https://example.com/cat.png' }) },
    { name: 'data URL', part: imagePart({ data: 'data:image/png;base64,iVBO' }) },
    { name: 'bare base64, no mediaType', part: imagePart({ data: 'iVBO' }) },
  ] as const;

  it.each(IMAGE_CASES)('anthropic: $name', async ({ part }) => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: [part] }],
    });
    const block = body(calls[0]!).messages[0].content[0];
    expect(block.type).toBe('image');
    if (typeof part.image === 'string' && part.image.startsWith('http')) {
      expect(block.source).toEqual({ type: 'url', url: 'https://example.com/cat.png' });
    } else {
      expect(block.source.type).toBe('base64');
      expect(String(block.source.media_type).startsWith('image/')).toBe(true);
    }
  });

  it.each(IMAGE_CASES)('chat completions: $name', async ({ part }) => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: [part] }],
    });
    const block = body(calls[0]!).messages[0].content[0];
    expect(block.type).toBe('image_url');
    expect(typeof block.image_url.url).toBe('string');
  });

  it.each(IMAGE_CASES)('openai responses: $name', async ({ part }) => {
    const { fetch, calls } = mockFetch(() => sseResponse([RESPONSES_DONE]));
    await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: [part] }],
    });
    const block = body(calls[0]!).input[0].content[0];
    expect(block.type).toBe('input_image');
    expect(typeof block.image_url).toBe('string');
  });

  it.each(IMAGE_CASES)('gemini native: $name', async ({ part }) => {
    const { fetch, calls } = mockFetch(() => sseResponse([GEMINI_DONE]));
    await generateText({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: [part] }],
    });
    const gp = body(calls[0]!).contents[0].parts[0];
    const mime = (gp.inlineData ?? gp.fileData).mimeType;
    expect(String(mime).startsWith('image/')).toBe(true);
  });

  it('the exact 1.8 image shapes are pinned (byte-for-byte)', async () => {
    const png = imagePart({ data: PNG_BYTES, mediaType: 'image/png' });

    const a = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, png] }],
    });
    expect(body(a.calls[0]!).messages[0].content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBO' } },
    ]);

    const c = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch: c.fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, png] }],
    });
    expect(body(c.calls[0]!).messages[0].content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } },
    ]);

    const r = mockFetch(() => sseResponse([RESPONSES_DONE]));
    await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch: r.fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, png] }],
    });
    expect(body(r.calls[0]!).input[0].content).toEqual([
      { type: 'input_text', text: 'hi' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBO' },
    ]);

    const g = mockFetch(() => sseResponse([GEMINI_DONE]));
    await generateText({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch: g.fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, png] }],
    });
    expect(body(g.calls[0]!).contents[0].parts).toEqual([
      { text: 'hi' },
      { inlineData: { mimeType: 'image/png', data: 'iVBO' } },
    ]);
  });
});

// ===================================================================
// https URL documents — passthrough only where the wire supports it
// ===================================================================

describe('https URL documents', () => {
  const URL_PDF = 'https://example.com/report.pdf';

  it('anthropic: a url-source `document` block', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: [{ type: 'image', image: URL_PDF }] }],
    });
    expect(body(calls[0]!).messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'url', url: URL_PDF },
    });
  });

  it('openai responses: `input_file` + file_url', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([RESPONSES_DONE]));
    await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: [{ type: 'image', image: URL_PDF }] }],
    });
    expect(body(calls[0]!).input[0].content[0]).toEqual({
      type: 'input_file',
      file_url: URL_PDF,
    });
  });

  it('gemini native: fileData with the derived mimeType', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([GEMINI_DONE]));
    await generateText({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: [{ type: 'image', image: URL_PDF }] }],
    });
    expect(body(calls[0]!).contents[0].parts[0]).toEqual({
      fileData: { mimeType: 'application/pdf', fileUri: URL_PDF },
    });
  });

  it('chat completions: no URL form on the `file` block → warns, sends no bogus block', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', image: URL_PDF },
          ],
        },
      ],
      deps: { logger },
    });
    // No `file` / `image_url` block survived — the text still went out.
    expect(body(calls[0]!).messages[0].content).toBe('hi');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![0])).toContain('application/pdf');
    expect(String(logger.warn.mock.calls[0]![0])).toContain('cannot reference a URL');
  });
});

// ===================================================================
// Models that cannot take a document: warn, never send a bogus block
// ===================================================================

describe('unsupported models', () => {
  it('chat completions: a known non-vision row (nativePdf false) warns and drops', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      // deepseek-v3.2: registry row has vision:false, nativePdf:false.
      model: createOpenAI({ apiKey: 'k', fetch })('deepseek-v3.2'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise this.' },
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
          ],
        },
      ],
      deps: { logger },
    });
    const sent = body(calls[0]!);
    expect(sent.messages[0].content).toBe('Summarise this.');
    expect(JSON.stringify(sent)).not.toContain(PDF_B64);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![0])).toContain('application/pdf');
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ modelId: 'deepseek-v3.2' });
  });

  it('anthropic: an unknown slug (conservative row) warns and drops the document', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise this.' },
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
          ],
        },
      ],
      deps: { logger },
    });
    const sent = body(calls[0]!);
    expect(sent.messages[0].content).toEqual([{ type: 'text', text: 'Summarise this.' }]);
    expect(JSON.stringify(sent)).not.toContain(PDF_B64);
    // Two warns: the registry's unknown-slug warning + ours. Ours names the media type.
    const dropWarns = logger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('application/pdf'),
    );
    expect(dropWarns).toHaveLength(1);
  });

  it('an ordinary image on a non-vision row is NOT dropped (unchanged 1.8 behaviour)', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('deepseek-v3.2'),
      messages: [
        { role: 'user', content: [imagePart({ data: PNG_BYTES, mediaType: 'image/png' })] },
      ],
      deps: { logger },
    });
    expect(body(calls[0]!).messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ===================================================================
// The pre-existing sanctioned RAG path is now actually wired up
// ===================================================================

describe('rag.toNativeDocumentPart end-to-end', () => {
  it('anthropic: the {type:image, mediaType:application/pdf} part reaches a `document` block', async () => {
    const part = toNativeDocumentPart({ bytes: PDF_BYTES, mime: 'application/pdf' });
    expect(part).toEqual({ type: 'image', image: PDF_BYTES, mediaType: 'application/pdf' });

    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-sonnet-5'),
      messages: [{ role: 'user', content: [part, { type: 'text', text: 'What does it say?' }] }],
    });
    expect(body(calls[0]!).messages[0].content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
      },
      { type: 'text', text: 'What does it say?' },
    ]);
  });
});
