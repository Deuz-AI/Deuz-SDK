/**
 * Zero-dep tolerant partial-JSON parser for `streamObject`.
 *
 * Best-effort parse of a JSON *prefix* as it streams in: unclosed objects and
 * arrays are completed, unterminated strings become truncated string values,
 * numbers trim to their longest valid prefix, dangling object keys and literal
 * prefixes (`tru`) are dropped. NEVER throws — malformed input stops at the
 * malformed point and returns whatever parsed before it (or `undefined` when
 * nothing is emittable yet).
 *
 * Called once per text-delta over the full accumulated buffer, so the stream
 * as a whole is O(n²) worst case — accepted: payloads are bounded by a single
 * model response.
 */

/** Recursion cap for adversarially nested input (the fast path handles valid deep JSON). */
const MAX_DEPTH = 64;

export interface PartialParseResult {
  value: unknown;
  /** True only when the input was a complete, valid JSON document. */
  complete: boolean;
}

interface Parsed {
  v: unknown;
}

interface ParsedString {
  v: string;
  /** False when the closing quote never arrived (truncated stream). */
  closed: boolean;
}

export function parsePartialJson(text: string): PartialParseResult | undefined {
  // Fast path: the buffer is already a complete document.
  try {
    return { value: JSON.parse(text) as unknown, complete: true };
  } catch {
    // Tolerant path below.
  }

  const s = text;
  let i = 0;

  const ws = (): void => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  };

  /** Decode one full escape sequence (`\n`, `\uXXXX`, …); undefined if invalid. */
  const decodeEscape = (esc: string): string | undefined => {
    try {
      return JSON.parse(`"${esc}"`) as string;
    } catch {
      return undefined;
    }
  };

  function parseString(): ParsedString {
    i++; // opening quote
    let out = '';
    while (i < s.length) {
      const c = s[i]!;
      if (c === '"') {
        i++;
        return { v: out, closed: true };
      }
      if (c === '\\') {
        const len = s[i + 1] === 'u' ? 6 : 2;
        if (i + len > s.length) {
          // Incomplete escape at the cut point — drop it from the truncated value.
          i = s.length;
          break;
        }
        const dec = decodeEscape(s.slice(i, i + len));
        if (dec === undefined) {
          i = s.length; // invalid escape — stop, keep what decoded so far
          break;
        }
        out += dec;
        i += len;
        continue;
      }
      out += c;
      i++;
    }
    return { v: out, closed: false };
  }

  function parseNumber(): Parsed | undefined {
    const start = i;
    while (i < s.length && /[-+0-9.eE]/.test(s[i]!)) i++;
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(start, i));
    if (!match) return undefined; // e.g. a lone '-'
    return { v: Number(match[0]) };
  }

  function parseLiteral(): Parsed | undefined {
    const rest = s.slice(i);
    for (const [word, val] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (rest.startsWith(word)) {
        i += word.length;
        return { v: val };
      }
      if (word.startsWith(rest)) {
        // Strict prefix of a literal at the cut point — nothing emittable.
        i = s.length;
        return undefined;
      }
    }
    return undefined; // malformed — stop here
  }

  function parseObject(depth: number): Parsed {
    i++; // '{'
    const out: Record<string, unknown> = {};
    for (;;) {
      ws();
      if (i >= s.length) break;
      const c = s[i]!;
      if (c === '}') {
        i++;
        break;
      }
      if (c === ',') {
        i++;
        continue;
      }
      if (c !== '"') break; // malformed key — stop
      const key = parseString();
      if (!key.closed) break; // dangling key — drop the pair
      ws();
      if (i >= s.length || s[i] !== ':') break;
      i++;
      const val = parseValue(depth + 1);
      if (val === undefined) break; // dangling value — drop the key
      out[key.v] = val.v;
    }
    return { v: out };
  }

  function parseArray(depth: number): Parsed {
    i++; // '['
    const out: unknown[] = [];
    for (;;) {
      ws();
      if (i >= s.length) break;
      const c = s[i]!;
      if (c === ']') {
        i++;
        break;
      }
      if (c === ',') {
        i++;
        continue;
      }
      const val = parseValue(depth + 1);
      if (val === undefined) break;
      out.push(val.v);
    }
    return { v: out };
  }

  function parseValue(depth: number): Parsed | undefined {
    ws();
    if (i >= s.length || depth > MAX_DEPTH) return undefined;
    const c = s[i]!;
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === '"') {
      const str = parseString();
      return { v: str.v };
    }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    return parseLiteral();
  }

  const result = parseValue(0);
  return result === undefined ? undefined : { value: result.v, complete: false };
}
