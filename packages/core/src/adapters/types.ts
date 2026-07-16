import type { StreamPart } from '../types/stream';
import type { CommonCallOptions } from '../types/config';
import type { JSONSchema } from '../types/schema';
import type { ToolChoice } from '../types/tool';
import type { NormalizedMessage } from '../core/normalize';
import type { ModelCapabilities } from '../core/registry';
import type { ResolvedCall } from '../internal/resolve-call';
import type { DeuzError } from '../errors';

/** Structured-output request (set by generateObject), honored in buildRequest. */
export interface ObjectRequest {
  schema: JSONSchema;
  name?: string;
  description?: string;
  /** 'json' = native json_schema/output_config; 'tool' = forced single tool call. */
  strategy: 'json' | 'tool';
}

/** A tool resolved to wire-ready form (schema already converted to JSON Schema). */
export interface WireTool {
  name: string;
  description?: string;
  parameters: JSONSchema;
  /** Raw native definition for a provider-executed tool — serialized verbatim by the adapter. */
  provider?: Record<string, unknown>;
}

/** Tool request (set by the agentic loop), honored in buildRequest. */
export interface WireToolRequest {
  tools: WireTool[];
  toolChoice?: ToolChoice;
  /** Hint for parallel_tool_calls / disable_parallel_tool_use. */
  allowParallel?: boolean;
}

/** Everything a wire adapter needs to build a request — pure, no I/O. */
export interface BuildContext {
  call: ResolvedCall;
  messages: NormalizedMessage[];
  caps: ModelCapabilities;
  options: CommonCallOptions;
  generateId: () => string;
  /** Present only for generateObject. */
  object?: ObjectRequest;
  /** Present when the call provides tools (agentic loop). */
  tools?: WireToolRequest;
}

export interface AdapterRequest {
  url: string;
  init: RequestInit;
}

export interface ParseContext {
  caps: ModelCapabilities;
  generateId: () => string;
  /** Actual provider id from the model descriptor (important for compat wires). */
  provider: string;
}

export interface ErrorContext {
  /** Actual provider id from the model descriptor (important for compat wires). */
  provider: string;
}

/**
 * The seam every wire (Anthropic / OpenAI Chat Completions / OpenAI Responses /
 * Gemini-compat) implements. `buildRequest` and `parseStream` are pure of the
 * orchestration concerns (resilience, tee, metering) — those live in
 * core/inference.ts.
 */
export interface Adapter {
  /** Canonical context → a concrete HTTP request for this wire. */
  buildRequest(ctx: BuildContext): AdapterRequest;
  /** Raw SSE body → canonical StreamPart iterable (the only stream consumers see). */
  parseStream(body: ReadableStream<Uint8Array>, ctx: ParseContext): AsyncIterable<StreamPart>;
  /** Map a non-2xx response (or in-stream error envelope) to a typed DeuzError. */
  mapError(status: number, body: unknown, headers: Headers, ctx?: ErrorContext): DeuzError;
}
