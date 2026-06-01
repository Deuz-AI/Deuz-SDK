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
