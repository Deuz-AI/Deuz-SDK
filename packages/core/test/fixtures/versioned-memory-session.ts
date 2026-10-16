/**
 * Test doubles for the versioned memory session tests (2.4): a scripted
 * memory LLM that answers extraction and reconciliation prompts, a
 * deterministic keyword embedder, and a store wrapper that can inject a
 * concurrent writer between a session's read and its commit.
 */
import { digestJson, sha256Digest } from '../../src/internal/digest';
import { createInMemoryVersionedMemoryStore } from '../../src/memory/versioned';
import type { VersionedMemoryCommit, VersionedMemoryStore } from '../../src/memory/versioned';
import type { Embedder, MemoryLLM, MemoryScope } from '../../src/memory';

export interface ExistingMemory {
  id: string;
  text: string;
}

/** The EXISTING list a reconciliation prompt shows the model (temp ids). */
export function existingIn(user: string): ExistingMemory[] {
  const match = user.match(/EXISTING:\n(.*)\n/);
  return match ? (JSON.parse(match[1]!) as ExistingMemory[]) : [];
}

/** The source tags an extraction prompt shows the model, e.g. `s0`. */
export function sourceTags(user: string): string[] {
  return [...user.matchAll(/^\[(s\d+)\]/gm)].map((match) => match[1]!);
}

export interface ScriptedLLM {
  llm: MemoryLLM;
  calls: { system: string; user: string }[];
  /** Prompts of each kind, in order. */
  extractions(): { system: string; user: string }[];
  reconciliations(): { system: string; user: string }[];
}

/**
 * A memory LLM: `extract` answers extraction prompts (default: no facts),
 * `reconcile` answers reconciliation prompts (default: ADD every new fact).
 */
export function scriptedLLM(
  script: {
    extract?: (prompt: { system: string; user: string }) => unknown;
    reconcile?: (prompt: { system: string; user: string }, existing: ExistingMemory[]) => unknown;
    /** Runs before every answer (e.g. to assert no store commit is open). */
    onCall?: () => void | Promise<void>;
  } = {},
): ScriptedLLM {
  const calls: { system: string; user: string }[] = [];
  const isReconcile = (system: string) => /reconcil/i.test(system);
  return {
    calls,
    extractions: () => calls.filter((call) => !isReconcile(call.system)),
    reconciliations: () => calls.filter((call) => isReconcile(call.system)),
    llm: async (prompt) => {
      calls.push(prompt);
      await script.onCall?.();
      if (isReconcile(prompt.system)) {
        const existing = existingIn(prompt.user);
        const reply =
          script.reconcile?.(prompt, existing) ??
          ({
            memory: (JSON.parse(prompt.user.match(/NEW FACTS:\n(.*)$/s)![1]!) as string[]).map(
              (text) => ({ event: 'ADD', text }),
            ),
          } as unknown);
        return JSON.stringify(reply);
      }
      return JSON.stringify(script.extract?.(prompt) ?? { facts: [] });
    },
  };
}

export interface KeywordEmbedder extends Embedder {
  calls: { texts: string[]; action: string }[];
}

/**
 * A deterministic embedder: one dimension per keyword (plus a bias), so texts
 * that share a keyword are close. `model` names the generation it writes.
 */
export function keywordEmbedder(
  keywords: readonly string[] = ['tea', 'coffee', 'paris', 'london'],
  model = 'kw-1',
): KeywordEmbedder {
  const calls: { texts: string[]; action: string }[] = [];
  return {
    calls,
    async embed(texts, action) {
      calls.push({ texts: [...texts], action });
      return {
        vectors: texts.map((text) => [
          ...keywords.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)),
          0.1,
        ]),
        model,
      };
    },
  };
}

export interface InterceptedStore extends VersionedMemoryStore {
  /** Commits currently inside the store. */
  readonly open: number;
  commits: VersionedMemoryCommit[];
  /** Runs before the next `n` commits reach the store (a concurrent writer). */
  beforeCommit(times: number, interloper: () => Promise<void>): void;
}

/** Wraps a store to count open commits and inject concurrent writes. */
export function interceptedStore(
  base: VersionedMemoryStore = createInMemoryVersionedMemoryStore(),
): InterceptedStore {
  let open = 0;
  let remaining = 0;
  let interloping = false;
  let interloper: (() => Promise<void>) | undefined;
  const commits: VersionedMemoryCommit[] = [];
  const store: InterceptedStore = Object.create(base) as InterceptedStore;
  Object.defineProperties(store, {
    open: { get: () => open },
    commits: { value: commits },
    beforeCommit: {
      value: (times: number, fn: () => Promise<void>) => {
        remaining = times;
        interloper = fn;
      },
    },
    commit: {
      value: async (operation: VersionedMemoryCommit) => {
        // The interloper's own writes pass straight through.
        if (remaining > 0 && interloper && !interloping) {
          remaining--;
          interloping = true;
          try {
            await interloper();
          } finally {
            interloping = false;
          }
        }
        commits.push(operation);
        open++;
        try {
          return await base.commit(operation);
        } finally {
          open--;
        }
      },
    },
  });
  for (const name of [
    'get',
    'search',
    'history',
    'receipt',
    'scopeRevision',
    'forget',
    'pruneHistory',
    'pruneOperations',
  ] as const)
    Object.defineProperty(store, name, {
      value: (base[name] as (...args: unknown[]) => unknown).bind(base),
    });
  Object.defineProperty(store, 'embeddings', { value: base.embeddings });
  return store;
}

let seeded = 0;

/** Writes a record straight into the store, as another writer would. */
export async function seed(
  store: VersionedMemoryStore,
  scope: MemoryScope,
  record: { id: string; text: string; origin?: 'asserted' | 'inferred' },
  operationId = `seed-${record.id}-${++seeded}`,
): Promise<void> {
  const mutations = [
    {
      type: 'create' as const,
      record: {
        id: record.id,
        text: record.text,
        origin: record.origin ?? 'asserted',
        sources: [{ kind: 'host' as const, digest: await sha256Digest(record.text) }],
      },
    },
  ];
  const result = await store.commit({
    operationId,
    scope,
    actor: 'host',
    mutations,
    requestDigest: await digestJson({ operationId, mutations }),
  });
  if (result.status !== 'committed') throw new Error(`seed failed: ${result.status}`);
}
