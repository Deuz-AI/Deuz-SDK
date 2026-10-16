/**
 * Builders for V3 native run records (2.4): an envelope at a revision, and a
 * compiled context package with its manifest, written by hand so the store
 * tests do not depend on the compiler.
 */
import type { ContextManifest, ContextPackage } from '../../src/context/types';
import type { Sha256Digest } from '../../src/internal/digest';
import type { AgentRunEnvelopeV3 } from '../../src/types/agent-run-v3';

const DIGEST_A = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as Sha256Digest;
const DIGEST_W = `sha256:${'c'.repeat(64)}` as Sha256Digest;

/** A minimal V3 envelope at `revision`. */
export function envelopeV3(
  runId: string,
  revision: number,
  extra: Partial<AgentRunEnvelopeV3> = {},
): AgentRunEnvelopeV3 {
  return {
    kind: 'deuz-agent-run',
    version: 3,
    runId,
    revision,
    scope: 'tenant',
    phase: 'running',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 3,
    },
    modelSteps: 0,
    finalizationAttempts: 0,
    verificationAttempts: 0,
    checkpoints: {},
    ...extra,
  };
}

/**
 * A package for model step `step`: one retrieval block with two memory
 * records (`mem-a` at revision `revisionA`, `mem-b` at 1) and a working
 * memory tail. `marker` changes the retrieval text, and so the digest.
 */
export function contextPackage(step: number, marker = 'x', revisionA = 2): ContextPackage {
  const manifest: ContextManifest = {
    version: 1,
    step,
    entries: [
      {
        source: 'memory',
        kind: 'memory',
        recordId: 'mem-a',
        revision: revisionA,
        digest: DIGEST_A,
        query: 'deploy',
        selected: true,
        reason: 'ranked',
        tokens: 12,
      },
      {
        source: 'memory',
        kind: 'memory',
        recordId: 'mem-b',
        revision: 1,
        digest: DIGEST_B,
        selected: true,
        reason: 'ranked',
        tokens: 9,
      },
      {
        source: 'memory',
        kind: 'memory',
        recordId: 'mem-c',
        revision: 4,
        digest: DIGEST_B,
        selected: false,
        reason: 'over-budget',
        tokens: 40,
      },
      {
        source: 'rag',
        kind: 'rag',
        recordId: 'doc-1#0',
        digest: DIGEST_A,
        selected: true,
        reason: 'reallocated',
        tokens: 7,
      },
      {
        source: 'working-memory',
        kind: 'working-memory',
        recordId: 'goal',
        revision: 0,
        digest: DIGEST_W,
        selected: true,
        reason: 'mandatory',
        tokens: 5,
      },
    ],
    sources: [
      {
        source: 'memory',
        kind: 'memory',
        required: false,
        status: 'ok',
        selected: 2,
        excluded: 1,
        tokens: 21,
      },
      {
        source: 'rag',
        kind: 'rag',
        required: false,
        status: 'ok',
        selected: 1,
        excluded: 0,
        tokens: 7,
      },
    ],
    budget: {
      inputTokens: 100_000,
      usedTokens: 2_000,
      contextTokens: 8_192,
      workingMemoryTokens: 1_024,
      selectedTokens: 33,
    },
    estimator: { kind: 'heuristic', calibrated: false },
    refresh: step === 0 ? 'initial' : 'reused',
    pass: 1,
    placement: { append: true, tail: true },
    cachePrefixChanged: false,
  };
  return {
    version: 1,
    blocks: [
      {
        placement: 'append',
        kind: 'retrieval',
        messages: [
          {
            role: 'user',
            content: `<context source="memory">The deploy target is eu-west (${marker}).</context>`,
          },
        ],
        tokens: 28,
        entries: [0, 1, 3],
      },
      {
        placement: 'ephemeral-tail',
        kind: 'working-memory',
        messages: [{ role: 'user', content: '<working_memory>goal: ship</working_memory>' }],
        tokens: 5,
        entries: [4],
      },
    ],
    manifest,
  };
}
