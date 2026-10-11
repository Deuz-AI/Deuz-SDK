/**
 * approval-identity.test.ts (2.3, roadmap 23.2) — an approval verdict is bound
 * to the call it was issued for: the run, the model step, the tool call id, the
 * tool name and the arguments.
 *
 * Providers that do not send call ids get `tool_0`, `tool_1`, … from the
 * adapter in every response, so before 2.3 an `approvalId` (then equal to the
 * tool call id) repeated across steps: a verdict a caller had kept from an
 * earlier gate approved whatever the model later issued under the same id —
 * another tool, other arguments, or the same call again at a later step.
 *
 * Offline: the mock model scripts every turn with the recycled id `tool_0`.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/generate';
import {
  createApprovalSigner,
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
} from '../src/durable';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { agentTool } from '../src/inference/agent-tool';
import { createMockModel, type MockResponse } from '../src/testing';
import type { CommonCallOptions } from '../src/types/config';
import type { Message } from '../src/types/message';
import type { ToolApprovalResponse, ToolSet } from '../src/types/tool';

const parameters = {
  type: 'object' as const,
  properties: { amount: { type: 'number' } },
  required: ['amount'],
};

const call = (toolName: string, amount: number): MockResponse => ({
  toolCalls: [{ toolName, id: 'tool_0', args: { amount } }],
});

function payTools() {
  const pay = vi.fn(async (args: { amount: number }) => `paid ${args.amount}`);
  const refund = vi.fn(async (args: { amount: number }) => `refunded ${args.amount}`);
  const tools: ToolSet = {
    pay: { parameters, needsApproval: true, execute: (a) => pay(a as { amount: number }) },
    refund: { parameters, needsApproval: true, execute: (a) => refund(a as { amount: number }) },
  };
  return { pay, refund, tools };
}

const approve = (approvalId: string): ToolApprovalResponse => ({ approvalId, approved: true });

type Entry = 'generateText' | 'streamChat';

/** One call through either entry point: the approval ids it issued. */
async function leg(entry: Entry, options: CommonCallOptions): Promise<string[]> {
  if (entry === 'generateText') {
    return (await generateText(options)).pendingApprovals?.map((r) => r.approvalId) ?? [];
  }
  const ids: string[] = [];
  for await (const part of streamChat(options).fullStream) {
    if (part.type === 'tool-approval-request') ids.push(part.approvalId);
  }
  return ids;
}

describe('approval identity: a stateless resume (no session)', () => {
  it.each([
    ['other arguments', call('pay', 500)],
    ['another tool', call('refund', 5)],
  ])('a kept verdict never authorizes %s under a recycled tool_0 id', async (_label, second) => {
    const { pay, refund, tools } = payTools();
    const model = createMockModel({ responses: [call('pay', 5), second, { text: 'done' }] });
    const user: Message = { role: 'user', content: 'pay' };

    const first = await generateText({ model, messages: [user], tools, maxSteps: 4 });
    expect(first.pendingApprovals).toHaveLength(1);
    const kept = approve(first.pendingApprovals![0]!.approvalId);
    const history1 = [user, ...first.response.messages];

    const secondLeg = await generateText({
      model,
      messages: history1,
      tools,
      maxSteps: 4,
      approvalResponses: [kept],
    });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(secondLeg.pendingApprovals).toHaveLength(1);
    // A new gate, under the same provider call id, gets its own approval id.
    expect(secondLeg.pendingApprovals![0]!.toolCallId).toBe('tool_0');
    expect(secondLeg.pendingApprovals![0]!.approvalId).not.toBe(kept.approvalId);

    // The caller re-sends the verdict it kept: it must not approve the new call.
    const third = await generateText({
      model,
      messages: [...history1, ...secondLeg.response.messages],
      tools,
      maxSteps: 4,
      approvalResponses: [kept],
    });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    // The settle answers the call with a denial, in the leg's first message.
    expect(third.response.messages[0]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'tool_0', isError: true }],
    });
    expect(JSON.stringify(third.response.messages[0])).toContain('Tool call denied');
  });

  it('honours a verdict that echoes the approval id it was shown', async () => {
    const { pay, tools } = payTools();
    const model = createMockModel({ responses: [call('pay', 500), { text: 'done' }] });
    const user: Message = { role: 'user', content: 'pay' };
    const first = await generateText({ model, messages: [user], tools, maxSteps: 4 });
    const resumed = await generateText({
      model,
      messages: [user, ...first.response.messages],
      tools,
      maxSteps: 4,
      approvalResponses: [approve(first.pendingApprovals![0]!.approvalId)],
    });
    expect(pay).toHaveBeenCalledWith({ amount: 500 });
    expect(resumed.text).toBe('done');
  });

  it('still honours the 2.2 form (the tool call id) when that id is unique in the run', async () => {
    const { pay, tools } = payTools();
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'pay', id: 'call_ab12', args: { amount: 5 } }] }],
    });
    const user: Message = { role: 'user', content: 'pay' };
    const first = await generateText({ model, messages: [user], tools, maxSteps: 1 });
    await generateText({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      messages: [user, ...first.response.messages],
      tools,
      approvalResponses: [approve('call_ab12')],
    });
    expect(pay).toHaveBeenCalledWith({ amount: 5 });
  });

  it('does not take the 2.2 form for an id the history already reused', async () => {
    const { pay, tools } = payTools();
    const free = vi.fn(async () => 'looked');
    const all: ToolSet = { ...tools, look: { parameters, execute: free } };
    const model = createMockModel({
      responses: [call('look', 1), call('pay', 5), { text: 'done' }],
    });
    const user: Message = { role: 'user', content: 'pay' };
    const first = await generateText({ model, messages: [user], tools: all, maxSteps: 4 });
    expect(free).toHaveBeenCalledTimes(1);
    expect(first.pendingApprovals).toHaveLength(1);
    await generateText({
      model,
      messages: [user, ...first.response.messages],
      tools: all,
      maxSteps: 4,
      approvalResponses: [approve('tool_0')],
    });
    expect(pay).not.toHaveBeenCalled();
  });

  it('never lets an approval of the arguments a guardrail produced cover different ones', async () => {
    const { pay, tools } = payTools();
    let rewrites = 0;
    const model = createMockModel({ responses: [call('pay', 5), { text: 'done' }] });
    // A non-deterministic rewrite: the resume leg re-evaluates it and gets other arguments.
    const onToolCall = () => ({ action: 'rewrite' as const, args: { amount: ++rewrites } });
    const user: Message = { role: 'user', content: 'pay' };
    const first = await generateText({
      model,
      messages: [user],
      tools,
      maxSteps: 4,
      guardrails: { onToolCall },
    });
    expect(first.pendingApprovals![0]!.input).toEqual({ amount: 1 });
    await generateText({
      model,
      messages: [user, ...first.response.messages],
      tools,
      maxSteps: 4,
      guardrails: { onToolCall },
      approvalResponses: [approve(first.pendingApprovals![0]!.approvalId)],
    });
    expect(pay).not.toHaveBeenCalled();
  });
});

describe('approval identity: a durable resume binds the run and the step', () => {
  it('a kept verdict never approves the same call again at a later step', async () => {
    const { pay, tools } = payTools();
    const store = createInMemorySessionStore();
    const model = createMockModel({ responses: [call('pay', 5), call('pay', 5), { text: 'x' }] });
    const first = await generateText({
      model,
      messages: [{ role: 'user', content: 'pay twice' }],
      tools,
      maxSteps: 6,
      session: { store, runId: 'r' },
    });
    const kept = approve(first.pendingApprovals![0]!.approvalId);
    const second = await resumeFromCheckpoint(store, 'r', {
      model,
      tools,
      maxSteps: 6,
      approvalResponses: [kept],
    });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(second.pendingApprovals![0]!.approvalId).not.toBe(kept.approvalId);
    await resumeFromCheckpoint(store, 'r', {
      model,
      tools,
      maxSteps: 6,
      approvalResponses: [kept],
    });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('a kept verdict from another run never approves this one', async () => {
    const { pay, tools } = payTools();
    const store = createInMemorySessionStore();
    const runA = await generateText({
      model: createMockModel({ responses: [call('pay', 5)] }),
      messages: [{ role: 'user', content: 'pay' }],
      tools,
      session: { store, runId: 'a' },
    });
    await generateText({
      model: createMockModel({ responses: [call('pay', 5)] }),
      messages: [{ role: 'user', content: 'pay' }],
      tools,
      session: { store, runId: 'b' },
    });
    await resumeFromCheckpoint(store, 'b', {
      model: createMockModel({ responses: [{ text: 'done' }] }),
      tools,
      approvalResponses: [approve(runA.pendingApprovals![0]!.approvalId)],
    });
    expect(pay).not.toHaveBeenCalled();
  });
});

// An app may continue one durable run with plain calls that carry its `session`
// (no `resumeFromCheckpoint`), reading each turn's history off the checkpoint.
// Every such leg continues the run's step counter, so a gate is never bound to
// a step the run already issued an approval for.
describe('approval identity: plain-call legs of one durable run', () => {
  it.each(['generateText', 'streamChat'] as const)(
    '%s: a verdict kept from an earlier turn never approves the identical call of a later one',
    async (entry) => {
      const { pay, tools } = payTools();
      const store = createInMemorySessionStore();
      const session = { store, runId: `chat-${entry}` };
      const history = async () => (await store.load(session.runId))!.messages;
      const model = createMockModel({
        responses: [call('pay', 5), { text: 'paid' }, call('pay', 5), { text: 'paid again' }],
      });
      const base = { model, tools, maxSteps: 4, session };

      const [issued] = await leg(entry, { ...base, messages: [{ role: 'user', content: 'pay' }] });
      const kept = approve(issued!);
      await leg(entry, { ...base, messages: await history(), approvalResponses: [kept] });
      expect(pay).toHaveBeenCalledTimes(1);

      const turn: Message = { role: 'user', content: 'pay again' };
      const [fresh] = await leg(entry, { ...base, messages: [...(await history()), turn] });
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(kept.approvalId);
      // The run's boundaries: suspended #1, completed #2, suspended #3.
      expect((await store.load(session.runId))!.stepId).toBe(`${session.runId}#3`);

      // The client re-sends the verdict it kept from the first gate.
      await leg(entry, { ...base, messages: await history(), approvalResponses: [kept] });
      expect(pay).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['generateText', 'streamChat'] as const)(
    '%s: the identical call issued again inside the verdict leg gets a new approval id',
    async (entry) => {
      const { pay, tools } = payTools();
      const store = createInMemorySessionStore();
      const session = { store, runId: `again-${entry}` };
      const history = async () => (await store.load(session.runId))!.messages;
      const model = createMockModel({ responses: [call('pay', 5), call('pay', 5), { text: 'x' }] });
      const base = { model, tools, maxSteps: 4, session };

      const [issued] = await leg(entry, { ...base, messages: [{ role: 'user', content: 'pay' }] });
      const kept = approve(issued!);
      // The verdict leg runs the approved call, then the model issues it again.
      const [again] = await leg(entry, {
        ...base,
        messages: await history(),
        approvalResponses: [kept],
      });
      expect(pay).toHaveBeenCalledTimes(1);
      expect(again).toBeDefined();
      expect(again).not.toBe(kept.approvalId);

      await leg(entry, { ...base, messages: await history(), approvalResponses: [kept] });
      expect(pay).toHaveBeenCalledTimes(1);
    },
  );

  it('a kept signed approval of an earlier turn is refused at a later gate', async () => {
    const { pay, tools } = payTools();
    const store = createInMemorySessionStore();
    const session = { store, runId: 'chat-signed' };
    const history = async () => (await store.load(session.runId))!.messages;
    const model = createMockModel({
      responses: [call('pay', 5), { text: 'paid' }, call('pay', 5), { text: 'paid again' }],
    });
    const approvalSigner = createApprovalSigner({ secret: 'k' });
    const base = { model, tools, maxSteps: 4, session, approvalSigner };

    const first = await generateText({ ...base, messages: [{ role: 'user', content: 'pay' }] });
    const request = first.pendingApprovals![0]!;
    const kept: ToolApprovalResponse = {
      approvalId: request.approvalId,
      approved: true,
      token: request.token!,
    };
    await generateText({ ...base, messages: await history(), approvalResponses: [kept] });
    expect(pay).toHaveBeenCalledTimes(1);

    const turn: Message = { role: 'user', content: 'pay again' };
    const next = await generateText({ ...base, messages: [...(await history()), turn] });
    const fresh = next.pendingApprovals![0]!;
    // The kept token, re-sent under the new approval id, names the earlier gate.
    await generateText({
      ...base,
      messages: await history(),
      approvalResponses: [{ ...kept, approvalId: fresh.approvalId }],
    });
    expect(pay).toHaveBeenCalledTimes(1);
  });
});

// What compaction or a windowing `prepareStep` does to a long run: once a call
// has been answered, the model sees a summary turn instead of the history, and
// the checkpoint stores what the model saw.
const windowed = ({ messages }: { messages: Message[] }) =>
  messages.some((m) => m.role === 'tool')
    ? { messages: [{ role: 'user', content: 'summary: 5 was paid; continue' } as Message] }
    : undefined;
// A 2.2-style client answers with the bare tool call id, and keeps it.
const bare: ToolApprovalResponse = { approvalId: 'tool_0', approved: true };

// The 2.2 form names a tool call id, so it can answer only an id the run issued
// one approval request under. The history alone cannot tell once it has been
// rewritten: the run keeps that count on its checkpoint.
describe('approval identity: the 2.2 form counts once per run, not once per history', () => {
  it.each(['resumeFromCheckpoint', 'resumeStreamFromCheckpoint'] as const)(
    '%s: a kept bare verdict never approves other arguments after the history was rewritten',
    async (entry) => {
      const { pay, tools } = payTools();
      const store = createInMemorySessionStore();
      const model = createMockModel({
        responses: [call('pay', 5), call('pay', 500), { text: 'x' }],
      });
      const options = { model, tools, maxSteps: 6, prepareStep: windowed };
      const resume = async (): Promise<void> => {
        const leg = { ...options, approvalResponses: [bare] };
        if (entry === 'resumeFromCheckpoint') await resumeFromCheckpoint(store, 'r', leg);
        else await resumeStreamFromCheckpoint(store, 'r', leg).consume!();
      };
      await generateText({
        ...options,
        messages: [{ role: 'user', content: 'pay' }],
        session: { store, runId: 'r' },
      });
      await resume();
      // The 2.2 form answered the run's only request under tool_0.
      expect(pay).toHaveBeenCalledWith({ amount: 5 });
      expect((await store.load('r'))!.pendingApprovals![0]!.input).toEqual({ amount: 500 });

      await resume();
      expect(pay).toHaveBeenCalledTimes(1);
    },
  );

  it('plain-call legs: a kept bare verdict never approves other arguments', async () => {
    const { pay, tools } = payTools();
    const store = createInMemorySessionStore();
    const history = async () => (await store.load('plain'))!.messages;
    const model = createMockModel({ responses: [call('pay', 5), call('pay', 500), { text: 'x' }] });
    const base = {
      model,
      tools,
      maxSteps: 6,
      prepareStep: windowed,
      session: { store, runId: 'plain' },
    };
    await generateText({ ...base, messages: [{ role: 'user', content: 'pay' }] });
    const second = await generateText({
      ...base,
      messages: await history(),
      approvalResponses: [bare],
    });
    expect(pay).toHaveBeenCalledWith({ amount: 5 });
    expect(second.pendingApprovals![0]!.input).toEqual({ amount: 500 });

    await generateText({ ...base, messages: await history(), approvalResponses: [bare] });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('native run: a kept bare verdict leaves the later gate suspended', async () => {
    const execute = vi.fn(async (args: { amount: number }) => `paid ${args.amount}`);
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [call('pay', 5), call('pay', 500), { text: 'x' }] });
    const options = {
      model,
      prompt: 'pay',
      prepareStep: windowed,
      tools: { pay: { parameters, needsApproval: true, execute } },
      session: { store, runId: 'n-bare', scope: 't' },
    };
    expect((await runAgent(options)).status).toBe('suspended');
    const second = await resumeAgent({ ...options, approvalResponses: [bare] });
    expect(second.status).toBe('suspended');
    const third = await resumeAgent({ ...options, approvalResponses: [bare] });
    expect(third.status).toBe('suspended');
    // `execute` also receives its ctx, so compare the arguments alone.
    expect(execute.mock.calls.map(([args]) => args)).toEqual([{ amount: 5 }]);
  });

  it('a checkpoint written without the count still resumes, and the history decides', async () => {
    const { pay, tools } = payTools();
    const store = createInMemorySessionStore();
    const model = createMockModel({ responses: [call('pay', 5), { text: 'done' }] });
    await generateText({
      model,
      messages: [{ role: 'user', content: 'pay' }],
      tools,
      maxSteps: 4,
      session: { store, runId: 'older' },
    });
    const { approvalRequestCounts, ...older } = (await store.load('older'))!;
    expect(approvalRequestCounts).toEqual({ tool_0: 1 });
    // What a writer without the count (2.2, or 2.3 before it) left in the store.
    await store.save(older);
    const resumed = await resumeFromCheckpoint(store, 'older', {
      model,
      tools,
      maxSteps: 4,
      approvalResponses: [bare],
    });
    expect(pay).toHaveBeenCalledWith({ amount: 5 });
    expect(resumed.text).toBe('done');
  });

  it("a sub-agent's count survives its resume and stays on the child's checkpoint", async () => {
    const pay = vi.fn(async () => 'paid');
    const store = createInMemorySessionStore();
    const worker = agentTool({
      name: 'worker',
      description: 'pays',
      model: createMockModel({ responses: [call('pay', 5), call('pay', 5)] }),
      tools: { pay: { parameters, needsApproval: true, execute: pay } },
      maxSteps: 4,
    });
    const parent = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'worker', id: 'tool_0', args: { prompt: 'pay' } }] }],
    });
    const options = { model: parent, tools: { worker }, maxSteps: 4 };
    const first = await generateText({
      ...options,
      messages: [{ role: 'user', content: 'pay' }],
      session: { store, runId: 'p' },
    });
    const request = first.pendingApprovals![0]!;
    expect(request.agentPath).toEqual(['worker']);
    await resumeFromCheckpoint(store, 'p', {
      ...options,
      approvalResponses: [approve(request.approvalId)],
    });
    expect(pay).toHaveBeenCalledTimes(1);
    expect((await store.load('p::worker#tool_0'))!.approvalRequestCounts).toEqual({ tool_0: 2 });
    // The parent issued no request of its own: the child's are the child's.
    expect((await store.load('p'))!.approvalRequestCounts).toBeUndefined();
  });
});

describe('approval identity: native runs', () => {
  it('a kept verdict leaves a later identical gate suspended instead of approving it', async () => {
    const execute = vi.fn(async (args: { amount: number }) => `paid ${args.amount}`);
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [call('pay', 5), call('pay', 5), { text: 'x' }] });
    const options = {
      model,
      prompt: 'pay twice',
      tools: { pay: { parameters, needsApproval: true, execute } },
      session: { store, runId: 'n', scope: 't' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const kept =
      first.status === 'suspended' ? approve(first.pendingApprovals[0]!.approvalId) : undefined;
    const second = await resumeAgent({ ...options, approvalResponses: [kept!] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('suspended');
    const third = await resumeAgent({ ...options, approvalResponses: [kept!] });
    expect(third.status).toBe('suspended');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a kept signed approval of the same call is not accepted at a later step', async () => {
    const execute = vi.fn(async (args: { amount: number }) => `paid ${args.amount}`);
    const approvalSigner = createApprovalSigner({ secret: 'k' });
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [call('pay', 5), call('pay', 5), { text: 'x' }] });
    const options = {
      model,
      prompt: 'pay twice',
      approvalSigner,
      tools: { pay: { parameters, needsApproval: true, execute } },
      session: { store, runId: 'signed', scope: 't' },
    };
    const first = await runAgent(options);
    const request = first.status === 'suspended' ? first.pendingApprovals[0]! : undefined;
    const kept: ToolApprovalResponse = {
      approvalId: request!.approvalId,
      approved: true,
      token: request!.token!,
    };
    const second = await resumeAgent({ ...options, approvalResponses: [kept] });
    expect(execute).toHaveBeenCalledTimes(1);
    const fresh = second.status === 'suspended' ? second.pendingApprovals[0]! : undefined;
    // The kept token, re-sent under the new approval id, is bound to the old one.
    await resumeAgent({
      ...options,
      approvalResponses: [{ ...kept, approvalId: fresh!.approvalId }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
