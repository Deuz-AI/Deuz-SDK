/**
 * `tool()` — the typed tool-authoring helper (1.9, Sprint 2 · 2.1).
 *
 * A PURE IDENTITY FUNCTION: it returns the very object it was handed (`===`),
 * introspects nothing, imports no validator (zod stays an optional peer) and
 * adds zero bytes of runtime behaviour. Its whole job is INFERENCE.
 *
 * Why it is needed: `ToolSet = Record<string, Tool>` (`types/tool.ts`) erases
 * `Tool<Args, Result>`, so a hand-written tool literal gets `args: unknown`
 * inside `execute` and editing the schema produces NO compile error in the
 * handler. Wrapping the literal in `tool()` flows the schema's output type into
 * `execute`'s first parameter — and back out through {@link InferToolInput} /
 * {@link InferToolOutput}.
 *
 * ```ts
 * const getWeather = tool({
 *   description: 'Current weather for a city',
 *   parameters: z.object({ city: z.string() }),
 *   execute: async (args) => fetchWeather(args.city), // args: { city: string }
 * });
 * await generateText({ model, messages, tools: { getWeather } }); // plain ToolSet
 * ```
 */

import type { StandardSchemaV1, JSONSchema, InferSchemaOutput } from './types/schema';
import type { Tool, ToolExecuteContext } from './types/tool';

/**
 * Anything carrying the Standard Schema marker.
 *
 * Why this exists instead of just `StandardSchemaV1`: core's inlined copy of the
 * spec types `StandardSchemaIssue.path` as `ReadonlyArray<PropertyKey>`, while
 * the real spec (and zod ≥ 3.24 / valibot) also allow OBJECT path segments
 * (`{ key: PropertyKey }`). A real `z.object({…})` is therefore NOT assignable
 * to `StandardSchemaV1` (verified against the pinned zod 3.25) — constraining
 * `S` to it would reject every zod schema, i.e. exactly the audience this helper
 * exists for. `types/schema.ts` is frozen, so we duck-type the marker here and
 * leave the runtime contract untouched (`schema/bridge.ts` already duck-types
 * the same way: `'~standard' in schema`).
 */
type StandardSchemaLike = {
  readonly '~standard': { readonly version: 1; readonly vendor: string };
};

/**
 * The `args` type a `parameters` schema hands to `execute`.
 *
 * A Standard Schema (zod/valibot/arktype) carries its output type in
 * `~standard.types` — we reuse `InferSchemaOutput` when the schema really is a
 * `StandardSchemaV1`, and fall back to reading the same `types.output` slot
 * structurally for the vendor types described on {@link StandardSchemaLike}.
 * A RAW JSON Schema has no type-level payload at all, so it degrades to
 * `unknown` — deliberately NOT `any`: the handler must still narrow before it
 * dereferences anything, exactly like a hand-written tool does today.
 */
type SchemaArgs<S> = S extends StandardSchemaV1
  ? InferSchemaOutput<S>
  : S extends {
        readonly '~standard': { readonly types?: { readonly output: infer O } | undefined };
      }
    ? O
    : unknown;

/**
 * Define a tool whose `parameters` schema types its own `execute(args)`.
 *
 * Returns the SAME object reference — `tool(def) === def` — so a tool can still
 * be frozen, shared across calls or compared by identity.
 *
 * Return-type note (the reason this is an intersection rather than the bare
 * `Tool<Args, R>`): `Tool`'s `Args` sits in a contravariant position
 * (`execute`'s first parameter), which makes `Tool` INVARIANT in `Args` under
 * `strictFunctionTypes`. A bare `Tool<{ city: string }, R>` therefore refuses to
 * slot into a plain `ToolSet` (`Record<string, Tool<unknown, unknown>>`) — i.e.
 * into `generateText({ tools })`, the only place tools are ever used. Adding the
 * `Tool<unknown, R>` constituent keeps the value assignable to `Tool` while the
 * narrow constituent (LAST, so it is the one `infer` picks up) preserves the
 * arg type for the helpers below. `ToolSet` and `types/tool.ts` stay untouched.
 * The visible cost is small and local: calling `myTool.execute(args, ctx)`
 * DIRECTLY resolves the widened overload, so `args` is checked as `unknown`
 * there — the result type is still `R`, and the loop is unaffected.
 */
export function tool<S extends StandardSchemaLike | JSONSchema, R = unknown>(
  def: Omit<Tool<SchemaArgs<S>, R>, 'parameters'> & { parameters: S },
): Tool<unknown, R> & Tool<SchemaArgs<S>, R> {
  // Identity. The cast is the entire implementation: `def` already IS the tool,
  // only its static type needs re-stating (the input's `parameters: S` is
  // narrower than `Tool['parameters']`, hence the two-step cast).
  return def as unknown as Tool<unknown, R> & Tool<SchemaArgs<S>, R>;
}

/**
 * The `args` type of a tool — `unknown` for anything that is not a tool, or for
 * a tool defined with a raw JSON Schema.
 *
 * Matched structurally on `execute` rather than via `T extends Tool<infer A, …>`
 * because `Tool` is invariant in `Args` (see {@link tool}); the nominal form
 * would silently resolve to `unknown` for the very values `tool()` returns.
 * Works on plain hand-written `Tool<Args, Result>` values too.
 */
export type InferToolInput<T> = T extends {
  execute?: (args: infer A, ctx: ToolExecuteContext) => unknown;
}
  ? A
  : unknown;

/**
 * The awaited result type of a tool's `execute` — `unknown` for a client tool
 * (no `execute`) or a non-tool. `Awaited` collapses the `Promise<R> | R` shape
 * `Tool.execute` is declared with, so a sync and an async tool report the same
 * type.
 */
export type InferToolOutput<T> = T extends {
  execute?: (args: never, ctx: ToolExecuteContext) => infer R;
}
  ? Awaited<R>
  : unknown;
