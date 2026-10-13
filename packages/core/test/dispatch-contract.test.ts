/**
 * dispatch-contract.test.ts (2.3, roadmap 23.2 / section 9) — one tool call
 * takes one path, whatever family it belongs to:
 *
 *   finish-reason gate -> policy -> approval -> admission (reservation) ->
 *   effect identity [modelStep, toolCallId] -> receipt 'executing' -> execute ->
 *   receipt 'completed' -> onToolResult -> checkpoint
 *
 * Each case records what it can observe of that path (the guardrail, the
 * approver, the receipt stages the store sees, the effect, the step checkpoint)
 * and compares the order with the contract. The completed receipt keeps the
 * tool's own result; `onToolResult` changes only the copy the model sees, and
 * runs again on a replayed receipt, so it may follow the receipt write.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/generate';
import { createAgent } from '../src/agent';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import { evolve } from '../src/evolve/controller';
import { createInMemoryPopulationStore } from '../src/evolve/store';
import { buildSamplingHandler, mcpToolsToToolSet, type McpClient } from '../src/mcp/shared';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { AgentRunEnvelope, AgentRunStore, AgentToolSet } from '../src/types/agent-run';
import type { Guardrails, ToolCallGuardrail, ToolResultGuardrail } from '../src/types/guardrails';
import type { JSONSchema } from '../src/types/schema';
import type { SwarmStore } from '../src/types/swarm';
import type { ToolCall } from '../src/types/tool';

const parameters = { type: 'object' as const, properties: {} };

/** The contract's observable order for a call that runs. */
const WALK = [
  'policy',
  'approval',
  'receipt:executing',
  'execute',
  'receipt:executed',
  'receipt:completed',
  'result-guardrail',
  'checkpoint',
];

/** Guardrails and an approver that write the policy and approval steps to `log`. */
function hooks(log: string[], name: string) {
  const onToolCall: ToolCallGuardrail = ({ toolCall }) => {
    if (toolCall.toolName === name) log.push('policy');
    return undefined;
  };
  const onToolResult: ToolResultGuardrail = ({ toolCall }) => {
    if (toolCall.toolName === name) log.push('result-guardrail');
    return undefined;
  };
  const guardrails: Guardrails = { onToolCall, onToolResult };
  const approveToolCall = (call: ToolCall) => {
    if (call.toolName === name) log.push('approval');
    return true;
  };
  return { guardrails, approveToolCall, onToolCall, onToolResult };
}

/** Writes the receipt stages and the step checkpoint the run persists to `log`. */
function journal(log: string[], inner = createInMemoryAgentRunStore()): AgentRunStore {
  const stages = new Map<string, string>();
  let answered = 0;
  return {
    load: (id) => inner.load(id),
    save(envelope: AgentRunEnvelope) {
      for (const [key, receipt] of Object.entries(envelope.toolResults ?? {})) {
        if (stages.get(key) !== receipt.stage) {
          stages.set(key, receipt.stage);
          log.push(`receipt:${receipt.stage}`);
        }
      }
      const tools =
        envelope.checkpoints[envelope.runId]?.messages.filter((m) => m.role === 'tool').length ?? 0;
      if (tools > answered) {
        answered = tools;
        log.push('checkpoint');
      }
      return inner.save(envelope);
    },
  };
}

function mcpServer(log: string[], defs: Array<{ name: string; outputSchema?: JSONSchema }>) {
  let catalog = defs.map((d) => ({ inputSchema: parameters, ...d }));
  const listeners = new Set<() => void>();
  const caller = {
    callTool: async ({ name }: { name: string }) => {
      log.push('execute');
      return {
        content: [{ type: 'text', text: `${name} ok` }],
        ...(name === 'lookup' ? { structuredContent: { v: 1 } } : {}),
      };
    },
  };
  const client: McpClient = {
    listTools: async (namespace) => mcpToolsToToolSet(caller, catalog, namespace),
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
  return {
    client,
    add(name: string) {
      catalog = [...catalog, { name, inputSchema: parameters }];
      for (const cb of listeners) cb();
    },
  };
}

const call = (toolName: string, id: string, args: object = {}): MockResponse => ({
  toolCalls: [{ toolName, id, args }],
});

describe('the finish-reason gate comes first', () => {
  it.each([
    ['cut off', 'length'],
    ['refused', 'content_filter'],
  ] as const)(
    'a %s turn dispatches nothing: no policy, no approval, no effect',
    async (_l, finishReason) => {
      const log: string[] = [];
      const execute = vi.fn(async () => log.push('execute'));
      const result = await generateText({
        model: createMockModel({ responses: [{ ...call('pay', 'p1'), finishReason }] }),
        messages: [{ role: 'user', content: 'pay' }],
        tools: { pay: { parameters, needsApproval: true, execute } },
        maxSteps: 3,
        ...hooks(log, 'pay'),
      });
      expect(log).toEqual([]);
      expect(result.finishReason).toBe(finishReason);
    },
  );
});

describe('every family walks the same path, in the same order', () => {
  it('a local tool', async () => {
    const log: string[] = [];
    const result = await runAgent({
      model: createMockModel({ responses: [call('charge', 'c1'), { text: 'done' }] }),
      prompt: 'charge',
      tools: {
        charge: {
          parameters,
          needsApproval: true,
          execute: async () => {
            log.push('execute');
            return 'charged';
          },
        },
      },
      ...hooks(log, 'charge'),
      session: { store: journal(log), runId: 'local', scope: 't' },
    });
    expect(result.status).toBe('completed');
    expect(log).toEqual(WALK);
  });

  it.each([
    ['discovered at connect', 'charge', undefined],
    ['with a JSON Schema outputSchema', 'lookup', { type: 'object' }],
  ] as const)('an MCP tool %s', async (_label, name, outputSchema) => {
    const log: string[] = [];
    const server = mcpServer(log, [{ name, ...(outputSchema ? { outputSchema } : {}) }]);
    const result = await runAgent({
      model: createMockModel({ responses: [call(name, 'm1'), { text: 'done' }] }),
      prompt: 'go',
      mcp: [server.client],
      execution: createExecutionContext({ policy: { requireApproval: true } }),
      ...hooks(log, name),
      session: { store: journal(log), runId: `mcp-${name}`, scope: 't' },
    });
    expect(result.status).toBe('completed');
    expect(log).toEqual(WALK);
  });

  it('an MCP tool that arrives through a hot refresh', async () => {
    const log: string[] = [];
    const server = mcpServer(log, [{ name: 'charge' }]);
    const result = await runAgent({
      model: createMockModel({
        responses: [call('upgrade', 'u1'), call('refund', 'r1'), { text: 'done' }],
      }),
      prompt: 'go',
      mcp: [server.client],
      onCatalogChange: 'accept',
      tools: { upgrade: { parameters, execute: async () => (server.add('refund'), 'ok') } },
      ...hooks(log, 'refund'),
      execution: createExecutionContext({ policy: { requireApproval: true } }),
      approveToolCall: (c: ToolCall) => (c.toolName === 'refund' && log.push('approval'), true),
      session: { store: journal(log), runId: 'refresh', scope: 't' },
    });
    expect(result.status).toBe('completed');
    // The first step's own receipts and checkpoint come first.
    const walk = log.slice(log.indexOf('policy'));
    expect(walk).toEqual(WALK);
  });

  it('a handoff transfer is decided after the policy and the gate; the target’s call walks it', async () => {
    const log: string[] = [];
    const billing = createMockModel({ responses: [call('refund', 'r1'), { text: 'done' }] });
    const tools: AgentToolSet = handoff({
      billing: {
        model: billing,
        tools: {
          refund: {
            parameters,
            execute: async () => {
              log.push('execute');
              return 'refunded';
            },
          },
        },
      },
    });
    const transfer = hooks(log, 'transfer_to_billing');
    const refund = hooks(log, 'refund');
    const result = await runAgent({
      model: createMockModel({ responses: [call('transfer_to_billing', 't1')] }),
      prompt: 'refund me',
      tools,
      execution: createExecutionContext({ policy: { requireApproval: true } }),
      guardrails: {
        onToolCall: (ctx) => transfer.onToolCall(ctx) ?? refund.onToolCall(ctx),
        onToolResult: (ctx) => refund.onToolResult(ctx),
      },
      approveToolCall: (c: ToolCall) => transfer.approveToolCall(c) && refund.approveToolCall(c),
      session: { store: journal(log), runId: 'handoff', scope: 't' },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    // The transfer: policy, approval, then a decision (no receipt, no effect).
    expect(log.slice(0, 2)).toEqual(['policy', 'approval']);
    expect(log.slice(2, 3)).toEqual(['checkpoint']);
    expect(log.slice(3)).toEqual(WALK);
  });

  it('a sub-agent’s own call walks the parent run’s path', async () => {
    const log: string[] = [];
    const child = createMockModel({ responses: [call('look', 'l1'), { text: 'seen' }] });
    await generateText({
      model: createMockModel({
        responses: [call('worker', 'w1', { prompt: 'look' }), { text: 'done' }],
      }),
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: 4,
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'w',
          model: child,
          tools: {
            look: {
              parameters,
              needsApproval: true,
              execute: async () => {
                log.push('execute');
                return 'seen';
              },
            },
          },
        }),
      },
      ...hooks(log, 'look'),
    });
    // A plain sub-agent loop keeps no receipts; its call is policed, gated and
    // guarded by the parent's hooks, in the contract's order.
    expect(log).toEqual(['policy', 'approval', 'execute', 'result-guardrail']);
  });

  it('a swarm blackboard tool', async () => {
    const log: string[] = [];
    const inner = createInMemorySwarmStore();
    const stages = new Map<string, string>();
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        for (const task of change.tasks ?? []) {
          for (const [key, receipt] of Object.entries(task.agentState?.toolResults ?? {})) {
            if (receipt.toolName !== 'blackboard_post' || stages.get(key) === receipt.stage)
              continue;
            stages.set(key, receipt.stage);
            log.push(`receipt:${receipt.stage}`);
          }
        }
        if (change.posts?.length) log.push('execute');
        return inner.commit(change);
      },
    };
    const scout = createAgent({
      model: createMockModel({
        responses: [call('blackboard_post', 'b1', { text: 'found it' }), { text: 'posted' }],
      }),
      ...hooks(log, 'blackboard_post'),
    });
    const swarm = createSwarm({
      store,
      policy: { requireApproval: true },
      agents: { scout: { agent: scout, blackboard: { read: 'group', post: true } } },
    });
    const outcome = await (
      await swarm.run({ scope: 't', tasks: [{ id: 'a', agent: 'scout', prompt: 'post' }] })
    ).result;
    expect(outcome.run.status).toBe('completed');
    expect(log).toEqual(WALK.filter((step) => step !== 'checkpoint'));
  });

  it('a spawned swarm task cannot bypass the gate', async () => {
    const execute = vi.fn(async () => 'written');
    const planner = createAgent({
      model: createMockModel({ responses: [{ text: '{"steps":["x"]}' }] }),
    });
    const worker = createAgent({
      model: createMockModel({ responses: [call('write', 'w1')] }),
      tools: { write: { parameters, execute } },
    });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      dynamic: { maxTasks: 5, maxSpawnDepth: 2 },
      policy: { requireApproval: true },
      agents: {
        planner: {
          agent: planner,
          output: {
            schema: { type: 'object', properties: { steps: { type: 'array' } } },
            mode: 'json',
            validate: (value) => value as { steps: string[] },
          },
          spawn: (output) =>
            (output as { steps: string[] }).steps.map((step) => ({
              key: step,
              agent: 'worker',
              prompt: step,
            })),
        },
        worker,
      },
    });
    const outcome = await (
      await swarm.run({ scope: 't', tasks: [{ id: 'plan', agent: 'planner', prompt: 'plan' }] })
    ).result;
    expect(outcome.tasks.find((t) => t.task.id === 'plan/x')?.status).toBe('suspended');
    expect(execute).not.toHaveBeenCalled();
  });

  it('an evolve mutation call is admitted under the run’s policy before it is sent', async () => {
    const base = createMockModel({ responses: [{ text: 'x' }] });
    const config = readConfig(base)!;
    const fetch = vi.fn(config.fetch!);
    const model = attachConfig({ ...base }, { ...config, fetch });
    const handle = evolve({
      scope: 't',
      runId: 'evo',
      store: createInMemoryPopulationStore(),
      initial: 'def f(x):\n    # EVOLVE-BLOCK-START\n    return x\n    # EVOLVE-BLOCK-END\n',
      stages: [{ name: 's', evaluate: () => ({ score: 0 }) }],
      models: [{ model }],
      generations: 1,
      mutationsPerGeneration: 1,
      seed: 'fixed',
      budget: { tokens: 100_000 },
      policy: { allowedModels: ['another-model'] },
    });
    await expect(handle.result).rejects.toMatchObject({ code: 'model_not_allowed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an MCP sampling request: policy, then approval, then the reserved model call', async () => {
    const log: string[] = [];
    const base = createMockModel({ responses: [{ text: 'sampled' }] });
    const config = readConfig(base)!;
    const execution = createExecutionContext({ budget: { tokens: 100_000 } });
    const model = attachConfig(
      { ...base },
      {
        ...config,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          // The reservation is on the ledger before the request is sent.
          if (execution.ledger.snapshot().reservations.length > 0) log.push('reservation');
          log.push('model');
          return config.fetch!(input, init);
        }) as typeof fetch,
      },
    );
    const handler = buildSamplingHandler({
      model,
      execution,
      approve: () => (log.push('approval'), true),
    });
    await handler({
      params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] },
    });
    expect(log).toEqual(['approval', 'reservation', 'model']);
    const refused = buildSamplingHandler({
      model,
      execution: createExecutionContext({ policy: { allowedModels: [] } }),
      approve: () => (log.push('approval'), true),
    });
    await expect(
      refused({ params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] } }),
    ).rejects.toMatchObject({ code: 'model_not_allowed' });
    expect(log).toEqual(['approval', 'reservation', 'model']);
  });
});

describe('one path for the live step and the resume settle', () => {
  it('a gated call approved on resume walks the same path as one approved inline', async () => {
    const inline: string[] = [];
    const resumed: string[] = [];
    const tools = (log: string[]): AgentToolSet => ({
      charge: {
        parameters,
        needsApproval: true,
        execute: async () => {
          log.push('execute');
          return 'charged';
        },
      },
    });
    await runAgent({
      model: createMockModel({ responses: [call('charge', 'c1'), { text: 'done' }] }),
      prompt: 'charge',
      tools: tools(inline),
      ...hooks(inline, 'charge'),
      session: { store: journal(inline), runId: 'inline', scope: 't' },
    });

    const inner = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [call('charge', 'c1'), { text: 'done' }] });
    const { guardrails } = hooks(resumed, 'charge');
    const first = await runAgent({
      model,
      prompt: 'charge',
      tools: tools(resumed),
      guardrails,
      session: { store: journal(resumed, inner), runId: 'resumed', scope: 't' },
    });
    expect(first.status).toBe('suspended');
    const approvalId = first.status === 'suspended' ? first.pendingApprovals[0]!.approvalId : '';
    resumed.push('approval');
    const { resumeAgent } = await import('../src/agent-run');
    await resumeAgent({
      model,
      prompt: 'charge',
      tools: tools(resumed),
      guardrails,
      approvalResponses: [{ approvalId, approved: true }],
      session: { store: journal(resumed, inner), runId: 'resumed', scope: 't' },
    });
    // The settle re-runs the policy before it executes the approved call.
    expect(resumed.slice(0, 2)).toEqual(['policy', 'approval']);
    expect(resumed.slice(2)).toEqual(['policy', ...WALK.slice(2)]);
    expect(inline).toEqual(WALK);
  });
});
