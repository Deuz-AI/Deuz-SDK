/**
 * The V3 native run record's rules (2.4, spec §4.1): a V3 envelope is
 * version 3 and stays version 3, it is encoded like a 2.3 envelope (bytes
 * included), and a save that is not the stored revision plus one is a
 * `RevisionConflictError` on the `'run'` subsystem.
 */
import { describe, expect, it } from 'vitest';
import {
  assertAgentRunEnvelopeV3,
  assertEnvelopeRevisionV3,
  decodeAgentRunEnvelopeV3,
  encodeAgentRunEnvelopeV3,
  isAgentRunEnvelopeV3,
} from '../src/agent-run-v3';
import { RevisionConflictError } from '../src/errors';
import { createWorkingMemoryFixture } from './fixtures/working-memory';
import { contextPackage, envelopeV3 } from './fixtures/agent-run-v3';

describe('V3 envelope validation', () => {
  it('accepts a V3 envelope with context, working memory and memory intents', () => {
    const pkg = contextPackage(0);
    const envelope = envelopeV3('run', 1, {
      context: {
        compiler: { version: 1, passes: 1, placed: [] },
        steps: [
          {
            step: 0,
            manifest: pkg.manifest,
            blob: { digest: `sha256:${'d'.repeat(64)}`, bytes: 10 },
          },
        ],
      },
      workingMemory: createWorkingMemoryFixture(),
      memoryIntents: [{ operationId: 'op-1', status: 'intended' }],
      memory: { extraction: { status: 'partial', operationId: 'x', planned: 2 } as never },
    });
    expect(() => assertAgentRunEnvelopeV3(envelope)).not.toThrow();
    expect(isAgentRunEnvelopeV3(envelope)).toBe(true);
  });

  it.each([
    ['version 1', { version: 1 }, /version 3/],
    ['version 2', { version: 2 }, /version 3/],
    ['version 4', { version: 4 }, /version 3/],
    ['another kind', { kind: 'deuz-swarm' }, /deuz-agent-run/],
    ['an empty runId', { runId: '' }, /runId/],
    ['a non-string scope', { scope: 7 }, /scope/],
    ['no revision', { revision: undefined }, /revision/],
    ['revision 0', { revision: 0 }, /revision/],
    ['a fractional revision', { revision: 1.5 }, /revision/],
    ['an unknown phase', { phase: 'paused' }, /phase/],
    ['messages that are not a list', { messages: {} }, /messages/],
    ['checkpoints that are not an object', { checkpoints: [] }, /checkpoints/],
    ['context steps that are not a list', { context: { steps: {} } }, /context/],
    [
      'a step blob with a malformed digest',
      { context: { steps: [{ step: 0, manifest: {}, blob: { digest: 'sha1:00', bytes: 1 } }] } },
      /digest/,
    ],
    [
      'a working memory of another kind',
      { workingMemory: { kind: 'notes', version: 1 } },
      /working memory/,
    ],
    ['a memory intent without operation id', { memoryIntents: [{ status: 'intended' }] }, /intent/],
    [
      'a memory intent with an unknown status',
      { memoryIntents: [{ operationId: 'o', status: 'done' }] },
      /intent/,
    ],
    ['an unknown extraction status', { memory: { extraction: { status: 'ok' } } }, /extraction/],
  ])('refuses %s with a TypeError', (_name, patch, message) => {
    const envelope = { ...envelopeV3('run', 1), ...patch } as unknown;
    expect(() => assertAgentRunEnvelopeV3(envelope)).toThrow(TypeError);
    expect(() => assertAgentRunEnvelopeV3(envelope)).toThrow(message);
    expect(isAgentRunEnvelopeV3(envelope)).toBe(false);
  });

  it('refuses what is not an object', () => {
    for (const value of [undefined, null, 'run', 3, []])
      expect(() => assertAgentRunEnvelopeV3(value)).toThrow(TypeError);
  });
});

describe('V3 envelope encoding', () => {
  it('round-trips the envelope, bytes included, as a 2.3 envelope is encoded', () => {
    const envelope = envelopeV3('run', 2, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', image: new Uint8Array([1, 2, 255]), mediaType: 'image/png' }],
        },
      ],
      workingMemory: createWorkingMemoryFixture(),
    });
    const decoded = decodeAgentRunEnvelopeV3(encodeAgentRunEnvelopeV3(envelope));
    expect(decoded).toEqual(envelope);
    const part = (decoded.messages[0]!.content as { image: unknown }[])[0]!;
    expect(part.image).toBeInstanceOf(Uint8Array);
  });

  it('never encodes a version 1 or 2 envelope, and never decodes one as V3', () => {
    const downgraded = { ...envelopeV3('run', 3), version: 2 } as unknown as Parameters<
      typeof encodeAgentRunEnvelopeV3
    >[0];
    expect(() => encodeAgentRunEnvelopeV3(downgraded)).toThrow(/version 3/);
    const legacy = JSON.stringify({ ...envelopeV3('run', 3), version: 1 });
    expect(() => decodeAgentRunEnvelopeV3(legacy)).toThrow(/version 3/);
  });

  it('refuses state JSON would change silently', () => {
    const envelope = envelopeV3('run', 1, { candidateText: undefined, modelSteps: Number.NaN });
    expect(() => encodeAgentRunEnvelopeV3(envelope)).toThrow();
  });
});

describe('V3 revision fence', () => {
  it('takes revision 1 for a new run and the stored revision plus one after it', () => {
    expect(() => assertEnvelopeRevisionV3(undefined, { runId: 'r', revision: 1 })).not.toThrow();
    expect(() =>
      assertEnvelopeRevisionV3({ revision: 4 }, { runId: 'r', revision: 5 }),
    ).not.toThrow();
  });

  it('answers any other revision with a RevisionConflictError on the run', () => {
    const cases: [{ revision: number } | undefined, number, number | undefined][] = [
      [undefined, 2, undefined],
      [{ revision: 4 }, 4, 4],
      [{ revision: 4 }, 6, 4],
      [{ revision: 4 }, 3, 4],
    ];
    for (const [stored, revision, actual] of cases) {
      let caught: unknown;
      try {
        assertEnvelopeRevisionV3(stored, { runId: 'run-7', revision });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RevisionConflictError);
      const error = caught as RevisionConflictError;
      expect(error.code).toBe('revision_conflict');
      expect(error.subsystem).toBe('run');
      expect(error.key).toBe('run-7');
      // What the writer believed was stored, and what was.
      expect(error.expectedRevision).toBe(revision - 1);
      expect(error.actualRevision).toBe(actual);
    }
  });
});
