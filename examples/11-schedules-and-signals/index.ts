/**
 * 11 — Schedules and signals: cron ticks with a durable claim, and a verified webhook (2.2).
 *
 * `createScheduler` never reads the host clock on its own: your platform's cron
 * trigger calls `tick(now)`, here with explicit timestamps. Each occurrence has
 * a key `${id}@${at}` and runs only once `claim(key)` grants it; the SQLite ops
 * store's `claims` grants a key once across every process sharing the file.
 * `handleSignal` turns one verified webhook delivery into one dispatch.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from '@deuz-sdk/core';
import { createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createScheduler, handleSignal, verifyHmacSignature } from '@deuz-sdk/core/schedule';
import type { ScheduleDefinition, ScheduleTickResult } from '@deuz-sdk/core/schedule';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// Scripted, so this runs without an API key. REAL PROVIDER: replace it with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({ responses: [{ text: 'Three PRs merged overnight.' }] });

const dir = mkdtempSync(join(tmpdir(), 'deuz-schedule-'));
const path = join(dir, 'ops.sqlite');
// Two processes (or serverless isolates), each with its own connection to one file.
const opsA = createSqliteOpsStore({ path });
const opsB = createSqliteOpsStore({ path });

const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
const schedules: ScheduleDefinition[] = [
  {
    id: 'digest',
    cron: '0 9 * * MON-FRI', // five fields, evaluated in UTC
    async run(occurrence) {
      const { text } = await generateText({ model, prompt: 'Summarise the night.' });
      console.log(`   run ${occurrence.key} (${minute(occurrence.at)}): ${text}`);
    },
  },
];
const report = (who: string, result: ScheduleTickResult) => {
  const occurrences = result.occurrences.map((o) => `${minute(o.at)} ${o.status}`);
  console.log(`   ${who}: ${occurrences.join(', ') || 'nothing due'}`);
};

// The sender's side of the webhook: an HMAC-SHA256 signature over the raw body.
const SECRET = 'whsec_demo';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const delivery = (id: string, body: string, signature = sign(body)) =>
  new Request('https://example.com/hooks/deploys', {
    method: 'POST',
    body,
    headers: { 'x-delivery-id': id, 'x-signature': signature },
  });

let queueUp = false; // the first dispatch fails, to show the key being given back
const onWebhook = (request: Request) =>
  handleSignal(request, {
    verify: async (r) =>
      verifyHmacSignature({
        body: await r.text(),
        signature: r.headers.get('x-signature'),
        secret: SECRET,
        prefix: 'sha256=',
      }),
    // Dedupe on the sender's delivery id (the default key is a hash of the body).
    key: ({ request: r }) => r.headers.get('x-delivery-id') ?? undefined,
    dedupe: opsA.claims, // durable across processes, and it has release()
    // Keep dispatch short: enqueue the work, or start a durable run keyed by `key`.
    dispatch({ body, key }) {
      if (!queueUp) {
        queueUp = true;
        throw new Error('queue unavailable');
      }
      console.log(`   queued ${key}: ${body}`);
    },
  });
const send = async (label: string, request: Request) => {
  const response = await onWebhook(request);
  console.log(`   ${label} -> ${response.status} ${await response.text()}`);
};

try {
  console.log('1) two processes tick the same minute; the durable claim lets one of them run it');
  const monday = Date.parse('2026-01-05T09:00:20Z'); // the host trigger fired 20 s late
  report('process A', await createScheduler({ schedules, claim: opsA.claims }).tick(monday));
  report('process B', await createScheduler({ schedules, claim: opsB.claims }).tick(monday));

  console.log('\n2) process B restarts on Thursday and catches up on what it missed');
  const restarted = createScheduler({
    schedules,
    claim: opsB.claims,
    catchUp: 'all', // run every missed occurrence, oldest first
    lookbackMs: 4 * 86_400_000,
  });
  report('process B', await restarted.tick(Date.parse('2026-01-08T09:00:30Z')));

  console.log('\n3) a signed webhook: verify, dedupe, dispatch');
  const body = JSON.stringify({ event: 'deploy.finished', service: 'api' });
  await send('delivery d-1', delivery('d-1', body)); // dispatch throws, the key is released
  await send('sender retries d-1', delivery('d-1', body));
  await send('d-1 delivered again', delivery('d-1', body));
  await send('forged d-2', delivery('d-2', body.replace('api', 'billing'), sign(body)));
} finally {
  await opsA.close();
  await opsB.close();
  rmSync(dir, { recursive: true, force: true });
}
