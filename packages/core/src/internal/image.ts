import type { ImagePart } from '../types/message';
import type { ModelCapabilities } from '../core/registry';
import type { Logger } from '../types/deps';
import type { WarningSink } from './warnings';

export type ImageKind = 'url' | 'base64' | 'data-url';

export interface ResolvedImage {
  kind: ImageKind;
  /** For url/data-url: the full string. For base64: the raw base64 data. */
  data: string;
  mediaType: string;
  /** The https:// URL when kind==='url', otherwise undefined. */
  url?: string;
}

/**
 * `ImagePart` is the canonical carrier for ALL binary media, not just images:
 * the `Part` union is locked in the 1.0 surface (a sixth `file` kind is a
 * breaking change queued for 2.0), so a PDF rides as
 * `{ type:'image', image: bytes, mediaType:'application/pdf' }` (see
 * `src/parts.ts#filePart` and `rag.ts#toNativeDocumentPart`).
 * `resolveMedia` is therefore the classifying resolver adapters should use —
 * it tells them whether to build an image block or a document block.
 */
export interface ResolvedMedia extends ResolvedImage {
  /** False when the media type is anything other than `image/*` (a document). */
  isImage: boolean;
}

const DEFAULT_MEDIA_TYPE = 'image/jpeg';

/** Derive a simple media type from a data URL `data:image/png;base64,...` prefix. */
function mediaTypeFromDataUrl(dataUrl: string): string {
  const m = dataUrl.match(/^data:([^;]+);/);
  return m?.[1] ?? DEFAULT_MEDIA_TYPE;
}

/**
 * Derive media type from a URL path extension, fallback to jpeg.
 *
 * `allowDocuments` exists so `resolveImage` stays byte-for-byte what it was
 * (every extension it does not know is an image) while `resolveMedia` can
 * recognise `.pdf`. Widening the legacy function would silently retype an
 * existing caller's URL.
 */
function mediaTypeFromUrl(url: string, allowDocuments: boolean): string {
  const ext = url.split('?')[0]?.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return allowDocuments ? 'application/pdf' : DEFAULT_MEDIA_TYPE;
    default:
      return DEFAULT_MEDIA_TYPE;
  }
}

/** Edge-safe base64 encoder (TextEncoder → btoa, no Buffer). */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Shared resolution used by both `resolveImage` and `resolveMedia`. */
function resolve(part: ImagePart, allowDocuments: boolean): ResolvedImage {
  const mediaType = part.mediaType ?? DEFAULT_MEDIA_TYPE;

  if (part.image instanceof Uint8Array) {
    return { kind: 'base64', data: uint8ToBase64(part.image), mediaType };
  }

  const src = part.image;

  if (src.startsWith('data:')) {
    // data:image/png;base64,iVBOR...
    const base64 = src.split(',')[1] ?? '';
    return { kind: 'data-url', data: base64, mediaType: mediaTypeFromDataUrl(src) };
  }

  if (src.startsWith('http://') || src.startsWith('https://')) {
    return {
      kind: 'url',
      data: src,
      url: src,
      mediaType: part.mediaType ?? mediaTypeFromUrl(src, allowDocuments),
    };
  }

  // Raw base64 string
  return { kind: 'base64', data: src, mediaType };
}

/**
 * Resolve an `ImagePart` into a normalised descriptor adapters can use.
 *
 * Kept for callers that only ever deal with images; new code should prefer
 * `resolveMedia`, which additionally classifies documents.
 */
export function resolveImage(part: ImagePart): ResolvedImage {
  return resolve(part, false);
}

/**
 * Resolve an `ImagePart` and classify it as image vs document.
 *
 * A caller-supplied `mediaType` is ALWAYS honoured (no more silently
 * defaulting a PDF to `image/jpeg`); only when nothing is known do we fall
 * back to the historical `image/jpeg`.
 */
export function resolveMedia(part: ImagePart): ResolvedMedia {
  const resolved = resolve(part, true);
  return { ...resolved, isImage: resolved.mediaType.startsWith('image/') };
}

/** Build an OpenAI-style `image_url` value (https or data: URL). */
export function toOpenAIImageUrl(img: ResolvedImage): string {
  if (img.kind === 'url') return img.data;
  return `data:${img.mediaType};base64,${img.data}`;
}

/** Inline `data:` URL for a resolved document (the `file_data` wire form). */
export function toDataUrl(media: ResolvedImage): string {
  return `data:${media.mediaType};base64,${media.data}`;
}

/** Common media type → file extension. Anything unlisted derives from the subtype. */
const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * A filename some wires (Chat Completions `file`, Responses `input_file`)
 * require. DETERMINISTIC by design: derived from the media type only — a clock
 * or `Math.random()` would both break edge purity AND poison prompt caching by
 * changing the request body on every call.
 */
export function documentFilename(mediaType: string): string {
  const known = EXTENSIONS[mediaType];
  if (known) return `document.${known}`;
  const subtype =
    mediaType
      .split('/')[1]
      ?.split('+')
      .pop()
      ?.replace(/[^a-z0-9]/gi, '') ?? '';
  return `document.${subtype.toLowerCase() || 'bin'}`;
}

/**
 * Can this model be sent a non-image document block on its wire?
 *
 * `caps.nativePdf` was a DEAD FLAG before 1.9: it is set only on the Gemini
 * NATIVE rows, yet Anthropic (`document`), OpenAI Responses (`input_file`) and
 * Chat Completions (`file`) all have a document channel too. On those three
 * wires document ingestion is part of the multimodal path, so a vision-capable
 * row can carry it; a text-only slug 400s. Hence `nativePdf || vision` — and an
 * unknown slug (conservative row: both false) is refused LOUDLY instead of
 * being sent a block the API will reject.
 */
export function acceptsDocuments(caps: Pick<ModelCapabilities, 'nativePdf' | 'vision'>): boolean {
  return caps.nativePdf || caps.vision;
}

/**
 * Make a dropped document VISIBLE. Same rationale as the Chat Completions
 * hosted-tool drop: a silently removed PDF looks exactly like a model that
 * ignored the attachment. `console.*` is banned in core, so the injected
 * `ctx.logger` seam is one channel — and since 1.9 the per-call `warnings` sink
 * is the other, so the drop also lands on the RESULT (`warnings`) and on
 * `fullStream` as a `warning` part instead of only in a log the app may never
 * have wired (the default logger is a no-op).
 *
 * `type: 'other'` is deliberate: `CallWarning.type` has no content member (the
 * union is locked and append-only), and 'other' is its documented escape hatch —
 * a dropped attachment is neither a setting nor a tool.
 *
 * The `logger?.warn` line is UNCHANGED, in its pre-1.9 shape (provider/modelId/
 * mediaType fields), and the sink records QUIETLY on top of it: one drop must
 * still produce exactly ONE log line for a log-based workflow.
 */
export function warnDroppedDocument(
  logger: Logger | undefined,
  info: { provider: string; modelId: string; mediaType: string; reason: string },
  warnings?: WarningSink,
): void {
  const message =
    `Dropped a '${info.mediaType}' document: ${info.reason}, ` +
    `so ${info.provider}/${info.modelId} will answer without it.`;
  logger?.warn(message, {
    provider: info.provider,
    modelId: info.modelId,
    mediaType: info.mediaType,
  });
  // Already logged just above — record only, do not mirror.
  warnings?.add({ type: 'other', message }, { mirror: false });
}
