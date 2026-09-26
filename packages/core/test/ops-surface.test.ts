import { describe, expect, it } from 'vitest';
import * as edge from '../src/edge';
import * as ops from '../src/ops';
import { assertEnvelopeRevision, assertLeaseRequest } from '../src/internal/ops-validate';

describe('the public ops surface', () => {
  it('publishes the lease provider but not the stores’ validation helpers', () => {
    for (const entry of [ops, edge]) {
      expect(entry).toHaveProperty('createInMemoryLeaseProvider');
      expect(entry).not.toHaveProperty('assertLeaseRequest');
      expect(entry).not.toHaveProperty('assertEnvelopeRevision');
    }
  });
});

describe('internal ops validation', () => {
  it('accepts a well-formed lease request and rejects a malformed one', () => {
    expect(() => assertLeaseRequest('run', 'a', 1)).not.toThrow();
    expect(() => assertLeaseRequest('', 'a', 1)).toThrow(TypeError);
    expect(() => assertLeaseRequest('run', '', 1)).toThrow(TypeError);
    expect(() => assertLeaseRequest('run', 'a', 0)).toThrow(TypeError);
    expect(() => assertLeaseRequest('run', 'a', 1.5)).toThrow(TypeError);
  });

  it('fences envelope revisions', () => {
    expect(() => assertEnvelopeRevision(undefined, { runId: 'r', revision: 1 })).not.toThrow();
    expect(() =>
      assertEnvelopeRevision({ revision: 1 }, { runId: 'r', revision: 2 }),
    ).not.toThrow();
    expect(() => assertEnvelopeRevision({}, { runId: 'r', revision: undefined })).not.toThrow();
    expect(() => assertEnvelopeRevision({ revision: 2 }, { runId: 'r', revision: 2 })).toThrow(
      'Agent run revision conflict for r: expected 3, got 2',
    );
    expect(() =>
      assertEnvelopeRevision({ revision: 1 }, { runId: 'r', revision: undefined }),
    ).toThrow(/revision conflict/);
  });
});
