/**
 * store-postgres.test.ts — the Postgres store pack, driven by a FAKE driver.
 *
 * No real Postgres, no container, no network: `createFakePg()` below is a small
 * in-memory SQL interpreter that speaks the exact dialect `store-postgres.ts`
 * emits. It is deliberately more than a stub —
 *
 * - it stores ROWS in a Map per table and evaluates WHERE / ORDER BY / LIMIT,
 *   so the three shared contract suites (`test/fixtures/store-conformance.ts`)
 *   run against it exactly as they run against the in-memory reference;
 * - it mimics the `pg` driver's WIRE TYPES — `BIGINT` comes back as a STRING,
 *   `jsonb` as a parsed object, `float8[]` as an array — which is the single
 *   most common way a hand-written Postgres adapter is silently wrong;
 * - it THROWS on any syntax it does not recognize, so a query shape that drifts
 *   fails loudly here instead of passing on a stub that returns `[]`.
 *
 * Everything the fake cannot judge — that `<=>` really is cosine distance, that
 * HNSW really indexes it — is asserted on the SQL TEXT instead.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPostgresStores, type PgClientLike } from '../src/node/store-postgres';
import { InvalidRequestError } from '../src/errors';
import { cosineSimilarity } from '../src/internal/vector';
import type { MemoryRecord, MemoryScope } from '../src/memory';
import type { RunRecord } from '../src/types/runtime';
import {
  assertMemoryStoreContract,
  assertPersistentMemoryStoreContract,
  assertChatStoreContract,
  assertSessionStoreContract,
} from './fixtures/store-conformance';

// ===================================================================
// The fake driver
// ===================================================================

type Row = Record<string, unknown>;

/** Wire types per table — what a real `pg` hands back for each column. */
const COLUMN_TYPES: Record<string, Record<string, 'bigint' | 'json' | 'float8[]'>> = {
  deuz_memory: {
    created_at: 'bigint',
    updated_at: 'bigint',
    last_accessed_at: 'bigint',
    expires_at: 'bigint',
    valid_at: 'bigint',
    invalid_at: 'bigint',
    metadata: 'json',
    embedding_json: 'float8[]',
  },
  deuz_chats: { updated_at: 'bigint' },
  deuz_sessions: { created_at: 'bigint' },
  deuz_runs: { created_at: 'bigint', updated_at: 'bigint', record: 'json' },
  deuz_meta: {},
  pg_extension: {},
};

const PRIMARY_KEYS: Record<string, string> = {
  deuz_memory: 'id',
  deuz_chats: 'chat_id',
  deuz_sessions: 'run_id',
  deuz_runs: 'run_id',
  deuz_meta: 'key',
  pg_extension: 'extname',
};

export interface FakePgClient extends PgClientLike {
  /** Every statement the adapter sent, whitespace-normalized, with its params. */
  calls: { sql: string; params: unknown[] }[];
  /** Statement texts only — handy for `.some(...)` / `.filter(...)` assertions. */
  texts(): string[];
  /** Statements from the multi-statement migration batch, split apart. */
  ddl(): string[];
  rows(table: string): Row[];
  seed(table: string, rows: Row[]): void;
  /** Make the next `query` reject once (transient-failure simulation). */
  failNext(error: Error): void;
}

function bare(table: string): string {
  return table.includes('.') ? table.slice(table.lastIndexOf('.') + 1) : table;
}

function coerce(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (COLUMN_TYPES[bare(table)]?.[column]) {
    // int8 overflows a JS number, so node-pg returns it as text.
    case 'bigint':
      return String(value);
    case 'json':
      return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)) as unknown;
    case 'float8[]':
      return Array.isArray(value) ? [...(value as number[])] : value;
    default:
      return value;
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** LIKE pattern → RegExp, honoring backslash escapes (the default ESCAPE char). */
function likeToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[++i];
      if (next !== undefined) out += escapeRe(next);
      continue;
    }
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += escapeRe(ch);
  }
  return new RegExp(`^${out}$`, 'i');
}

function parseVector(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  return JSON.parse(value) as number[];
}

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function createFakePg(
  options: {
    vectorExtension?: boolean;
    /** Width of an ALREADY-EXISTING `deuz_memory.embedding` column, if any. */
    existingVectorDimensions?: number;
  } = {},
): FakePgClient {
  const tables = new Map<string, Map<string, Row>>();
  const calls: { sql: string; params: unknown[] }[] = [];
  let pendingFailure: Error | undefined;

  const table = (name: string): Map<string, Row> => {
    const key = bare(name);
    let rows = tables.get(key);
    if (!rows) tables.set(key, (rows = new Map()));
    return rows;
  };

  if (options.vectorExtension) table('pg_extension').set('vector', { extname: 'vector' });

  // --- WHERE ---------------------------------------------------------------

  const matches = (where: string | undefined, row: Row, params: unknown[]): boolean => {
    if (!where) return true;
    return where.split(' AND ').every((atom) => evalAtom(atom.trim(), row, params));
  };

  const param = (params: unknown[], index: string): unknown => params[Number(index) - 1];

  const evalAtom = (atom: string, row: Row, params: unknown[]): boolean => {
    let m: RegExpExecArray | null;

    // (invalid_at IS NULL OR invalid_at > $3)
    if ((m = /^\(([a-z_]+) IS NULL OR \1 > \$(\d+)\)$/.exec(atom))) {
      const value = row[m[1]!];
      return (
        value === null || value === undefined || numeric(value) > numeric(param(params, m[2]!))
      );
    }
    // COALESCE(valid_at, created_at) <= $3
    if ((m = /^COALESCE\(([a-z_]+), ([a-z_]+)\) <= \$(\d+)$/.exec(atom))) {
      const value = row[m[1]!] ?? row[m[2]!];
      return numeric(value) <= numeric(param(params, m[3]!));
    }
    if ((m = /^([a-z_]+) IS NULL$/.exec(atom))) {
      const value = row[m[1]!];
      return value === null || value === undefined;
    }
    if ((m = /^([a-z_]+) IS NOT NULL$/.exec(atom))) {
      const value = row[m[1]!];
      return value !== null && value !== undefined;
    }
    if ((m = /^([a-z_]+) = ANY\(\$(\d+)\)$/.exec(atom))) {
      const value = row[m[1]!];
      const list = param(params, m[2]!) as unknown[];
      if (!Array.isArray(list)) throw new Error(`fake-pg: ANY() needs an array param: ${atom}`);
      return list.some((v) => value !== null && value !== undefined && String(v) === String(value));
    }
    if ((m = /^([a-z_]+) ILIKE \$(\d+)$/.exec(atom))) {
      const value = row[m[1]!];
      return typeof value === 'string' && likeToRegExp(String(param(params, m[2]!))).test(value);
    }
    if ((m = /^metadata @> \$(\d+)::jsonb$/.exec(atom))) {
      const filter = JSON.parse(String(param(params, m[1]!))) as Record<string, unknown>;
      const value = (row['metadata'] ?? {}) as Record<string, unknown>;
      return Object.entries(filter).every(
        ([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v),
      );
    }
    if ((m = /^([a-z_]+) (<=|>=|<|>) \$(\d+)$/.exec(atom))) {
      const value = row[m[1]!];
      if (value === null || value === undefined) return false;
      const left = numeric(value);
      const right = numeric(param(params, m[3]!));
      return m[2] === '<='
        ? left <= right
        : m[2] === '>='
          ? left >= right
          : m[2] === '<'
            ? left < right
            : left > right;
    }
    if ((m = /^([a-z_]+) = \$(\d+)$/.exec(atom))) {
      const value = row[m[1]!];
      if (value === null || value === undefined) return false;
      return String(value) === String(param(params, m[2]!));
    }
    if ((m = /^([a-z_]+) = '([^']*)'$/.exec(atom))) {
      const value = row[m[1]!];
      return value !== null && value !== undefined && String(value) === m[2];
    }
    throw new Error(`fake-pg: unsupported WHERE atom: ${atom}`);
  };

  // --- SELECT --------------------------------------------------------------

  const project = (list: string, row: Row, params: unknown[]): Row => {
    const out: Row = {};
    for (const raw of list.split(', ')) {
      const item = raw.trim();
      let m: RegExpExecArray | null;
      if (item === '1') {
        out['?column?'] = 1;
        continue;
      }
      if ((m = /^1 - \(embedding <=> \$(\d+)::vector\) AS score$/.exec(item))) {
        const query = parseVector(param(params, m[1]!));
        out['score'] = cosineSimilarity(query, parseVector(row['embedding']));
        continue;
      }
      if (/^[a-z_]+$/.test(item)) {
        out[item] = row[item] ?? null;
        continue;
      }
      throw new Error(`fake-pg: unsupported select item: ${item}`);
    }
    return out;
  };

  const sortRows = (rows: Row[], order: string, params: unknown[]): Row[] => {
    let m: RegExpExecArray | null;
    if ((m = /^embedding <=> \$(\d+)::vector$/.exec(order))) {
      const query = parseVector(param(params, m[1]!));
      // ORDER BY distance ASC — nearest first.
      return [...rows].sort(
        (a, b) =>
          1 -
          cosineSimilarity(query, parseVector(a['embedding'])) -
          (1 - cosineSimilarity(query, parseVector(b['embedding']))),
      );
    }
    if ((m = /^([a-z_]+) (ASC|DESC)$/.exec(order))) {
      const column = m[1]!;
      const sign = m[2] === 'DESC' ? -1 : 1;
      return [...rows].sort((a, b) => sign * (numeric(a[column]) - numeric(b[column])));
    }
    throw new Error(`fake-pg: unsupported ORDER BY: ${order}`);
  };

  const runSelect = (sql: string, params: unknown[]): Row[] => {
    const fromIdx = sql.indexOf(' FROM ');
    const list = sql.slice('SELECT '.length, fromIdx);
    let rest = sql.slice(fromIdx + ' FROM '.length);
    let limit: string | undefined;
    let order: string | undefined;
    let where: string | undefined;
    const limitIdx = rest.indexOf(' LIMIT ');
    if (limitIdx >= 0) {
      limit = rest.slice(limitIdx + ' LIMIT '.length);
      rest = rest.slice(0, limitIdx);
    }
    const orderIdx = rest.indexOf(' ORDER BY ');
    if (orderIdx >= 0) {
      order = rest.slice(orderIdx + ' ORDER BY '.length);
      rest = rest.slice(0, orderIdx);
    }
    const whereIdx = rest.indexOf(' WHERE ');
    if (whereIdx >= 0) {
      where = rest.slice(whereIdx + ' WHERE '.length);
      rest = rest.slice(0, whereIdx);
    }

    let rows = [...table(rest.trim()).values()].filter((row) => matches(where, row, params));
    if (order) rows = sortRows(rows, order, params);
    if (limit !== undefined) {
      const n = limit.startsWith('$') ? numeric(param(params, limit.slice(1))) : Number(limit);
      rows = rows.slice(0, n);
    }
    return rows.map((row) => project(list, row, params));
  };

  // --- INSERT / UPDATE / DELETE -------------------------------------------

  const runInsert = (sql: string, params: unknown[]): Row[] => {
    const m =
      /^INSERT INTO (\S+) \(([^)]*)\) VALUES \(([^)]*)\)(?: ON CONFLICT \((\w+)\) DO (?:UPDATE SET (.+)|(NOTHING)))?$/.exec(
        sql,
      );
    if (!m) throw new Error(`fake-pg: unsupported INSERT: ${sql}`);
    const name = m[1]!;
    const columns = m[2]!.split(', ').map((c) => c.trim());
    const values = m[3]!.split(', ').map((v) => {
      const p = /^\$(\d+)(::\w+)?$/.exec(v.trim());
      if (!p) throw new Error(`fake-pg: only placeholders are allowed in VALUES: ${v}`);
      return param(params, p[1]!);
    });

    const incoming: Row = {};
    columns.forEach((column, i) => {
      incoming[column] = coerce(name, column, values[i]);
    });

    const rows = table(name);
    const pk = PRIMARY_KEYS[bare(name)]!;
    const key = String(incoming[pk]);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, incoming);
      return [];
    }
    if (m[6] === 'NOTHING') return [];
    if (!m[5]) throw new Error(`fake-pg: duplicate key '${key}' with no ON CONFLICT clause`);
    for (const assignment of m[5].split(', ')) {
      const a = /^([a-z_]+) = EXCLUDED\.([a-z_]+)$/.exec(assignment.trim());
      if (!a) throw new Error(`fake-pg: unsupported DO UPDATE assignment: ${assignment}`);
      existing[a[1]!] = incoming[a[2]!] ?? null;
    }
    return [];
  };

  const runUpdate = (sql: string, params: unknown[]): Row[] => {
    const m = /^UPDATE (\S+) SET (.+?) WHERE (.+)$/.exec(sql);
    if (!m) throw new Error(`fake-pg: unsupported UPDATE: ${sql}`);
    const name = m[1]!;
    for (const row of table(name).values()) {
      if (!matches(m[3], row, params)) continue;
      for (const assignment of m[2]!.split(', ')) {
        const a = /^([a-z_]+) = \$(\d+)(::\w+)?$/.exec(assignment.trim());
        if (!a) throw new Error(`fake-pg: unsupported SET assignment: ${assignment}`);
        row[a[1]!] = coerce(name, a[1]!, param(params, a[2]!));
      }
    }
    return [];
  };

  const runDelete = (sql: string, params: unknown[]): Row[] => {
    let rest = sql.slice('DELETE FROM '.length);
    let returning: string | undefined;
    const returningIdx = rest.indexOf(' RETURNING ');
    if (returningIdx >= 0) {
      returning = rest.slice(returningIdx + ' RETURNING '.length);
      rest = rest.slice(0, returningIdx);
    }
    let where: string | undefined;
    const whereIdx = rest.indexOf(' WHERE ');
    if (whereIdx >= 0) {
      where = rest.slice(whereIdx + ' WHERE '.length);
      rest = rest.slice(0, whereIdx);
    }
    const rows = table(rest.trim());
    const removed: Row[] = [];
    for (const [key, row] of [...rows.entries()]) {
      if (!matches(where, row, params)) continue;
      rows.delete(key);
      removed.push(row);
    }
    return returning ? removed.map((row) => project(returning!, row, params)) : [];
  };

  const runBatch = (sql: string): Row[] => {
    for (const raw of sql.split(';')) {
      const statement = raw.trim();
      if (statement === '') continue;
      if (/^(BEGIN|COMMIT|CREATE INDEX|ALTER TABLE|SELECT pg_advisory_xact_lock\()/.test(statement))
        continue;
      if (/^CREATE TABLE/.test(statement)) {
        const m = /^CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) table(m[1]!);
        continue;
      }
      const meta = /^INSERT INTO (\S+) \(key, value\) VALUES \('([^']*)', '([^']*)'\)/.exec(
        statement,
      );
      if (meta) {
        const rows = table(meta[1]!);
        if (!rows.has(meta[2]!)) rows.set(meta[2]!, { key: meta[2]!, value: meta[3]! });
        continue;
      }
      throw new Error(`fake-pg: unsupported statement in batch: ${statement}`);
    }
    return [];
  };

  const runStatement = (sql: string, params: unknown[]): Row[] => {
    // The ONE catalog query a row-store cannot model: `pg_attribute.atttypmod`
    // carries a vector column's declared width, and `to_regclass` answers NULL
    // (no rows) for a table that does not exist yet. Answered from the fake's
    // configuration rather than by pretending to hold the catalog.
    if (sql.startsWith('SELECT atttypmod FROM pg_attribute')) {
      return options.existingVectorDimensions === undefined
        ? []
        : [{ atttypmod: options.existingVectorDimensions }];
    }
    // Sent after a failed migration batch; the fake keeps no transaction state.
    if (sql === 'ROLLBACK') return [];
    if (sql.startsWith('SELECT ')) return runSelect(sql, params);
    if (sql.startsWith('INSERT INTO ')) return runInsert(sql, params);
    if (sql.startsWith('UPDATE ')) return runUpdate(sql, params);
    if (sql.startsWith('DELETE FROM ')) return runDelete(sql, params);
    if (sql.startsWith('CREATE TABLE')) {
      const m = /^CREATE TABLE IF NOT EXISTS (\S+)/.exec(sql);
      if (m) table(m[1]!);
      return [];
    }
    throw new Error(`fake-pg: unsupported statement: ${sql}`);
  };

  return {
    calls,
    texts() {
      return calls.map((c) => c.sql);
    },
    ddl() {
      return calls
        .filter((c) => c.sql.includes(';'))
        .flatMap((c) => c.sql.split(';').map((s) => s.trim()))
        .filter((s) => s !== '');
    },
    rows(name) {
      return [...table(name).values()];
    },
    seed(name, seeded) {
      const rows = table(name);
      const pk = PRIMARY_KEYS[bare(name)]!;
      for (const row of seeded) rows.set(String(row[pk]), row);
    },
    failNext(error) {
      pendingFailure = error;
    },
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = undefined;
        throw error;
      }
      return { rows: sql.includes(';') ? runBatch(sql) : runStatement(sql, params) };
    },
  };
}

// ===================================================================
// Fixtures
// ===================================================================

const T0 = 1_700_000_000_000;
const SCOPE: MemoryScope = { userId: 'user-a', chatId: 'chat-1' };

function record(id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text,
    hash: `hash-${id}`,
    kind: 'semantic',
    scope: SCOPE,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function find(client: FakePgClient, needle: string): { sql: string; params: unknown[] } {
  const call = client.calls.find((c) => c.sql.includes(needle));
  if (!call)
    throw new Error(`no statement containing '${needle}' in:\n${client.texts().join('\n')}`);
  return call;
}

// ===================================================================
// Schema-name validation
// ===================================================================

describe('createPostgresStores — schema name', () => {
  it('rejects anything that is not a bare lower-case identifier', () => {
    const bad = [
      'x; DROP TABLE deuz_memory', // the classic
      'public"',
      'Public', // unquoted identifiers fold to lower case — reject rather than surprise
      '1abc',
      'deuz-memory',
      '',
      'a'.repeat(64), // over Postgres' 63-byte identifier limit
    ];
    for (const schema of bad) {
      expect(() => createPostgresStores({ client: createFakePg(), schema })).toThrow(
        InvalidRequestError,
      );
    }
    expect(() =>
      createPostgresStores({ client: createFakePg(), schema: 'x; DROP TABLE y' }),
    ).toThrow(/Invalid Postgres schema name/);
  });

  it('accepts a valid schema and qualifies EVERY statement with it', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, schema: 'deuz_2', pgvector: 'off' });
    await stores.memory.upsert([record('m1', 'hello')]);
    await stores.memory.get('m1');

    const touching = client
      .texts()
      .flatMap((sql) => sql.split(';'))
      .filter((sql) => /deuz_(memory|chats|sessions|runs|meta)/.test(sql));
    expect(touching.length).toBeGreaterThan(0);
    for (const sql of touching) {
      expect(sql).toMatch(/deuz_2\.deuz_/);
      expect(sql).not.toMatch(/(?<!deuz_2\.)public\.deuz_/);
    }
  });

  it('rejects a nonsensical vector width', () => {
    expect(() => createPostgresStores({ client: createFakePg(), dimensions: 0 })).toThrow(
      InvalidRequestError,
    );
    expect(() => createPostgresStores({ client: createFakePg(), dimensions: 1.5 })).toThrow(
      /Invalid pgvector dimensions/,
    );
  });

  it('rejects options carrying neither a client nor a connectionString', () => {
    expect(() => createPostgresStores({} as never)).toThrow(InvalidRequestError);
  });
});

// ===================================================================
// Migration
// ===================================================================

describe('migration', () => {
  it('creates schema v1 in ONE transactional batch and records the version', async () => {
    const client = createFakePg();
    await createPostgresStores({ client, pgvector: 'off' }).migrate();

    const batch = client.calls.find((c) => c.sql.includes(';'));
    expect(batch).toBeDefined();
    const statements = batch!.sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    // BEGIN/COMMIT must ride the SAME query — a pool would otherwise scatter
    // them across connections.
    expect(client.calls.filter((c) => c.sql === 'BEGIN')).toHaveLength(0);

    for (const table of ['deuz_memory', 'deuz_chats', 'deuz_sessions', 'deuz_runs']) {
      expect(
        statements.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS public.${table}`)),
      ).toBe(true);
    }
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS deuz_memory_scope_idx ON public.deuz_memory (user_id, agent_id, chat_id)',
    );
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS deuz_memory_hash_idx ON public.deuz_memory (hash)',
    );
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS deuz_memory_expires_idx ON public.deuz_memory (expires_at) WHERE expires_at IS NOT NULL',
    );
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS deuz_runs_status_idx ON public.deuz_runs (status)',
    );
    expect(
      statements.some((s) => s.includes("deuz_meta (key, value) VALUES ('schema_version', '1')")),
    ).toBe(true);
    expect(client.rows('deuz_meta')).toEqual([{ key: 'schema_version', value: '1' }]);
  });

  it('is idempotent and memoized — the second call issues no further DDL', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.migrate();
    // Two DDL statements exactly: the deuz_meta bootstrap (the version gate has
    // to read before the batch runs) and the batch itself.
    const ddlCalls = (): number =>
      client.calls.filter((c) => c.sql.includes('CREATE TABLE')).length;
    expect(ddlCalls()).toBe(2);
    const after = client.calls.length;

    await stores.migrate();
    await stores.memory.list(SCOPE); // lazily migrates too — must not re-run DDL
    expect(ddlCalls()).toBe(2);
    expect(client.calls.length).toBe(after + 1); // just the SELECT
  });

  it('refuses a schema written by a NEWER sdk', async () => {
    const client = createFakePg();
    client.seed('deuz_meta', [{ key: 'schema_version', value: '2' }]);
    const stores = createPostgresStores({ client, pgvector: 'off' });

    await expect(stores.migrate()).rejects.toThrow(/schema_version 2, newer than the 1/);
  });

  it('does not cache a FAILED migration — the next call retries', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    client.failNext(new Error('connection terminated'));

    await expect(stores.migrate()).rejects.toThrow('connection terminated');
    await expect(stores.migrate()).resolves.toBeUndefined();
    expect(client.rows('deuz_meta')).toHaveLength(1);
  });

  it('takes an advisory lock first thing in the batch, so concurrent first migrations queue', async () => {
    const client = createFakePg();
    await createPostgresStores({ client, schema: 'deuz_2', pgvector: 'off' }).migrate();
    expect(client.ddl().slice(0, 2)).toEqual([
      'BEGIN',
      "SELECT pg_advisory_xact_lock(hashtext('deuz-sdk'), hashtext('stores:deuz_2'))",
    ]);
  });

  it('runs the deuz_meta bootstrap and the batch again when a concurrent first migration failed them', async () => {
    const fake = createFakePg();
    // 23505, 42P07 and 42710: two sessions created one table at once. 40001:
    // under REPEATABLE READ the batch's snapshot predates its lock wait.
    const failures: [RegExp, string[]][] = [
      [/^CREATE TABLE IF NOT EXISTS public\.deuz_meta\b/, ['42P07', '23505', '42710']],
      [/^BEGIN;/, ['40001', '23505', '42P07']],
    ];
    const racing: PgClientLike = {
      async query(sql, params) {
        const text = sql.replace(/\s+/g, ' ').trim();
        for (const [pattern, codes] of failures) {
          const code = pattern.test(text) ? codes.shift() : undefined;
          if (code) throw Object.assign(new Error(`first migration race (${code})`), { code });
        }
        return fake.query(sql, params);
      },
    };
    await createPostgresStores({ client: racing, pgvector: 'off' }).migrate();
    expect(failures.map(([, codes]) => codes)).toEqual([[], []]);
    expect(fake.rows('deuz_meta')).toEqual([{ key: 'schema_version', value: '1' }]);
    // A failed batch may leave its connection inside an aborted transaction
    // block, so each failure is followed by a ROLLBACK before the retry.
    expect(fake.texts().filter((sql) => sql === 'ROLLBACK')).toHaveLength(3);
  });

  it('runs lazily on the first store call, before the statement itself', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([record('m1', 'lazy')]);

    const ddlIndex = client.calls.findIndex((c) => c.sql.includes(';'));
    const insertIndex = client.calls.findIndex((c) => c.sql.startsWith('INSERT INTO'));
    expect(ddlIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(ddlIndex);
  });
});

// ===================================================================
// pgvector detection
// ===================================================================

describe('pgvector detection', () => {
  it("'auto' adds the vector column + HNSW index when the extension is installed", async () => {
    const client = createFakePg({ vectorExtension: true });
    await createPostgresStores({ client, dimensions: 3 }).migrate();

    expect(find(client, 'pg_extension').sql).toBe(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
    );
    const ddl = client.ddl();
    expect(ddl).toContain(
      'ALTER TABLE public.deuz_memory ADD COLUMN IF NOT EXISTS embedding vector(3)',
    );
    expect(ddl).toContain(
      'CREATE INDEX IF NOT EXISTS deuz_memory_embedding_idx ON public.deuz_memory USING hnsw (embedding vector_cosine_ops)',
    );
    // Never our call to make — it needs rights most managed hosts withhold.
    expect(client.texts().join(' ')).not.toMatch(/CREATE EXTENSION/);
  });

  it("'auto' falls back silently when the extension is absent", async () => {
    const client = createFakePg();
    await createPostgresStores({ client }).migrate();

    expect(client.texts().some((s) => s.includes('pg_extension'))).toBe(true);
    expect(client.ddl().some((s) => s.includes('vector'))).toBe(false);
  });

  it("'require' fails loudly when the extension is absent", async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'require' });

    await expect(stores.migrate()).rejects.toThrow(InvalidRequestError);
    await expect(stores.migrate()).rejects.toThrow(/CREATE EXTENSION vector/);
    // The gate runs BEFORE any DDL — a rejected pack leaves no half-built schema.
    expect(client.texts().some((s) => s.includes('CREATE TABLE'))).toBe(false);
  });

  it("'off' never probes pg_extension, even when it is installed", async () => {
    const client = createFakePg({ vectorExtension: true });
    await createPostgresStores({ client, pgvector: 'off' }).migrate();

    expect(client.texts().some((s) => s.includes('pg_extension'))).toBe(false);
    expect(client.ddl().some((s) => s.includes('vector'))).toBe(false);
  });
});

// ===================================================================
// pgvector dimension agreement
// ===================================================================

describe('pgvector dimensions', () => {
  it('refuses to migrate onto an existing vector column of a different width', async () => {
    const client = createFakePg({ vectorExtension: true, existingVectorDimensions: 1536 });
    const stores = createPostgresStores({ client, dimensions: 768 });

    await expect(stores.migrate()).rejects.toThrow(InvalidRequestError);
    await expect(stores.migrate()).rejects.toThrow(/vector\(1536\)/);
    await expect(stores.migrate()).rejects.toThrow(/dimensions: 768/);
    // `ADD COLUMN IF NOT EXISTS` cannot widen a column, so it would have been a
    // silent no-op followed by a runtime failure on every single write.
    expect(client.texts().some((s) => s.includes('ADD COLUMN IF NOT EXISTS embedding'))).toBe(
      false,
    );
    expect(
      client.texts().some((s) => s.includes('CREATE TABLE IF NOT EXISTS public.deuz_memory')),
    ).toBe(false);
  });

  it('migrates happily onto an existing column of the SAME width', async () => {
    const client = createFakePg({ vectorExtension: true, existingVectorDimensions: 3 });
    const stores = createPostgresStores({ client, dimensions: 3 });

    await expect(stores.migrate()).resolves.toBeUndefined();
    expect(client.ddl()).toContain(
      'ALTER TABLE public.deuz_memory ADD COLUMN IF NOT EXISTS embedding vector(3)',
    );
  });

  it('never probes the column width when pgvector is off', async () => {
    const client = createFakePg({ existingVectorDimensions: 1536 });
    await createPostgresStores({ client, pgvector: 'off', dimensions: 3 }).migrate();

    expect(client.texts().some((s) => s.includes('pg_attribute'))).toBe(false);
  });

  it('rejects a write whose embedding width contradicts the vector column', async () => {
    const client = createFakePg({ vectorExtension: true });
    const stores = createPostgresStores({ client, dimensions: 3 });

    // Postgres itself would reject the row; swallowing that turns "the agent
    // stopped learning" into a silent condition with no error anywhere.
    await expect(
      stores.memory.upsert([record('m1', 'x', { embedding: [0.1, 0.2] })]),
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      stores.memory.upsert([record('m1', 'x', { embedding: [0.1, 0.2] })]),
    ).rejects.toThrow(/2-dimension embedding.*vector\(3\)/s);
    expect(client.rows('deuz_memory')).toEqual([]);

    // …and the same guard on the targeted-UPDATE path.
    await stores.memory.upsert([record('m1', 'x', { embedding: [1, 0, 0] })]);
    await expect(stores.memory.update('m1', { embedding: [1, 0] })).rejects.toThrow(
      /2-dimension embedding/,
    );
    expect(client.rows('deuz_memory')[0]!['embedding']).toBe('[1,0,0]');
  });

  it('does not police widths when there is no vector column to disagree with', async () => {
    const client = createFakePg(); // no extension → embedding_json only
    const stores = createPostgresStores({ client, dimensions: 3 });

    // `DOUBLE PRECISION[]` has no declared width, so nothing is lost or wrong.
    await expect(
      stores.memory.upsert([record('m1', 'x', { embedding: [0.1, 0.2] })]),
    ).resolves.toBeUndefined();
    expect(client.rows('deuz_memory')[0]!['embedding_json']).toEqual([0.1, 0.2]);
  });
});

// ===================================================================
// Writes
// ===================================================================

describe('memory upsert', () => {
  it('overwrites every column but the primary key on conflict', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([record('m1', 'first')]);

    const { sql } = find(client, 'INSERT INTO public.deuz_memory');
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE SET');
    const assignments = sql.slice(sql.indexOf('DO UPDATE SET ') + 'DO UPDATE SET '.length);
    const updated = assignments.split(', ').map((a) => a.split(' = ')[0]);
    expect(updated).toEqual([
      'text',
      'hash',
      'kind',
      'user_id',
      'agent_id',
      'run_id',
      'actor_id',
      'chat_id',
      'importance',
      'metadata',
      'embedding_json',
      'embedding_model_id',
      'created_at',
      'updated_at',
      'last_accessed_at',
      'expires_at',
      'valid_at',
      'invalid_at',
    ]);
    expect(updated).not.toContain('id');
  });

  it('writes embedding_json ALWAYS and the vector column ADDITIONALLY', async () => {
    const withVector = createFakePg({ vectorExtension: true });
    const withoutVector = createFakePg();

    await createPostgresStores({ client: withVector, dimensions: 3 }).memory.upsert([
      record('m1', 'x', { embedding: [0.1, 0.2, 0.3] }),
    ]);
    await createPostgresStores({ client: withoutVector }).memory.upsert([
      record('m1', 'x', { embedding: [0.1, 0.2, 0.3] }),
    ]);

    const vectored = find(withVector, 'INSERT INTO public.deuz_memory');
    expect(vectored.sql).toContain('embedding_json, embedding_model_id');
    expect(vectored.sql).toContain('invalid_at, embedding)');
    expect(vectored.sql).toContain('$20::vector');
    expect(vectored.params[11]).toEqual([0.1, 0.2, 0.3]); // embedding_json (float8[])
    expect(vectored.params[19]).toBe('[0.1,0.2,0.3]'); // pgvector text format
    expect(withVector.rows('deuz_memory')[0]!['embedding']).toBe('[0.1,0.2,0.3]');

    const plain = find(withoutVector, 'INSERT INTO public.deuz_memory');
    expect(plain.sql).not.toContain('::vector');
    expect(plain.sql).not.toMatch(/, embedding\)/);
    expect(plain.params[11]).toEqual([0.1, 0.2, 0.3]);
    // …which is exactly what the documented backfill upgrades later:
    //   UPDATE deuz_memory SET embedding = embedding_json::vector WHERE embedding IS NULL …
    expect(withoutVector.rows('deuz_memory')[0]!['embedding_json']).toEqual([0.1, 0.2, 0.3]);
  });

  it('keeps non-finite vector components writable (pgvector rejects NaN)', async () => {
    const client = createFakePg({ vectorExtension: true });
    await createPostgresStores({ client, dimensions: 3 }).memory.upsert([
      record('m1', 'x', { embedding: [1, Number.NaN, Number.POSITIVE_INFINITY] }),
    ]);
    expect(find(client, 'INSERT INTO public.deuz_memory').params[19]).toBe('[1,0,0]');
  });
});

// ===================================================================
// Search
// ===================================================================

describe('memory search', () => {
  it('uses the <=> operator, a ::vector cast and the HNSW-friendly ORDER BY', async () => {
    const client = createFakePg({ vectorExtension: true });
    const stores = createPostgresStores({ client, dimensions: 3 });
    await stores.memory.upsert([record('m1', 'x', { embedding: [1, 0, 0] })]);

    await stores.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 4 });
    const { sql, params } = find(client, '<=>');

    expect(sql).toContain('1 - (embedding <=> $1::vector) AS score');
    expect(sql).toContain('ORDER BY embedding <=> $1::vector');
    expect(sql).toContain('WHERE user_id = $2 AND chat_id = $3 AND invalid_at IS NULL');
    expect(sql).toContain('AND embedding IS NOT NULL');
    expect(sql).toMatch(/LIMIT \$4$/);
    expect(params).toEqual(['[1,0,0]', 'user-a', 'chat-1', 4]);
    // The read set never drags the vector back over the wire.
    expect(sql).not.toContain('embedding_json');
    expect(sql).not.toContain('SELECT *');
  });

  it('ranks with the database when pgvector is on', async () => {
    const client = createFakePg({ vectorExtension: true });
    const stores = createPostgresStores({ client, dimensions: 3 });
    await stores.memory.upsert([
      record('far', 'a', { embedding: [0, 0, 1] }),
      record('near', 'b', { embedding: [1, 0, 0] }),
      record('mid', 'c', { embedding: [0.6, 0.8, 0] }),
    ]);

    const hits = await stores.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 3 });
    expect(hits.map((h) => h.record.id)).toEqual(['near', 'mid', 'far']);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[1]!.score).toBeCloseTo(0.6, 6);
  });

  it('falls back to freshest-1000 candidates + JS cosine without pgvector', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([
      // The freshest row is the WORST match: proving the JS re-rank runs.
      record('stale-but-close', 'a', { embedding: [1, 0, 0], updatedAt: T0 }),
      record('fresh-but-far', 'b', { embedding: [0, 0, 1], updatedAt: T0 + 9_000 }),
    ]);

    const hits = await stores.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 2 });
    const { sql } = find(client, 'embedding_json FROM');

    expect(sql).toContain('ORDER BY updated_at DESC LIMIT 1000');
    expect(sql).not.toContain('<=>');
    // The candidate set is the SCOPE, not "the scope that happens to have a
    // vector" — a row with no embedding scores 0 and still competes.
    expect(sql).not.toContain('embedding_json IS NOT NULL');
    expect(hits.map((h) => h.record.id)).toEqual(['stale-but-close', 'fresh-but-far']);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[1]!.score).toBeCloseTo(0, 6);
    // A DB-backed record never carries its vector back into the record.
    expect(hits[0]!.record.embedding).toBeUndefined();
  });

  it('tops up a vector page with unembedded rows only when the index page cannot be final', async () => {
    const client = createFakePg({ vectorExtension: true });
    const stores = createPostgresStores({ client, dimensions: 3 });
    await stores.memory.upsert([
      record('near', 'a', { embedding: [1, 0, 0] }),
      record('orthogonal', 'b', { embedding: [0, 1, 0] }),
      record('novec', 'c'),
    ]);
    const topUps = (): number =>
      client.calls.filter((c) => c.sql.includes('embedding IS NULL')).length;

    // A FULL page whose worst score is >= 0 is already the answer: a score-0
    // row can only TIE it, so the HNSW path stays at ONE round-trip.
    client.calls.length = 0;
    const full = await stores.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 2 });
    expect(full.map((h) => h.record.id)).toEqual(['near', 'orthogonal']);
    expect(topUps()).toBe(0);

    // A SHORT page has to reach for the rows the vector index cannot answer for.
    client.calls.length = 0;
    const short = await stores.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 5 });
    expect(short.map((h) => h.record.id)).toEqual(['near', 'orthogonal', 'novec']);
    expect(topUps()).toBe(1);
  });

  it('ranks an unembedded row ABOVE a negative cosine, as the reference store does', async () => {
    const client = createFakePg({ vectorExtension: true });
    const stores = createPostgresStores({ client, dimensions: 3 });
    await stores.memory.upsert([
      record('near', 'a', { embedding: [1, 0, 0] }),
      record('opposite', 'b', { embedding: [-1, 0, 0] }),
      record('novec', 'c'),
    ]);

    // A full page is NOT final when it ends below zero — score 0 beats -1.
    const hits = await stores.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 2 });
    expect(hits.map((h) => h.record.id)).toEqual(['near', 'novec']);
  });

  it('escapes LIKE metacharacters in a text query', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([
      record('literal', 'discount of 50%_off today'),
      record('decoy', 'discount of 50 percent off today'),
    ]);

    const hits = await stores.memory.search({ scope: SCOPE, text: '50%_off', topK: 5 });
    const { sql, params } = find(client, 'ILIKE');
    expect(sql).toContain('text ILIKE $3');
    expect(params[2]).toBe('%50\\%\\_off%');
    expect(hits.map((h) => h.record.id)).toEqual(['literal']);
    expect(hits[0]!.score).toBe(1);
  });

  it('applies the bi-temporal WHERE for an asOf query', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([
      record('was-true', 'old fact', { validAt: T0 - 5_000, invalidAt: T0 + 5_000 }),
      record('not-yet', 'future fact', { validAt: T0 + 50_000 }),
      record('still-true', 'current fact', { validAt: T0 - 5_000 }),
    ]);

    const hits = await stores.memory.search({ scope: SCOPE, asOf: T0, topK: 10 });
    const { sql } = find(client, 'COALESCE');
    expect(sql).toContain('COALESCE(valid_at, created_at) <= $3');
    expect(sql).toContain('(invalid_at IS NULL OR invalid_at > $3)');
    expect(hits.map((h) => h.record.id).sort()).toEqual(['still-true', 'was-true']);
  });

  it('pushes a metadata filter down as a jsonb containment test', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([
      record('tagged', 'a', { metadata: { source: 'chat', lang: 'tr' } }),
      record('other', 'b', { metadata: { source: 'docs' } }),
    ]);

    const hits = await stores.memory.search({ scope: SCOPE, filter: { source: 'chat' }, topK: 5 });
    expect(find(client, '@>').sql).toContain('metadata @> $3::jsonb');
    expect(hits.map((h) => h.record.id)).toEqual(['tagged']);
  });
});

// ===================================================================
// Indexed fast paths + wire types
// ===================================================================

describe('memory fast paths', () => {
  it('resolves hashes with a single ANY($1) round-trip', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([record('m1', 'a'), record('m2', 'b')]);

    const found = await stores.memory.findByHash(['hash-m1', 'absent'], SCOPE);
    const { sql, params } = find(client, 'hash = ANY');
    expect(sql).toContain(
      'WHERE hash = ANY($1) AND user_id = $2 AND chat_id = $3 AND invalid_at IS NULL',
    );
    expect(params[0]).toEqual(['hash-m1', 'absent']);
    expect(found.map((r) => r.id)).toEqual(['m1']);

    // An empty hash list must not cost a round-trip at all.
    const before = client.calls.length;
    expect(await stores.memory.findByHash([], SCOPE)).toEqual([]);
    expect(client.calls.length).toBe(before);
  });

  it('sweeps TTLs with DELETE … RETURNING id and reports the count', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([
      record('dead', 'a', { expiresAt: T0 - 1 }),
      record('alive', 'b', { expiresAt: T0 + 1 }),
      record('forever', 'c'),
    ]);

    expect(await stores.sweepExpiredMemories(T0)).toBe(1);
    const { sql } = find(client, 'RETURNING id');
    expect(sql).toContain('WHERE expires_at IS NOT NULL AND expires_at <= $1 RETURNING id');
    expect(
      client
        .rows('deuz_memory')
        .map((r) => r['id'])
        .sort(),
    ).toEqual(['alive', 'forever']);
  });

  it('decodes BIGINT columns that the driver hands back as strings', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.memory.upsert([
      record('m1', 'a', { lastAccessedAt: T0 + 7, expiresAt: T0 + 9, importance: 0.25 }),
    ]);

    // The fake stores int8 the way `pg` returns it — as text.
    expect(client.rows('deuz_memory')[0]!['created_at']).toBe(String(T0));

    const got = await stores.memory.get('m1');
    expect(got!.createdAt).toBe(T0);
    expect(got!.updatedAt).toBe(T0);
    expect(got!.lastAccessedAt).toBe(T0 + 7);
    expect(got!.expiresAt).toBe(T0 + 9);
    expect(got!.importance).toBeCloseTo(0.25, 6);
    expect(typeof got!.createdAt).toBe('number');
  });

  it('patches columns in place instead of read-modify-write (the vector survives)', async () => {
    const client = createFakePg({ vectorExtension: true });
    const stores = createPostgresStores({ client, dimensions: 3 });
    await stores.memory.upsert([record('m1', 'before', { embedding: [1, 0, 0] })]);

    await stores.memory.update('m1', { text: 'after', updatedAt: T0 + 1 });
    const { sql } = find(client, 'UPDATE public.deuz_memory');
    expect(sql).toBe('UPDATE public.deuz_memory SET text = $2, updated_at = $3 WHERE id = $1');

    const row = client.rows('deuz_memory')[0]!;
    expect(row['text']).toBe('after');
    expect(row['embedding']).toBe('[1,0,0]'); // untouched
    expect((await stores.memory.get('m1'))!.updatedAt).toBe(T0 + 1);
  });
});

// ===================================================================
// RunStore
// ===================================================================

describe('RunStore', () => {
  const runRecord = (runId: string, extra: Partial<RunRecord> = {}): RunRecord => ({
    runId,
    status: 'running',
    goal: 'ship 2.0',
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  });

  it('round-trips a record, patches it, filters by status and deletes it', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });

    await stores.runs.create(runRecord('run-1'));
    await stores.runs.create(runRecord('run-2', { status: 'completed', createdAt: T0 + 1 }));

    expect((await stores.runs.get('run-1'))!.goal).toBe('ship 2.0');
    expect(await stores.runs.get('nope')).toBeUndefined();

    await stores.runs.update('run-1', { status: 'failed', error: 'boom', updatedAt: T0 + 5 });
    const patched = await stores.runs.get('run-1');
    expect(patched!.status).toBe('failed');
    expect(patched!.error).toBe('boom');
    expect(patched!.goal).toBe('ship 2.0'); // the untouched half of the document survives
    expect(client.rows('deuz_runs').find((r) => r['run_id'] === 'run-1')!['status']).toBe('failed');

    expect((await stores.runs.list({ status: 'failed' })).map((r) => r.runId)).toEqual(['run-1']);
    expect(find(client, 'FROM public.deuz_runs WHERE status').sql).toContain('status = $1');
    expect((await stores.runs.list()).map((r) => r.runId).sort()).toEqual(['run-1', 'run-2']);

    await stores.runs.delete('run-1');
    expect(await stores.runs.get('run-1')).toBeUndefined();
    // Patching a run that is gone is a no-op, never a resurrection.
    await stores.runs.update('run-1', { status: 'completed' });
    expect(await stores.runs.get('run-1')).toBeUndefined();
  });
});

// ===================================================================
// Lifecycle
// ===================================================================

describe('lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('never closes an injected client', async () => {
    const client = createFakePg();
    const stores = createPostgresStores({ client, pgvector: 'off' });
    await stores.migrate();
    await expect(stores.close()).resolves.toBeUndefined();
    // Still usable — the caller owns the connection, so we left it alone.
    await expect(stores.memory.list(SCOPE)).resolves.toEqual([]);
  });

  it('close() awaits a pool creation that is still in flight, then ends it', async () => {
    let ended = 0;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => (markImportStarted = resolve));
    let releaseImport!: () => void;
    const heldImport = new Promise<void>((resolve) => (releaseImport = resolve));

    // An ASYNC module factory keeps `await import('pg')` pending, which is
    // exactly the window `close()` used to fall through: `ownedPool` is not
    // assigned yet, so the pool is created AFTER close and leaks — holding the
    // event loop (and a real connection) open for the life of the process.
    vi.doMock('pg', async () => {
      markImportStarted();
      await heldImport;
      return {
        Pool: class {
          async query(): Promise<{ rows: Record<string, unknown>[] }> {
            return { rows: [] };
          }
          async end(): Promise<void> {
            ended++;
          }
        },
      };
    });
    vi.resetModules();
    const { createPostgresStores: create } = await import('../src/node/store-postgres');

    const stores = create({ connectionString: 'postgres://localhost/deuz', pgvector: 'off' });
    const migrating = stores.migrate();
    await importStarted;

    const closing = stores.close();
    releaseImport();
    await closing;
    await migrating;

    expect(ended).toBe(1);
  });

  it('explains the optional peer when the connectionString path cannot load pg', async (ctx) => {
    let installed = true;
    try {
      await import('pg' as string);
    } catch {
      installed = false;
    }
    if (installed) return ctx.skip();

    const stores = createPostgresStores({ connectionString: 'postgres://localhost/deuz' });
    await expect(stores.migrate()).rejects.toThrow(/optional peer 'pg'/);
    await expect(stores.close()).resolves.toBeUndefined();
  });
});

// ===================================================================
// The shared contract suites — both search modes
// ===================================================================

assertMemoryStoreContract('postgres (pgvector)', async () => {
  const stores = createPostgresStores({
    client: createFakePg({ vectorExtension: true }),
    dimensions: 3,
  });
  return { store: stores.memory, cleanup: () => stores.close() };
});

assertMemoryStoreContract('postgres (embedding_json fallback)', async () => {
  const stores = createPostgresStores({ client: createFakePg(), pgvector: 'off' });
  return { store: stores.memory, cleanup: () => stores.close() };
});

assertPersistentMemoryStoreContract('postgres (pgvector)', async () => {
  const stores = createPostgresStores({
    client: createFakePg({ vectorExtension: true }),
    dimensions: 3,
  });
  return { store: stores.memory, cleanup: () => stores.close() };
});

assertPersistentMemoryStoreContract('postgres (embedding_json fallback)', async () => {
  const stores = createPostgresStores({ client: createFakePg(), pgvector: 'off' });
  return { store: stores.memory, cleanup: () => stores.close() };
});

assertChatStoreContract('postgres', async () => {
  const stores = createPostgresStores({ client: createFakePg(), pgvector: 'off' });
  return { store: stores.chats, cleanup: () => stores.close() };
});

assertSessionStoreContract('postgres', async () => {
  const stores = createPostgresStores({ client: createFakePg(), pgvector: 'off' });
  return { store: stores.sessions, cleanup: () => stores.close() };
});
