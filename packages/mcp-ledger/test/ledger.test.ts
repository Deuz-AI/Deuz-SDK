/**
 * The ledger's public contract, driven through MCP the way a client sees it: a
 * Deuz MCP client wired straight into `ledger.server.fetch` (no socket), over a
 * temp data directory and a manual clock. One case uses a real loopback socket
 * to cover `serveMcpLedgerHttp`. No provider, no API key, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@deuz-sdk/core';
import { createMcpClient, type McpRootsClient } from '@deuz-sdk/core/mcp';
import {
  createMcpLedger,
  LEDGER_FILES,
  LEDGER_TOOL_NAMES,
  McpLedgerError,
  parseLedgerArgs,
  serveMcpLedgerHttp,
  type McpLedger,
  type McpLedgerOptions,
} from '../src/index';

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 1);

const dirs: string[] = [];
const ledgers: McpLedger[] = [];
const clients: McpRootsClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manualClock(start = START): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    advance(ms) {
      now += ms;
    },
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deuz-mcp-ledger-'));
  dirs.push(dir);
  return dir;
}

function open(options: Partial<McpLedgerOptions> = {}): McpLedger {
  const ledger = createMcpLedger({ dataDir: options.dataDir ?? tempDir(), ...options });
  ledgers.push(ledger);
  return ledger;
}

async function connect(ledger: McpLedger): Promise<McpRootsClient> {
  const client = await createMcpClient({
    sdk: 'v2',
    transport: {
      type: 'http',
      url: 'http://ledger.test/mcp',
      fetch: (input: string | URL, init?: RequestInit) =>
        ledger.server.fetch(new Request(input, init)),
    },
  });
  clients.push(client);
  return client;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (client: McpRootsClient, name: string, args: unknown = {}): Promise<Json> =>
  (await client.callTool(name, args)) as Json;

describe('@deuz-sdk/mcp-ledger', () => {
  it('serves exactly the nine ledger tools, each described', async () => {
    const client = await connect(open());
    const tools = await client.listTools();
    expect(Object.keys(tools).sort()).toEqual([...LEDGER_TOOL_NAMES].sort());
    for (const tool of Object.values(tools)) expect(tool.description?.length).toBeGreaterThan(20);
  });

  it('remembers and recalls by words with no embedder, and lists recent memories without a query', async () => {
    const client = await connect(open({ clock: manualClock() }));
    const saved = await call(client, 'memory_remember', { text: 'The user prefers metric units.' });
    expect(saved).toMatchObject({
      revision: 1,
      origin: 'inferred',
      status: 'active',
      kind: 'semantic',
    });
    await call(client, 'memory_remember', {
      text: 'Deploys go out on Thursdays.',
      kind: 'procedural',
    });

    const found = await call(client, 'memory_recall', { query: 'metric' });
    expect(found.memories).toHaveLength(1);
    expect(found.memories[0]).toMatchObject({
      id: saved.id,
      text: 'The user prefers metric units.',
    });

    const recent = await call(client, 'memory_recall', {});
    expect(recent.memories).toHaveLength(2);
    expect((await call(client, 'memory_recall', { query: 'zebra' })).memories).toEqual([]);
  });

  it('returns the stored memory instead of a duplicate for the same fact', async () => {
    const client = await connect(open());
    const first = await call(client, 'memory_remember', { text: 'Invoices are due net 30.' });
    const again = await call(client, 'memory_remember', { text: '  invoices are due   NET 30. ' });
    expect(again).toMatchObject({ id: first.id, alreadyKnown: true });
    expect((await call(client, 'memory_recall', {})).memories).toHaveLength(1);
  });

  it('revises with history, and refuses a stale revision', async () => {
    const client = await connect(open());
    const saved = await call(client, 'memory_remember', { text: 'The office is in Ankara.' });
    const revised = await call(client, 'memory_revise', {
      id: saved.id,
      text: 'The office is in Izmir.',
      expectedRevision: 1,
    });
    expect(revised).toMatchObject({ id: saved.id, revision: 2, text: 'The office is in Izmir.' });

    const history = await call(client, 'memory_history', { id: saved.id });
    expect(history.revisions.map((r: Json) => r.text)).toEqual([
      'The office is in Ankara.',
      'The office is in Izmir.',
    ]);
    await expect(
      call(client, 'memory_revise', {
        id: saved.id,
        text: 'The office is in Bursa.',
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/changed since revision 1/);
    await expect(call(client, 'memory_revise', { id: 'nope', text: 'x' })).rejects.toThrow(
      /No memory/,
    );
  });

  it('forgets a memory for good', async () => {
    const client = await connect(open());
    const saved = await call(client, 'memory_remember', { text: 'My passport number is X123.' });
    expect(await call(client, 'memory_forget', { id: saved.id })).toMatchObject({
      forgotten: true,
      deletedRevisions: 1,
    });
    expect((await call(client, 'memory_recall', { query: 'passport' })).memories).toEqual([]);
    await expect(call(client, 'memory_history', { id: saved.id })).rejects.toThrow(/No memory/);
    await expect(call(client, 'memory_forget', { id: 'never-existed' })).rejects.toThrow(
      /No memory/,
    );
  });

  it('reports spend against the ceiling in a rolling window, and records spend past it', async () => {
    const clock = manualClock();
    const client = await connect(open({ clock, budget: { usd: 10, window: '7d' } }));
    const empty = await call(client, 'budget_status', { estimateUsd: 4 });
    expect(empty).toMatchObject({
      state: 'ok',
      spent: { usd: 0 },
      remaining: { usd: 10 },
      fits: true,
      enforcement: 'advisory',
    });

    await call(client, 'budget_record_spend', { usd: 6, tokens: 1200, model: 'claude-sonnet-5' });
    const mid = await call(client, 'budget_status', { estimateUsd: 5 });
    expect(mid).toMatchObject({
      spent: { usd: 6, tokens: 1200 },
      remaining: { usd: 4 },
      percentUsed: 60,
      fits: false,
    });
    expect(mid.byModel['claude-sonnet-5']).toEqual({ usd: 6, tokens: 1200 });

    const over = await call(client, 'budget_record_spend', { usd: 5 });
    expect(over.status).toMatchObject({
      state: 'exceeded',
      spent: { usd: 11 },
      remaining: { usd: 0 },
    });

    clock.advance(8 * DAY);
    const later = await call(client, 'budget_status');
    expect(later).toMatchObject({
      state: 'ok',
      spent: { usd: 0 },
      lifetime: { usd: 11, tokens: 1200 },
      window: '7d',
    });
  });

  it('counts a spend id once and refuses the same id with other amounts', async () => {
    const client = await connect(open({ budget: { usd: 100 } }));
    await call(client, 'budget_record_spend', { usd: 2.5, id: 'req-1' });
    await call(client, 'budget_record_spend', { usd: 2.5, id: 'req-1' });
    expect((await call(client, 'budget_status')).spent.usd).toBe(2.5);
    await expect(call(client, 'budget_record_spend', { usd: 3, id: 'req-1' })).rejects.toThrow(
      /already recorded/,
    );
  });

  it('reports no_ceiling when no budget is configured', async () => {
    const client = await connect(open());
    await call(client, 'budget_record_spend', { usd: 1.25 });
    const status = await call(client, 'budget_status', { estimateUsd: 1000 });
    expect(status).toMatchObject({
      state: 'no_ceiling',
      spent: { usd: 1.25 },
      fits: true,
      window: '30d',
    });
    expect(status.ceiling).toBeUndefined();
  });

  it('keeps an idempotent, filterable, paged receipt log with an intact chain', async () => {
    const client = await connect(open({ clock: manualClock() }));
    const first = await call(client, 'receipt_record', {
      action: 'Sent invoice to acme',
      tool: 'gmail',
      target: 'billing@acme.test',
      id: 'r1',
    });
    expect(first).toMatchObject({ seq: 1, id: 'r1', status: 'succeeded', replayed: false });
    expect(first.prevDigest).toBeUndefined();
    const second = await call(client, 'receipt_record', {
      action: 'Deployed web app',
      status: 'unknown',
      costUsd: 0.4,
    });
    expect(second).toMatchObject({ seq: 2, prevDigest: first.digest });
    await call(client, 'receipt_record', { action: 'Wrote report.md', status: 'failed' });

    expect(
      await call(client, 'receipt_record', {
        action: 'Sent invoice to acme',
        tool: 'gmail',
        target: 'billing@acme.test',
        id: 'r1',
      }),
    ).toMatchObject({ seq: 1, replayed: true });
    await expect(
      call(client, 'receipt_record', { action: 'Something else', id: 'r1' }),
    ).rejects.toThrow(/different content/);

    const page = await call(client, 'receipt_list', { limit: 2, verify: true });
    expect(page.receipts.map((r: Json) => r.seq)).toEqual([3, 2]);
    expect(page.nextBefore).toBe(2);
    expect(page.chain).toEqual({ intact: true, checked: 3 });
    expect(
      (await call(client, 'receipt_list', { before: page.nextBefore })).receipts.map(
        (r: Json) => r.seq,
      ),
    ).toEqual([1]);
    expect(
      (await call(client, 'receipt_list', { status: 'unknown' })).receipts.map((r: Json) => r.seq),
    ).toEqual([2]);
    expect(
      (await call(client, 'receipt_list', { query: 'ACME' })).receipts.map((r: Json) => r.seq),
    ).toEqual([1]);
  });

  it('detects a receipt edited behind its back', async () => {
    const dataDir = tempDir();
    const ledger = open({ dataDir });
    await ledger.receipts.record({ action: 'Paid $20 to vendor' });
    await ledger.receipts.record({ action: 'Emailed the receipt' });
    const db = new DatabaseSync(join(dataDir, LEDGER_FILES.receipts));
    db.prepare("UPDATE deuz_ledger_receipts SET action = 'Paid $2 to vendor' WHERE seq = 1").run();
    db.close();
    expect(await ledger.receipts.verify()).toEqual({ intact: false, checked: 1, brokenAt: 1 });
  });

  it('detects the newest receipts deleted behind its back', async () => {
    const dataDir = tempDir();
    const ledger = open({ dataDir });
    await ledger.receipts.record({ action: 'Paid $20 to vendor' });
    await ledger.receipts.record({ action: 'Refunded $20' });
    expect(await ledger.receipts.verify()).toEqual({ intact: true, checked: 2 });
    const db = new DatabaseSync(join(dataDir, LEDGER_FILES.receipts));
    db.prepare('DELETE FROM deuz_ledger_receipts WHERE seq = 2').run();
    db.close();
    expect(await ledger.receipts.verify()).toEqual({ intact: false, checked: 1, brokenAt: 2 });
  });

  it('refuses absurd amounts and oversized text, also when a host loop runs the tools directly', async () => {
    const ledger = open({ budget: { usd: 10 } });
    await expect(ledger.budget.record({ usd: 1e303 })).rejects.toThrow(McpLedgerError);
    expect((await ledger.budget.status()).spent.usd).toBe(0);
    const remember = ledger.tools.memory_remember!.execute!;
    await expect(remember({ text: 'x'.repeat(4001) }, {} as never)).rejects.toThrow(/at most 4000/);
    const spend = ledger.tools.budget_record_spend!.execute!;
    await expect(spend({ usd: 1, id: 'i'.repeat(201) }, {} as never)).rejects.toThrow(
      /at most 200/,
    );
  });

  it('keeps memory, spend and receipts across restarts, with namespaces apart', async () => {
    const dataDir = tempDir();
    const first = open({ dataDir, budget: { usd: 5 } });
    let client = await connect(first);
    await call(client, 'memory_remember', { text: 'Project codename is Falcon.' });
    await call(client, 'budget_record_spend', { usd: 1 });
    await call(client, 'receipt_record', { action: 'Created repo falcon' });
    await client.close();
    await first.close();

    client = await connect(open({ dataDir, budget: { usd: 5 } }));
    expect((await call(client, 'memory_recall', { query: 'codename' })).memories).toHaveLength(1);
    expect((await call(client, 'budget_status')).spent.usd).toBe(1);
    expect((await call(client, 'receipt_list', { verify: true })).chain).toEqual({
      intact: true,
      checked: 1,
    });

    const other = await connect(open({ dataDir, namespace: 'work' }));
    expect((await call(other, 'memory_recall', { query: 'codename' })).memories).toEqual([]);
  });

  it('parses flags over environment, windows and the per-user default directory', () => {
    const host = {
      platform: 'linux',
      env: { DEUZ_LEDGER_BUDGET_USD: '9', DEUZ_LEDGER_WINDOW: 'week' },
      homedir: '/home/u',
    };
    expect(parseLedgerArgs(['--budget-usd=20', '--namespace', 'acme'], host)).toEqual({
      kind: 'serve',
      dataDir: '/home/u/.local/share/deuz/mcp-ledger',
      budget: { usd: 20, window: { ms: 7 * DAY, label: '7d' } },
      namespace: 'acme',
    });
    expect(parseLedgerArgs(['--window', '12h', '--http'], { ...host, env: {} })).toMatchObject({
      budget: { window: { ms: 12 * 3_600_000, label: '12h' } },
      http: { port: 3741 },
    });
    expect(
      parseLedgerArgs([], {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        homedir: 'C:\\Users\\u',
      }),
    ).toMatchObject({
      dataDir: 'C:\\Users\\u\\AppData\\Local\\deuz\\mcp-ledger',
      budget: { window: { label: '30d' } },
    });
    expect(parseLedgerArgs(['--help'], host)).toEqual({ kind: 'help' });
    expect(() => parseLedgerArgs(['--bogus'], host)).toThrow(McpLedgerError);
    expect(() => parseLedgerArgs(['--window', 'fortnight'], host)).toThrow(/Unknown budget window/);
    expect(() => parseLedgerArgs(['--budget-usd', '-3'], host)).toThrow(/nonnegative/);
  });

  it('serves loopback Streamable HTTP and refuses a foreign Host or Origin', async () => {
    const ledger = open();
    const http = await serveMcpLedgerHttp(ledger.server, { port: 0 });
    try {
      const client = await createMcpClient({
        sdk: 'v2',
        transport: { type: 'http', url: http.url },
      });
      clients.push(client);
      expect(await call(client, 'budget_status')).toMatchObject({ state: 'no_ceiling' });
      const crossOrigin = await fetch(http.url, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(crossOrigin.status).toBe(403);
      const rebound = await new Promise<number>((resolve, reject) => {
        const req = request(
          http.url,
          { method: 'POST', headers: { host: `evil.example:${http.port}` } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(rebound).toBe(403);
    } finally {
      for (const client of clients.splice(0)) await client.close().catch(() => {});
      await http.close();
    }
  });
});
