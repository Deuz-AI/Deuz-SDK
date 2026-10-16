/**
 * The version rule every new store follows (2.4), shared by the SQLite and
 * Postgres schema-meta helpers (`sqlite-handle.ts`, `pg-tx.ts`).
 *
 * The existing version checks refuse any newer version: the SQLite ops store's
 * `deuz_ops_schema`, the Postgres stores' version tables and the SQLite pack's
 * `PRAGMA user_version`, which is one integer for the whole file. A new store
 * that raised one of them would lock a 2.3 process out of its own tables. So
 * each new store keeps its version in a single-row table of its own,
 * `<name>_schema`, and never writes the others. Node-only.
 */

/** Exactly the identifiers Postgres accepts unquoted, which SQLite takes too. */
const NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
/** Postgres truncates identifiers past 63 bytes, and the table adds `_schema`. */
const MAX_NAME_LENGTH = 63 - '_schema'.length;

/** The version tables of the 2.3 stores, without their `_schema` suffix: never a new store's. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'deuz_ops',
  'deuz_budget',
  'deuz_swarm',
  'deuz_swarm_pg',
  'deuz_evolve',
]);

export interface SchemaMetaSpec<Step> {
  /**
   * The store's name, e.g. `deuz_vmem`: its version lives in `<name>_schema`.
   * Lower-case letters, digits and underscores, at most 56 characters.
   */
  name: string;
  /**
   * The version this build writes, a positive integer. Raise it only for a
   * change older builds must not write through: they refuse a newer version.
   */
  version: number;
  /**
   * `CREATE ... IF NOT EXISTS` statements for the current version, run in
   * order on every open after any upgrade step. An object a database lacks is
   * created here, so an addition older builds can ignore, such as an index or
   * a table, needs no version change.
   */
  create: readonly string[];
  /**
   * Forward migrations: `upgrades[n]` takes a schema stored at version n to
   * n + 1, for every n from the oldest version this build still upgrades to
   * `version - 1`. A fresh schema skips them: `create` builds it whole.
   */
  upgrades?: Readonly<Record<number, readonly Step[]>>;
}

/** What a schema-meta helper found and left behind. */
export interface SchemaMetaState {
  /** The version stored before this open; `undefined` when the schema was created now. */
  stored: number | undefined;
  /** The version stored now: always the spec's. */
  version: number;
}

export interface SchemaMetaPlan<Step> {
  /** The unqualified version table, `<name>_schema`. */
  table: string;
  /** The oldest stored version this build reads. */
  oldest: number;
  /** The upgrade steps, by the version each one starts from, in order. */
  steps: { from: number; run: readonly Step[] }[];
}

/** Validates a spec and orders its upgrade steps. Throws `TypeError` on a malformed spec. */
export function planSchemaMeta<Step>(spec: SchemaMetaSpec<Step>): SchemaMetaPlan<Step> {
  const { name, version } = spec;
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH)
    throw new TypeError(
      `Invalid store schema name ${JSON.stringify(name)}: use lower-case letters, digits and underscores, at most ${MAX_NAME_LENGTH} characters.`,
    );
  if (RESERVED_NAMES.has(name))
    throw new TypeError(
      `The store schema name ${JSON.stringify(name)} is reserved: ${name}_schema is the version table of a 2.3 store.`,
    );
  if (!Number.isSafeInteger(version) || version < 1)
    throw new TypeError(`Schema version must be a positive integer, got ${version}`);
  const steps = Object.entries(spec.upgrades ?? {})
    .map(([from, run]) => ({ from: Number(from), run }))
    .sort((left, right) => left.from - right.from);
  if (
    steps.some(
      (step, index) =>
        !Number.isSafeInteger(step.from) || step.from !== version - steps.length + index,
    ) ||
    (steps[0]?.from ?? 1) < 1
  )
    throw new TypeError(`Schema upgrade steps must run without gaps up to version ${version}`);
  return { table: `${name}_schema`, oldest: steps[0]?.from ?? version, steps };
}

/**
 * Throws when `stored` is outside what `plan` reads: newer than its version,
 * or older than its oldest upgrade step. `table` names the version table in
 * the message, qualified as the backend shows it.
 */
export function assertStoredSchemaVersion(
  plan: SchemaMetaPlan<unknown>,
  version: number,
  stored: number | undefined,
  table: string,
): void {
  if (stored === undefined) return;
  const readable =
    plan.oldest === version ? `version ${version}` : `versions ${plan.oldest} to ${version}`;
  if (stored > version)
    throw new Error(
      `${table} holds schema version ${stored}, newer than this build reads (${readable}): ` +
        'a newer @deuz-sdk/core wrote it. Upgrade the SDK rather than downgrading the database.',
    );
  if (!(stored >= plan.oldest))
    throw new Error(
      `${table} holds schema version ${stored}, older than this build upgrades (${readable}).`,
    );
}
