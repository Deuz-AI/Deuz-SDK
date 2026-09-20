import { describe, expect, it } from 'vitest';
import {
  assertExecutionPolicy,
  createExecutionContext,
  ExecutionPolicyError,
} from '../src/execution-policy';
import type { ExecutionContextSnapshot } from '../src/execution-policy';

describe('native execution policy', () => {
  it('immutably intersects mandatory restrictions and cannot loosen inherited limits', () => {
    const tools = ['read', 'write'];
    const parent = createExecutionContext({
      policy: {
        allowedTools: tools,
        allowedModels: ['safe'],
        requireApproval: true,
        maxDepth: 2,
        deadlineAt: 100,
      },
      budget: { tokens: 100, usd: 2 },
    });
    tools.push('shell');
    const child = parent.child({
      scopeId: 'worker',
      policy: {
        allowedTools: ['read', 'shell'],
        allowedModels: ['safe', 'other'],
        requireApproval: false,
        maxDepth: 99,
        deadlineAt: 1000,
      },
      budget: { tokens: 1000, usd: 1 },
    });
    expect(child.policy).toEqual({
      allowedTools: ['read'],
      allowedModels: ['safe'],
      requireApproval: true,
      maxDepth: 2,
      deadlineAt: 100,
    });
    expect(child.budget).toEqual({ tokens: 100, usd: 1 });
    expect(child.ledger).toBe(parent.ledger);
    expect(child.depth).toBe(1);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.policy.allowedTools)).toBe(true);
    expect(Object.isFrozen(child.budget)).toBe(true);
    expect(parent.policy.allowedTools).toEqual(['read', 'write']);
  });

  it('distinguishes omitted allowlists from empty deny-all allowlists', () => {
    const any = createExecutionContext();
    assertExecutionPolicy(any, { toolName: 'anything', modelId: 'anything' });
    const none = any.child({ scopeId: 'none', policy: { allowedTools: [], allowedModels: [] } });
    expect(() => assertExecutionPolicy(none, { toolName: 'read' })).toThrow(ExecutionPolicyError);
    expect(() => assertExecutionPolicy(none, { modelId: 'safe' })).toThrow(ExecutionPolicyError);
    const grandchild = none.child({
      scopeId: 'try-widen',
      policy: { allowedTools: ['read'], allowedModels: ['safe'] },
    });
    expect(grandchild.policy.allowedTools).toEqual([]);
    expect(grandchild.policy.allowedModels).toEqual([]);
  });

  it('checks depth at child creation and absolute deadline with the injected clock', async () => {
    const root = createExecutionContext({ policy: { maxDepth: 1, deadlineAt: 100 } });
    const child = root.child({ scopeId: 'a' });
    expect(() => child.child({ scopeId: 'b', policy: { maxDepth: 10 } })).toThrow(
      ExecutionPolicyError,
    );
    expect(() => assertExecutionPolicy(root)).toThrow(/clock value/);
    assertExecutionPolicy(root, { now: 99 });
    expect(() => assertExecutionPolicy(root, { now: 100 })).toThrow(/deadline/);
    await root.reserve({ requestId: 'before', modelId: 'm', now: 99 });
    expect(() => root.reserve({ requestId: 'after', modelId: 'm', now: 100 })).toThrow(
      ExecutionPolicyError,
    );
    expect(root.ledger.get('after')).toBeUndefined();
  });

  it('applies the parent aggregate cap across parallel children', async () => {
    const root = createExecutionContext({ budget: { tokens: 100 } });
    const left = root.child({ scopeId: 'left' });
    const right = root.child({ scopeId: 'right' });
    const results = await Promise.allSettled([
      left.reserve({ requestId: 'a', modelId: 'm', tokens: 60 }),
      right.reserve({ requestId: 'b', modelId: 'm', tokens: 60 }),
    ]);
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
    expect(root.ledger.totals().committed.tokens).toBe(60);
    expect(root.ledger.totals(root.scopeId).committed.tokens).toBe(60);
  });

  it('enforces a tighter child subtree cap without taking capacity from siblings', async () => {
    const root = createExecutionContext({ budget: { tokens: 100 } });
    const narrow = root.child({ scopeId: 'narrow', budget: { tokens: 20 } });
    const nested = narrow.child({ scopeId: 'nested', budget: { tokens: 1000 } });
    await nested.reserve({ requestId: 'a', modelId: 'm', tokens: 20 });
    await expect(narrow.reserve({ requestId: 'b', modelId: 'm', tokens: 1 })).rejects.toMatchObject(
      { code: 'budget_exceeded' },
    );
    await root.child({ scopeId: 'other' }).reserve({ requestId: 'c', modelId: 'm', tokens: 80 });
    expect(root.ledger.totals(narrow.scopeId).committed.tokens).toBe(20);
    expect(root.ledger.totals().committed.tokens).toBe(100);
  });

  it('recovers subtree accounting and cannot widen restored policy or budgets', async () => {
    const root = createExecutionContext({
      policy: { allowedModels: ['safe'], requireApproval: true },
      budget: { tokens: 100 },
    });
    const child = root.child({ scopeId: 'worker', budget: { tokens: 20 } });
    await child.reserve({ requestId: 'a', modelId: 'safe', tokens: 20 });
    await child.ledger.markUnknown('a');
    const saved = JSON.parse(JSON.stringify(child.snapshot())) as ExecutionContextSnapshot;
    const recovered = createExecutionContext({
      snapshot: saved,
      policy: { allowedModels: ['safe', 'other'], requireApproval: false },
      budget: { tokens: 1000 },
    });
    expect(recovered.policy).toEqual(child.policy);
    expect(recovered.budget.tokens).toBe(20);
    expect(recovered.ledger.budget.tokens).toBe(100);
    expect(recovered.scopeId).toBe(child.scopeId);
    expect(recovered.depth).toBe(1);
    await expect(
      recovered.reserve({ requestId: 'b', modelId: 'safe', tokens: 1 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await recovered.ledger.settle({ requestId: 'a', tokens: 5 });
    await recovered.reserve({ requestId: 'b', modelId: 'safe', tokens: 15 });
  });

  it('prevents recreating an existing scope with a looser budget', async () => {
    const root = createExecutionContext({ budget: { tokens: 100 } });
    await root
      .child({ scopeId: 'a', budget: { tokens: 10 } })
      .reserve({ requestId: 'first', modelId: 'm', tokens: 10 });
    const attempted = root.child({ scopeId: 'a', budget: { tokens: 100 } });
    await expect(
      attempted.reserve({ requestId: 'second', modelId: 'm', tokens: 1 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('uses collision-free nested scope identifiers', () => {
    const root = createExecutionContext();
    expect(root.child({ scopeId: 'a/b' }).scopeId).not.toBe(
      root.child({ scopeId: 'a' }).child({ scopeId: 'b' }).scopeId,
    );
  });

  it('rejects invalid policy and corrupted execution ancestry', () => {
    expect(() => createExecutionContext({ policy: { maxDepth: -1 } })).toThrow(
      ExecutionPolicyError,
    );
    const snapshot = createExecutionContext().child({ scopeId: 'a' }).snapshot();
    expect(() => createExecutionContext({ snapshot: { ...snapshot, depth: 0 } })).toThrow(
      ExecutionPolicyError,
    );
    expect(() =>
      createExecutionContext({
        snapshot: { ...snapshot, scopes: [{ id: 'unrelated', budget: {} }, snapshot.scopes[1]!] },
      }),
    ).toThrow(ExecutionPolicyError);
  });
});
