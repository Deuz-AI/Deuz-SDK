/**
 * Faults around one tool call of a native run, in dispatch order: before the
 * call is dispatched, after its approval, between its effect and its receipt,
 * and between its receipt and the step checkpoint (native-agents.mdx, "When the
 * store fails").
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import type { AgentToolContext, AgentToolSet } from '../../../src/types/agent-run';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import {
  MOCK,
  costKept,
  failingOnce,
  mockPrices,
  parameters,
  ranOnce,
  scripted,
  stages,
} from './support';

const charge = { toolCalls: [{ toolName: 'charge', id: 'c1', args: {} }] };
const answer = { text: 'Charged order 7.' };

/** A payment tool: every execution charges the card once more. */
function chargeTool(
  context: EvalTaskContext,
  extra: { replay?: 'idempotent'; needsApproval?: boolean } = {},
): AgentToolSet {
  const effects = ((context.store.effects as string[] | undefined) ??= []);
  return {
    charge: {
      description: 'Charge order 7.',
      parameters,
      ...extra,
      execute: (_args: unknown, call: AgentToolContext) => {
        // An idempotent charge is keyed by its call identity; the payment
        // system drops a repeat of a key it has seen. Any charge it accepts
        // charges order 7, so a replay under another identity is a repeat.
        const key = extra.replay ? `charge:${call.modelStep}:${call.toolCallId}` : 'charge:order-7';
        if (extra.replay && effects.includes(key)) return 'charged';
        context.effect('charge:order-7');
        effects.push(key);
        return 'charged';
      },
    },
  };
}

const prompt = [{ role: 'user' as const, content: 'Charge order 7.' }];

export const beforeDispatch: EvalTaskManifest = {
  id: 'fault/before-dispatch',
  version: 1,
  title: "The 'executing' receipt cannot be written: the tool never ran",
  tags: ['fault', 'native', 'receipts'],
  model: MOCK,
  start: { messages: prompt },
  fault: { boundary: 'before-dispatch', recovery: 'replay-step' },
  acceptance: [
    { name: 'completes after resume', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:order-7'),
    costKept,
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    // The replayed step asks for the call again.
    const { model, calls } = scripted([charge, charge, answer]);
    const options = {
      model,
      messages: context.messages,
      tools: chargeTool(context),
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const store = failingOnce(
      durable,
      (envelope) => stages(envelope).includes('c1:executing'),
      () => context.interrupt('before-dispatch'),
    );
    const first = await runAgent({ ...options, session: { store, runId: 'r', scope: 'eval' } });
    const ranBefore = ((context.store.effects as string[] | undefined) ?? []).length;
    const resumed = await resumeAgent({
      ...options,
      session: { store: durable, runId: 'r', scope: 'eval' },
    });
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        first.status === 'failed' && ranBefore === 0 && calls() === 3 ? 'replay-step' : 'other',
    };
  },
};

export const afterApproval: EvalTaskManifest = {
  id: 'fault/after-approval',
  version: 1,
  title: 'The process dies after the human approved, before the call ran',
  tags: ['fault', 'native', 'approval'],
  model: MOCK,
  start: { messages: prompt },
  approvals: ['charge'],
  fault: { boundary: 'after-approval', recovery: 'verdict-replayed' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:order-7'),
    costKept,
    {
      name: 'the human decided once',
      check: (_outcome, context) => context.store.decisions === 1,
    },
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const { model, calls } = scripted([charge, answer]);
    const options = {
      model,
      messages: context.messages,
      tools: chargeTool(context, { needsApproval: true }),
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const session = { store: durable, runId: 'r', scope: 'eval' };
    const first = await runAgent({ ...options, session });
    if (first.status !== 'suspended') return first;
    // The application stores the human's verdict, then resumes.
    const verdicts = context.approve(first.pendingApprovals);
    context.store.decisions = verdicts.length;
    const store = failingOnce(
      durable,
      (envelope) => stages(envelope).includes('c1:executing'),
      () => context.interrupt('after-approval'),
    );
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store },
      approvalResponses: verdicts,
    });
    // The verdict was not consumed: the run still waits for it, and the stored
    // verdict answers it again without asking the human twice.
    const resumed = await resumeAgent({ ...options, session, approvalResponses: verdicts });
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery: crashed.status === 'failed' && calls() === 2 ? 'verdict-replayed' : 'other',
    };
  },
};

export const afterEffect: EvalTaskManifest = {
  id: 'fault/after-effect-before-receipt',
  version: 1,
  title: 'The store fails between the charge and its receipt',
  tags: ['fault', 'native', 'receipts', 'reconciliation'],
  model: MOCK,
  start: { messages: prompt },
  fault: { boundary: 'after-effect-before-receipt', recovery: 'reconciliation-stop' },
  acceptance: [
    {
      name: 'stops for reconciliation and names the call',
      check: (outcome) => {
        const stopped = outcome as { reason?: string; unknownEffects?: { toolCallId: string }[] };
        return (
          outcome.status === 'stopped' &&
          stopped.reason === 'tool-reconciliation-required' &&
          JSON.stringify(stopped.unknownEffects?.map((r) => r.toolCallId)) === '["c1"]'
        );
      },
    },
    ranOnce('charge:order-7'),
    costKept,
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const { model, calls } = scripted([charge, answer]);
    const options = {
      model,
      messages: context.messages,
      tools: chargeTool(context),
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const store = failingOnce(
      durable,
      () => ((context.store.effects as string[] | undefined) ?? []).length > 0,
      () => context.interrupt('after-effect-before-receipt'),
    );
    await runAgent({ ...options, session: { store, runId: 'r', scope: 'eval' } });
    const session = { store: durable, runId: 'r', scope: 'eval' };
    const resumed = await resumeAgent({ ...options, session });
    if (resumed.status === 'stopped' && resumed.reason === 'tool-reconciliation-required') {
      // A person checks the payment system: the charge landed, so nothing is retried.
      context.rescue('checked charge c1 in the payment system: it landed');
    }
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery: resumed.status === 'stopped' && calls() === 1 ? 'reconciliation-stop' : 'other',
    };
  },
};

export const afterEffectIdempotent: EvalTaskManifest = {
  id: 'fault/after-effect-before-receipt-idempotent',
  version: 1,
  title: 'The same fault for an idempotent tool: it runs again under the same identity',
  tags: ['fault', 'native', 'receipts', 'idempotent'],
  model: MOCK,
  start: { messages: prompt },
  fault: { boundary: 'after-effect-before-receipt', recovery: 'idempotent-replay' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:1:c1'),
    costKept,
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const { model, calls } = scripted([charge, answer]);
    let executions = 0;
    const tools = chargeTool(context, { replay: 'idempotent' });
    const execute = tools.charge!.execute!;
    tools.charge!.execute = (args, call) => {
      executions += 1;
      return execute(args, call);
    };
    const options = {
      model,
      messages: context.messages,
      tools,
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const store = failingOnce(
      durable,
      () => executions > 0,
      () => context.interrupt('after-effect-before-receipt'),
    );
    await runAgent({ ...options, session: { store, runId: 'r', scope: 'eval' } });
    const resumed = await resumeAgent({
      ...options,
      session: { store: durable, runId: 'r', scope: 'eval' },
    });
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery: executions === 2 && calls() === 2 ? 'idempotent-replay' : 'other',
    };
  },
};

export const afterReceipt: EvalTaskManifest = {
  id: 'fault/after-receipt-before-checkpoint',
  version: 1,
  title: 'The step checkpoint fails after the completed receipt',
  tags: ['fault', 'native', 'receipts'],
  model: MOCK,
  start: { messages: prompt },
  fault: { boundary: 'after-receipt-before-checkpoint', recovery: 'replay-recorded-result' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:order-7'),
    costKept,
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const { model, calls } = scripted([charge, answer]);
    const options = {
      model,
      messages: context.messages,
      tools: chargeTool(context),
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    let receiptSaved = false;
    const store = failingOnce(
      durable,
      (envelope) => {
        // The write after the one that recorded the completed receipt.
        const after = receiptSaved;
        if (stages(envelope).includes('c1:completed')) receiptSaved = true;
        return after;
      },
      () => context.interrupt('after-receipt-before-checkpoint'),
    );
    await runAgent({ ...options, session: { store, runId: 'r', scope: 'eval' } });
    const recorded = stages(await durable.load('r'));
    const resumed = await resumeAgent({
      ...options,
      session: { store: durable, runId: 'r', scope: 'eval' },
    });
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        JSON.stringify(recorded) === '["c1:completed"]' && calls() === 2
          ? 'replay-recorded-result'
          : 'other',
    };
  },
};

export const afterEffectReconciled: EvalTaskManifest = {
  id: 'fault/after-effect-before-receipt-reconciled',
  version: 1,
  title: 'The same fault, reconciled: the charge landed, and its outcome is recorded',
  tags: ['fault', 'native', 'receipts', 'reconciliation'],
  model: MOCK,
  start: { messages: prompt },
  fault: { boundary: 'after-effect-before-receipt', recovery: 'reconciled-result' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:order-7'),
    {
      name: 'the receipt keeps the reconciled outcome',
      check: (_outcome, context) => context.store.receipt === 'c1:completed:reconciled',
    },
    costKept,
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const { model, calls } = scripted([charge, answer]);
    const options = {
      model,
      messages: context.messages,
      tools: chargeTool(context),
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const store = failingOnce(
      durable,
      () => ((context.store.effects as string[] | undefined) ?? []).length > 0,
      () => context.interrupt('after-effect-before-receipt'),
    );
    await runAgent({ ...options, session: { store, runId: 'r', scope: 'eval' } });
    const session = { store: durable, runId: 'r', scope: 'eval' };
    const stopped = await resumeAgent({ ...options, session });
    const unknown = stopped.status === 'stopped' ? (stopped.unknownEffects ?? []) : [];
    // The application looks the order up in the payment system, which keeps
    // its own record of each charge: this one landed, so its outcome is
    // recorded and nothing runs again. No person is involved.
    const landed = ((context.store.effects as string[] | undefined) ?? []).includes(
      'charge:order-7',
    );
    const resumed = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: unknown
        .filter(() => landed)
        .map((receipt) => ({ toolCallId: receipt.toolCallId, output: 'charged' })),
    });
    const receipt = Object.values((await durable.load('r'))?.toolResults ?? {})[0];
    context.store.receipt = receipt
      ? `${receipt.toolCallId}:${receipt.stage}${receipt.reconciled ? ':reconciled' : ''}`
      : undefined;
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        stopped.status === 'stopped' &&
        stopped.reason === 'tool-reconciliation-required' &&
        calls() === 2
          ? 'reconciled-result'
          : 'other',
    };
  },
};
