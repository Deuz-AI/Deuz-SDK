/**
 * The receipt log: an append-only, hash-chained SQLite table of the side effects
 * an agent reports (an email sent, a file written, a payment made). Each receipt
 * carries the digest of the one before it, and every append also stores the
 * chain head (last `seq` and digest), so an edit or a deletion anywhere in the
 * file, the newest receipts included, shows up in {@link ReceiptLog.verify}.
 * Recording is idempotent by receipt id.
 *
 * The chain makes tampering DETECTABLE, not impossible: whoever can write the
 * file can also rewrite the whole chain from the edited row on. And a receipt
 * says what the model reported, not what happened.
 */
import { createHash } from 'node:crypto';
import { McpLedgerError } from './errors';

/** How a reported effect ended. `unknown`: it may or may not have happened (a timeout, a crash). */
export type ReceiptStatus = 'succeeded' | 'failed' | 'unknown';

/** The statuses a receipt may carry, in the order tools advertise them. */
export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['succeeded', 'failed', 'unknown'];

/** What a caller records. */
export interface ReceiptInput {
  /** Idempotency key: recording the same id with the same content again changes nothing. Generated when absent. */
  id?: string;
  /** What was done, in one line ("Sent the March invoice to billing@acme.test"). */
  action: string;
  /** Default `'succeeded'`. */
  status?: ReceiptStatus;
  /** The tool, app or system that did it. */
  tool?: string;
  /** What it was done to: a path, URL, recipient, record id. */
  target?: string;
  /** What it cost, when known. Recorded only; it does not touch the budget. */
  costUsd?: number;
  /** Anything else worth keeping. */
  details?: string;
}

/** A stored receipt. */
export interface Receipt {
  /** Position in the log, from 1, without gaps. */
  seq: number;
  id: string;
  action: string;
  status: ReceiptStatus;
  tool?: string;
  target?: string;
  costUsd?: number;
  details?: string;
  /** Epoch ms on the ledger clock. */
  recordedAt: number;
  /** `sha256:<hex>` of the previous receipt; absent on the first. */
  prevDigest?: string;
  /** `sha256:<hex>` over this receipt's content, `seq` and `prevDigest`. */
  digest: string;
}

/** A page query; newest first. */
export interface ReceiptQuery {
  /** 1..200, default 20. */
  limit?: number;
  status?: ReceiptStatus;
  /** Case-insensitive substring over action, tool, target and details. */
  text?: string;
  /** Only receipts with `seq` below this: pass the previous page's `nextBefore`. */
  before?: number;
}

/** One page of receipts. */
export interface ReceiptPage {
  receipts: Receipt[];
  /** Pass as `before` for the next (older) page; absent on the last page. */
  nextBefore?: number;
}

/** The outcome of walking the chain. */
export interface ReceiptChainCheck {
  intact: boolean;
  /** Receipts examined. */
  checked: number;
  /** The first `seq` whose digest, link or position does not hold, or the first one missing at the end. */
  brokenAt?: number;
}

/** The receipt log; see the module comment. */
export interface ReceiptLog {
  /**
   * Append a receipt. A repeated id with the same content returns the stored
   * receipt and `replayed: true`.
   *
   * @throws McpLedgerError `receipt_conflict` when the id was recorded with other content,
   *   `invalid_argument` for an empty action, an unknown status or a negative cost.
   */
  record(input: ReceiptInput): Promise<{ receipt: Receipt; replayed: boolean }>;
  list(query?: ReceiptQuery): Promise<ReceiptPage>;
  /** Recompute every digest and link, oldest first. */
  verify(): Promise<ReceiptChainCheck>;
  /** Close the database. Idempotent. */
  close(): Promise<void>;
}

/** Options of {@link createReceiptLog}. */
export interface ReceiptLogOptions {
  /** Database file, or `':memory:'`. */
  path: string;
  /** Epoch-ms time source. Default `Date.now`. */
  now?: () => number;
  /** Receipt ids when none is given. Default `crypto.randomUUID`. */
  generateId?: () => string;
}

// --- node:sqlite, structurally (the module is loaded lazily) ------------------

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

/** Load `node:sqlite` with an actionable error on a Node that lacks it. */
export async function openSqlite(path: string, who: string): Promise<Database> {
  let mod: { DatabaseSync: new (path: string) => Database };
  try {
    const spec: string = 'node:sqlite';
    mod = (await import(spec)) as typeof mod;
  } catch (cause) {
    throw new McpLedgerError(
      'sqlite_unavailable',
      `${who} needs node:sqlite, which ships unflagged from Node 22.13 / 23.4. Upgrade Node (22.13 or later).`,
      { cause },
    );
  }
  const db = new mod.DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deuz_ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO deuz_ledger_meta (key, value) VALUES ('receipts_schema', '1');
CREATE TABLE IF NOT EXISTS deuz_ledger_receipts (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  tool TEXT,
  target TEXT,
  cost_usd REAL,
  details TEXT,
  recorded_at INTEGER NOT NULL,
  prev_digest TEXT,
  digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deuz_ledger_receipts_status_idx ON deuz_ledger_receipts (status, seq);
`;

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** The idempotency fingerprint: the reported content, without time or position. */
function fingerprintOf(
  input: Required<Pick<ReceiptInput, 'action' | 'status'>> & ReceiptInput,
): string {
  return sha256(
    JSON.stringify([
      input.action,
      input.status,
      input.tool ?? null,
      input.target ?? null,
      input.costUsd ?? null,
      input.details ?? null,
    ]),
  );
}

function digestOf(receipt: Omit<Receipt, 'digest'>): string {
  return sha256(
    JSON.stringify([
      receipt.seq,
      receipt.prevDigest ?? null,
      receipt.id,
      receipt.action,
      receipt.status,
      receipt.tool ?? null,
      receipt.target ?? null,
      receipt.costUsd ?? null,
      receipt.details ?? null,
      receipt.recordedAt,
    ]),
  );
}

type Row = Record<string, unknown>;

function rowToReceipt(row: Row): Receipt {
  const opt = (key: string): string | undefined =>
    typeof row[key] === 'string' ? (row[key] as string) : undefined;
  const tool = opt('tool');
  const target = opt('target');
  const details = opt('details');
  const prevDigest = opt('prev_digest');
  const cost = row.cost_usd;
  return {
    seq: Number(row.seq),
    id: String(row.id),
    action: String(row.action),
    status: String(row.status) as ReceiptStatus,
    ...(tool !== undefined ? { tool } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(typeof cost === 'number' ? { costUsd: cost } : {}),
    ...(details !== undefined ? { details } : {}),
    recordedAt: Number(row.recorded_at),
    ...(prevDigest !== undefined ? { prevDigest } : {}),
    digest: String(row.digest),
  };
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new McpLedgerError('invalid_argument', `${label} must be a string.`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Open (lazily, on first use) a receipt log at `options.path`. Several
 * processes may share one file: appends run in `BEGIN IMMEDIATE`.
 */
export function createReceiptLog(options: ReceiptLogOptions): ReceiptLog {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
  let opening: Promise<Database> | undefined;
  let closed = false;

  const db = (): Promise<Database> => {
    if (closed) return Promise.reject(new McpLedgerError('closed', 'The receipt log is closed.'));
    opening ??= openSqlite(options.path, 'The receipt log').then((handle) => {
      handle.exec(SCHEMA);
      return handle;
    });
    return opening;
  };

  const transaction = <T>(handle: Database, work: () => T): T => {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      handle.exec('COMMIT');
      return result;
    } catch (error) {
      handle.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    async record(input) {
      if (input === null || typeof input !== 'object') {
        throw new McpLedgerError('invalid_argument', 'A receipt must be an object.');
      }
      const action = optionalText(input.action, 'action');
      if (action === undefined) {
        throw new McpLedgerError('invalid_argument', 'A receipt needs a non-empty action.');
      }
      const status = input.status ?? 'succeeded';
      if (!RECEIPT_STATUSES.includes(status)) {
        throw new McpLedgerError(
          'invalid_argument',
          `status must be one of ${RECEIPT_STATUSES.join(', ')}.`,
        );
      }
      if (
        input.costUsd !== undefined &&
        (typeof input.costUsd !== 'number' || !Number.isFinite(input.costUsd) || input.costUsd < 0)
      ) {
        throw new McpLedgerError(
          'invalid_argument',
          'costUsd must be a finite nonnegative number.',
        );
      }
      const tool = optionalText(input.tool, 'tool');
      const target = optionalText(input.target, 'target');
      const details = optionalText(input.details, 'details');
      const id = optionalText(input.id, 'id') ?? generateId();
      const clean = {
        action,
        status,
        ...(tool !== undefined ? { tool } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
        ...(details !== undefined ? { details } : {}),
      };
      const fingerprint = fingerprintOf(clean);
      const handle = await db();
      return transaction(handle, () => {
        const existing = handle
          .prepare('SELECT * FROM deuz_ledger_receipts WHERE id = ?')
          .get(id) as Row | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new McpLedgerError(
              'receipt_conflict',
              `Receipt '${id}' was already recorded with different content. Use a new id for a new effect.`,
            );
          }
          return { receipt: rowToReceipt(existing), replayed: true };
        }
        const last = handle
          .prepare('SELECT seq, digest FROM deuz_ledger_receipts ORDER BY seq DESC LIMIT 1')
          .get() as Row | undefined;
        const body: Omit<Receipt, 'digest'> = {
          seq: last ? Number(last.seq) + 1 : 1,
          id,
          ...clean,
          recordedAt: now(),
          ...(last ? { prevDigest: String(last.digest) } : {}),
        };
        const receipt: Receipt = { ...body, digest: digestOf(body) };
        handle
          .prepare(
            `INSERT INTO deuz_ledger_receipts
               (seq, id, action, status, tool, target, cost_usd, details, recorded_at, prev_digest, digest, fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            receipt.seq,
            receipt.id,
            receipt.action,
            receipt.status,
            receipt.tool ?? null,
            receipt.target ?? null,
            receipt.costUsd ?? null,
            receipt.details ?? null,
            receipt.recordedAt,
            receipt.prevDigest ?? null,
            receipt.digest,
            fingerprint,
          );
        // The head anchors the end of the chain, so dropping the newest rows is detected too.
        handle
          .prepare(
            `INSERT INTO deuz_ledger_meta (key, value) VALUES ('receipts_head', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(JSON.stringify({ seq: receipt.seq, digest: receipt.digest }));
        return { receipt, replayed: false };
      });
    },

    async list(query = {}) {
      const limit = query.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new McpLedgerError('invalid_argument', 'limit must be an integer from 1 to 200.');
      }
      if (query.status !== undefined && !RECEIPT_STATUSES.includes(query.status)) {
        throw new McpLedgerError(
          'invalid_argument',
          `status must be one of ${RECEIPT_STATUSES.join(', ')}.`,
        );
      }
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status !== undefined) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.before !== undefined) {
        where.push('seq < ?');
        params.push(query.before);
      }
      const text = query.text?.trim();
      if (text) {
        const pattern = `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(
          `(${['action', 'tool', 'target', 'details']
            .map((column) => `lower(coalesce(${column}, '')) LIKE ? ESCAPE '\\'`)
            .join(' OR ')})`,
        );
        params.push(pattern, pattern, pattern, pattern);
      }
      const handle = await db();
      const rows = handle
        .prepare(
          `SELECT * FROM deuz_ledger_receipts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(...params, limit + 1) as Row[];
      const receipts = rows.slice(0, limit).map(rowToReceipt);
      const more = rows.length > limit;
      return {
        receipts,
        ...(more && receipts.length > 0 ? { nextBefore: receipts[receipts.length - 1]!.seq } : {}),
      };
    },

    async verify() {
      const handle = await db();
      // One read transaction: the rows and the head come from the same snapshot.
      handle.exec('BEGIN');
      let rows: Row[];
      let headRow: Row | undefined;
      try {
        rows = handle.prepare('SELECT * FROM deuz_ledger_receipts ORDER BY seq ASC').all() as Row[];
        headRow = handle
          .prepare("SELECT value FROM deuz_ledger_meta WHERE key = 'receipts_head'")
          .get() as Row | undefined;
      } finally {
        handle.exec('COMMIT');
      }
      let previous: string | undefined;
      let checked = 0;
      for (const row of rows) {
        const receipt = rowToReceipt(row);
        checked++;
        const { digest, ...body } = receipt;
        if (
          receipt.seq !== checked ||
          receipt.prevDigest !== previous ||
          digestOf(body) !== digest
        ) {
          return { intact: false, checked, brokenAt: receipt.seq };
        }
        previous = digest;
      }
      let head: { seq?: unknown; digest?: unknown } = {};
      try {
        if (typeof headRow?.value === 'string') head = JSON.parse(headRow.value) as typeof head;
      } catch {
        // An unreadable head anchors nothing: treated as an empty log below.
      }
      const headSeq = typeof head.seq === 'number' ? head.seq : 0;
      if (headSeq !== checked) {
        // Receipts past the head were added behind the log's back, or the newest were removed.
        return { intact: false, checked, brokenAt: Math.min(headSeq, checked) + 1 };
      }
      if (checked > 0 && head.digest !== previous)
        return { intact: false, checked, brokenAt: checked };
      return { intact: true, checked };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (opening) {
        const handle = await opening.catch(() => undefined);
        handle?.close();
      }
    },
  };
}
