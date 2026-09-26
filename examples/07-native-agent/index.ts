/**
 * 07 — Native agent: a validated result and an approval that suspends and resumes.
 *
 * `runAgent` (2.1) returns an explicit outcome instead of "some text". Only a
 * `completed` result carries `output`, and only after your validator (and
 * verifier) accepted it. A tool marked `needsApproval` suspends the run: the
 * checkpoint sits in an `AgentRunStore`, and `resumeAgent` continues the SAME
 * run once a human has decided — in this process or in another one.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '@deuz-sdk/core/agent';
import type { AgentOutput, AgentRunOptions, AgentRunSession } from '@deuz-sdk/core/agent';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// A scripted model, so this runs without an API key: one reply per model call,
// in order. REAL PROVIDER: replace `createMockModel({ ... })` with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({
  responses: [
    // call 1 (run): the model asks for a gated tool, so the run suspends.
    { toolCalls: [{ toolName: 'refund', args: { orderId: 'A-17', amountUsd: 42 } }] },
    // call 2 (resume): the approved tool has run; the tool loop ends.
    { text: 'Refund issued for order A-17.' },
    // call 3: finalization. A field is missing, so validation rejects it...
    { text: '{"orderId":"A-17"}' },
    // call 4: ...and the repair attempt returns the complete object.
    { text: '{"orderId":"A-17","refundedUsd":42,"status":"refunded"}' },
  ],
});

type Receipt = { orderId: string; refundedUsd: number; status: 'refunded' };

// The JSON Schema goes on the wire; `validate` is what certifies the value at
// runtime. A Standard Schema (zod, valibot) can play both roles.
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
    if (typeof receipt?.orderId !== 'string' || typeof receipt.refundedUsd !== 'number') {
      console.log(`   [validate] rejected ${JSON.stringify(value)}; the engine asks for a repair`);
      throw new Error('expected { orderId, refundedUsd, status }');
    }
    console.log(`   [validate] accepted ${JSON.stringify(value)}`);
    return { orderId: receipt.orderId, refundedUsd: receipt.refundedUsd, status: 'refunded' };
  },
};

const store = createInMemoryAgentRunStore(); // durable: createSqliteOpsStore(...).agentRuns
const options: AgentRunOptions<Receipt> & { session: AgentRunSession } = {
  model,
  prompt: 'Order A-17 arrived broken. Refund it, then report the receipt as JSON.',
  bindingId: 'refunds-v1', // bump it when the tools or the verifier change meaning
  session: { store, runId: 'refund-A-17', scope: 'tenant-a' },
  maxSteps: 6,
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
        console.log(`   [tool] refund(${orderId}, $${amountUsd}) executed`);
        return { refunded: true };
      },
    },
  },
  output,
  // Validation checks the shape; the verifier checks the answer.
  verify: ({ output: receipt }) => {
    const ok = receipt.refundedUsd === 42;
    console.log(`   [verify] refundedUsd=${receipt.refundedUsd}: ${ok ? 'verified' : 'rejected'}`);
    return ok
      ? { status: 'verified' }
      : { status: 'rejected', feedback: 'The refund must equal the order total, $42.' };
  },
};

console.log('1) runAgent');
const first = await runAgent(options);
console.log(`   status: ${first.status}`);
if (first.status !== 'suspended')
  throw new Error(`expected a wait for approval, got ${first.status}`);
for (const request of first.pendingApprovals) {
  console.log(`   waiting for approval: ${request.toolName}(${JSON.stringify(request.input)})`);
}
const saved = await store.load('refund-A-17');
console.log(`   checkpoint: phase=${saved?.phase}, revision=${saved?.revision}`);

console.log('\n2) a human approves; resumeAgent continues the same run');
const resumed = await resumeAgent({
  ...options,
  approvalResponses: first.pendingApprovals.map((request) => ({
    approvalId: request.approvalId,
    approved: true, // in production: the authenticated user's decision
    token: request.token,
  })),
});
console.log(`   status: ${resumed.status}`);
if (resumed.status === 'completed') {
  // `output` exists only on `completed`: typed as Receipt, already validated.
  console.log(`   output: ${JSON.stringify(resumed.output)}`);
}
console.log(`   model steps: ${resumed.modelSteps}, tokens: ${resumed.usage.totalTokens}`);
