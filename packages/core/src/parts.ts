/**
 * Content-part constructors.
 *
 * These exist because the canonical `Part` union is LOCKED in the 1.0 surface
 * (`types/message.ts`: adding a sixth kind is a breaking change, queued for
 * 2.0). Until then `ImagePart` is the carrier for ALL binary media — a PDF is
 * `{ type:'image', image: bytes, mediaType:'application/pdf' }`, which every
 * adapter now maps to its wire's document block (Anthropic `document`, OpenAI
 * Responses `input_file`, Chat Completions `file`, Gemini `inlineData`).
 *
 * That convention is correct but undiscoverable — nobody guesses "attach a PDF
 * as an image". `filePart()` turns it into an API. When the `file` kind lands
 * in 2.0 this function keeps its signature and just returns the new part, so
 * callers written today do not change.
 */
import type { ImagePart } from './types/message';

/**
 * Attach a document (PDF, plain text, …) to a message.
 *
 * ```ts
 * const bytes = new Uint8Array(await file.arrayBuffer());
 * await generateText({
 *   model,
 *   messages: [
 *     { role: 'user', content: [filePart({ data: bytes, mediaType: 'application/pdf' }),
 *                               { type: 'text', text: 'Summarise this.' }] },
 *   ],
 * });
 * ```
 *
 * `data` may be raw bytes, a base64 string, a `data:` URL, or an https URL
 * (passed through on the wires that can fetch it). `mediaType` is REQUIRED
 * here — unlike an image there is no sane default, and it is what the adapters
 * classify on.
 */
export function filePart(input: { data: string | Uint8Array; mediaType: string }): ImagePart {
  return { type: 'image', image: input.data, mediaType: input.mediaType };
}

/**
 * Attach an image. Symmetric sibling of `filePart` — the point of the pair is
 * that a reader who finds one immediately learns the other exists, and that
 * `image`/`file` are the SAME carrier today. `mediaType` is optional: an
 * unlabelled image resolves to `image/jpeg`, or is derived from a `data:`/URL
 * extension (`internal/image.ts#resolveMedia`).
 */
export function imagePart(input: { data: string | Uint8Array; mediaType?: string }): ImagePart {
  return {
    type: 'image',
    image: input.data,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
  };
}
