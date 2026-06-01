import type { ImagePart } from '../types/message';

export type ImageKind = 'url' | 'base64' | 'data-url';

export interface ResolvedImage {
  kind: ImageKind;
  /** For url/data-url: the full string. For base64: the raw base64 data. */
  data: string;
  mediaType: string;
  /** The https:// URL when kind==='url', otherwise undefined. */
  url?: string;
}

const DEFAULT_MEDIA_TYPE = 'image/jpeg';

/** Derive a simple media type from a data URL `data:image/png;base64,...` prefix. */
function mediaTypeFromDataUrl(dataUrl: string): string {
  const m = dataUrl.match(/^data:([^;]+);/);
  return m?.[1] ?? DEFAULT_MEDIA_TYPE;
}

/** Derive media type from a URL path extension, fallback to jpeg. */
function mediaTypeFromUrl(url: string): string {
  const ext = url.split('?')[0]?.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
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

/** Resolve an `ImagePart` into a normalised descriptor adapters can use. */
export function resolveImage(part: ImagePart): ResolvedImage {
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
    return { kind: 'url', data: src, url: src, mediaType: part.mediaType ?? mediaTypeFromUrl(src) };
  }

  // Raw base64 string
  return { kind: 'base64', data: src, mediaType };
}

/** Build an OpenAI-style `image_url` value (https or data: URL). */
export function toOpenAIImageUrl(img: ResolvedImage): string {
  if (img.kind === 'url') return img.data;
  return `data:${img.mediaType};base64,${img.data}`;
}
