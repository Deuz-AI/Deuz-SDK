/**
 * The 2.4 error codes (W0), added once so no W1 lane has to touch the shared
 * error model: a context budget that mandatory content does not fit, revision
 * and operation conflicts of the new stores, a store backend that cannot carry
 * a 2.4 feature (Redis with V3 runs), and the goal-runtime additions to
 * GoalErrorCode. Each is a DeuzError (cross-realm `isDeuzError`, stable
 * `code`) whose JSON carries ids, counts and enums, never content.
 */
import { describe, expect, it } from 'vitest';
import {
  ContextBudgetExceededError,
  DeuzError,
  EmbeddingMismatchError,
  OperationConflictError,
  RevisionConflictError,
  UnsupportedStoreError,
  isDeuzError,
} from '../src/errors';
import { GoalError } from '../src/goal/errors';

describe('ContextBudgetExceededError', () => {
  it('reports how far mandatory content overshoots the budget', () => {
    const error = new ContextBudgetExceededError({
      requiredTokens: 9000,
      availableTokens: 4096,
      phase: 'overflow-retry',
    });
    expect(error).toBeInstanceOf(DeuzError);
    expect(isDeuzError(error)).toBe(true);
    expect(error.code).toBe('context_budget_exceeded');
    expect(error.requiredTokens).toBe(9000);
    expect(error.availableTokens).toBe(4096);
    expect(error.phase).toBe('overflow-retry');
    expect(error.message).toMatch(/9000/);
    expect(error.toJSON()).toEqual({
      name: 'ContextBudgetExceededError',
      code: 'context_budget_exceeded',
      message: error.message,
      details: { requiredTokens: 9000, availableTokens: 4096, phase: 'overflow-retry' },
    });
  });

  it('is never a retryable error', () => {
    const error = new ContextBudgetExceededError({
      requiredTokens: 2,
      availableTokens: 1,
      phase: 'compile',
    });
    expect((error as unknown as { isRetryable?: boolean }).isRetryable).not.toBe(true);
  });
});

describe('RevisionConflictError', () => {
  it('names the store, the record and both revisions', () => {
    const error = new RevisionConflictError({
      subsystem: 'memory',
      key: 'mem_1',
      expectedRevision: 3,
      actualRevision: 4,
      attempts: 3,
    });
    expect(isDeuzError(error)).toBe(true);
    expect(error.code).toBe('revision_conflict');
    expect(error.toJSON().details).toEqual({
      subsystem: 'memory',
      key: 'mem_1',
      expectedRevision: 3,
      actualRevision: 4,
      attempts: 3,
    });
  });

  it('accepts a missing record (no actual revision)', () => {
    const error = new RevisionConflictError({ subsystem: 'chat', key: 'c1', expectedRevision: 2 });
    expect(error.actualRevision).toBeUndefined();
    expect(error.toJSON().details).toEqual({ subsystem: 'chat', key: 'c1', expectedRevision: 2 });
  });
});

describe('OperationConflictError', () => {
  it('names the operation id reused with a different request', () => {
    const error = new OperationConflictError({
      subsystem: 'process',
      operationId: 'op-7',
      storedDigest: `sha256:${'a'.repeat(64)}`,
      requestDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(isDeuzError(error)).toBe(true);
    expect(error.code).toBe('operation_conflict');
    expect(error.message).toMatch(/op-7/);
    expect(error.toJSON().details).toEqual({
      subsystem: 'process',
      operationId: 'op-7',
      storedDigest: `sha256:${'a'.repeat(64)}`,
      requestDigest: `sha256:${'b'.repeat(64)}`,
    });
  });
});

describe('EmbeddingMismatchError', () => {
  it('names both embedding models and sizes instead of scoring zero', () => {
    const error = new EmbeddingMismatchError({
      expected: { modelId: 'text-embedding-3-small', dims: 1536, generation: 2 },
      actual: { modelId: 'voyage-3', dims: 1024 },
    });
    expect(isDeuzError(error)).toBe(true);
    expect(error.code).toBe('embedding_mismatch');
    expect(error.message).toMatch(/voyage-3/);
    expect(error.toJSON().details).toEqual({
      expectedModelId: 'text-embedding-3-small',
      expectedDims: 1536,
      expectedGeneration: 2,
      actualModelId: 'voyage-3',
      actualDims: 1024,
    });
  });
});

describe('UnsupportedStoreError', () => {
  it('rejects Redis with V3 runs at configuration time, fatally', () => {
    const error = new UnsupportedStoreError({ backend: 'redis', feature: 'agent-run-v3' });
    expect(isDeuzError(error)).toBe(true);
    expect(error.code).toBe('unsupported_store');
    expect(error.fatalExecution).toBe(true);
    expect(error.message).toMatch(/redis/i);
    expect(error.message).toMatch(/agent-run-v3/);
    expect(error.toJSON().details).toEqual({ backend: 'redis', feature: 'agent-run-v3' });
  });
});

describe('GoalErrorCode (2.4 additions)', () => {
  it('carries the supervisor and webhook codes', () => {
    for (const code of ['lease_lost', 'stale', 'policy_limit', 'delivery_conflict'] as const) {
      const error = new GoalError(code, 'x');
      expect(error.code).toBe(code);
      expect(error.name).toBe('GoalError');
    }
  });
});
