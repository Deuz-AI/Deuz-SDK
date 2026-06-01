import type { StandardSchemaV1, JSONSchema } from '../types/schema';
import { InvalidRequestError } from '../errors';

/** Narrow an unknown schema to a Standard Schema instance. */
export function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return !!schema && typeof schema === 'object' && '~standard' in schema;
}

/**
 * Obtain the JSON Schema to send on the wire. Raw `JSONSchema` is the
 * first-class, zero-dependency path. A Standard Schema (zod/valibot/arktype)
 * does NOT expose JSON Schema in the spec, so we lazily import the OPTIONAL peer
 * `@standard-community/standard-json`; if it isn't installed we throw a clear,
 * actionable error rather than bundling a converter (zero-runtime-dep promise).
 */
export async function toJSONSchema(schema: StandardSchemaV1 | JSONSchema): Promise<JSONSchema> {
  if (!isStandardSchema(schema)) return schema;

  // Variable specifier keeps TS/esbuild from resolving the optional peer statically.
  const peer = '@standard-community/standard-json';
  try {
    const mod = await import(peer);
    const fn = (mod.toJsonSchema ?? mod.default?.toJsonSchema) as
      | ((s: StandardSchemaV1) => JSONSchema | Promise<JSONSchema>)
      | undefined;
    if (!fn) throw new Error('toJsonSchema export not found');
    return await fn(schema);
  } catch (err) {
    throw new InvalidRequestError({
      message:
        'generateObject received a Standard Schema (e.g. zod/valibot). Converting it to JSON Schema needs the optional peer "@standard-community/standard-json" — install it, or pass a raw JSON Schema instead.',
      cause: err,
    });
  }
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string };

/**
 * Validate parsed model output. With a Standard Schema we use the native,
 * zero-dep `~standard.validate` (which may be async). With a raw JSON Schema
 * there is no zero-dep validator, so we accept the parsed value as-is.
 */
export async function validateOutput<T>(
  schema: StandardSchemaV1<unknown, T> | JSONSchema,
  value: unknown,
): Promise<ValidationResult<T>> {
  if (!isStandardSchema(schema)) return { ok: true, value: value as T };
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    return { ok: false, issues: result.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value: result.value as T };
}
