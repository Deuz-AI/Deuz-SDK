import type { CommonCallOptions } from '../types/config';
import type { StreamChatResult } from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Message } from '../types/message';
import type { Usage, FinishReason } from '../types/usage';
import type { ToolCall, StepResult } from '../types/tool';
import { runStream } from '../core/inference';
import { resolveDependencies } from '../internal/resolve-deps';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from '../internal/async-iter';
import { assembleAssistant, type ToolArgMap, type EncryptedReasoning } from './run-step';
import { EMPTY_USAGE, withTotal, fireFinish } from '../core/metering';
import {
  buildWireTools,
  filterWireTools,
  applyPrepareStep,
  executeTools,
  toToolResultPart,
  toStepResult,
  hasClientTool,
  bumpErrorGuard,
  normalizeStop,
  needsCost,
  shouldStop,
  sumUsage,
  findApprovalNeeded,
  resolveServerApprovals,
  settlePendingApprovals,
} from './loop-shared';

async function* projectText(source: AsyncIterable<StreamPart>): AsyncGenerator<string> {
  for await (const part of source) {
    if (part.type === 'text-delta') yield part.text;
    else if (part.type === 'error') throw part.error;
  }
}

/**
 * Streaming agentic loop. Produces ONE canonical `fullStream` spanning N model
 * calls: each step's text/reasoning/tool deltas pass through, then `step-finish`,
 * `tool-call` (parsed), `tool-result` (after execution), then the next step —
 * until no tool calls (Gemini guard) or a stop/runaway condition fires.
 */
export function runStreamToolLoop(options: CommonCallOptions): StreamChatResult {
  const broadcaster = createBroadcaster<StreamPart>();
  const usageDeferred = createDeferred<Usage>();
  const finishDeferred = createDeferred<FinishReason>();
  const fullSub = broadcaster.subscribe();
  const textSub = broadcaster.subscribe();

  let started = false;
  function ensureStarted(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    const deps = resolveDependencies(options.deps);
    const tools = options.tools!;
    let messages: Message[] = [...options.messages];
    const steps: StepResult[] = [];
    const stopConditions = normalizeStop(options.stopWhen, options.maxSteps ?? 1);
    const wantCost = needsCost(stopConditions);
    if (wantCost && !deps.priceProvider) {
      deps.logger.warn('costExceeds: no deps.priceProvider injected — the condition never fires');
    }
    const errorCounters = new Map<string, number>();
    let totalUsage: Usage = EMPTY_USAGE;
    let lastFinish: FinishReason = 'stop';
    let stoppedBy: string | undefined;
    let stepIndex = 0;

    try {
      const fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
      const staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);

      // Resume: settle the previous break's pending approvals BEFORE step 1 —
      // their tool-result parts precede the first step-start.
      const settled = await settlePendingApprovals(messages, tools, options);
      if (settled) {
        messages = settled.messages;
        for (const r of settled.results) {
          broadcaster.push({
            type: 'tool-result',
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: r.result,
            ...(r.isError ? { isError: true } : {}),
          });
        }
        bumpErrorGuard(
          errorCounters,
          settled.results.filter((r) => !settled.deniedIds.has(r.toolCallId)),
        );
      }

      for (;;) {
        broadcaster.push({ type: 'step-start', stepIndex });
        const prepared = await applyPrepareStep(
          options,
          { stepIndex, messages, usage: totalUsage },
          fullWire,
          staticWire,
          deps.logger,
        );
        messages = prepared.messages;
        const inner = runStream({ ...prepared.options, messages }, { tools: prepared.wire });

        let text = '';
        let reasoningText = '';
        let reasoningSignature: string | undefined;
        const encryptedReasoning: EncryptedReasoning = [];
        const toolArgs: ToolArgMap = new Map();
        const toolOrder: string[] = [];
        let stepUsage: Usage = EMPTY_USAGE;
        let stepFinish: FinishReason = 'stop';
        let stepPhase: string | undefined;

        for await (const part of inner.fullStream) {
          switch (part.type) {
            case 'text-delta':
              text += part.text;
              broadcaster.push(part);
              break;
            case 'reasoning-delta':
              if (part.encrypted) {
                encryptedReasoning.push({ text: part.text, signature: part.signature });
                broadcaster.push(part);
                break;
              }
              reasoningText += part.text;
              if (part.signature) reasoningSignature = part.signature;
              broadcaster.push(part);
              break;
            case 'tool-call-delta': {
              let entry = toolArgs.get(part.id);
              if (!entry) {
                entry = { name: part.name, args: '' };
                toolArgs.set(part.id, entry);
                toolOrder.push(part.id);
              }
              if (part.name && !entry.name) entry.name = part.name;
              if (part.providerMetadata) entry.meta = part.providerMetadata;
              entry.args += part.argsTextDelta;
              broadcaster.push(part); // forward raw for live UI input-streaming
              break;
            }
            case 'source':
              broadcaster.push(part);
              break;
            case 'finish':
              stepUsage = part.usage;
              stepFinish = part.finishReason;
              stepPhase = (part.providerMetadata?.openai as { phase?: string } | undefined)?.phase;
              break; // re-framed as step-finish below
            case 'error':
              broadcaster.push(part);
              usageDeferred.reject(part.error);
              finishDeferred.reject(part.error);
              broadcaster.close();
              return;
            default:
              break;
          }
        }

        totalUsage = sumUsage(totalUsage, stepUsage);
        lastFinish = stepFinish;
        broadcaster.push({
          type: 'step-finish',
          stepIndex,
          finishReason: stepFinish,
          usage: stepUsage,
        });

        const { assistantMessage, toolUseParts } = assembleAssistant(
          text,
          reasoningText,
          reasoningSignature,
          toolArgs,
          toolOrder,
          encryptedReasoning,
        );
        if (stepPhase) assistantMessage.providerMetadata = { openai: { phase: stepPhase } };

        if (options.signal?.aborted) {
          lastFinish = 'aborted';
          break;
        }

        // *** GEMINI GUARD: continue on tool_use parts, NOT finishReason ***
        if (toolUseParts.length === 0) {
          steps.push(
            toStepResult(
              {
                text,
                reasoningText,
                toolUseParts,
                usage: stepUsage,
                finishReason: stepFinish,
                assistantMessage,
              },
              [],
              [],
              steps.length,
            ),
          );
          break;
        }

        const toolCalls: ToolCall[] = toolUseParts.map((p) => ({
          toolCallId: p.id,
          toolName: p.name,
          args: p.input,
        }));
        for (const c of toolCalls) {
          broadcaster.push({
            type: 'tool-call',
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.args,
          });
        }
        messages = [...messages, assistantMessage];

        // Approval gate: server mode denies inline; without approveToolCall the
        // gated calls break the loop like client tools (client mode).
        const gated = await findApprovalNeeded(toolCalls, tools, options, messages);
        const denied = options.approveToolCall
          ? await resolveServerApprovals(gated, toolCalls, options, messages)
          : new Map<string, string | undefined>();
        const pendingApproval = options.approveToolCall
          ? []
          : toolCalls.filter((c) => gated.has(c.toolCallId));

        const stepData = {
          text,
          reasoningText,
          toolUseParts,
          usage: stepUsage,
          finishReason: stepFinish,
          assistantMessage,
        };
        // Pending approvals and client tools break together: ONE break, nothing
        // from the batch executes; the resume call settles the deferred rest.
        if (pendingApproval.length > 0 || hasClientTool(toolCalls, tools)) {
          for (const c of pendingApproval) {
            broadcaster.push({
              type: 'tool-approval-request',
              approvalId: c.toolCallId,
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.args,
            });
          }
          const sr = toStepResult(stepData, toolCalls, [], steps.length);
          steps.push(sr);
          options.onStepFinish?.(sr);
          break;
        }

        const toolResults = await executeTools(toolCalls, tools, options, messages, denied);
        for (const r of toolResults) {
          broadcaster.push({
            type: 'tool-result',
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: r.result,
            ...(r.isError ? { isError: true } : {}),
          });
        }
        const toolResultMessage: Message = {
          role: 'tool',
          content: toolResults.map(toToolResultPart),
        };
        messages = [...messages, toolResultMessage];

        const sr = toStepResult(stepData, toolCalls, toolResults, steps.length, toolResultMessage);
        steps.push(sr);
        options.onStepFinish?.(sr);

        // Denials are deliberate, not tool failures — exclude from the runaway guard.
        if (
          bumpErrorGuard(
            errorCounters,
            toolResults.filter((r) => !denied.has(r.toolCallId)),
          )
        )
          break;
        const costUSD =
          wantCost && deps.priceProvider
            ? ((await deps.priceProvider.priceUsage(options.model.modelId, totalUsage)) ??
              undefined)
            : undefined;
        const stop = await shouldStop(stopConditions, steps, { usage: totalUsage, costUSD });
        if (stop.stop) {
          stoppedBy = stop.stoppedBy;
          break;
        }
        stepIndex++;
      }

      const usage = withTotal(totalUsage);
      broadcaster.push({
        type: 'finish',
        usage,
        finishReason: lastFinish,
        ...(stoppedBy ? { providerMetadata: { deuz: { stoppedBy } } } : {}),
      });
      usageDeferred.resolve(usage);
      finishDeferred.resolve(lastFinish);
      fireFinish(options, deps, { model: options.model.modelId, finishReason: lastFinish });
      broadcaster.close();
    } catch (err) {
      broadcaster.push({ type: 'error', error: err });
      usageDeferred.reject(err);
      finishDeferred.reject(err);
      broadcaster.close();
    }
  }

  const fullStream = lazyAsyncIterable<StreamPart>(() => fullSub, ensureStarted);
  const textStream = lazyAsyncIterable<string>(() => projectText(textSub), ensureStarted);

  return {
    get textStream() {
      return textStream;
    },
    get fullStream() {
      return fullStream;
    },
    get usage() {
      ensureStarted();
      return usageDeferred.promise;
    },
    get finishReason() {
      ensureStarted();
      return finishDeferred.promise;
    },
  };
}
