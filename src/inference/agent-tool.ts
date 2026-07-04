/**
 * `agentTool` — turn an agent into a tool the parent loop can call (a
 * sub-agent). Unlike a black-box delegate, a sub-agent's whole canonical stream
 * is forwarded LIVE into the parent (`sub-agent` parts tagged with `agentPath`)
 * when the parent is streaming, and its tool calls stay gated by the parent's
 * server-mode `approveToolCall` (which AI SDK's subagents cannot do). No new
 * runtime: `execute` just drives the existing streaming loop one level down.
 */
import type { Tool, ToolSet, StopCondition } from '../types/tool';
import type { CompactionOption } from '../types/config';
import type { LanguageModel } from '../types/model';
import type { Message } from '../types/message';
import type { Dependencies } from '../types/deps';
import type { JSONSchema } from '../types/schema';
import { runStreamToolLoop } from './stream-tool-loop';

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
      const parentDeps = ctx.deps;
      const innerDeps: Dependencies | undefined = parentDeps
        ? {
            ...parentDeps,
            ...(parentDeps.onUsage
              ? {
                  onUsage: (u, m) => parentDeps.onUsage!(u, { ...m, agentPath: path }),
                }
              : {}),
          }
        : undefined;

      const messages: Message[] = [
        ...(def.system ? [{ role: 'system', content: def.system } as Message] : []),
        { role: 'user', content: prompt },
      ];
      const inner = runStreamToolLoop({
        model: def.model,
        messages,
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
      });

      const forward = Boolean(ctx.emitPart) && def.subAgentStream !== 'none';
      let stepText = '';
      let sawPendingApproval = false;
      for await (const part of inner.fullStream) {
        if (part.type === 'step-start') stepText = '';
        else if (part.type === 'text-delta') stepText += part.text;
        else if (part.type === 'tool-approval-request') sawPendingApproval = true;
        else if (part.type === 'error') throw part.error;
        if (forward) ctx.emitPart!({ type: 'sub-agent', agentPath: path, part });
      }

      // Fold the sub-agent's cumulative usage into the parent (result + budget).
      ctx.reportUsage?.(await inner.usage);

      if (sawPendingApproval) {
        throw new Error(
          `agentTool '${def.name}': a sub-agent tool call needs approval. Client-mode approval ` +
            `inside a sub-agent is not supported yet — pass a server-mode approveToolCall on the ` +
            `parent call, or wait for 1.5 durable sessions.`,
        );
      }
      return stepText;
    },
  };
}
