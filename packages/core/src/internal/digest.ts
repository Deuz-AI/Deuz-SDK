/**
 * The 2.4 digest convention, in one place: `sha256:` and the lower-case hex
 * SHA-256 (the form goal evidence and the ops claim keys already use), computed
 * with WebCrypto, so it is edge-safe. Structured content is hashed as canonical
 * JSON. The workspace-entry algorithm is shared by `digestWorkspace` and the
 * Docker runner's artifacts, so the same files give the same digest whichever
 * of them read the files.
 *
 * Every function here is pure apart from `crypto.subtle`, and the format is a
 * persisted contract: a digest stored in a 2.4 record must still match after
 * an upgrade. Change nothing here without a new algorithm name.
 */

/** A SHA-256 digest: `sha256:` and 64 lower-case hex digits. */
export type Sha256Digest = `sha256:${string}`;

/**
 * The name of the workspace-entry algorithm, part of what it hashes. A later
 * algorithm gets a new name and leaves this one as it is.
 */
export const WORKSPACE_DIGEST_ALGORITHM = 'deuz-workspace-v1';

const encoder = new TextEncoder();
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function utf8(data: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
}

/** The lower-case hex SHA-256 of `data` (a string is hashed as UTF-8). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(data)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** `sha256:<hex>` of `data` (a string is hashed as UTF-8). */
export async function sha256Digest(data: string | Uint8Array): Promise<Sha256Digest> {
  return `sha256:${await sha256Hex(data)}`;
}

/** Whether `value` is a well-formed `sha256:<64 lower-case hex>` digest. */
export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function encode(value: unknown, path: string, open: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`Canonical JSON has no non-finite numbers (at ${path})`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Canonical JSON cannot encode a ${typeof value} (at ${path})`);
  }
  if (open.has(value)) throw new TypeError(`Canonical JSON cannot encode a cycle (at ${path})`);
  if (Array.isArray(value)) {
    open.add(value);
    const items = value.map((item, index) => {
      if (item === undefined)
        throw new TypeError(`Canonical JSON has no undefined array items (at ${path}[${index}])`);
      return encode(item, `${path}[${index}]`, open);
    });
    open.delete(value);
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value))
    throw new TypeError(`Canonical JSON encodes only plain objects and arrays (at ${path})`);
  open.add(value);
  const record = value as Record<string, unknown>;
  // RFC 8785 orders members by UTF-16 code unit, which is what the default
  // string comparison does; localeCompare would vary by runtime.
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    members.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`, open)}`);
  }
  open.delete(value);
  return `{${members.join(',')}}`;
}

/**
 * The canonical JSON of `value` (RFC 8785 ordering): no whitespace, object
 * members sorted by UTF-16 code unit at every depth, strings and numbers as
 * `JSON.stringify` writes them. A member whose value is `undefined` is left
 * out, so an absent optional field encodes like a missing one.
 *
 * Throws a TypeError for anything JSON would change or drop silently: a
 * non-finite number, a bigint, a function or symbol, `undefined` at the top or
 * in an array, a cycle, or an object that is not a plain object or array
 * (a `Date`, `Map`, typed array or class instance). Hash bytes yourself.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('Canonical JSON cannot encode undefined');
  return encode(value, '$', new Set());
}

/** `sha256:<hex>` of the canonical JSON of `value`; throws as `canonicalJson` does. */
export async function digestJson(value: unknown): Promise<Sha256Digest> {
  return sha256Digest(canonicalJson(value));
}

/** One file of a workspace digest: its path, byte size and content digest. */
export interface WorkspaceDigestEntry {
  /** A normalized relative path: forward slashes, no `.`/`..` or empty segment. */
  readonly path: string;
  /** The content's length in bytes (UTF-8 for text). */
  readonly size: number;
  /** `sha256:<hex>` of the content. */
  readonly digest: Sha256Digest;
}

function assertDigestPath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    path === '' ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new TypeError(
      `A workspace digest path must be a normalized relative path, got ${JSON.stringify(path)}`,
    );
}

/**
 * Orders two paths by the bytes of their UTF-8 encoding (code point order),
 * which is what `LC_ALL=C sort` gives, so a digest can be rebuilt with shell
 * tools.
 */
export function compareDigestPaths(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** The digest entry for one file: `path` must be a normalized relative path. */
export async function workspaceDigestEntry(
  path: string,
  content: string | Uint8Array,
): Promise<WorkspaceDigestEntry> {
  assertDigestPath(path);
  const bytes = utf8(content);
  return { path, size: bytes.byteLength, digest: await sha256Digest(bytes) };
}

/**
 * The digest of a set of files (2.4, `deuz-workspace-v1`): the entries sorted
 * by path in UTF-8 byte order, then `sha256:<hex>` of the canonical JSON of
 * `{ algorithm: 'deuz-workspace-v1', entries: [{ path, size, digest }, ...] }`.
 * The order entries are given in does not matter; a repeated path, a malformed
 * path, size or digest throws a TypeError. No entries is a valid, empty set.
 */
export async function digestWorkspaceEntries(
  entries: readonly WorkspaceDigestEntry[],
): Promise<Sha256Digest> {
  const sorted = entries
    .map((entry) => {
      assertDigestPath(entry.path);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0)
        throw new TypeError(`Workspace digest entry ${entry.path} has a malformed size`);
      if (!isSha256Digest(entry.digest))
        throw new TypeError(`Workspace digest entry ${entry.path} has a malformed digest`);
      return { path: entry.path, size: entry.size, digest: entry.digest };
    })
    .sort((left, right) => compareDigestPaths(left.path, right.path));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.path === sorted[index - 1]!.path)
      throw new TypeError(`Workspace digest entries repeat the path ${sorted[index]!.path}`);
  }
  return digestJson({ algorithm: WORKSPACE_DIGEST_ALGORITHM, entries: sorted });
}
