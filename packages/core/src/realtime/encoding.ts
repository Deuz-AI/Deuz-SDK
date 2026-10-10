/**
 * realtime/encoding.ts — the small, pure helpers the realtime mapping modules
 * share: base64 for audio frames, a plain-object deep merge for
 * `providerOptions`, and tolerant readers for untrusted wire JSON.
 * Web APIs only (`btoa`/`atob`/`TextDecoder`): edge-safe.
 */

// --- audio bytes --------------------------------------------------------------

/** View any binary input as bytes, without copying. */
export function toBytes(audio: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (audio instanceof Uint8Array) return audio;
  if (ArrayBuffer.isView(audio))
    return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  return new Uint8Array(audio);
}

/** One `String.fromCharCode` call per chunk keeps large frames off the argument limit. */
const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// --- objects ------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Merge `override` into a copy of `base`: plain objects merge recursively,
 * everything else (arrays, scalars, `null`) replaces. `undefined` is skipped,
 * so an absent option never erases a mapped field.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

// --- tolerant wire readers ------------------------------------------------------

/** The value as an object, or an empty one — wire JSON is never trusted to be well-formed. */
export function obj(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A non-negative finite count, else 0. */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
