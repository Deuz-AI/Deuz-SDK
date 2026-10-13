/**
 * Faults at an MCP hot refresh in a native run that accepts catalog changes:
 * a refresh whose listing fails, and a crash before the run records the
 * refreshed catalog, resumed under the native default and under
 * `onCatalogChange: 'accept'`. The MCP server is a scripted client behind the
 * SDK's own `mcpToolsToToolSet` mapping (as in native-mcp.test.ts), so the
 * moment of the failure is exact.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import { mcpToolsToToolSet, type McpClient, type McpToolDef } from '../../../src/mcp/shared';
import type { AgentRunEnvelope, AgentRunStore } from '../../../src/types/agent-run';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import { MOCK, costKept, mockPrices, parameters, ranOnce, scripted } from './support';

const ping: McpToolDef = {
  name: 'ping',
  description: 'Health check.',
  inputSchema: { type: 'object', properties: {} },
};
const report: McpToolDef = {
  name: 'report',
  description: 'Build the report.',
  inputSchema: { type: 'object', properties: {} },
};

/** A server whose catalog changes on demand; `failListAfter` breaks later listings. */
function liveServer(context: EvalTaskContext, failListAfter?: number) {
  let defs = [ping];
  let lists = 0;
  const listeners = new Set<() => void>();
  const caller = {
    callTool: async ({ name }: { name: string; arguments: unknown }) => {
      context.effect(`mcp:${name}`);
      ((context.store.effects as string[] | undefined) ??= []).push(`mcp:${name}`);
      return { content: [{ type: 'text', text: `${name} ok` }] };
    },
  };
  const client: McpClient = {
    async listTools(namespace) {
      lists += 1;
      if (failListAfter !== undefined && lists > failListAfter) {
        context.interrupt('mcp-hot-refresh');
        throw new Error('tools/list failed');
      }
      return mcpToolsToToolSet(caller, defs, namespace);
    },
    callTool: async () => undefined,
    listResources: async () => [],
    readResource: async () => [],
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
    status: () => 'connected',
    onToolListChanged(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    close: async () => {},
  };
  return {
    client,
    addReport() {
      defs = [ping, report];
      for (const callback of listeners) callback();
    },
  };
}

const boundTools = (envelope: AgentRunEnvelope | undefined): string[] =>
  Object.keys(
    (JSON.parse(envelope?.binding?.mcp ?? '{}') as { tools?: Record<string, unknown> }).tools ?? {},
  ).sort();

export const mcpRefreshListFailure: EvalTaskManifest = {
  id: 'fault/mcp-refresh-list-failure',
  version: 1,
  title: 'A hot refresh whose tools/list fails keeps the catalog the run had',
  tags: ['fault', 'native', 'mcp'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Enable reports, then answer.' }] },
  fault: { boundary: 'mcp-hot-refresh', recovery: 'previous-catalog' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    {
      name: 'the binding keeps the catalog that last listed',
      check: (_outcome, context) => JSON.stringify(context.store.bound) === '["ping"]',
    },
    costKept,
  ],
  async run(context) {
    const server = liveServer(context, 1);
    const store = createInMemoryAgentRunStore();
    const { model, calls } = scripted([
      { toolCalls: [{ toolName: 'enable', args: {} }] },
      { text: 'Reports could not be enabled yet.' },
    ]);
    const result = await runAgent({
      model,
      messages: context.messages,
      mcp: [server.client],
      onCatalogChange: 'accept',
      session: { store, runId: 'm', scope: 'eval' },
      tools: {
        enable: {
          parameters,
          execute: () => {
            server.addReport();
            return 'requested';
          },
        },
      },
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    context.store.bound = boundTools(await store.load('m'));
    context.store.billedCalls = calls();
    return {
      ...result,
      recovery: result.status === 'completed' ? 'previous-catalog' : 'other',
    };
  },
};

/**
 * A run that accepts catalog changes, killed on the save that would record the
 * refreshed catalog: the stored run is bound to the old catalog, and the server
 * keeps its new one. Returns what a resume needs; the resume decides.
 */
async function diedBeforeTheRecord(context: EvalTaskContext) {
  const server = liveServer(context);
  const durable = createInMemoryAgentRunStore();
  let refreshed = false;
  let crashed = false;
  const dying: AgentRunStore = {
    load: (runId) => durable.load(runId),
    save(envelope) {
      if (!crashed && refreshed && boundTools(envelope).includes('report')) {
        crashed = true;
        context.interrupt('mcp-hot-refresh');
        throw new Error('process died');
      }
      return durable.save(envelope);
    },
  };
  const { model, calls } = scripted([
    { toolCalls: [{ toolName: 'enable', id: 'e1', args: {} }] },
    { toolCalls: [{ toolName: 'report', id: 'r1', args: {} }] },
    { text: 'Built the report.' },
  ]);
  const options = {
    model,
    messages: context.messages,
    mcp: [server.client],
    tools: {
      enable: {
        parameters,
        execute: () => {
          refreshed = true;
          server.addReport();
          return 'enabled';
        },
      },
    },
    deps: { observer: context.observer, priceProvider: mockPrices },
  };
  await runAgent({
    ...options,
    onCatalogChange: 'accept',
    session: { store: dying, runId: 'm', scope: 'eval' },
  });
  return { durable, calls, options, session: { store: durable, runId: 'm', scope: 'eval' } };
}

export const mcpRefreshRecordFailure: EvalTaskManifest = {
  id: 'fault/mcp-refresh-record-failure',
  version: 2,
  title: 'The process dies before the run records a refreshed MCP catalog',
  tags: ['fault', 'native', 'mcp'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Enable reports, then build one.' }] },
  // Documented (native-mcp.mdx): a resume whose catalog drifted fails and
  // leaves the stored run untouched unless it accepts the change. This one
  // resumes under the native default, onCatalogChange: 'stop'; the accepting
  // resume is fault/mcp-refresh-record-failure-accepted.
  fault: { boundary: 'mcp-hot-refresh', recovery: 'resume-refused' },
  acceptance: [
    {
      name: 'the resume fails on the catalog drift',
      check: (outcome) =>
        outcome.status === 'failed' &&
        outcome.error?.message === 'MCP tool catalog changed across resume (added: report).',
    },
    {
      name: 'the stored run is untouched',
      check: (_outcome, context) => context.store.untouched === true,
    },
    {
      name: 'the new tool was never called',
      check: (_outcome, context) => context.store.reportCalled !== true,
    },
    costKept,
  ],
  async run(context) {
    const { durable, calls, options, session } = await diedBeforeTheRecord(context);
    const before = JSON.stringify(await durable.load('m'));
    const resumed = await resumeAgent({ ...options, session });
    context.store.untouched = JSON.stringify(await durable.load('m')) === before;
    context.store.reportCalled = context.observer
      .events()
      .some((event) => event.type === 'tool.started' && event.toolName === 'report');
    context.store.billedCalls = calls();
    // The resume fails before its first model call, so its accounting is the
    // stored run's: one billed call.
    return {
      ...resumed,
      recovery: resumed.status === 'failed' && calls() === 1 ? 'resume-refused' : 'other',
    };
  },
};

export const mcpRefreshRecordFailureAccepted: EvalTaskManifest = {
  id: 'fault/mcp-refresh-record-failure-accepted',
  version: 1,
  title: "The same crash, resumed with onCatalogChange: 'accept': the resume records the catalog",
  tags: ['fault', 'native', 'mcp'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Enable reports, then build one.' }] },
  // Documented (native-mcp.mdx): an accepting resume records the servers' new
  // catalog with its first write, before its first model call, and goes on.
  fault: { boundary: 'mcp-hot-refresh', recovery: 'catalog-accepted-on-resume' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    {
      name: "the resume's first write records the new catalog",
      check: (_outcome, context) =>
        JSON.stringify(context.store.firstWrite) === '["ping","report"]',
    },
    ranOnce('mcp:report'),
    costKept,
  ],
  async run(context) {
    const { durable, calls, options, session } = await diedBeforeTheRecord(context);
    const billedBefore = calls();
    const watching: AgentRunStore = {
      load: (runId) => durable.load(runId),
      save(envelope) {
        // Recorded before the resume's first model call.
        if (context.store.firstWrite === undefined && calls() === billedBefore)
          context.store.firstWrite = boundTools(envelope);
        return durable.save(envelope);
      },
    };
    const resumed = await resumeAgent({
      ...options,
      onCatalogChange: 'accept',
      session: { ...session, store: watching },
    });
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        resumed.status === 'completed' && billedBefore === 1 && calls() === 3
          ? 'catalog-accepted-on-resume'
          : 'other',
    };
  },
};
