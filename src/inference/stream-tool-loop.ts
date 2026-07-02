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
  executeTools,
  toToolResultPart,
  toStepResult,
  hasClientTool,
  bumpErrorGuard,
  normalizeStop,
  shouldStop,
  sumUsage,
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
    const errorCounters = new Map<string, number>();
    let totalUsage: Usage = EMPTY_USAGE;
    let lastFinish: FinishReason = 'stop';
    let stepIndex = 0;

    try {
      const wireTools = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);

      for (;;) {
        broadcaster.push({ type: 'step-start', stepIndex });
        const inner = runStream({ ...options, messages }, { tools: wireTools });

        let text = '';
        let reasoningText = '';
        let reasoningSignature: string | undefined;
        const encryptedReasoning: EncryptedReasoning = [];
        const toolArgs: ToolArgMap = new Map();
        const toolOrder: string[] = [];
        let stepUsage: Usage = EMPTY_USAGE;
        let stepFinish: FinishReason = 'stop';

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

        const stepData = {
          text,
          reasoningText,
          toolUseParts,
          usage: stepUsage,
          finishReason: stepFinish,
          assistantMessage,
        };
        if (hasClientTool(toolCalls, tools)) {
          const sr = toStepResult(stepData, toolCalls, [], steps.length);
          steps.push(sr);
          options.onStepFinish?.(sr);
          break;
        }

        const toolResults = await executeTools(toolCalls, tools, options, messages);
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

        if (bumpErrorGuard(errorCounters, toolResults)) break;
        if (await shouldStop(stopConditions, steps)) break;
        stepIndex++;
      }

      const usage = withTotal(totalUsage);
      broadcaster.push({ type: 'finish', usage, finishReason: lastFinish });
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
