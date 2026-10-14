/**
 * The 2.4 contract skeletons (W0): every entry point a W1 lane implements is
 * published now under its final name, and until its lane lands it fails
 * loudly with `NotImplementedError` (code `not_implemented`) naming itself,
 * never silently. A promise-returning stub rejects instead of throwing. The
 * errors each entry re-exports are the shared classes, not copies.
 */
import { describe, expect, it } from 'vitest';
import * as errors from '../src/errors';
import { NotImplementedError } from '../src/internal/not-implemented';
import * as versioned from '../src/memory/versioned';
import * as context from '../src/context';
import * as chat from '../src/chat';
import * as ui from '../src/ui';
import { createTokenEstimator } from '../src/internal/estimate-tokens';

function expectStub(name: string, call: () => unknown): void {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, name).toBeInstanceOf(NotImplementedError);
  expect((thrown as NotImplementedError).feature).toBe(name);
  expect((thrown as NotImplementedError).code).toBe('not_implemented');
}

async function expectAsyncStub(name: string, call: () => Promise<unknown>): Promise<void> {
  const error = await call().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, name).toBeInstanceOf(NotImplementedError);
  expect((error as NotImplementedError).feature).toBe(name);
}

const any = {} as never;

describe('/memory/versioned skeleton', () => {
  it('publishes the session, tools, in-memory store and import helper as stubs', async () => {
    expectStub('createMemorySession', () => versioned.createMemorySession(any));
    expectStub('createVersionedMemoryTools', () => versioned.createVersionedMemoryTools(any));
    expectStub('createInMemoryVersionedMemoryStore', () =>
      versioned.createInMemoryVersionedMemoryStore(),
    );
    await expectAsyncStub('importLegacyMemory', () => versioned.importLegacyMemory(any));
  });

  it('re-exports the shared conflict and mismatch errors', () => {
    expect(versioned.RevisionConflictError).toBe(errors.RevisionConflictError);
    expect(versioned.OperationConflictError).toBe(errors.OperationConflictError);
    expect(versioned.EmbeddingMismatchError).toBe(errors.EmbeddingMismatchError);
    expect(typeof versioned.defineAccountedMemoryLLM).toBe('function');
    expect(typeof versioned.isAccounted).toBe('function');
  });
});

describe('/context skeleton', () => {
  it('publishes the compiler, working memory and source adapters as stubs', () => {
    expectStub('compileContext', () => context.compileContext(any));
    expectStub('createContextCompiler', () => context.createContextCompiler(any));
    expectStub('createWorkingMemory', () => context.createWorkingMemory(any));
    expectStub('applyWorkingMemoryPatch', () => context.applyWorkingMemoryPatch(any, any, any));
    expectStub('workingMemoryTools', () => context.workingMemoryTools(any));
    expectStub('createMemoryContextSource', () => context.createMemoryContextSource(any));
    expectStub('createRagContextSource', () => context.createRagContextSource(any));
    expectStub('createTranscriptContextSource', () => context.createTranscriptContextSource(any));
    expectStub('createSkillsContextSource', () => context.createSkillsContextSource(any));
  });

  it('makes the one token estimator public, unchanged', () => {
    expect(context.createTokenEstimator).toBe(createTokenEstimator);
    const estimator = context.createTokenEstimator();
    expect(estimator.estimate([{ role: 'user', content: 'x'.repeat(36) }])).toBe(14);
  });

  it('pins the spec defaults the compiler implements', () => {
    expect(context.DEFAULT_CONTEXT_BUDGET).toEqual({
      ratio: 0.2,
      maxTokens: 8192,
      workingMemoryTokens: 1024,
      shares: { memory: 2, rag: 2, skills: 1, transcript: 1 },
      candidatesPerSource: 20,
    });
    expect(context.DEFAULT_CONTEXT_REFRESH).toEqual({ minSteps: 2, maxPasses: 4 });
    expect(context.ContextBudgetExceededError).toBe(errors.ContextBudgetExceededError);
  });
});

describe('/chat and /ui 2.4 additions', () => {
  it('publishes the conditional chat store, transcript index and backfill as stubs', async () => {
    expectStub('createInMemoryConditionalChatStore', () =>
      chat.createInMemoryConditionalChatStore(),
    );
    expectStub('createInMemoryTranscriptIndex', () => chat.createInMemoryTranscriptIndex());
    await expectAsyncStub('indexChat', () => chat.indexChat(any, any));
    expect(chat.RevisionConflictError).toBe(errors.RevisionConflictError);
  });

  it('publishes the durable stream store stub, its batch defaults and the capability handshake', () => {
    expectStub('createInMemoryDurableStreamStateStore', () =>
      ui.createInMemoryDurableStreamStateStore(),
    );
    expect(ui.DEFAULT_DURABLE_STREAM_BATCH).toEqual({ maxDelayMs: 20, maxBytes: 16_384 });
    expect(ui.DEUZ_CAPABILITIES_HEADER).toBe('x-deuz-capabilities');
    expect(typeof ui.parseDeuzCapabilities).toBe('function');
  });
});
