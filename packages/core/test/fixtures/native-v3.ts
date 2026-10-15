/**
 * Test doubles for V3 native runs (2.4): a scripted mock model whose calls
 * can also answer with a provider overflow, the request bodies it received,
 * and an in-memory V3 run store that records every save and blob write and
 * can fail a chosen save (a process that dies there).
 */
import { vi } from 'vitest';
import { createInMemoryAgentRunStoreV3 } from '../../src/agent-run-v3-store';
import { sha256DigestSync } from '../../src/context/sha256';
import type {
  ContextCandidate,
  ContextCompiler,
  ContextSource,
  ContextSourceKind,
  ContextSourceRequest,
  ContextStepInput,
} from '../../src/context/types';
import { readConfig } from '../../src/internal/config-symbol';
import { createMockModel, type MockResponse } from '../../src/testing';
import type { AgentRunEnvelopeV3, AgentRunStoreV3 } from '../../src/types/agent-run-v3';
import type { Dependencies } from '../../src/types/deps';

/** One scripted call: a mock turn, or the provider refusing the request as too long. */
export type ScriptedCall = MockResponse | 'overflow';

/** A request body as the Chat Completions wire sent it. */
export interface WireRequest {
  messages: { role: string; content?: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
  [key: string]: unknown;
}

/** The OpenAI-compatible over-long-prompt answer (mapped to ContextOverflowError). */
function overflowResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'context_length_exceeded',
        type: 'invalid_request_error',
        message: "This model's maximum context length is exceeded.",
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * A mock model following `script` (the last entry repeats). `capabilities`
 * sizes its context window for budget tests.
 */
export function scriptedModel(script: ScriptedCall[]) {
  const turns = script.filter((call): call is MockResponse => call !== 'overflow');
  const model = createMockModel({ responses: turns.length > 0 ? turns : [{ text: '' }] });
  const config = readConfig(model)!;
  const base = config.fetch!;
  let call = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = script[Math.min(call, script.length - 1)];
    call += 1;
    if (entry === 'overflow') return overflowResponse();
    return base(input, init);
  });
  config.fetch = fetch as unknown as typeof globalThis.fetch;
  const requests = (): WireRequest[] =>
    fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as WireRequest);
  return { model, fetch, requests };
}

/** The text of a wire message (string content or text parts). */
export function wireText(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as { type?: string; text?: string }[])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}

export interface RecordingStoreV3 extends AgentRunStoreV3 {
  saves: AgentRunEnvelopeV3[];
  blobs: string[];
  /** Every store call in order: `save:<revision>`, `putBlob:<digest>`. */
  log: string[];
  /** Makes the `n`-th next save (1 = the next one) and every later one fail. */
  failFromSave(n: number): void;
}

/** An in-memory V3 store that records what it is given. */
export function recordingStoreV3(inner: AgentRunStoreV3 = createInMemoryAgentRunStoreV3()) {
  const saves: AgentRunEnvelopeV3[] = [];
  const blobs: string[] = [];
  const log: string[] = [];
  let failAt: number | undefined;
  let seen = 0;
  const store: RecordingStoreV3 = {
    checkpointVersion: 3,
    saves,
    blobs,
    log,
    failFromSave(n) {
      failAt = seen + n;
    },
    load: (runId) => inner.load(runId),
    async save(envelope) {
      seen += 1;
      if (failAt !== undefined && seen >= failAt) throw new Error('process died');
      await inner.save(envelope);
      saves.push(structuredClone(envelope));
      log.push(`save:${envelope.revision}`);
    },
    list: (query) => inner.list(query),
    async putBlob(blob) {
      await inner.putBlob(blob);
      blobs.push(blob.digest);
      log.push(`putBlob:${blob.digest}`);
    },
    getBlob: (digest) => inner.getBlob(digest),
    redactForgotten: (event) => inner.redactForgotten(event),
    prune: (options) => inner.prune(options),
  };
  return store;
}

/** Deterministic dependencies: a fixed clock and counted ids. */
export function fixedDeps(start = 10_000): Dependencies {
  let id = 0;
  let now = start;
  return {
    clock: {
      now: () => now++,
      setTimeout: (fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    generateId: () => `id-${++id}`,
  } as Dependencies;
}

/** A context candidate whose digest is that of its text. */
export function candidate(recordId: string, text: string, score = 1): ContextCandidate {
  return { recordId, text, score, digest: sha256DigestSync(text) };
}

/** A context source answering from a fixed list, recording every request. */
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
