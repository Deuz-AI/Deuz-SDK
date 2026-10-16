/**
 * 21 — Versioned memory and the context compiler in a V3 native run (2.4).
 *
 * `@deuz-sdk/core/memory/versioned` keeps facts as records with a stable id,
 * increasing revisions, an `asserted | inferred` origin and the sources they
 * rest on. Every write is one operation with a receipt: a repeated operation
 * id replays, a stale expected revision conflicts. `@deuz-sdk/core/context`
 * compiles those records and the run's working memory into one token budget:
 * retrieval enters the history once, labelled as data, and the working memory
 * rides at the end of each request without entering the history. A V3 run
 * (`checkpointVersion: 3`) stores each step's package as a content-addressed
 * blob, so a `forget` can redact what the run kept.
 */
import {
  createInMemoryAgentRunStoreV3,
  resumeStreamAgent,
  streamAgent,
} from '@deuz-sdk/core/agent';
import type { AgentRunOptionsV3, AgentStreamV3, AgentToolSet } from '@deuz-sdk/core/agent';
import { createMemoryContextSource } from '@deuz-sdk/core/context';
import {
  RevisionConflictError,
  createInMemoryVersionedMemoryStore,
  createMemorySession,
} from '@deuz-sdk/core/memory/versioned';
import type { MemorySourceRef, VersionedMemoryRecord } from '@deuz-sdk/core/memory/versioned';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// Scripted, so this runs without an API key: one reply per model call, in
// order. REAL PROVIDER: replace it with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({
  responses: [
    // step 0: Ada asked for a Slack message after every deploy; the model remembers it
    {
      toolCalls: [
        {
          toolName: 'memory_remember',
          args: { text: 'Ada wants a message in #billing after each deploy.', kind: 'semantic' },
        },
      ],
    },
    // step 1: the deploy itself, which waits for a person's approval
    {
      toolCalls: [
        {
          toolName: 'schedule_deploy',
          args: { service: 'billing', region: 'eu-west-1', window: 'Tuesday 10:00 UTC' },
        },
      ],
    },
    // step 2, after the approval
    { text: 'The billing deploy to eu-west-1 is booked for Tuesday 10:00 UTC.' },
  ],
});

// --- CLOCK AND IDS ------------------------------------------------------------
// The memory's clock and ids are injected, so the output is the same on every run.
let now = Date.parse('2026-10-15T09:00:00Z');
const clock = {
  now: () => now,
  setTimeout: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
let ids = 0;
const deps = { clock, generateId: () => `mem-${++ids}` };

/** `sha256:<hex>` of a text: what a source reference cites. */
async function digest(text: string): Promise<`sha256:${string}`> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** A user message in Ada's chat, as a memory source. */
async function said(messageId: string, text: string): Promise<MemorySourceRef[]> {
  return [{ kind: 'user', chatId: 'chat-7', messageId, digest: await digest(text) }];
}

const show = (record: VersionedMemoryRecord) =>
  `${record.id} r${record.revision} ${record.origin} [${record.sources.map((s) => s.kind).join(',')}] "${record.text}"`;

// --- STORES -----------------------------------------------------------------
// In-memory here. For durable ones: createSqliteVersionedMemoryStore({ path })
// from '@deuz-sdk/core/memory/versioned/sqlite' and createSqliteAgentRunStoreV3({ path })
// from '@deuz-sdk/core/ops/sqlite' (PostgreSQL stores exist for both too).
const runs = createInMemoryAgentRunStoreV3();
const memoryStore = createInMemoryVersionedMemoryStore({ deps });
const memory = createMemorySession({
  store: memoryStore,
  scope: { userId: 'ada' },
  deps,
  // A forget tells the V3 run store to redact every context package that held the record.
  onForget: async (event) => {
    const redacted = await runs.redactForgotten(event);
    console.log(`   [onForget] ${event.recordId}: ${redacted} context package(s) redacted`);
  },
});

console.log('1) the host remembers what Ada said: asserted records that cite her messages');
const facts = [
  ['m1', 'Ada deploys the billing service to eu-west-1.'],
  ['m2', "Ada's deploy window is Friday 16:00 UTC."],
  ['m3', "Ada's staging password is hunter2."],
] as const;
const remembered: VersionedMemoryRecord[] = [];
for (const [messageId, text] of facts) {
  const { records } = await memory.remember(
    { text, kind: 'semantic', sources: await said(messageId, text) },
    { operationId: `onboarding-${messageId}` },
  );
  remembered.push(...records);
  console.log(`   ${show(records[0]!)}`);
}
const [, deployWindow, secret] = remembered as [
  VersionedMemoryRecord,
  VersionedMemoryRecord,
  VersionedMemoryRecord,
];
// A redelivered request: the same operation id and request replay the receipt.
const again = await memory.remember(
  { text: facts[0][1], kind: 'semantic', sources: await said('m1', facts[0][1]) },
  { operationId: 'onboarding-m1' },
);
console.log(
  `   onboarding-m1 again: replayed=${again.replayed}, ${again.records.map((r) => `${r.id} r${r.revision}`).join(', ')}, scope revision ${again.receipt.scopeRevision}`,
);

console.log('\n2) a correction is a new revision; the old one stays in the history');
const beforeFix = now;
now += 60 * 60_000;
const fixedText = "Ada's deploy window is Tuesday 10:00 UTC.";
const fixed = await memory.revise(
  deployWindow.id,
  { text: fixedText, sources: await said('m9', fixedText) },
  { expectedRevision: 1, operationId: 'fix-window' },
);
console.log(`   revise: ${show(fixed.records[0]!)}`);
try {
  // A second writer still holds revision 1: refused, nothing written.
  await memory.revise(
    deployWindow.id,
    { text: "Ada's deploy window is Monday 08:00 UTC." },
    { expectedRevision: 1, operationId: 'fix-window-stale' },
  );
} catch (error) {
  if (!(error instanceof RevisionConflictError)) throw error;
  console.log(
    `   a stale revise: ${error.code}, the record is at revision ${error.actualRevision}`,
  );
}
for (const revision of await memory.history(deployWindow.id))
  console.log(`   history: r${revision.revision} "${revision.text}"`);
const [then] = await memory.recall({ text: 'deploy window', recordedAsOf: beforeFix });
const [today] = await memory.recall({ text: 'deploy window' });
console.log(
  `   recall as recorded before the fix: r${then?.record.revision} "${then?.record.text}"`,
);
console.log(`   recall now: r${today?.record.revision} "${today?.record.text}"`);

// --- THE RUN ----------------------------------------------------------------
const tools: AgentToolSet = {
  schedule_deploy: {
    description: 'Book a deploy of a service to a region in a window.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        region: { type: 'string' },
        window: { type: 'string' },
      },
      required: ['service', 'region', 'window'],
      additionalProperties: false,
    },
    needsApproval: true,
    execute: ({ service, region, window }: { service: string; region: string; window: string }) => {
      console.log(`   [tool] schedule_deploy(${service}, ${region}, ${window})`);
      return { booked: true };
    },
  },
};

const options: AgentRunOptionsV3 = {
  model,
  prompt:
    'Schedule my billing deploy, and post in #billing when it is done. Do that after every deploy.',
  tools,
  checkpointVersion: 3,
  session: { store: runs, runId: 'deploy-billing', scope: 'acme' },
  // Memory is a context source: the compiler recalls and places it (the legacy recall stays off).
  context: { sources: [createMemoryContextSource({ session: memory })] },
  // The host sets the goal and constraints; they are placed at the end of every request.
  workingMemory: {
    create: {
      scope: 'acme',
      goal: "Book Ada's billing deploy",
      constraints: ['Deploy only inside the agreed window.'],
      now,
    },
  },
  // The model gets memory_remember / recall / revise / retract, bound to Ada's scope.
  versionedMemory: { session: memory, tools: true },
};

/** Prints a V3 stream's own events: each step's manifest and the memory intents. */
async function follow(stream: AgentStreamV3): Promise<void> {
  for await (const event of stream.eventsV3) {
    if (event.type === 'context') {
      const { manifest } = event;
      const placed = manifest.entries
        .filter((entry) => entry.selected && entry.kind !== 'working-memory')
        .map((entry) => `${entry.recordId}@${entry.revision}`);
      const already = manifest.entries.filter((entry) => entry.reason === 'already-placed').length;
      const flags = manifest.redacted ? ', redacted: true' : '';
      const left = already ? `, ${already} already placed` : '';
      console.log(
        `   [context] step ${event.step} (refresh: ${manifest.refresh}${flags}): placed ${placed.join(' ') || 'nothing new'}${left}; working memory ${manifest.placement.tail ? 'in the tail' : 'absent'}`,
      );
    } else if (event.type === 'memory-intent') {
      console.log(`   [memory-intent] ${event.status}`);
    } else if (event.type === 'part' && event.part.type === 'tool-call') {
      console.log(`   [model] ${event.part.toolName}(${JSON.stringify(event.part.input)})`);
    }
  }
}

console.log('\n3) a V3 run: memory and working memory placed by the context compiler');
const first = streamAgent(options);
await follow(first);
const suspended = await first.result;
console.log(`   status: ${suspended.status}`);
if (suspended.status !== 'suspended')
  throw new Error(`expected an approval wait, got ${suspended.status}`);
const stored = (await runs.load('deploy-billing'))!;
const block = stored.messages.find(
  (message) => typeof message.content === 'string' && message.content.startsWith('<deuz_context '),
);
const labels = String(block?.content)
  .split('\n')
  .filter((line) => line.startsWith('<record '));
console.log('   the block in the history labels each record as data:');
for (const line of labels) console.log(`     ${line}`);
const inferred = (await memory.recall({ text: '#billing' }))[0]?.record;
if (inferred) console.log(`   written by the model: ${show(inferred)}`);

console.log('\n4) the password should never have been stored: forget it while the run waits');
const forgot = await memory.forget(secret.id, { operationId: 'forget-password' });
console.log(
  `   forget ${forgot.recordId}: revisions [${forgot.revisions.join(', ')}], redaction ${forgot.redaction}`,
);
const packages = stored.context?.steps ?? [];
for (const step of packages)
  console.log(`   step ${step.step} package: ${(await runs.getBlob(step.blob.digest)).status}`);
console.log(`   recall "password": ${(await memory.recall({ text: 'password' })).length} hits`);

console.log('\n5) a person approves; the resumed run drops the redacted block and compiles again');
const resumed = resumeStreamAgent({
  ...options,
  approvalResponses: suspended.pendingApprovals.map((request) => ({
    approvalId: request.approvalId,
    approved: true, // in production: the authenticated user's decision
    token: request.token,
  })),
});
await follow(resumed);
const done = await resumed.result;
console.log(`   status: ${done.status}: "${done.text}"`);
const final = (await runs.load('deploy-billing'))!;
const blocks = final.messages.filter(
  (message) => typeof message.content === 'string' && message.content.startsWith('<deuz_context '),
);
console.log(`   retrieval blocks in the history: ${blocks.length} (step 0's was dropped)`);
console.log(
  `   the stored run still holds the password: ${JSON.stringify(final).includes('hunter2')}`,
);
console.log(
  `   the working memory tail entered the history: ${JSON.stringify(final.messages).includes('<deuz_working_memory')}`,
);
console.log(`   memory intents: ${final.memoryIntents?.map((intent) => intent.status).join(', ')}`);
const left = await memory.recall({ topK: 10 });
console.log(
  `   Ada's records now: ${left.map(({ record }) => `${record.id} r${record.revision}`).join(', ')}`,
);
