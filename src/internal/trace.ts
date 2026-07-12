/**
 * Span plumbing for the orchestration layer (1.6): a lifecycle guard plus the
 * attribute builders shared by the pump (`core/inference.ts`) and the agentic
 * loops. Three span names exist: `invoke` (one per orchestrated call), `step`
 * (one per model round-trip, parent = invoke) and `execute_tool` (one per tool
 * execution, parent = its step).
 *
 * Attribute policy (redaction P0): span attributes carry ONLY token counts,
 * ids, tool/model names, booleans and small enums. Message content, tool
 * arguments/results, headers, URLs and key material must NEVER enter a span
 * attribute — OTel semconv content capture stays OFF by design (see
 * `internal/redact.ts` for the invariant this protects).
 */
import type { Span, Tracer } from '../types/deps';
import type { LanguageModel } from '../types/model';
import type { Usage, FinishReason } from '../types/usage';

/**
 * A started span with idempotent settlement. The loops have many exit paths
 * (success, error part, abort, suspension, runaway stop) — every path settles
 * defensively and the guard makes sure `end()` fires exactly once.
 */
export interface SpanHandle {
  /** The raw seam span — pass as a child's parent. */
  readonly span: Span;
  setAttribute(key: string, value: unknown): void;
  recordException(error: unknown): void;
  /** recordException + end, once (no-op if already ended). */
  fail(error: unknown): void;
  /** end, once (later calls are no-ops). */
  end(): void;
}

export function openSpan(
  tracer: Tracer,
  name: string,
  attributes: Record<string, unknown>,
  parent?: Span,
): SpanHandle {
  const span = tracer.startSpan(name, attributes, parent ? { parent } : undefined);
  let ended = false;
  return {
    span,
    setAttribute(key, value) {
      if (!ended) span.setAttribute(key, value);
    },
    recordException(error) {
      if (!ended) span.recordException(error);
    },
    fail(error) {
      if (ended) return;
      span.recordException(error);
      ended = true;
      span.end();
    },
    end() {
      if (ended) return;
      ended = true;
      span.end();
    },
  };
}

/** `invoke` start attributes: provider + model identity (+ sub-agent path). */
export function invokeAttributes(
  model: LanguageModel,
  agentPath?: string[],
): Record<string, unknown> {
  return {
    'gen_ai.provider.name': model.provider,
    'gen_ai.request.model': model.modelId,
    ...(agentPath && agentPath.length > 0 ? { 'deuz.agent.path': agentPath.join('/') } : {}),
  };
}

/** `step` start attributes: 0-based index + the step's (possibly prepareStep-switched) model. */
export function stepAttributes(index: number, modelId: string): Record<string, unknown> {
  return { 'deuz.step.index': index, 'gen_ai.request.model': modelId };
}

/** End attributes shared by `invoke` and `step`: real token usage + final finish reason. */
export function setUsageAttributes(
  span: SpanHandle,
  usage: Usage,
  finishReason: FinishReason,
): void {
  span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
  span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
  // Semconv defines finish_reasons as an array; ours always has one element.
  span.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
}

/** Tracer + parent threaded into `executeTools` for per-tool `execute_tool` spans. */
export interface ExecTrace {
  tracer: Tracer;
  parent?: Span;
}
