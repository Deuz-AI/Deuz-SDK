import type {
  AgentTool,
  AgentToolSet,
  AgentToolContext,
  AgentValidation,
  AgentToolReceipt,
} from '../types/agent-run';
import type { Tool, ToolSet, ToolExecuteContext } from '../types/tool';
import { assertAgentValidation, validateAgentValue } from './agent-output';
import { toJSONSchema } from '../schema/bridge';
import { assertExecutionPolicy } from '../execution-policy';
import { SubAgentSuspension } from './loop-shared';
import { isAgentDelegationTool } from './agent-tool';
import { HANDOFF_TARGET, readHandoffTarget, type HandoffTargetMeta } from './handoff';
import { isFatalExecutionError } from '../internal/execution-error';

export interface NativeToolOutput {
  toolCallId: string;
  toolName: string;
  rawResult: unknown;
  modelOutput?: unknown;
  error?: string;
}

export interface NativeToolReceipts {
  load(toolCallId: string): AgentToolReceipt | undefined;
  save(receipt: AgentToolReceipt, context: ToolExecuteContext): Promise<void>;
  retryToolCallIds?: readonly string[];
  /** The root model step whose calls are executing (2.2). */
  modelStep?(): number;
}

class ToolReceiptError extends Error {
  readonly fatalExecution = true;
  readonly name = 'ToolReceiptError';
}

/** Adapts native validation/projection to the one canonical tool executor. */
export async function prepareAgentTools(
  tools: AgentToolSet = {},
  contexts: Record<string, unknown> = {},
  onOutput?: (output: NativeToolOutput) => void | Promise<void>,
  receipts?: NativeToolReceipts,
): Promise<ToolSet> {
  return prepareToolSet(tools, contexts, onOutput, receipts, new Map());
}

/**
 * Route a native run's MCP tools through the receipts its local tools use (2.3,
 * F01): the `executing` stage before the call, reconciliation on resume and a
 * `tool-output` event. `replayOf` names the tools whose `mcp` entry declared
 * them idempotent.
 *
 * An MCP tool's `outputSchema` is its server's raw JSON Schema. It stays
 * metadata, as on every `Tool`: the MCP client validates structured results
 * against it (the official SDK rejects a result that does not conform), and
 * core ships no JSON Schema validator to repeat that check. Receipts and
 * `tool-output` events keep the result the client returned.
 */
export async function prepareMcpTools(
  tools: ToolSet,
  replayOf: (name: string) => AgentTool['replay'],
  onOutput?: (output: NativeToolOutput) => void | Promise<void>,
  receipts?: NativeToolReceipts,
): Promise<ToolSet> {
  const view = Object.create(null) as AgentToolSet;
  for (const [name, tool] of Object.entries(tools)) {
    const replay = replayOf(name);
    // An MCP `execute` ignores its context, so the native context fits it.
    view[name] = { ...tool, outputSchema: undefined, ...(replay ? { replay } : {}) } as AgentTool;
  }
  const prepared = await prepareToolSet(view, {}, onOutput, receipts, new Map());
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.outputSchema) prepared[name]!.outputSchema = tool.outputSchema;
  }
  return prepared;
}

/**
 * Carry a handoff transfer marker (2.3) onto the prepared copy of a tool. The
 * spread that builds the copy drops it, because the marker is deliberately
 * NON-enumerable. The target agent's own tools are prepared too: once a transfer
 * is accepted they run in this same native run, so they need the same receipts.
 */
async function preparedHandoffTarget(
  meta: HandoffTargetMeta,
  onOutput: ((output: NativeToolOutput) => void | Promise<void>) | undefined,
  receipts: NativeToolReceipts | undefined,
  seen: Map<object, ToolSet>,
): Promise<HandoffTargetMeta> {
  const targetTools = meta.def.tools;
  if (!targetTools) return meta;
  // One prepared set per target set. It is registered BEFORE it is filled, so
  // transfer groups that reference each other resolve to the same object.
  let prepared = seen.get(targetTools);
  if (!prepared) {
    prepared = Object.create(null) as ToolSet;
    seen.set(targetTools, prepared);
    await prepareToolSet(targetTools as AgentToolSet, {}, onOutput, receipts, seen, prepared);
  }
  return { ...meta, def: { ...meta.def, tools: prepared } };
}

async function prepareToolSet(
  tools: AgentToolSet,
  contexts: Record<string, unknown>,
  onOutput: ((output: NativeToolOutput) => void | Promise<void>) | undefined,
  receipts: NativeToolReceipts | undefined,
  seen: Map<object, ToolSet>,
  into?: ToolSet,
): Promise<ToolSet> {
  const result: ToolSet = into ?? (Object.create(null) as ToolSet);
  for (const [name, tool] of Object.entries(tools)) {
    const scoped =
      Object.prototype.hasOwnProperty.call(contexts, name) || tool.contextSchema !== undefined;
    if (scoped && isAgentDelegationTool({ parameters: tool.parameters, execute: tool.execute })) {
      throw new TypeError(
        `Tool ${name}: scoped context is not supported on agent delegation tools; their durable session and approval context must remain intact.`,
      );
    }
    let context = Object.prototype.hasOwnProperty.call(contexts, name) ? contexts[name] : undefined;
    if (tool.contextSchema) {
      const spec = { schema: tool.contextSchema, validate: tool.validateContext };
      assertAgentValidation(spec, `Tool ${name} context`);
      context = await validateAgentValue(spec as AgentValidation<unknown>, context);
    } else if (tool.validateContext) {
      context = await tool.validateContext(context);
    }
    if (tool.outputSchema) {
      assertAgentValidation(
        { schema: tool.outputSchema, validate: tool.validateResult },
        `Tool ${name} output`,
      );
    }
    const executionContext = (ctx: ToolExecuteContext): AgentToolContext => {
      const modelStep = receipts?.modelStep?.();
      const step = modelStep === undefined ? {} : { modelStep };
      return scoped
        ? {
            toolCallId: ctx.toolCallId,
            messages: ctx.messages,
            signal: ctx.signal,
            agentPath: ctx.agentPath,
            execution: ctx.execution,
            ...step,
            context,
          }
        : { ...ctx, ...step, context };
    };
    const prepared: Tool = {
      ...tool,
      outputSchema: tool.outputSchema ? await toJSONSchema(tool.outputSchema) : undefined,
      needsApproval:
        typeof tool.needsApproval === 'function'
          ? (args, ctx) =>
              (tool.needsApproval as Exclude<typeof tool.needsApproval, boolean | undefined>)(
                args,
                executionContext(ctx),
              )
          : tool.needsApproval,
      execute: tool.execute
        ? async (args, ctx) => {
            const scopedContext = executionContext(ctx);
            let receipt = receipts?.load(ctx.toolCallId);
            const save = async (next: AgentToolReceipt): Promise<void> => {
              receipt = next;
              try {
                await receipts?.save(next, ctx);
              } catch (error) {
                throw new ToolReceiptError(`Tool receipt could not be persisted: ${String(error)}`);
              }
            };
            if (
              receipt &&
              (receipt.toolName !== name || JSON.stringify(receipt.input) !== JSON.stringify(args))
            ) {
              throw new ToolReceiptError(
                'A persisted tool-call ID was reused with a different tool or input.',
              );
            }
            if (receipt?.stage === 'completed') return receipt.modelOutput;
            // The model was already answered with this failure (2.3): a replay
            // reports the same error and never repeats the effect.
            if (receipt?.stage === 'failed') throw new Error(receipt.error);
            if (
              receipt?.stage === 'executing' &&
              tool.replay !== 'idempotent' &&
              !receipts?.retryToolCallIds?.includes(ctx.toolCallId)
            ) {
              throw new ToolReceiptError(
                `Tool ${ctx.toolCallId} needs reconciliation before replay.`,
              );
            }
            let rawResult: unknown;
            if (receipt && receipt.stage !== 'executing' && receipt.stage !== 'suspended')
              rawResult = receipt.rawResult;
            else {
              await save({
                toolCallId: ctx.toolCallId,
                toolName: name,
                input: args,
                stage: 'executing',
              });
              if (ctx.execution)
                assertExecutionPolicy(ctx.execution, {
                  toolName: name,
                  now: ctx.deps?.clock.now(),
                });
              if (ctx.signal?.aborted)
                throw new ToolReceiptError('Tool execution was cancelled before dispatch.');
              try {
                rawResult = await tool.execute!(args, scopedContext);
              } catch (error) {
                if (error instanceof SubAgentSuspension)
                  await save({ ...receipt!, stage: 'suspended' });
                // An ordinary throw is a KNOWN outcome: the loop answers the call
                // with this error, so a resume must not stop for reconciliation.
                // A fatal infrastructure error keeps `executing`: whether the
                // effect happened is unknown.
                else if (!isFatalExecutionError(error))
                  await save({ ...receipt!, stage: 'failed', error: failureText(error) });
                throw error;
              }
              await save({ ...receipt!, stage: 'executed', rawResult });
            }
            let validated: unknown;
            try {
              validated = tool.outputSchema
                ? await validateAgentValue(
                    {
                      schema: tool.outputSchema,
                      validate: tool.validateResult,
                    } as AgentValidation<unknown>,
                    rawResult,
                  )
                : tool.validateResult
                  ? await tool.validateResult(rawResult)
                  : rawResult;
            } catch (error) {
              await save({ ...receipt!, stage: 'validation-failed', error: String(error) });
              await onOutput?.({
                toolName: name,
                toolCallId: ctx.toolCallId,
                rawResult,
                error: String(error),
              });
              throw error;
            }
            let modelOutput: unknown;
            try {
              modelOutput = tool.toModelOutput
                ? await tool.toModelOutput(validated, scopedContext)
                : validated;
            } catch (error) {
              await save({ ...receipt!, stage: 'projection-failed', error: String(error) });
              await onOutput?.({
                toolName: name,
                toolCallId: ctx.toolCallId,
                rawResult,
                error: String(error),
              });
              throw error;
            }
            await save({ ...receipt!, stage: 'completed', modelOutput, error: undefined });
            await onOutput?.({
              toolName: name,
              toolCallId: ctx.toolCallId,
              rawResult,
              modelOutput,
            });
            return modelOutput;
          }
        : undefined,
    };
    const target = readHandoffTarget(tool as Tool);
    if (target) {
      Object.defineProperty(prepared, HANDOFF_TARGET, {
        value: await preparedHandoffTarget(target, onOutput, receipts, seen),
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
    result[name] = prepared;
  }
  return result;
}

/** The text the loop's self-heal gives the model for a thrown error, so a replay reads the same. */
function failureText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
