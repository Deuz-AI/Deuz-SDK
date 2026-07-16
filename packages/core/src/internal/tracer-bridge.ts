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

export function createTracerBridge(
  tracer: Tracer,
  mode: 'hierarchical' | 'legacy' = 'hierarchical',
): Observer {
  if (mode === 'legacy') return createLegacyBridge(tracer);
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

/**
 * `tracerMode: 'legacy'` (1.6.1): reproduces the exact 1.5 span shape for
 * consumers whose dashboards/tests pinned it — one FLAT `invoke` span per
 * model call (agentic loops emit N of them), `deuz.step.count` always 1,
 * retries as `deuz.retry.count` on the model's own invoke, no `step`/
 * `execute_tool` children. Compaction summarize side-calls stay span-less
 * (the 1.5 `skipInvokeSpan` behavior — detected via `purpose`). A user abort
 * still ends without an exception.
 */
function createLegacyBridge(tracer: Tracer): Observer {
  const spans = new Map<string, SpanHandle>();
  const retryCounts = new Map<string, number>();

  return {
    emit(event: ObserveEvent): void {
      switch (event.type) {
        case 'model.started': {
          if (event.purpose !== undefined) break; // 1.5: skipInvokeSpan side-calls
          spans.set(
            event.spanId,
            openSpan(tracer, 'invoke', {
              'gen_ai.provider.name': event.provider,
              'gen_ai.request.model': event.model,
              ...(event.agentPath && event.agentPath.length > 0
                ? { 'deuz.agent.path': event.agentPath.join('/') }
                : {}),
            }),
          );
          break;
        }
        case 'model.retry': {
          const span = spans.get(event.spanId);
          if (span) {
            const count = (retryCounts.get(event.spanId) ?? 0) + 1;
            retryCounts.set(event.spanId, count);
            span.setAttribute('deuz.retry.count', count);
          }
          break;
        }
        case 'model.completed': {
          const span = spans.get(event.spanId);
          if (span) {
            // 1.5 abort contract: usage attrs + clean end, never an exception.
            setUsageAttributes(span, event.usage, event.finishReason as FinishReason);
            span.setAttribute('deuz.step.count', 1);
            span.end();
            spans.delete(event.spanId);
            retryCounts.delete(event.spanId);
          }
          break;
        }
        case 'model.failed': {
          const span = spans.get(event.spanId);
          if (span) {
            span.fail(event.error);
            spans.delete(event.spanId);
            retryCounts.delete(event.spanId);
          }
          break;
        }
        case 'run.completed':
        case 'run.suspended':
        case 'run.aborted':
        case 'run.failed': {
          // Safety net for exotic exit paths: settle anything still open.
          for (const span of spans.values()) span.end();
          spans.clear();
          retryCounts.clear();
          break;
        }
        default:
          break;
      }
    },
  };
}
