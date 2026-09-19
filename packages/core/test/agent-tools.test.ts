import { describe, expect, it, vi } from 'vitest';
import { prepareAgentTools } from '../src/inference/agent-tools';
import type { AgentToolReceipt } from '../src/types/agent-run';
import { resolveDependencies } from '../src/internal/resolve-deps';
import { createExecutionContext } from '../src/execution-policy';
import { agentTool } from '../src/inference/agent-tool';
import { createMockModel } from '../src/testing';

const parameters = { type: 'object', properties: {} };
const context = {
  toolCallId: 'c1',
  messages: [],
  runtimeContext: { secret: 'global' },
  deps: resolveDependencies(),
};

describe('native tool contracts', () => {
  it('rejects scoped delegation before stripping child session and approval internals', async () => {
    const delegated = agentTool({
      name: 'child',
      description: 'Child agent',
      model: createMockModel({ responses: [{ text: 'unused' }] }),
    });
    await expect(
      prepareAgentTools({ child: delegated }, { child: { tenant: 'a' } }),
    ).rejects.toThrow('scoped context is not supported');
    // Object spreads preserve execute identity, so adding contextSchema cannot bypass the check.
    await expect(
      prepareAgentTools({
        child: {
          ...delegated,
          contextSchema: { type: 'object' },
          validateContext: (value) => value,
        },
      }),
    ).rejects.toThrow('scoped context is not supported');
    await expect(prepareAgentTools({ child: delegated })).resolves.toHaveProperty('child.execute');
  });
  it('validates per-tool context before exposing it and strips ambient privileges', async () => {
    const execute = vi.fn((_args, ctx) => ctx.context.tenant);
    const tools = await prepareAgentTools(
      {
        one: {
          parameters,
          execute,
          contextSchema: { type: 'object' },
          validateContext: (value) => {
            if (!value || typeof value !== 'object') throw new Error('tenant');
            return value;
          },
        },
      },
      { one: { tenant: 'alpha' }, other: { secret: 'beta' } },
    );
    expect(await tools.one!.execute!({}, context)).toBe('alpha');
    expect(execute.mock.calls[0]![1]).not.toHaveProperty('runtimeContext');
    expect(execute.mock.calls[0]![1]).not.toHaveProperty('deps');
    expect(JSON.stringify(tools.one!.parameters)).not.toContain('alpha');
    await expect(
      prepareAgentTools({ one: { parameters, contextSchema: { type: 'object' } } }),
    ).rejects.toThrow('runtime validator');
  });

  it('persists raw results before projection failure and repairs projection without repeating effects', async () => {
    const execute = vi.fn(() => ({ private: 'raw', value: 7 }));
    let fail = true;
    const toModelOutput = vi.fn((raw: { value: number }) => {
      if (fail) throw new Error('projection failed');
      return { value: raw.value };
    });
    const saved = new Map<string, AgentToolReceipt>();
    const stages: string[] = [];
    const tools = await prepareAgentTools(
      { one: { parameters, execute, toModelOutput } },
      {},
      undefined,
      {
        load: (id) => saved.get(id),
        save: async (receipt) => {
          saved.set(receipt.toolCallId, structuredClone(receipt));
          stages.push(receipt.stage);
        },
      },
    );
    await expect(tools.one!.execute!({}, context)).rejects.toThrow('projection failed');
    expect(saved.get('c1')).toMatchObject({
      stage: 'projection-failed',
      rawResult: { private: 'raw', value: 7 },
    });
    fail = false;
    expect(await tools.one!.execute!({}, context)).toEqual({ value: 7 });
    expect(await tools.one!.execute!({}, context)).toEqual({ value: 7 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(['executing', 'executed', 'projection-failed', 'completed']);
  });

  it('prevents uncertain effect replay and persistence failures from becoming self-healing tool errors', async () => {
    const execute = vi.fn(() => 'effect');
    const receipt: AgentToolReceipt = {
      toolName: 'one',
      toolCallId: 'c1',
      input: {},
      stage: 'executing',
    };
    const tools = await prepareAgentTools({ one: { parameters, execute } }, {}, undefined, {
      load: () => receipt,
      save: async () => {},
    });
    await expect(tools.one!.execute!({}, context)).rejects.toMatchObject({ fatalExecution: true });
    expect(execute).not.toHaveBeenCalled();
    const broken = await prepareAgentTools({ one: { parameters, execute } }, {}, undefined, {
      load: () => undefined,
      save: async () => {
        throw new Error('disk');
      },
    });
    await expect(broken.one!.execute!({}, context)).rejects.toMatchObject({ fatalExecution: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks the mandatory deadline after awaiting a tool receipt commit', async () => {
    let now = 1;
    const execute = vi.fn(() => 'effect');
    const execution = createExecutionContext({ policy: { deadlineAt: 2 } });
    const tools = await prepareAgentTools({ one: { parameters, execute } }, {}, undefined, {
      load: () => undefined,
      save: async () => {
        now = 3;
      },
    });
    const ctx = {
      ...context,
      execution,
      deps: { ...context.deps, clock: { ...context.deps.clock, now: () => now } },
    };
    await expect(tools.one!.execute!({}, ctx)).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(execute).not.toHaveBeenCalled();
  });
});
