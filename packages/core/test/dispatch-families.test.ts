/**
 * dispatch-families.test.ts (2.3, roadmap 23.2) — every family of tool call
 * takes the dispatch contract's one path: the policy (the execution policy and
 * the `onToolCall` guardrails), then the approval gate.
 *
 * Before 2.3 a handoff transfer was decided before the guardrails and the gate,
 * so `requireApproval`, `needsApproval` and a blocking guardrail never saw it; a
 * sub-agent's own tool calls ran outside the parent's guardrails; and an MCP
 * sampling request reached the model without the run's policy or budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/generate';
import { handoff } from '../src/inference/handoff';
import { agentTool } from '../src/inference/agent-tool';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { buildSamplingHandler, mcpToolsToToolSet, type McpClient } from '../src/mcp/shared';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';
import type { ToolSet } from '../src/types/tool';

const parameters = { type: 'object' as const, properties: {} };
const user: Message = { role: 'user', content: 'go' };

/** A mock model whose wire requests are recorded (bodies, in order). */
function recorded(responses: MockResponse[]): { model: LanguageModel; bodies: string[] } {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const bodies: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init!.body));
    return config.fetch!(input, init);
  }) as typeof fetch;
  return { model: attachConfig({ ...base }, { ...config, fetch: fetchImpl }), bodies };
}

const transferCall: MockResponse = {
  toolCalls: [{ toolName: 'transfer_to_billing', id: 't1', args: { reason: 'invoice' } }],
};

function agents(billing: LanguageModel, gate = false): ToolSet {
  const tools = handoff({ billing: { model: billing, instructions: 'You handle billing.' } });
  if (gate) tools.transfer_to_billing!.needsApproval = true;
  return tools;
}

describe('handoff transfers take the policy and the approval gate', () => {
  it('an onToolCall guardrail can refuse a transfer', async () => {
    const billing = recorded([{ text: 'billing here' }]);
    const result = await generateText({
      model: createMockModel({ responses: [transferCall, { text: 'root continues' }] }),
      messages: [user],
      tools: agents(billing.model),
      maxSteps: 4,
      guardrails: {
        onToolCall: ({ toolCall }) =>
          toolCall.toolName === 'transfer_to_billing'
            ? { action: 'block', reason: 'no transfers today' }
            : undefined,
      },
    });
    expect(result.text).toBe('root continues');
    expect(billing.bodies).toEqual([]);
    expect(result.providerMetadata?.deuz).not.toHaveProperty('handoffs');
    expect(result.steps![0]!.toolResults).toEqual([
      expect.objectContaining({ toolCallId: 't1', isError: true, outcome: 'permission-denied' }),
    ]);
  });

  it('a transfer that needs approval is refused by a server approver like any call', async () => {
    const billing = recorded([{ text: 'billing here' }]);
    const approve = vi.fn((call: { toolName: string }) => call.toolName !== 'transfer_to_billing');
    const result = await generateText({
      model: createMockModel({ responses: [transferCall, { text: 'root continues' }] }),
      messages: [user],
      tools: agents(billing.model, true),
      maxSteps: 4,
      approveToolCall: approve,
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'transfer_to_billing' }),
      expect.anything(),
    );
    expect(result.text).toBe('root continues');
    expect(billing.bodies).toEqual([]);
    expect(result.steps![0]!.toolResults[0]).toMatchObject({ outcome: 'approval-denied' });
  });

  it('requireApproval suspends a native run on a transfer, and the approved transfer applies', async () => {
    const billing = recorded([{ text: 'billing here' }]);
    const store = createInMemoryAgentRunStore();
    const execution = createExecutionContext({ policy: { requireApproval: true } });
    const options = {
      model: createMockModel({ responses: [transferCall, { text: 'root answer' }] }),
      prompt: 'invoice question',
      tools: agents(billing.model),
      execution,
      session: { store, runId: 'gated-transfer', scope: 't' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    expect(billing.bodies).toEqual([]);
    const request = first.status === 'suspended' ? first.pendingApprovals[0]! : undefined;
    expect(request?.toolName).toBe('transfer_to_billing');
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: request!.approvalId, approved: true }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'billing here' });
    expect(billing.bodies).toHaveLength(1);
  });
});

describe('a sub-agent cannot step outside the parent run’s guardrails', () => {
  it('the parent’s onToolCall guardrail refuses the sub-agent’s own call', async () => {
    const danger = vi.fn(async () => 'boom');
    const child = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'danger', id: 'd1', args: {} }] }, { text: 'ok' }],
    });
    await generateText({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'worker', id: 'w1', args: { prompt: 'do it' } }] },
          { text: 'parent done' },
        ],
      }),
      messages: [user],
      maxSteps: 4,
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'does work',
          model: child,
          tools: { danger: { parameters, execute: danger } },
        }),
      },
      guardrails: {
        onToolCall: ({ toolCall }) =>
          toolCall.toolName === 'danger' ? { action: 'block', reason: 'never' } : undefined,
      },
    });
    expect(danger).not.toHaveBeenCalled();
  });

  it('the parent’s onToolResult guardrail projects what the sub-agent’s model sees', async () => {
    const child = recorded([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'ok' },
    ]);
    await generateText({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'worker', id: 'w1', args: { prompt: 'look' } }] },
          { text: 'parent done' },
        ],
      }),
      messages: [user],
      maxSteps: 4,
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'does work',
          model: child.model,
          tools: { lookup: { parameters, execute: async () => 'secret-123' } },
        }),
      },
      guardrails: {
        onToolResult: ({ result }) =>
          String(result).includes('secret')
            ? { action: 'rewrite', result: '[redacted]' }
            : undefined,
      },
    });
    expect(child.bodies).toHaveLength(2);
    expect(child.bodies[1]).toContain('[redacted]');
    expect(child.bodies[1]).not.toContain('secret-123');
  });
});

describe('a tool that arrives through a hook or a refresh cannot bypass the gate', () => {
  it('prepareStep can put a gated tool on the wire, but not past its approval', async () => {
    const pay = vi.fn(async () => 'paid');
    const result = await generateText({
      model: createMockModel({ responses: [{ toolCalls: [{ toolName: 'pay', args: {} }] }] }),
      messages: [user],
      tools: {
        look: { parameters, execute: async () => 'seen' },
        pay: { parameters, needsApproval: true, execute: pay },
      },
      activeTools: ['look'],
      prepareStep: () => ({ activeTools: ['pay'] }),
      maxSteps: 3,
    });
    expect(pay).not.toHaveBeenCalled();
    expect(result.pendingApprovals?.map((a) => a.toolName)).toEqual(['pay']);
  });

  it('a tool an MCP refresh brings in is gated and policed like the rest', async () => {
    const effects: string[] = [];
    let defs = [{ name: 'look', inputSchema: parameters }];
    const listeners = new Set<() => void>();
    const caller = {
      callTool: async ({ name }: { name: string }) => {
        effects.push(name);
        return { content: [{ type: 'text', text: `${name} ok` }] };
      },
    };
    const client: McpClient = {
      listTools: async (namespace) => mcpToolsToToolSet(caller, defs, namespace),
      callTool: async () => undefined,
      listResources: async () => [],
      readResource: async () => [],
      listPrompts: async () => [],
      getPrompt: async () => ({ messages: [] }),
      status: () => 'connected',
      onToolListChanged(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      close: async () => {},
    };
    const result = await generateText({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'look', id: 'l1', args: {} }] },
          { toolCalls: [{ toolName: 'drop_table', id: 'd1', args: {} }] },
        ],
      }),
      messages: [user],
      mcp: [client],
      maxSteps: 4,
      execution: createExecutionContext({ policy: { requireApproval: true } }),
      approveToolCall: (call) => {
        if (call.toolName === 'look') {
          // The server changes its catalog while the first call is approved.
          defs = [...defs, { name: 'drop_table', inputSchema: parameters }];
          for (const cb of listeners) cb();
          return true;
        }
        return false;
      },
    });
    expect(effects).toEqual(['look']);
    expect(result.steps![1]!.toolResults[0]).toMatchObject({
      toolCallId: 'd1',
      outcome: 'approval-denied',
    });
  });
});

describe('an MCP sampling request takes the run’s policy and budget', () => {
  it('checks the execution policy before asking the approver or the model', async () => {
    const { model, bodies } = recorded([{ text: 'sampled' }]);
    const approve = vi.fn(() => true);
    const handler = buildSamplingHandler({
      model,
      approve,
      execution: createExecutionContext({ policy: { allowedModels: ['another-model'] } }),
    });
    await expect(
      handler({ params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] } }),
    ).rejects.toMatchObject({ name: 'ExecutionPolicyError', code: 'model_not_allowed' });
    expect(approve).not.toHaveBeenCalled();
    expect(bodies).toEqual([]);
  });

  it('reserves the call on the execution ledger, so a spent budget refuses it', async () => {
    const { model, bodies } = recorded([{ text: 'sampled' }]);
    const execution = createExecutionContext({ budget: { tokens: 10_000 } });
    const handler = buildSamplingHandler({ model, execution });
    const params = { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] };
    await expect(handler({ params })).resolves.toMatchObject({ content: { text: 'sampled' } });
    expect(execution.ledger.totals().spent.tokens).toBeGreaterThan(0);
    const spent = createExecutionContext({ budget: { tokens: 0 } });
    await expect(
      buildSamplingHandler({ model, execution: spent })({ params }),
    ).rejects.toMatchObject({ name: 'BudgetLedgerError' });
    expect(bodies).toHaveLength(1);
  });
});
