/**
 * evolve/selection.ts — pure selection policy for `./evolve` (2.2): parent
 * sampling (OpenEvolve's explore / elite / exploit split over weighted,
 * power-law, beam or FunSearch's Boltzmann), prompt inspirations, patch-type
 * choice, the UCB1 model bandit and the MAP-Elites archive. Every random draw
 * comes from an injected seeded stream.
 */
import type { EvolveBanditState, EvolvePatchType, EvolveSelection } from './types';

export interface Scored {
  readonly id: string;
  readonly score?: number;
  readonly accepted?: boolean;
  readonly features?: Readonly<Record<string, number>>;
}

/** Accepted first, then by score descending, then by ID. */
export function rankCandidates<T extends Scored>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const accepted = Number(b.accepted === true) - Number(a.accepted === true);
    if (accepted) return accepted;
    const left = a.score ?? Number.NEGATIVE_INFINITY;
    const right = b.score ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return right > left ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function uniform<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;
}

function roulette<T>(items: readonly T[], weights: readonly number[], rng: () => number): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return uniform(items, rng);
  let point = rng() * total;
  for (let i = 0; i < items.length; i++) {
    point -= weights[i]!;
    if (point < 0 && weights[i]! > 0) return items[i]!;
  }
  // Floating-point remainder: the last positively weighted item.
  for (let i = items.length - 1; i >= 0; i--) if (weights[i]! > 0) return items[i]!;
  return uniform(items, rng);
}

function exploit<T extends Scored>(
  ranked: readonly T[],
  selection: EvolveSelection,
  rng: () => number,
): T {
  if (selection === 'beam') return ranked[0]!;
  const scores = ranked.map((item) => item.score);
  const finite = scores.filter((score): score is number => score !== undefined);
  if (!finite.length) return uniform(ranked, rng);
  if (selection === 'power-law')
    return roulette(
      ranked,
      ranked.map((item, rank) => (item.score === undefined ? 0 : 1 / (rank + 1))),
      rng,
    );
  const max = Math.max(...finite);
  if (typeof selection === 'object') {
    const temperature = selection.boltzmann;
    return roulette(
      ranked,
      scores.map((score) => (score === undefined ? 0 : Math.exp((score - max) / temperature))),
      rng,
    );
  }
  // Fitness-proportional, shifted so the worst scored member keeps a small chance.
  const min = Math.min(...finite);
  const floor = (max - min) * 0.05 || 1;
  return roulette(
    ranked,
    scores.map((score) => (score === undefined ? 0 : score - min + floor)),
    rng,
  );
}

export interface ParentOptions {
  readonly rng: () => number;
  readonly selection: EvolveSelection;
  readonly eliteRatio: number;
  readonly exploreRatio: number;
}

/** Explore (uniform over the island), elite (uniform over the archive) or exploit. */
export function pickParent<T extends Scored>(
  members: readonly T[],
  archive: readonly T[],
  options: ParentOptions,
): T {
  if (!members.length) throw new Error('An island has no members to select from');
  const draw = options.rng();
  if (draw < options.exploreRatio) return uniform(members, options.rng);
  if (draw < options.exploreRatio + options.eliteRatio && archive.length)
    return uniform(archive, options.rng);
  return exploit(rankCandidates(members), options.selection, options.rng);
}

/** The `top` best programs, then `diverse` uniform picks from the rest. */
export function pickInspirations<T extends Scored>(
  pool: readonly T[],
  exclude: readonly string[],
  options: { readonly rng: () => number; readonly top: number; readonly diverse: number },
): T[] {
  const seen = new Set(exclude);
  const ranked = rankCandidates(pool).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const chosen = ranked.slice(0, options.top);
  const rest = ranked.slice(options.top);
  for (let i = 0; i < options.diverse && rest.length; i++)
    chosen.push(rest.splice(Math.floor(options.rng() * rest.length), 1)[0]!);
  return chosen;
}

export function pickPatchType(
  rng: () => number,
  weights: { readonly diff: number; readonly full: number; readonly cross: number },
  canCross: boolean,
): EvolvePatchType {
  const types: EvolvePatchType[] = ['diff', 'full', 'cross'];
  const chosen = roulette(
    types,
    types.map((type) => weights[type]),
    rng,
  );
  return chosen === 'cross' && !canCross ? 'diff' : chosen;
}

/**
 * UCB1 over the model ensemble. `pending` counts picks already made in this
 * generation whose reward is not known yet, so concurrent slots spread out.
 */
export function chooseModel(
  bandit: EvolveBanditState,
  weights: readonly number[],
  pending: readonly number[],
): number {
  const counts = weights.map((_, index) => (bandit.pulls[index] ?? 0) + (pending[index] ?? 0));
  for (let i = 0; i < weights.length; i++) if (weights[i]! > 0 && counts[i] === 0) return i;
  const total = counts.reduce((sum, count, index) => sum + (weights[index]! > 0 ? count : 0), 0);
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < weights.length; i++) {
    if (!(weights[i]! > 0)) continue;
    const pulls = bandit.pulls[i] ?? 0;
    const mean = pulls ? (bandit.rewards[i] ?? 0) / pulls : 0;
    const score = weights[i]! * (mean + Math.sqrt((2 * Math.log(total)) / counts[i]!));
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best < 0) throw new Error('Every evolve model has weight 0');
  return best;
}

function cell(item: Scored, bins: number): string {
  if (!item.features || !Object.keys(item.features).length) return `id:${item.id}`;
  return Object.keys(item.features)
    .sort()
    .map((name) => {
      const value = Math.min(1, Math.max(0, item.features![name]!));
      return `${name}:${Math.min(bins - 1, Math.floor(value * bins))}`;
    })
    .join('|');
}

/**
 * MAP-Elites: the best accepted candidate per feature cell (a candidate with no
 * features is its own cell), truncated to the archive size by score.
 */
export function updateArchive(
  archive: readonly string[],
  added: readonly string[],
  lookup: ReadonlyMap<string, Scored>,
  options: { readonly archiveSize: number; readonly featureBins: number },
): string[] {
  const cells = new Map<string, Scored>();
  for (const id of new Set([...archive, ...added])) {
    const item = lookup.get(id);
    if (!item?.accepted) continue;
    const key = cell(item, options.featureBins);
    const current = cells.get(key);
    if (!current || rankCandidates([item, current])[0] === item) cells.set(key, item);
  }
  return rankCandidates([...cells.values()])
    .slice(0, options.archiveSize)
    .map((item) => item.id);
}
