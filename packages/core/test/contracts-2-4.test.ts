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
