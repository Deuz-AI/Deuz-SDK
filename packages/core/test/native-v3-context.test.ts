/**
 * native-v3-context.test.ts (2.4, spec §2.3 "Native çalışma sırası",
 * "Yerleşim ve prompt cache") — the context compiler in the native loop of a
 * V3 run: it runs after compaction and the host's prepareStep, with the
 * step's real model and active tools; the retrieval block enters the history
 * append-only (once, after the call succeeded), the working memory is the
 * request's ephemeral tail and never history, the system message and tool
 * schemas never change, and each step's package and manifest are in the V3
 * store (content-addressed) before its model call.
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import { createContextCompiler } from '../src/context/compiler';
import { sha256DigestSync } from '../src/context/sha256';
import type {
  ContextCandidate,
  ContextCompiler,
  ContextSource,
  ContextSourceKind,
  ContextSourceRequest,
  ContextStepInput,
} from '../src/context/types';
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import type { Message } from '../src/types/message';
import { recordingStoreV3, scriptedModel, wireText, type ScriptedCall } from './fixtures/native-v3';

const parameters = { type: 'object', properties: { q: { type: 'string' } } };

export function candidate(recordId: string, text: string, score = 1): ContextCandidate {
  return { recordId, text, score, digest: sha256DigestSync(text) };
}

/** A source answering from a fixed list, recording every request. */
export function fakeSource(id: string, kind: ContextSourceKind, answer: ContextCandidate[]) {
  const requests: ContextSourceRequest[] = [];
  const source: ContextSource = {
    id,
    kind,
    async query(request) {
      requests.push(request);
      return answer;
    },
  };
  return { source, requests };
}

/** A compiler that records what the loop hands it. */
export function spyCompiler(compiler: ContextCompiler) {
  const inputs: ContextStepInput[] = [];
  const spied: ContextCompiler = {
    sources: compiler.sources,
    requestRefresh: () => compiler.requestRefresh(),
    state: () => compiler.state(),
    beforeModelCall(input) {
      inputs.push(structuredClone({ ...input, signal: undefined }));
      return compiler.beforeModelCall(input);
    },
    onOverflow(input) {
      inputs.push(structuredClone({ ...input, signal: undefined }));
      return compiler.onOverflow(input);
    },
  };
  return { compiler: spied, inputs };
}

const isContext = (message: { content?: unknown }) =>
  wireText(message).startsWith('<deuz_context ');
const isMemoryTail = (message: { content?: unknown }) =>
  wireText(message).startsWith('<deuz_working_memory ');

function v3Run(
  store: AgentRunStoreV3,
  script: ScriptedCall[],
  extra: Partial<AgentRunOptionsV3> = {},
) {
  const scripted = scriptedModel(script);
  const options: AgentRunOptionsV3 = {
    model: scripted.model,
    instructions: 'You are careful.',
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store, runId: 'run-ctx', scope: 'tenant' },
    tools: { lookup: { description: 'Look things up.', parameters, execute: () => 'found' } },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    ...extra,
  };
  return { ...scripted, options };
}

describe('context placement in the native loop', () => {
  it('appends retrieval to history once and keeps the working memory an ephemeral tail', async () => {
    const rag = fakeSource('docs', 'rag', [
      candidate('doc-1', 'The deploy target is eu-west.'),
      candidate('doc-2', 'Deploys need a green CI.'),
    ]);
    const store = recordingStoreV3();
    const { options, requests } = v3Run(
      store,
      [{ toolCalls: [{ toolName: 'lookup', id: 'l1', args: { q: 'x' } }] }, { text: 'done' }],
      {
        context: { sources: [rag.source] },
        workingMemory: { create: { scope: 'tenant', goal: 'Ship the service', now: 1 } },
      },
    );
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: 'completed', output: 'done' });

    const [first, second] = requests();
    // Step 0: system, user prompt, the retrieval block, the working memory tail last.
    expect(first!.messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'user']);
    expect(isContext(first!.messages[2]!)).toBe(true);
    expect(isMemoryTail(first!.messages[3]!)).toBe(true);
    expect(wireText(first!.messages[3]!)).toContain('Ship the service');
    // Step 1: the same prefix (the block where it was), the turn, a fresh tail only.
    expect(second!.messages.slice(0, 3)).toEqual(first!.messages.slice(0, 3));
    expect(second!.messages.filter(isContext)).toHaveLength(1);
    expect(second!.messages.filter(isMemoryTail)).toHaveLength(1);
    expect(isMemoryTail(second!.messages.at(-1)!)).toBe(true);
    // System and tool schemas never change.
    expect(second!.messages[0]).toEqual(first!.messages[0]);
    expect(second!.tools).toEqual(first!.tools);
    // Sources were asked once (the first call; no refresh was due at step 1).
    expect(rag.requests).toHaveLength(1);

    // History holds the block once and never the tail; the transcript holds neither.
    const isBlock = (m: Message) => isContext(m);
    expect(result.messages.filter(isBlock)).toHaveLength(1);
    expect(result.messages.filter((m) => isMemoryTail(m))).toHaveLength(0);
    const stored = (await store.load('run-ctx'))!;
    expect(stored.messages.filter(isBlock)).toHaveLength(1);
    expect(stored.transcript?.messages.filter(isBlock) ?? []).toHaveLength(0);

    // One package per model step, in the run record with its blob reference.
    expect(stored.context?.steps.map((step) => step.step)).toEqual([0, 1]);
    expect(stored.context?.steps.map((step) => step.manifest.refresh)).toEqual([
      'initial',
      'reused',
    ]);
    for (const step of stored.context!.steps) {
      expect(step.manifest.blob).toEqual(step.blob);
      expect((await store.getBlob(step.blob.digest)).status).toBe('found');
    }
    expect(stored.context?.compiler?.passes).toBe(1);
  });

  it('writes each package and its manifest before the model call it is for', async () => {
    const rag = fakeSource('docs', 'rag', [candidate('doc-1', 'The deploy target is eu-west.')]);
    const store = recordingStoreV3();
    const run = v3Run(store, [{ text: 'done' }], { context: { sources: [rag.source] } });
    const seen: string[][] = [];
    const fetch = run.fetch.getMockImplementation()!;
    run.fetch.mockImplementation(async (input, init) => {
      seen.push([...store.log]);
      return fetch(input, init);
    });
    await runAgent(run.options);
    const stored = (await store.load('run-ctx'))!;
    const digest = stored.context!.steps[0]!.blob.digest;
    const atCall = seen[0]!;
    const blob = atCall.indexOf(`putBlob:${digest}`);
    expect(blob).toBeGreaterThanOrEqual(0);
    // A save recording the step follows the blob, still before the call.
    const recorded = store.saves.findIndex((save) => save.context?.steps.length === 1);
    expect(atCall.indexOf(`save:${store.saves[recorded]!.revision}`)).toBeGreaterThan(blob);
  });

  it('writes an unchanged package once', async () => {
    const rag = fakeSource('docs', 'rag', [candidate('doc-1', 'The deploy target is eu-west.')]);
    const store = recordingStoreV3();
    const call = (id: string) => ({ toolCalls: [{ toolName: 'lookup', id, args: { q: id } }] });
    const { options } = v3Run(store, [call('a'), call('b'), call('c'), { text: 'done' }], {
      context: { sources: [rag.source] },
      workingMemory: { create: { scope: 'tenant', goal: 'Ship', now: 1 } },
    });
    await runAgent(options);
    const stored = (await store.load('run-ctx'))!;
    const digests = stored.context!.steps.map((step) => step.blob.digest);
    expect(digests).toHaveLength(4);
    // Step 0 carries the retrieval; steps 1-3 only the same tail.
    expect(new Set(digests.slice(1)).size).toBe(1);
    expect(store.blobs).toEqual([...new Set(digests)]);
  });

  it('hands the compiler the step after compaction and prepareStep, with its real model and tools', async () => {
    const rag = fakeSource('docs', 'rag', [candidate('doc-1', 'The deploy target is eu-west.')]);
    const spy = spyCompiler(createContextCompiler({ sources: [rag.source] }));
    const store = recordingStoreV3();
    const { options, model } = v3Run(store, [{ text: 'done' }], {
      context: spy.compiler,
      tools: {
        lookup: { description: 'Look things up.', parameters, execute: () => 'found' },
        other: { description: 'x'.repeat(4_000), parameters, execute: () => 'other' },
      },
      prepareStep: ({ messages }) => ({
        messages: [...messages, { role: 'user', content: 'prepared marker' }],
        activeTools: ['lookup'],
      }),
    });
    await runAgent(options);
    const [input] = spy.inputs;
    expect(input!.messages.at(-1)).toEqual({ role: 'user', content: 'prepared marker' });
    expect(input!.model).toMatchObject({
      provider: model.provider,
      modelId: model.modelId,
      contextWindow: 100_000,
      maxOutputTokens: 4_000,
    });
    // The active tool's schema is counted; the withdrawn 4000-character one is not.
    expect(input!.overheadTokens).toBeGreaterThan(0);
    expect(input!.overheadTokens).toBeLessThan(500);
    expect(input!.runId).toBe('run-ctx');
    expect(input!.step).toBe(0);
  });
});
