/**
 * `agentTool` — turn an agent into a tool the parent loop can call (a
 * sub-agent). Unlike a black-box delegate, a sub-agent's whole canonical stream
 * is forwarded LIVE into the parent (`sub-agent` parts tagged with `agentPath`)
 * when the parent is streaming, and its tool calls stay gated by the parent's
 * server-mode `approveToolCall` (which AI SDK's subagents cannot do). No new
 * runtime: `execute` just drives the existing streaming loop one level down.
 */
import type { Tool, ToolSet, StopCondition, ToolApprovalRequest } from '../types/tool';
import type { CompactionOption } from '../types/config';
import type { LanguageModel } from '../types/model';
import type { Message } from '../types/message';
import type { Dependencies } from '../types/deps';
import type { JSONSchema } from '../types/schema';
import { runStreamToolLoop, type StreamToolLoopInternal } from './stream-tool-loop';
import { SubAgentSuspension } from './loop-shared';
import { readInheritedObserve } from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';

export interface AgentToolDef {
  /** Sub-agent identity — used in `agentPath`; use the same string as the tool key. */
  name: string;
  /** Shown to the parent model so it knows when to delegate. */
  description: string;
  model: LanguageModel;
  /** The sub-agent's own tools (optional — a tool-less sub-agent is a single focused turn). */
  tools?: ToolSet;
  /** The sub-agent's system prompt. */
  system?: string;
  /** Max steps for the sub-agent loop. Default 10 (sub-agents are inherently multi-step). */
  maxSteps?: number;
  /** Nesting cap — `agentTool` inside `agentTool`. Default 2. */
  maxDepth?: number;
  /** Gate the sub-agent CALL itself in the parent (the parent's approval flow). */
  needsApproval?: Tool['needsApproval'];
  /** The sub-agent's own compaction policy (long-lived research agents). */
  compaction?: CompactionOption;
  /** The sub-agent's own stop condition(s). */
  stopWhen?: StopCondition | StopCondition[];
  /** `'full'` (default) forwards the sub-agent's live stream; `'none'` runs it silently. */
  subAgentStream?: 'full' | 'none';
}

const PROMPT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { prompt: { type: 'string', description: 'The task for the sub-agent.' } },
  required: ['prompt'],
  additionalProperties: false,
};

// Returns a plain `Tool` (unknown/unknown) so it drops straight into a
// `ToolSet` — the prompt shape is enforced by `PROMPT_SCHEMA`, not the generic.
export function agentTool(def: AgentToolDef): Tool {
  const maxDepth = def.maxDepth ?? 2;
  return {
    description: def.description,
    parameters: PROMPT_SCHEMA,
    ...(def.needsApproval !== undefined ? { needsApproval: def.needsApproval } : {}),
    execute: async (args, ctx): Promise<string> => {
      const { prompt } = args as { prompt: string };
      const path = [...(ctx.agentPath ?? []), def.name];
      if (path.length > maxDepth) {
        // Throw → self-healing is_error; the parent model can try itself.
        throw new Error(
          `agentTool '${def.name}': max agent depth ${maxDepth} reached (${path.join(' > ')}).`,
        );
      }

      // Reuse the parent transport; tag the sub-agent's usage with its path.
      // `agentPath: m.agentPath ?? path` preserves a DEEPER path a nested
      // wrapper already set — the outer wrapper (which runs last) must not
      // overwrite it with its shallower path. (The loop injects the effective
      // onUsage — call- or deps-level — into ctx.deps, so it is not lost here.)
      const parentDeps = ctx.deps;
      const innerDeps: Dependencies | undefined = parentDeps
        ? {
            ...parentDeps,
            ...(parentDeps.onUsage
              ? {
                  onUsage: (u, m) =>
                    parentDeps.onUsage!(u, { ...m, agentPath: m.agentPath ?? path }),
                }
              : {}),
          }
        : undefined;

      // Durable child session (1.5): when the parent loop carries `session`,
      // the child checkpoints under a per-call key — and if THAT key holds
      // a suspended checkpoint (an earlier leg broke on a client-mode
      // approval inside this sub-agent), the child RESUMES it instead of
      // starting over, settling its pending calls from the forwarded
      // `approvalResponses`. The key includes `ctx.toolCallId` — the model-
      // issued tool_use id, stable across resume legs because it lives in the
      // parent history — so parallel same-name sub-agents never collide.
      const childSession = ctx.session
        ? {
            store: ctx.session.store,
            runId: `${ctx.session.runId}::${def.name}#${ctx.toolCallId}`,
          }
        : undefined;
      let resume: StreamToolLoopInternal | undefined;
      let childMessages: Message[] = [
        ...(def.system ? [{ role: 'system', content: def.system } as Message] : []),
        { role: 'user', content: prompt },
      ];
      if (childSession) {
        const checkpoint = await childSession.store.load(childSession.runId);
        if (checkpoint && checkpoint.status === 'suspended') {
          childMessages = [...checkpoint.messages];
          resume = {
            resumeFrom: { stepIndex: checkpoint.stepIndex, usage: checkpoint.usage },
          };
        }
      }

      // Observation (1.6): the parent's runtime rides on ctx.deps (symbol);
      // sub-agent events share the parent runId/executionId and parent under
      // this tool call's span. The child loop inherits the runtime and emits
      // no run.* events of its own.
      const observe = readInheritedObserve(ctx.deps);
      const subSpan = observe?.runtime.startSpan();
      let childStepCount = 0;
      if (observe && subSpan) {
        observe.runtime.emit({
          type: 'subagent.started',
          spanId: subSpan.spanId,
          parentSpanId: observe.parentSpanId,
          agentPath: path,
          agentName: def.name,
          depth: path.length,
          parentToolCallId: ctx.toolCallId,
          model: def.model.modelId,
          durable: childSession !== undefined,
          ...(childSession ? { childRunId: childSession.runId } : {}),
        });
      }

      const inner = runStreamToolLoop(
        {
          model: def.model,
          messages: childMessages,
          agentPath: path,
          maxSteps: def.maxSteps ?? 10,
          // Always an object — the loop assumes a present tool set. Empty is fine
          // (a tool-less sub-agent is a single focused turn); adapters omit an
          // empty tools array from the wire.
          tools: def.tools ?? {},
          ...(def.stopWhen ? { stopWhen: def.stopWhen } : {}),
          ...(def.compaction ? { compaction: def.compaction } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          // Inherit the parent's server-mode approver so sub-agent calls stay gated.
          ...(ctx.approveToolCall ? { approveToolCall: ctx.approveToolCall } : {}),
          ...(innerDeps ? { deps: innerDeps } : {}),
          ...(childSession ? { session: childSession } : {}),
          // Forwarded verdicts settle a resumed child's pending calls; fresh
          // child runs have nothing to settle, so they pass through harmlessly.
          ...(ctx.approvalResponses ? { approvalResponses: ctx.approvalResponses } : {}),
        },
        {
          ...resume,
          ...(observe && subSpan
            ? { observeInherited: { runtime: observe.runtime, parentSpanId: subSpan.spanId } }
            : {}),
        },
      );

      const forward = Boolean(ctx.emitPart) && def.subAgentStream !== 'none';
      let stepText = '';
      let lastNonEmpty = '';
      const pendingApprovals: ToolApprovalRequest[] = [];
      try {
        for await (const part of inner.fullStream) {
          if (part.type === 'step-finish') childStepCount += 1;
          if (part.type === 'step-start') {
            // Carry forward the last step that actually produced text, so a run
            // cut mid-tool (maxSteps/stopWhen on a tool step) still returns the
            // sub-agent's most recent answer instead of an empty string.
            if (stepText.trim()) lastNonEmpty = stepText;
            stepText = '';
          } else if (part.type === 'text-delta') stepText += part.text;
          else if (part.type === 'tool-approval-request') {
            pendingApprovals.push({
              approvalId: part.approvalId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              // A deeper descendant's path survives; this loop's own breaks
              // carry `path` from the child loop already, but keep the fallback.
              agentPath: part.agentPath ?? path,
            });
          } else if (part.type === 'error') throw part.error;
          if (forward) ctx.emitPart!({ type: 'sub-agent', agentPath: path, part });
        }

        // Fold the sub-agent's cumulative usage into the parent (result + budget).
        // On a suspension this runs BEFORE the signal below, so the suspended
        // parent's checkpoint still counts the child's tokens.
        ctx.reportUsage?.(await inner.usage);

        if (pendingApprovals.length > 0) {
          if (childSession) {
            // The child checkpointed itself as suspended — suspend the parent
            // too, carrying the approvals up (executeTools re-throws this).
            if (observe && subSpan) {
              observe.runtime.emit({
                type: 'subagent.suspended',
                spanId: subSpan.spanId,
                parentSpanId: observe.parentSpanId,
                agentPath: path,
                agentName: def.name,
                depth: path.length,
                durationMs: observe.runtime.durationSince(subSpan.startedAt),
                pendingApprovalCount: pendingApprovals.length,
              });
            }
            throw new SubAgentSuspension(pendingApprovals);
          }
          // No durable session: keep the 1.4 self-healing contract.
          throw new Error(
            `agentTool '${def.name}': a sub-agent tool call needs approval. Client-mode approval ` +
              `inside a sub-agent is not supported yet without a durable session — pass a ` +
              `server-mode approveToolCall on the parent call, or add \`session\` (1.5 durable ` +
              `sessions) so the run can suspend and resume.`,
          );
        }
        if (observe && subSpan) {
          observe.runtime.emit({
            type: 'subagent.completed',
            spanId: subSpan.spanId,
            parentSpanId: observe.parentSpanId,
            agentPath: path,
            agentName: def.name,
            depth: path.length,
            durationMs: observe.runtime.durationSince(subSpan.startedAt),
            stepCount: childStepCount,
            // Already folded into the parent totals via reportUsage — consumers
            // must never sum it twice.
            usage: await inner.usage,
          });
        }
        // Prefer the final step's text; fall back to the last step that had any,
        // then to an explicit note (never silently return '' after real work).
        const answer = stepText.trim() ? stepText : lastNonEmpty;
        return answer || '(the sub-agent finished without a text answer)';
      } catch (err) {
        // Suspension is control flow (subagent.suspended already fired);
        // everything else is a sub-agent failure that will self-heal above.
        if (observe && subSpan && !(err instanceof SubAgentSuspension)) {
          observe.runtime.emit({
            type: 'subagent.failed',
            spanId: subSpan.spanId,
            parentSpanId: observe.parentSpanId,
            agentPath: path,
            agentName: def.name,
            depth: path.length,
            durationMs: observe.runtime.durationSince(subSpan.startedAt),
            error: toObservedError(err, observe.runtime.capture.errorMessages),
          });
        }
        throw err;
      }
    },
  };
}
