import type {
  AgentToolSet,
  AgentToolContext,
  AgentValidation,
  AgentToolReceipt,
} from '../types/agent-run';
import type { ToolSet, ToolExecuteContext } from '../types/tool';
import { assertAgentValidation, validateAgentValue } from './agent-output';
import { toJSONSchema } from '../schema/bridge';
import { assertExecutionPolicy } from '../execution-policy';
import { SubAgentSuspension } from './loop-shared';
import { isAgentDelegationTool } from './agent-tool';

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
  const result: ToolSet = Object.create(null) as ToolSet;
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
    result[name] = {
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
  }
  return result;
}
