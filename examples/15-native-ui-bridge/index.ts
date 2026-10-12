/**
 * 15 — Native UI bridge: a native run on the Deuz UI wire, read back by a
 * client in the same process (2.3).
 *
 * The server half is a route function, `POST(request)`, with the `Request` to
 * `Response` signature of a Next.js route handler or any other Fetch API
 * server. It starts a run with `streamAgent`, or resumes one with
 * `resumeStreamAgent`, and serves it with `toDeuzAgentStreamResponse`. Next to
 * the run's text and tool parts, the wire carries `data-agent` frames: the run
 * id, the phases, drafts of the output and the terminal state. The client half
 * reads the response body with `readDeuzStream`, folds the frames into the
 * run's state with `agentStateFromParts`, and folds every part into the
 * assistant turn it renders with `applyUIPart`. No framework, browser or
 * server process.
 */
import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '@deuz-sdk/core/agent';
import type { AgentOutput, AgentRunOptions } from '@deuz-sdk/core/agent';
import { applyUIPart, createAssistantTurn, validateChatRequest } from '@deuz-sdk/core/chat';
import { createMockModel } from '@deuz-sdk/core/testing';
import {
  agentStateFromParts,
  createInMemoryStreamStateStore,
  negotiateDeuzStreamVersion,
  readDeuzStream,
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
} from '@deuz-sdk/core/ui';
import type { DeuzAgentState, DeuzUIPart } from '@deuz-sdk/core/ui';

// --- MODEL ------------------------------------------------------------------
// A scripted model, so this runs without an API key: one reply per model call,
// in order. REAL PROVIDER: replace `createMockModel({ ... })` with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({
  responses: [
    // call 1 (first request): the model asks for a gated tool, so the run suspends.
    { toolCalls: [{ toolName: 'refund', args: { orderId: 'A-17', amountUsd: 42 } }] },
    // call 2 (the resume): the approved tool has run; the tool loop ends.
    { text: 'Refunded $42 for order A-17.' },
    // call 3: finalization, the structured output.
    { text: '{"orderId":"A-17","refundedUsd":42,"status":"refunded"}' },
  ],
});

type Receipt = { orderId: string; refundedUsd: number; status: 'refunded' };

// The JSON Schema goes on the wire; `validate` certifies the value on the server.
const output: AgentOutput<Receipt> = {
  mode: 'json',
  schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      refundedUsd: { type: 'number' },
      status: { type: 'string', enum: ['refunded'] },
    },
    required: ['orderId', 'refundedUsd', 'status'],
    additionalProperties: false,
  },
  validate(value) {
    const receipt = value as Partial<Receipt> | null;
    if (typeof receipt?.orderId !== 'string' || typeof receipt.refundedUsd !== 'number')
      throw new Error('expected { orderId, refundedUsd, status }');
    return { orderId: receipt.orderId, refundedUsd: receipt.refundedUsd, status: 'refunded' };
  },
};

// --- SERVER -----------------------------------------------------------------
const runs = createInMemoryAgentRunStore(); // durable: createSqliteOpsStore(...).agentRuns
const streams = createInMemoryStreamStateStore(); // shared by every instance: Redis, a database
const agent: AgentRunOptions<Receipt> = {
  model,
  output,
  bindingId: 'refunds-v1', // bump it when the tools or the output change meaning
  tools: {
    refund: {
      description: 'Refund an order in full.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' }, amountUsd: { type: 'number' } },
        required: ['orderId', 'amountUsd'],
        additionalProperties: false,
      },
      needsApproval: true,
      execute: ({ orderId, amountUsd }: { orderId: string; amountUsd: number }) => {
        console.log(`   [server] refund(${orderId}, $${amountUsd}) executed`);
        return { refunded: true };
      },
    },
  },
};
let created = 0;

/** POST /api/agent: starts a run, or resumes the one `runId` names with the user's verdicts. */
async function POST(request: Request): Promise<Response> {
  const parsed = validateChatRequest(await request.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
  const { messages, approvalResponses, rest } = parsed.request;
  const scope = 'tenant-a'; // the signed-in user's tenant, never a field of the body
  const resuming = typeof rest.runId === 'string';
  // crypto.randomUUID() in production; a counter keeps this output stable.
  const runId = resuming ? (rest.runId as string) : `refund-${++created}`;
  if (resuming) {
    // Only this tenant's run, and only while it waits for answers.
    const stored = await runs.load(runId);
    if (stored?.scope !== scope) return new Response('Unknown run', { status: 404 });
    if (stored.result?.status !== 'suspended') return new Response('Not waiting', { status: 409 });
  }
  const session = { store: runs, runId, scope };
  // A resume reads the run's history from its store, not from the posted messages.
  const stream = resuming
    ? resumeStreamAgent({ ...agent, session, approvalResponses: approvalResponses ?? [] })
    : streamAgent({ ...agent, session, messages });
  // Every leg of the run goes into one journal, so `seq` grows across them.
  return toDeuzAgentStreamResponse(stream, {
    runId,
    store: streams,
    streamId: runId,
    wireVersion: negotiateDeuzStreamVersion(request),
  });
}

// --- CLIENT -----------------------------------------------------------------
const user = {
  role: 'user',
  content: 'Order A-17 arrived broken. Refund it and send the receipt.',
};
/** The run as this client sees it: folded from the `data-agent` frames of every response. */
let state = agentStateFromParts<Receipt>([]);
/** The assistant turn the client renders: text, tool cards, approval requests. */
let turn = createAssistantTurn('turn-1');
/** The state of each tool card, by call id, as last printed. */
const cards = new Map<string, string>();

function describe(run: DeuzAgentState<Receipt>): string {
  const at = `seq ${run.seq}`;
  switch (run.status) {
    case 'running':
      if (run.partial) return `${at}: running, draft ${JSON.stringify(run.partial.value)}`;
      return run.phase ? `${at}: running, phase ${run.phase}` : `${at}: running (run ${run.runId})`;
    case 'suspended':
      return `${at}: suspended, waiting for ${run.pendingApprovals.length} approval`;
    case 'stopped':
      return `${at}: stopped (${run.reason})`;
    case 'failed':
      return `${at}: failed (${run.error.message})`;
    default:
      return `${at}: ${run.status}`;
  }
}

/** One request to the route; its response body is read and folded part by part. */
async function send(body: Record<string, unknown>): Promise<void> {
  const response = await POST(
    new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  console.log(
    `   HTTP ${response.status}, x-deuz-stream: ${response.headers.get('x-deuz-stream')}`,
  );
  for await (const part of readDeuzStream(response)) {
    const next = agentStateFromParts([part], state);
    if (next !== state) console.log(`   [agent] ${describe(next)}`);
    state = next;
    turn = applyUIPart(turn, part);
    for (const call of turn.message.toolCalls ?? []) {
      if (cards.get(call.toolCallId) === call.state) continue;
      cards.set(call.toolCallId, call.state);
      console.log(`   [turn] ${call.toolName}: ${call.state}`);
    }
  }
}

console.log('1) POST /api/agent: the run starts, and stops at an approval');
await send({ messages: [user] });
const waiting = state;
if (waiting.status !== 'suspended') throw new Error(`expected a suspension, got ${waiting.status}`);
for (const request of waiting.pendingApprovals)
  console.log(`   pending action: approve ${request.toolName}(${JSON.stringify(request.input)})?`);

console.log('\n2) the user approves: one POST with the run id and the verdict resumes the run');
await send({
  messages: [user],
  runId: waiting.runId,
  approvalResponses: waiting.pendingApprovals.map((request) => ({
    approvalId: request.approvalId,
    approved: true, // the user's click
    ...(request.token ? { token: request.token } : {}),
  })),
});
const done = state;
if (done.status === 'completed') {
  // `output` exists only once completed: the value the server validated, typed as Receipt.
  console.log(`   output: ${JSON.stringify(done.output)}`);
  console.log(
    `   receipt: $${done.output.refundedUsd.toFixed(2)} refunded on order ${done.output.orderId}`,
  );
}

console.log('\n3) another tab opens the run: its journal replays every leg from the start');
const replayed: DeuzUIPart[] = [];
for await (const part of readDeuzStream(resumeDeuzStreamResponse(streams, done.runId!)))
  replayed.push(part);
const fresh = agentStateFromParts<Receipt>(replayed);
const shown = fresh.status === 'completed' ? ` ${JSON.stringify(fresh.output)}` : '';
console.log(
  `   replayed ${replayed.length} parts; a fresh client folds it into: ${fresh.status}${shown}`,
);
const unchanged = agentStateFromParts(replayed, state) === state;
console.log(`   the state this client holds comes back unchanged: ${unchanged}`);
