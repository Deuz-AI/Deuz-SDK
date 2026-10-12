/**
 * 20 — A2A agent: a native agent run served over A2A, and a client that talks to it (2.3).
 *
 * `createA2AHandler` serves an agent over the Agent2Agent protocol (A2A 1.0),
 * and `createA2AAgentExecutor` makes a native agent run its executor: each A2A
 * task is one run, kept in an `AgentRunStore` under the task's id. A run that
 * suspends on an approval is an `INPUT_REQUIRED` task listing the pending
 * actions in a data part; the client's next message answers them, and the
 * run's validated, typed output arrives as the task's artifact. Client and
 * agent share this process: the client's `fetch` calls the handler directly,
 * so nothing touches the network.
 */
import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '@deuz-sdk/core/agent';
import type { AgentOutput } from '@deuz-sdk/core/agent';
import {
  A2AError,
  a2aText,
  createA2AAgentExecutor,
  createA2AClient,
  createA2AHandler,
  fetchAgentCard,
  type A2AAgentAction,
  type A2AAgentCard,
  type A2AAgentPendingActions,
  type A2ATask,
} from '@deuz-sdk/core/a2a';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// A scripted model, so this runs without an API key: one reply per model call,
// in order. REAL PROVIDER: replace `createMockModel({ ... })` with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({
  responses: [
    // call 1: the model books a table; the tool needs an approval, so the run suspends.
    {
      toolCalls: [
        { toolName: 'bookTable', args: { restaurant: 'Lokanta', guests: 2, time: '19:30' } },
      ],
    },
    // call 2 (after the approval): the booking has run; the tool loop ends.
    { text: 'Booked a table for two at Lokanta, 19:30.' },
    // call 3: finalization, the typed result.
    { text: '{"reference":"LOK-1930-2","restaurant":"Lokanta","guests":2,"time":"19:30"}' },
  ],
});

// --- THE AGENT --------------------------------------------------------------
type Booking = { reference: string; restaurant: string; guests: number; time: string };

// The JSON Schema goes on the wire; `validate` certifies the value at runtime.
const output: AgentOutput<Booking> = {
  mode: 'json',
  schema: {
    type: 'object',
    properties: {
      reference: { type: 'string' },
      restaurant: { type: 'string' },
      guests: { type: 'number' },
      time: { type: 'string' },
    },
    required: ['reference', 'restaurant', 'guests', 'time'],
    additionalProperties: false,
  },
  validate(value) {
    const booking = value as Partial<Booking> | null;
    if (
      typeof booking?.reference !== 'string' ||
      typeof booking.restaurant !== 'string' ||
      typeof booking.guests !== 'number' ||
      typeof booking.time !== 'string'
    ) {
      throw new Error('expected { reference, restaurant, guests, time }');
    }
    return {
      reference: booking.reference,
      restaurant: booking.restaurant,
      guests: booking.guests,
      time: booking.time,
    };
  },
};

const card: A2AAgentCard = {
  name: 'Table booker',
  description: 'Books restaurant tables once you approve.',
  version: '1.0.0',
  // The handler serves this interface at its URL's path, on whatever host it runs.
  supportedInterfaces: [
    { url: 'https://booker.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'book-table',
      name: 'Book a table',
      description: 'Books a restaurant table; every booking needs your approval.',
      tags: ['restaurants'],
    },
  ],
};

const runs = createInMemoryAgentRunStore(); // durable: createSqliteOpsStore({ path }).agentRuns
// The handler checks the protocol, not the caller. Served for real, authenticate
// every request (and answer CORS preflights) in front of it, and name the
// verified caller, so callers reach only their own tasks and approvals:
//   owner: async (request) => (await verifySession(request))?.userId,
const handler = createA2AHandler({
  card,
  executor: createA2AAgentExecutor<Booking>({
    agent: { streamAgent, resumeStreamAgent },
    store: runs,
    run: {
      model,
      instructions: 'You book restaurant tables.',
      bindingId: 'table-booker-v1',
      tools: {
        bookTable: {
          description: 'Book a table at a restaurant.',
          parameters: {
            type: 'object',
            properties: {
              restaurant: { type: 'string' },
              guests: { type: 'number' },
              time: { type: 'string' },
            },
            required: ['restaurant', 'guests', 'time'],
          },
          needsApproval: true,
          execute: (args) => {
            console.log(`   [agent] bookTable ran with ${JSON.stringify(args)}`);
            return { confirmed: true };
          },
        },
      },
      output,
    },
    artifact: { name: 'booking', description: 'The confirmed booking.' },
  }),
});

// --- THE CLIENT -------------------------------------------------------------
// In production the client uses the global fetch against the agent's URL;
// here it calls the handler directly.
const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  handler(new Request(input, init))) as typeof globalThis.fetch;
const client = createA2AClient({
  card: await fetchAgentCard('https://booker.example.com', { deps: { fetch } }),
  deps: { fetch },
});

/** The data part of the task's status message with this `type`. */
function statusData<T>(task: A2ATask, type: string): T | undefined {
  const part = task.status.message?.parts.find(
    (candidate) => (candidate.data as { type?: unknown } | undefined)?.type === type,
  );
  return part?.data as T | undefined;
}

console.log(`1) the client asks ${client.card?.name} for a booking (streaming)`);
let taskId: string | undefined;
for await (const event of client.sendStreamingMessage('Book a table for two at Lokanta, 19:30.')) {
  if (event.task) taskId = event.task.id;
  const status = event.task?.status ?? event.statusUpdate?.status;
  if (status) console.log(`   ${status.state}`);
}
const asked = await client.getTask(taskId!);
console.log(`   "${a2aText(asked.status.message?.parts.slice(0, 1))}"`);
const pending = statusData<A2AAgentPendingActions>(asked, 'pending-actions');
for (const action of pending?.actions ?? []) {
  console.log(`   pending: ${action.kind} of ${action.toolName} ${JSON.stringify(action.input)}`);
}

console.log('\n2) an answer that does not fit is refused, and nothing changes');
try {
  await client.sendMessage('Sure, go ahead.', { taskId: asked.id });
} catch (error) {
  if (!(error instanceof A2AError)) throw error;
  console.log(
    `   ${error.reason}: ${error.message.split('. ')[0]?.replace(`Task ${asked.id}`, 'The task')}.`,
  );
}
console.log(`   still ${(await client.getTask(asked.id)).status.state}`);

console.log('\n3) the user approves; the client answers every pending action in a data part');
// Your app shows each pending action to the user; here the user approves them all.
const approvalResponses = (pending?.actions ?? []).flatMap((action: A2AAgentAction) =>
  action.kind === 'approval'
    ? [
        {
          approvalId: action.approvalId,
          approved: true,
          ...(action.token ? { token: action.token } : {}),
        },
      ]
    : [],
);
const answered = await client.sendMessage(
  [{ text: 'Approved.' }, { data: { approvalResponses } }],
  { taskId: asked.id },
);
const done = answered.task!;
console.log(`   ${done.status.state}`);
const artifact = done.artifacts?.[0];
const booking = artifact?.parts[0]?.data as Booking;
console.log(`   artifact '${artifact?.name}': ${JSON.stringify(booking)}`);

console.log('\n4) the task is the native run');
const run = await runs.load(done.id);
console.log(
  `   run ${run?.runId === done.id ? 'id = task id' : 'id differs'}, phase ${run?.phase}, ` +
    `status ${run?.result?.status}, scope ${run?.scope}`,
);
