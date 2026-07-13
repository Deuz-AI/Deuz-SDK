/**
 * Legacy tracer bridge (1.6): the SINGLE source of spans. Observation events
 * drive the documented `invoke → step → execute_tool` hierarchy onto the
 * injected `Dependencies.tracer` — completing the wiring that shipped
 * half-built in 1.5 (only flat per-model-call 'invoke' spans ever fired;
 * 'step'/'execute_tool' plumbing existed but no caller passed it).
 *
 * Contracts preserved from the direct-span era:
 * - exact span names and attribute keys (gen_ai.* semconv + deuz.*)
 * - a user abort ends the invoke span WITHOUT recordException (a resolution,
 *   not a failure); suspension likewise ends clean
 * - denials mark `deuz.tool.is_error` without an exception; tool throws
 *   record the (normalized) error then settle
 * - attribute policy (redaction P0): only token counts, ids, names, booleans,
 *   small enums — never message content, tool args/results, headers, keys
 * - a throwing tracer never affects the run (the runtime try/catches sinks)
 *
 * Behavior change vs 1.5 (documented): agentic loops now produce ONE invoke
 * span with step/execute_tool children instead of N flat invokes.
 */
import type { Tracer } from '../types/deps';
import type { FinishReason } from '../types/usage';
import type { Observer, ObserveEvent } from '../types/observe';
import { openSpan, stepAttributes, setUsageAttributes, type SpanHandle } from './trace';

export function createTracerBridge(tracer: Tracer): Observer {
  // Open spans keyed by the event spanId that created them. One bridge exists
  // per observation runtime (= per execution leg), so state stays run-local.
  const spans = new Map<string, SpanHandle>();
  const retryCounts = new Map<SpanHandle, number>();
  let invoke: SpanHandle | undefined;
  let stepCount = 0;

  const parentOf = (event: ObserveEvent): SpanHandle | undefined =>
    (event.parentSpanId !== undefined ? spans.get(event.parentSpanId) : undefined) ?? invoke;

  const settleAll = (): void => {
    for (const span of spans.values()) span.end(); // idempotent guard
    spans.clear();
    retryCounts.clear();
    invoke = undefined;
  };

  return {
    emit(event: ObserveEvent): void {
      switch (event.type) {
        case 'run.started': {
          invoke = openSpan(tracer, 'invoke', {
            'gen_ai.provider.name': event.provider,
            'gen_ai.request.model': event.model,
            ...(event.agentPath && event.agentPath.length > 0
              ? { 'deuz.agent.path': event.agentPath.join('/') }
              : {}),
          });
          spans.set(event.spanId, invoke);
          break;
        }
        case 'step.started': {
          const span = openSpan(
            tracer,
            'step',
            stepAttributes(event.stepIndex ?? 0, event.model),
            parentOf(event)?.span,
          );
          spans.set(event.spanId, span);
          break;
        }
        case 'step.completed': {
          const span = spans.get(event.spanId);
          if (span) {
            setUsageAttributes(span, event.usage, event.finishReason as FinishReason);
            span.end();
            spans.delete(event.spanId);
          }
          stepCount += 1;
          break;
        }
        case 'tool.started': {
          const span = openSpan(
            tracer,
            'execute_tool',
            { 'gen_ai.tool.name': event.toolName, 'gen_ai.tool.call.id': event.toolCallId },
            parentOf(event)?.span,
          );
          spans.set(event.spanId, span);
          break;
        }
        case 'tool.completed': {
          const span = spans.get(event.spanId);
          if (span) {
            span.setAttribute('deuz.tool.is_error', false);
            span.end();
            spans.delete(event.spanId);
          }
          break;
        }
        case 'tool.failed': {
          const span = spans.get(event.spanId);
          if (span) {
            // The original throw was normalized at the catch site — record it,
            // then settle as a self-healed is_error result (old contract).
            span.recordException(event.error);
            span.setAttribute('deuz.tool.is_error', true);
            span.end();
            spans.delete(event.spanId);
          }
          break;
        }
        case 'tool.denied': {
          const span = spans.get(event.spanId);
          if (span) {
            // A denial is deliberate — is_error without an exception.
            span.setAttribute('deuz.tool.is_error', true);
            span.end();
            spans.delete(event.spanId);
          }
          break;
        }
        case 'model.retry': {
          // Old semantics: `deuz.retry.count` lands on the enclosing step
          // span when one exists, else on the invoke (single-turn calls).
          const target = parentOf(event);
          if (target) {
            const count = (retryCounts.get(target) ?? 0) + 1;
            retryCounts.set(target, count);
            target.setAttribute('deuz.retry.count', count);
          }
          break;
        }
        case 'run.completed': {
          if (invoke) {
            setUsageAttributes(invoke, event.usage, event.finishReason as FinishReason);
            // Single-turn calls have no step events; the old contract reported 1.
            invoke.setAttribute('deuz.step.count', Math.max(event.stepCount, 1));
          }
          settleAll();
          break;
        }
        case 'run.aborted': {
          if (invoke) {
            // A user abort is a resolution, not a failure — no exception recorded.
            setUsageAttributes(invoke, event.usage, 'aborted');
            invoke.setAttribute('deuz.step.count', Math.max(stepCount, 1));
          }
          settleAll();
          break;
        }
        case 'run.suspended': {
          if (invoke) {
            // Suspension is control flow: usage attrs, clean end, no exception.
            invoke.setAttribute('gen_ai.usage.input_tokens', event.usage.inputTokens);
            invoke.setAttribute('gen_ai.usage.output_tokens', event.usage.outputTokens);
          }
          settleAll();
          break;
        }
        case 'run.failed': {
          // Children settle clean; the invoke itself records the failure.
          const failing = invoke;
          invoke = undefined;
          for (const span of spans.values()) {
            if (span !== failing) span.end();
          }
          spans.clear();
          retryCounts.clear();
          failing?.fail(event.error);
          break;
        }
        default:
          // model/checkpoint/compaction/subagent/approval/cost events carry no
          // span of their own in the legacy hierarchy.
          break;
      }
    },
  };
}
