/**
 * memory-markdown.ts — Node-only Obsidian-style markdown `MemoryStore` backend.
 * Exported as `@deuz-sdk/core/memory/markdown` (NOT bundled into edge-safe core).
 *
 * HYBRID design (the research-recommended sweet spot): the markdown files are the
 * human-readable, git-versionable source of truth — one `<id>.md` per record with
 * YAML frontmatter + body text + Obsidian `[[wikilinks]]`. Embeddings (when a
 * record carries one) live in a hidden sidecar `.deuz-vectors.json` so the `.md`
 * files stay clean for Obsidian's property UI. `search()` does cosine ranking
 * when a query embedding + stored vectors are available, otherwise falls back to
 * grep/full-text — so the SAME store works with or without an embedder.
 *
 * Reuses the pure helpers (`matchesScope` / `cosineSimilarity`) from
 * `@deuz-sdk/core/memory` so semantics match the in-memory reference store.
 */
import {
  cosineSimilarity,
  matchesScope,
  type MemoryHit,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
} from './memory';

interface NodeFs {
  mkdir(path: string, opts: { recursive: true }): Promise<string | undefined>;
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, opts: { force: true }): Promise<void>;
}
interface NodePath {
  join(...parts: string[]): string;
}

async function load(): Promise<{ fs: NodeFs; path: NodePath }> {
  try {
    // `as string` keeps tsup's dts builder from statically resolving node: builtins.
    const fs = (await import('node:fs/promises' as string)) as unknown as NodeFs;
    const path = (await import('node:path' as string)) as unknown as NodePath;
    return { fs, path };
  } catch (err) {
    throw new Error('createMarkdownMemoryStore requires a Node runtime (node:fs/promises).', {
      cause: err,
    });
  }
}

const VECTORS_FILE = '.deuz-vectors.json';

/** A record's filename — uuids from generateId() are already filesystem-safe. */
function fileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`;
}

// --- frontmatter (de)serialization — focused subset; we own both ends ---

function serializeValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v); // quote to survive ':' / '#'
  if (Array.isArray(v)) {
    const items = v.filter((x) => typeof x === 'string' || typeof x === 'number');
    return `[${items.map((x) => (typeof x === 'string' ? JSON.stringify(x) : String(x))).join(', ')}]`;
  }
  return undefined;
}

function serializeRecord(rec: MemoryRecord): string {
  const fm: Record<string, unknown> = {
    id: rec.id,
    hash: rec.hash,
    kind: rec.kind,
    userId: rec.scope.userId,
    agentId: rec.scope.agentId,
    runId: rec.scope.runId,
    actorId: rec.scope.actorId,
    chatId: rec.scope.chatId,
    importance: rec.importance,
    embeddingModelId: rec.embeddingModelId,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastAccessedAt: rec.lastAccessedAt,
    expiresAt: rec.expiresAt,
    validAt: rec.validAt,
    invalidAt: rec.invalidAt,
  };
  // Fold metadata (tags, links, source, …) into frontmatter — scalars + string arrays.
  if (rec.metadata) {
    for (const [k, v] of Object.entries(rec.metadata)) {
      if (!(k in fm)) fm[k] = v;
    }
  }
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    const s = serializeValue(v);
    if (s !== undefined) lines.push(`${k}: ${s}`);
  }
  lines.push('---', '', rec.text, '');
  return lines.join('\n');
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v); // ints AND floats (e.g. importance 0.5)
  if (v.startsWith('"') || v.startsWith("'")) {
    try {
      return JSON.parse(v.replace(/^'|'$/g, '"'));
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

const TYPED_KEYS = new Set([
  'id',
  'hash',
  'kind',
  'userId',
  'agentId',
  'runId',
  'actorId',
  'chatId',
  'importance',
  'embeddingModelId',
  'createdAt',
  'updatedAt',
  'lastAccessedAt',
  'expiresAt',
  'validAt',
  'invalidAt',
]);

function deserializeRecord(text: string): MemoryRecord | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = parseScalar(kv[2]!);
  }
  const body = (m[2] ?? '').trim();
  const scope: MemoryScope = {};
  if (fm.userId !== undefined) scope.userId = String(fm.userId);
  if (fm.agentId !== undefined) scope.agentId = String(fm.agentId);
  if (fm.runId !== undefined) scope.runId = String(fm.runId);
  if (fm.actorId !== undefined) scope.actorId = String(fm.actorId);
  if (fm.chatId !== undefined) scope.chatId = String(fm.chatId);

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!TYPED_KEYS.has(k)) metadata[k] = v;

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const rec: MemoryRecord = {
    id: String(fm.id ?? ''),
    text: body,
    hash: String(fm.hash ?? ''),
    kind: (fm.kind as MemoryKind) ?? 'semantic',
    scope,
    createdAt: num(fm.createdAt) ?? 0,
    updatedAt: num(fm.updatedAt) ?? 0,
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(num(fm.importance) !== undefined ? { importance: num(fm.importance) } : {}),
    ...(fm.embeddingModelId !== undefined ? { embeddingModelId: String(fm.embeddingModelId) } : {}),
    ...(num(fm.lastAccessedAt) !== undefined ? { lastAccessedAt: num(fm.lastAccessedAt) } : {}),
    ...(num(fm.expiresAt) !== undefined ? { expiresAt: num(fm.expiresAt) } : {}),
    ...(num(fm.validAt) !== undefined ? { validAt: num(fm.validAt) } : {}),
    ...(fm.invalidAt != null ? { invalidAt: num(fm.invalidAt) ?? null } : {}),
  };
  if (!rec.id) return null;
  return rec;
}

export interface MarkdownMemoryStoreOptions {
  /** Directory holding the `<id>.md` files (created if missing). */
  dir: string;
  /**
   * Maintain the hidden `.deuz-vectors.json` sidecar so embeddings persist and
   * `search()` can do cosine ranking (hybrid). Default true. Set false for a
   * pure grep/markdown store with no vector index.
   */
  vectors?: boolean;
}

/**
 * Obsidian-style markdown `MemoryStore`. One `.md` file per record; optional
 * embedding sidecar for hybrid semantic search.
 */
export function createMarkdownMemoryStore(opts: MarkdownMemoryStoreOptions): MemoryStore {
  const useVectors = opts.vectors !== false;
  let vectorCache: Map<string, number[]> | undefined;

  async function ensureDir(): Promise<{ fs: NodeFs; path: NodePath }> {
    const io = await load();
    await io.fs.mkdir(opts.dir, { recursive: true });
    return io;
  }

  async function loadVectors(io: { fs: NodeFs; path: NodePath }): Promise<Map<string, number[]>> {
    if (vectorCache) return vectorCache;
    if (!useVectors) return (vectorCache = new Map());
    try {
      const raw = await io.fs.readFile(io.path.join(opts.dir, VECTORS_FILE), 'utf-8');
      vectorCache = new Map(Object.entries(JSON.parse(raw) as Record<string, number[]>));
    } catch {
      vectorCache = new Map();
    }
    return vectorCache;
  }

  async function saveVectors(io: { fs: NodeFs; path: NodePath }): Promise<void> {
    if (!useVectors || !vectorCache) return;
    const obj = Object.fromEntries(vectorCache);
    await io.fs.writeFile(io.path.join(opts.dir, VECTORS_FILE), JSON.stringify(obj), 'utf-8');
  }

  async function readAll(io: { fs: NodeFs; path: NodePath }): Promise<MemoryRecord[]> {
    let names: string[];
    try {
      names = await io.fs.readdir(opts.dir);
    } catch {
      return [];
    }
    const out: MemoryRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      try {
        const text = await io.fs.readFile(io.path.join(opts.dir, name), 'utf-8');
        const rec = deserializeRecord(text);
        if (rec) out.push(rec);
      } catch {
        /* skip unreadable file */
      }
    }
    return out;
  }

  return {
    async upsert(records) {
      const io = await ensureDir();
      const vectors = await loadVectors(io);
      for (const rec of records) {
        await io.fs.writeFile(
          io.path.join(opts.dir, fileName(rec.id)),
          serializeRecord(rec),
          'utf-8',
        );
        if (useVectors && rec.embedding) vectors.set(rec.id, rec.embedding);
      }
      await saveVectors(io);
    },

    async get(id, scope) {
      const io = await load();
      try {
        const text = await io.fs.readFile(io.path.join(opts.dir, fileName(id)), 'utf-8');
        const rec = deserializeRecord(text);
        if (!rec) return null;
        if (scope && !matchesScope(rec, scope)) return null;
        return rec;
      } catch {
        return null;
      }
    },

    async search(query) {
      const io = await load();
      const [all, vectors] = await Promise.all([readAll(io), loadVectors(io)]);
      const topK = query.topK ?? 5;
      const candidates = all.filter(
        (r) =>
          matchesScope(r, query.scope) &&
          (query.kind ? r.kind === query.kind : true) &&
          r.invalidAt == null,
      );
      let scored: MemoryHit[];
      if (query.embedding && useVectors) {
        scored = candidates.map((r) => {
          const vec = r.embedding ?? vectors.get(r.id);
          return { record: r, score: vec ? cosineSimilarity(query.embedding!, vec) : 0 };
        });
      } else if (query.text) {
        const q = query.text.toLowerCase();
        scored = candidates
          .map((r) => ({ record: r, score: r.text.toLowerCase().includes(q) ? 1 : 0 }))
          .filter((h) => h.score > 0); // grep: drop non-matches
      } else {
        scored = candidates.map((r) => ({ record: r, score: 0 }));
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    },

    async list(scope, listOpts) {
      const io = await load();
      const all = await readAll(io);
      const out = all.filter(
        (r) =>
          matchesScope(r, scope) &&
          (listOpts?.kind ? r.kind === listOpts.kind : true) &&
          r.invalidAt == null,
      );
      return listOpts?.limit ? out.slice(0, listOpts.limit) : out;
    },

    async delete(ids) {
      const io = await ensureDir();
      const vectors = await loadVectors(io);
      for (const id of ids) {
        await io.fs.rm(io.path.join(opts.dir, fileName(id)), { force: true });
        vectors.delete(id);
      }
      await saveVectors(io);
    },

    async update(id, patch) {
      const io = await ensureDir();
      try {
        const text = await io.fs.readFile(io.path.join(opts.dir, fileName(id)), 'utf-8');
        const rec = deserializeRecord(text);
        if (!rec) return;
        const merged = { ...rec, ...patch } as MemoryRecord;
        await io.fs.writeFile(
          io.path.join(opts.dir, fileName(id)),
          serializeRecord(merged),
          'utf-8',
        );
        if (useVectors && patch.embedding) {
          const vectors = await loadVectors(io);
          vectors.set(id, patch.embedding);
          await saveVectors(io);
        }
      } catch {
        /* nothing to update */
      }
    },
  };
}

export { serializeRecord as _serializeRecord, deserializeRecord as _deserializeRecord };
