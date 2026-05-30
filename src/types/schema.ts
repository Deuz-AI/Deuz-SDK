/**
 * Standard Schema (https://standardschema.dev) — the vendor-neutral validation
 * contract. `generateObject` accepts any schema implementing it (zod, valibot,
 * arktype, …) OR a raw JSON Schema, so core stays zero-dependency and never
 * type-depends on zod. Inlined here (no runtime, no package) to honour the
 * "zero runtime dependencies" goal.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey> | undefined;
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

export type InferSchemaOutput<S extends StandardSchemaV1> = NonNullable<
  S['~standard']['types']
>['output'];

/** Loose JSON Schema fallback for callers without a Standard Schema instance. */
export type JSONSchema = { readonly [key: string]: unknown };
