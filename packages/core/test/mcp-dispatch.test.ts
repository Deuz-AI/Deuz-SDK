/**
 * mcp-dispatch.test.ts (2.3, roadmap 23.2 / F01 hand-offs) — how a run reports
 * MCP tool-name collisions, and what it does when a server changes its catalog
 * in the middle of a run.
 *
 * Before 2.3 a local tool shadowed an MCP tool of the same name in silence, and
 * two servers exposing the same name only reached `deps.logger` (a no-op by
 * default). A mid-run catalog change was always accepted: a native run recorded
 * the new catalog and carried on with tools nobody had reviewed.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/generate';
import { streamChat } from '../src/index';
import { createInMemoryAgentRunStore, runAgent, streamAgent } from '../src/agent-run';
import { mcpToolsToToolSet, type McpClient, type McpToolDef } from '../src/mcp/shared';
import { createMockModel, type MockResponse } from '../src/testing';
import type { AgentEvent } from '../src/types/agent-run';
import type { CommonCallOptions } from '../src/types/config';
import type { Message } from '../src/types/message';
import type { StreamPart } from '../src/types/stream';

const parameters = { type: 'object' as const, properties: {} };
const user: Message = { role: 'user', content: 'go' };
const def = (name: string, description = `${name} tool`): McpToolDef => ({
  name,
  description,
  inputSchema: parameters,
});

/** A scripted server whose catalog can change mid-run (`tools/list_changed`). */
function server(initial: McpToolDef[], name = 'srv') {
  let defs = initial;
  const effects: string[] = [];
  const listeners = new Set<() => void>();
  const caller = {
    callTool: async ({ name: tool }: { name: string }) => {
      effects.push(tool);
      return { content: [{ type: 'text', text: `${tool} from ${name}` }] };
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
  return {
    client,
    effects,
    change(next: McpToolDef[]) {
      defs = next;
      for (const cb of listeners) cb();
    },
    /** Announce a change without changing anything. */
    poke() {
      for (const cb of listeners) cb();
    },
  };
}

const call = (toolName: string, id: string): MockResponse => ({
  toolCalls: [{ toolName, id, args: {} }],
});

describe('MCP name collisions are typed warnings', () => {
  it('reports a local tool that shadows an MCP tool', async () => {
    const srv = server([def('echo'), def('ping')]);
    const result = await generateText({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      messages: [user],
      mcp: [srv.client],
      tools: { echo: { parameters, execute: async () => 'local' } },
    });
    expect(result.warnings).toContainEqual({
      type: 'unsupported-tool',
      setting: 'mcp',
      message: expect.stringContaining("'echo'"),
    });
    expect(result.warnings?.filter((w) => w.setting === 'mcp')).toHaveLength(1);
  });

  it('reports two servers that expose the same name', async () => {
    const a = server([def('ping')], 'a');
    const b = server([def('ping')], 'b');
    const seen: StreamPart[] = [];
    const result = streamChat({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      messages: [user],
      mcp: [
        { client: a.client, namespace: 'dup' },
        { client: b.client, namespace: 'dup' },
      ],
    });
    for await (const part of result.fullStream) seen.push(part);
    const warning = {
      type: 'unsupported-tool',
      setting: 'mcp',
      message: expect.stringContaining("duplicate tool name 'dup_ping'"),
    };
    expect(seen).toContainEqual({ type: 'warning', warning });
    expect(await result.warnings).toContainEqual(warning);
  });

  it('reports the shadowing on a native run’s stream', async () => {
    const srv = server([def('echo')]);
    const stream = streamAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'go',
      mcp: [srv.client],
      tools: { echo: { parameters, execute: async () => 'local' } },
    });
    const events: AgentEvent[] = [];
    for await (const event of stream.events) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'part',
        part: {
          type: 'warning',
          warning: expect.objectContaining({ type: 'unsupported-tool', setting: 'mcp' }),
        },
      }),
    );
  });
});

describe('onCatalogChange: a server changes its catalog mid-run', () => {
  /** A local tool that makes the server add `refund` while the first step runs. */
  function upgrading(srv: ReturnType<typeof server>) {
    return {
      upgrade: {
        parameters,
        execute: async () => {
          srv.change([def('charge'), def('refund')]);
          return 'upgraded';
        },
      },
    };
  }

  it('stops a native run by default, before the model is offered the new catalog', async () => {
    const srv = server([def('charge')]);
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({
      responses: [call('upgrade', 'u1'), call('refund', 'r1'), { text: 'x' }],
    });
    const stream = streamAgent({
      model,
      prompt: 'go',
      mcp: [srv.client],
      tools: upgrading(srv),
      session: { store, runId: 'stop', scope: 't' },
    });
    const events: AgentEvent[] = [];
    for await (const event of stream.events) events.push(event);
    expect(await stream.result).toMatchObject({
      status: 'stopped',
      reason: 'mcp-catalog-changed',
    });
    expect(srv.effects).toEqual([]);
    const envelope = (await store.load('stop'))!;
    // The run never used the new catalog, so its binding keeps the old one.
    expect(Object.keys(JSON.parse(envelope.binding!.mcp!).tools)).toEqual(['charge']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'part',
        part: {
          type: 'warning',
          warning: expect.objectContaining({
            setting: 'mcp',
            message: expect.stringContaining('added: refund'),
          }),
        },
      }),
    );
    // Only the step that ran was counted.
    expect(envelope.modelSteps).toBe(1);
  });

  it("accepts the change with onCatalogChange: 'accept'", async () => {
    const srv = server([def('charge')]);
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: createMockModel({
        responses: [call('upgrade', 'u1'), call('refund', 'r1'), { text: 'done' }],
      }),
      prompt: 'go',
      mcp: [srv.client],
      tools: upgrading(srv),
      onCatalogChange: 'accept',
      session: { store, runId: 'accept', scope: 't' },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    expect(srv.effects).toEqual(['refund']);
    const binding = (await store.load('accept'))!.binding!;
    expect(Object.keys(JSON.parse(binding.mcp!).tools)).toEqual(['charge', 'refund']);
  });

  it('keeps going after an announcement that changed nothing', async () => {
    const srv = server([def('charge')]);
    const result = await runAgent({
      model: createMockModel({
        responses: [call('poke', 'p1'), call('charge', 'c1'), { text: 'done' }],
      }),
      prompt: 'go',
      mcp: [srv.client],
      tools: { poke: { parameters, execute: async () => (srv.poke(), 'poked') } },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    expect(srv.effects).toEqual(['charge']);
  });

  it('accepts by default in the legacy loops, and reports the change', async () => {
    const srv = server([def('charge')]);
    const result = await generateText({
      model: createMockModel({
        responses: [call('upgrade', 'u1'), call('refund', 'r1'), { text: 'done' }],
      }),
      messages: [user],
      mcp: [srv.client],
      tools: upgrading(srv),
      maxSteps: 5,
    });
    expect(result.text).toBe('done');
    expect(srv.effects).toEqual(['refund']);
    expect(result.warnings).toContainEqual({
      type: 'other',
      setting: 'mcp',
      message: expect.stringContaining('added: refund'),
    });
  });

  it("stops a legacy loop with onCatalogChange: 'stop'", async () => {
    const srv = server([def('charge')]);
    const seen: StreamPart[] = [];
    const result = streamChat({
      model: createMockModel({
        responses: [call('upgrade', 'u1'), call('refund', 'r1'), { text: 'done' }],
      }),
      messages: [user],
      mcp: [srv.client],
      tools: upgrading(srv),
      maxSteps: 5,
      onCatalogChange: 'stop',
    } as CommonCallOptions);
    for await (const part of result.fullStream) seen.push(part);
    expect(srv.effects).toEqual([]);
    expect(seen.filter((p) => p.type === 'step-start')).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({
      type: 'finish',
      providerMetadata: { deuz: { stoppedBy: 'mcp-catalog-changed' } },
    });
  });

  it('rejects an onCatalogChange value it does not know', async () => {
    const srv = server([def('charge')]);
    const execute = vi.fn();
    const result = await runAgent({
      model: createMockModel({ responses: [{ text: 'never' }] }),
      prompt: 'go',
      mcp: [srv.client],
      tools: { t: { parameters, execute } },
      onCatalogChange: 'ignore' as never,
    });
    expect(result).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
  });
});
