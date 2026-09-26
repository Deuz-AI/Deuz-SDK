/**
 * evolve/store.ts — the `PopulationStore` seam's shared rules and the
 * edge-safe in-memory backend (2.2). The SQLite backend
 * (`src/node/evolve-sqlite.ts`) reuses the codec and validators here, so both
 * accept and reject exactly the same records.
 */
import type {
  EvolveCandidate,
  EvolveCandidateQuery,
  EvolveGenerationCommit,
  EvolveKey,
  EvolveRunRecord,
  PopulationStore,
} from './types';

export class EvolveConflictError extends Error {
  readonly name = 'EvolveConflictError';

  constructor(message = 'Evolve run conflict') {
    super(message);
  }
}

function canonical(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Evolve state must be finite at ${path}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonical(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`Evolve state requires plain objects at ${path}`);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item, `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`Evolve state must be JSON-serializable at ${path}`);
}

/** Canonical JSON: sorted keys, no `undefined`, finite numbers, plain objects only. */
export function encodeEvolve(value: unknown): string {
  return JSON.stringify(canonical(value, '$'));
}

export function decodeEvolve<T>(value: string): T {
  return JSON.parse(value) as T;
}

/** The deterministic slot ID a resumed run looks up before calling a model. */
export function evolveCandidateId(generation: number, island: number, slot: number): string {
  return `g${generation}-i${island}-s${slot}`;
}

function nonempty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be a nonempty string`);
}

const integer = (value: unknown, min: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

export function validateEvolveKey(key: EvolveKey): void {
  nonempty(key?.scope, 'scope');
  nonempty(key?.runId, 'runId');
}

export function validateRunRecord(run: EvolveRunRecord): string {
  validateEvolveKey(run);
  if (
    run.kind !== 'deuz-evolve' ||
    run.version !== 1 ||
    typeof run.seed !== 'string' ||
    !integer(run.generation, -1) ||
    !integer(run.islandCount, 1) ||
    !integer(run.mutationsPerGeneration, 1) ||
    !Array.isArray(run.islands) ||
    run.islands.length !== run.islandCount
  ) {
    throw new TypeError('Malformed evolve run record');
  }
  return encodeEvolve(run);
}

export function validateCandidate(candidate: EvolveCandidate): string {
  validateEvolveKey(candidate);
  if (
    !integer(candidate.generation, 0) ||
    !integer(candidate.island, 0) ||
    !integer(candidate.slot, 0) ||
    typeof candidate.program !== 'string' ||
    typeof candidate.accepted !== 'boolean'
  ) {
    throw new TypeError('Malformed evolve candidate');
  }
  if (candidate.id !== evolveCandidateId(candidate.generation, candidate.island, candidate.slot))
    throw new TypeError('Candidate IDs must be g{generation}-i{island}-s{slot}');
  return encodeEvolve(candidate);
}

export function compareCandidates(a: EvolveCandidate, b: EvolveCandidate): number {
  return a.generation - b.generation || a.island - b.island || a.slot - b.slot;
}

export function validateCommit(commit: EvolveGenerationCommit): string {
  validateEvolveKey(commit);
  const encoded = validateRunRecord(commit.run);
  if (commit.run.scope !== commit.scope || commit.run.runId !== commit.runId)
    throw new TypeError('Commit key and run record disagree');
  if (
    !integer(commit.expectedGeneration, -1) ||
    commit.run.generation !== commit.expectedGeneration + 1
  )
    throw new TypeError('A committed generation must be expectedGeneration + 1');
  return encoded;
}

const runKey = (key: EvolveKey) => JSON.stringify([key.scope, key.runId]);

/** Edge-safe, process-local population store. Records are copied in and out. */
export function createInMemoryPopulationStore(): PopulationStore {
  const runs = new Map<string, { run: string; candidates: Map<string, string> }>();
  const entry = (key: EvolveKey) => {
    const found = runs.get(runKey(key));
    if (!found) throw new Error('Evolve run not found');
    return found;
  };
  return {
    async createRun(run) {
      const encoded = validateRunRecord(run);
      if (runs.has(runKey(run))) throw new EvolveConflictError('Evolve run already exists');
      runs.set(runKey(run), { run: encoded, candidates: new Map() });
    },
    async loadRun(key) {
      validateEvolveKey(key);
      const found = runs.get(runKey(key));
      return found ? decodeEvolve<EvolveRunRecord>(found.run) : undefined;
    },
    async putCandidate(candidate) {
      const encoded = validateCandidate(candidate);
      const found = entry(candidate);
      const existing = found.candidates.get(candidate.id);
      if (existing !== undefined) {
        if (existing !== encoded)
          throw new EvolveConflictError(`Conflicting candidate ${candidate.id}`);
        return false;
      }
      found.candidates.set(candidate.id, encoded);
      return true;
    },
    async listCandidates(key, query: EvolveCandidateQuery = {}) {
      validateEvolveKey(key);
      const found = runs.get(runKey(key));
      if (!found) return [];
      const ids = query.ids ? new Set(query.ids) : undefined;
      return [...found.candidates.values()]
        .map((value) => decodeEvolve<EvolveCandidate>(value))
        .filter(
          (item) =>
            (query.generation === undefined || item.generation === query.generation) &&
            (!ids || ids.has(item.id)),
        )
        .sort(compareCandidates);
    },
    async commitGeneration(commit) {
      const encoded = validateCommit(commit);
      const found = entry(commit);
      if (decodeEvolve<EvolveRunRecord>(found.run).generation !== commit.expectedGeneration)
        throw new EvolveConflictError('Evolve generation conflict');
      found.run = encoded;
    },
    async saveRun(run) {
      const encoded = validateRunRecord(run);
      const found = entry(run);
      if (decodeEvolve<EvolveRunRecord>(found.run).generation !== run.generation)
        throw new EvolveConflictError('Evolve generation conflict');
      found.run = encoded;
    },
  };
}
