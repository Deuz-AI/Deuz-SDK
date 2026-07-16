/**
 * Secret redaction (P0). Anything that can flow into a logger, error message,
 * tracer attribute, or `cause` chain must pass through here first. The "key is
 * never logged" guarantee is regression-tested in Faz 1.E.
 */

/** Header names whose values must always be masked. */
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']);

/** Token shapes that look like credentials wherever they appear in free text. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g, // Anthropic
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / xAI
  /AIza[A-Za-z0-9_-]{10,}/g, // Google
  /Bearer\s+[A-Za-z0-9._-]+/gi, // bearer tokens
];

/** Keep the last `keep` chars, mask the rest: `sk-…AB12` style. */
export function maskSecret(value: string, keep = 4): string {
  if (value.length <= keep) return '****';
  return `****${value.slice(-keep)}`;
}

/** Redact secret-looking substrings from an arbitrary string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => maskSecret(match));
  }
  return out;
}

/** Redact a headers bag (object or `Headers`) into a safe, loggable record. */
export function redactHeaders(headers: HeadersInit | Headers | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!headers) return safe;
  const entries: Iterable<[string, string]> =
    headers instanceof Headers
      ? headers.entries()
      : Array.isArray(headers)
        ? (headers as [string, string][])
        : Object.entries(headers as Record<string, string>);
  for (const [key, value] of entries) {
    safe[key] = SECRET_HEADERS.has(key.toLowerCase()) ? maskSecret(value) : redactString(value);
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Observation profile (1.6). Observe events can leave the process (JSONL,
// remote sinks), so this profile is stricter than the log profile above: a
// wider key list, JWT/PEM patterns, and a full '[REDACTED]' replacement with
// NO trailing chars. It is ADDITIVE — `maskSecret`'s last-4 output is pinned
// by P0 regression tests and must not change.
// ---------------------------------------------------------------------------

export const OBSERVE_REDACTED = '[REDACTED]';

/** Key names (case-insensitive) whose values are always fully redacted in observe payloads. */
const OBSERVE_SECRET_KEYS = new Set([
  ...SECRET_HEADERS,
  'proxy-authorization',
  'apikey',
  'api_key',
  'token',
  'access-token',
  'refresh-token',
  'secret',
  'client-secret',
  'password',
  'cookie',
  'set-cookie',
  'private-key',
]);

const OBSERVE_SECRET_PATTERNS: RegExp[] = [
  ...SECRET_PATTERNS,
  // JWT: three base64url segments — the eyJ prefix pins a JSON header. No
  // LEADING \b: a token embedded flush against alphanumerics (…xxxeyJ…) must
  // still redact — over-matching is the safe side for an observation profile.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // PEM private-key blocks (multi-line).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace secret-looking substrings with '[REDACTED]' (observe profile). */
export function redactObservationString(input: string): string {
  let out = input;
  for (const pattern of OBSERVE_SECRET_PATTERNS) {
    out = out.replace(pattern, OBSERVE_REDACTED);
  }
  return out;
}

/**
 * Deep-redact a value for observation payloads. Secret keys are replaced
 * wholesale (whatever the value type); strings pass the pattern sweep.
 * Cycle-safe: revisited objects become '[Unserializable]' (the runtime's
 * degradation marker) rather than recursing.
 */
export function redactForObservation(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactObservationString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Unserializable]';
    seen.add(value);
    return value.map((v) => redactForObservation(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Unserializable]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = OBSERVE_SECRET_KEYS.has(k.toLowerCase())
        ? OBSERVE_REDACTED
        : redactForObservation(v, seen);
    }
    return out;
  }
  return value;
}

/** Deep-redact a value for safe structured logging (strings/arrays/objects). */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        SECRET_HEADERS.has(k.toLowerCase()) && typeof v === 'string'
          ? maskSecret(v)
          : redactValue(v);
    }
    return out;
  }
  return value;
}
