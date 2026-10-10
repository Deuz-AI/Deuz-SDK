/**
 * realtime/tools.ts — the bridge from realtime function calls to Deuz tools.
 *
 * Tools keep the core `Tool` shape (`parameters` as a Standard Schema or raw
 * JSON Schema, `execute`, `needsApproval`, `timeoutMs`), and a call fails the
 * way it fails in the chat loop (`executeTools` in `inference/loop-shared.ts`):
 * an unknown name, unparsable or invalid arguments, a denial, a throw or a
 * timeout all become an error result the model hears, so the conversation goes
 * on. The message texts match the loop's. A tool without `execute` is a client
 * tool: the call waits for `session.sendToolResult`.
 *
 * The calls of one model turn form a batch, answered together once every call
 * has settled — Gemini expects one `toolResponse` for a `toolCall`, and OpenAI
 * should get a single `response.create` after all outputs.
 */
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { TimeoutError, ToolExecutionError } from '../errors';
import type { CallWarning } from '../types/methods';
import type { ResolvedDependencies } from '../types/deps';
import type { ToolCall, ToolExecuteContext, ToolSet } from '../types/tool';
import { RealtimeError } from './errors';
import type { DecodedToolCall, ToolOutcome, WireTool } from './protocol';
import type { RealtimeEvent } from './types';

/** The loop's denial text (`TOOL_DENIED` in inference/loop-shared.ts). */
const TOOL_DENIED = 'Tool call denied.';

function unknownToolMessage(tools: ToolSet | undefined, name: string): string {
  const available = Object.entries(tools ?? {})
    .filter(([, tool]) => tool.type !== 'provider')
    .map(([toolName]) => toolName);
  return available.length > 0
    ? `No such tool: "${name}". Available tools: ${available.join(', ')}.`
    : `No such tool: "${name}". No tools are available.`;
}

/** Resolve every tool's schema to JSON Schema once, before the session is configured. */
export async function buildWireTools(
  tools: ToolSet | undefined,
  warn: (warning: CallWarning) => void,
): Promise<WireTool[]> {
  const wire: WireTool[] = [];
  for (const [name, tool] of Object.entries(tools ?? {})) {
    if (tool.type === 'provider') {
      warn({
        type: 'unsupported-tool',
        setting: name,
        message: `Tool '${name}' is provider-executed; realtime sessions declare function tools only, so it was left out.`,
      });
      continue;
    }
    wire.push({
      name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: await toJSONSchema(tool.parameters),
    });
  }
  return wire;
}

export interface ToolRunnerOptions {
  tools: ToolSet | undefined;
  approveToolCall?: (call: ToolCall) => boolean | Promise<boolean>;
  /** Present only when the caller passed one (forwarded untouched). */
  runtimeContext?: { value: unknown };
  deps: ResolvedDependencies;
  emit(event: RealtimeEvent): void;
  /** Deliver a settled batch to the wire. */
  flush(outcomes: ToolOutcome[]): void;
}

export interface ToolRunner {
  dispatch(calls: DecodedToolCall[], responseId: string | undefined): void;
  /** Answer a pending client-tool call. Throws when no such call is waiting. */
  resolveClientCall(toolCallId: string, result: unknown, isError: boolean): void;
  /**
   * Abort and forget calls the provider cancelled; they are never answered.
   * Returns the ids that were still pending (already-answered calls are left alone).
   */
  cancel(toolCallIds: string[]): string[];
  /** Abort everything still running; no result is delivered after this. */
  close(): void;
}

interface Batch {
  calls: DecodedToolCall[];
  outcomes: Map<string, ToolOutcome>;
  cancelled: Set<string>;
  flushed: boolean;
}

const TIMED_OUT = Symbol('timed-out');

export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const open = new Set<Batch>();
  const running = new Map<string, AbortController>();
  const clientCalls = new Map<string, { batch: Batch; call: DecodedToolCall }>();
  let closed = false;

  function maybeFlush(batch: Batch): void {
    if (batch.flushed) return;
    const live = batch.calls.filter((call) => !batch.cancelled.has(call.toolCallId));
    if (live.some((call) => !batch.outcomes.has(call.toolCallId))) return;
    batch.flushed = true;
    open.delete(batch);
    if (live.length > 0) options.flush(live.map((call) => batch.outcomes.get(call.toolCallId)!));
  }

  function settle(batch: Batch, call: DecodedToolCall, result: unknown, isError: boolean): void {
    if (closed || batch.flushed || batch.cancelled.has(call.toolCallId)) return;
    if (batch.outcomes.has(call.toolCallId)) return;
    running.delete(call.toolCallId);
    clientCalls.delete(call.toolCallId);
    batch.outcomes.set(call.toolCallId, { call, result, isError });
    options.emit({
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result,
      ...(isError ? { isError: true } : {}),
    });
    maybeFlush(batch);
  }

  /** `execute` raced against `timeoutMs` on the injected clock (never an ambient timer). */
  async function invoke(
    batch: Batch,
    call: DecodedToolCall,
    execute: () => unknown,
    timeoutMs: number | undefined,
    controller: AbortController,
  ): Promise<void> {
    const work = new Promise<unknown>((resolve) => resolve(execute()));
    // Infinity means no cap: a host timer would clamp it to 1 ms.
    if (timeoutMs === undefined || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
      settle(batch, call, await work, false);
      return;
    }
    let cancelTimer: () => void = () => {};
    const timer = new Promise<typeof TIMED_OUT>((resolve) => {
      cancelTimer = options.deps.clock.setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const outcome = await Promise.race([work, timer]);
      if (outcome === TIMED_OUT) {
        const message = `Tool '${call.toolName}' timed out after ${timeoutMs}ms and was abandoned.`;
        controller.abort(new TimeoutError('tool', message));
        settle(batch, call, message, true);
        return;
      }
      settle(batch, call, outcome, false);
    } finally {
      cancelTimer();
    }
  }

  async function run(batch: Batch, call: DecodedToolCall): Promise<void> {
    const tool = options.tools?.[call.toolName];
    if (!tool || tool.type === 'provider') {
      settle(batch, call, unknownToolMessage(options.tools, call.toolName), true);
      return;
    }
    if (call.argsError !== undefined) {
      settle(batch, call, `Invalid arguments: ${call.argsError}`, true);
      return;
    }
    if (!tool.execute) {
      clientCalls.set(call.toolCallId, { batch, call });
      return;
    }
    const execute = tool.execute;
    const controller = new AbortController();
    running.set(call.toolCallId, controller);
    const ctx: ToolExecuteContext = {
      toolCallId: call.toolCallId,
      messages: [],
      signal: controller.signal,
      deps: options.deps,
      ...(options.runtimeContext ? { runtimeContext: options.runtimeContext.value } : {}),
    };
    try {
      const validation = await validateOutput(tool.parameters, call.args);
      if (!validation.ok) {
        settle(batch, call, `Invalid arguments: ${validation.issues}`, true);
        return;
      }
      const args = validation.value;
      const needsApproval =
        typeof tool.needsApproval === 'function'
          ? await tool.needsApproval(args, ctx)
          : tool.needsApproval === true;
      if (needsApproval) {
        if (!options.approveToolCall) {
          settle(
            batch,
            call,
            `${TOOL_DENIED} Reason: '${call.toolName}' needs approval and the session has no approveToolCall.`,
            true,
          );
          return;
        }
        const approved = await options.approveToolCall({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args,
        });
        if (!approved) {
          settle(batch, call, TOOL_DENIED, true);
          return;
        }
      }
      if (controller.signal.aborted) return;
      await invoke(batch, call, () => execute(args, ctx), tool.timeoutMs, controller);
    } catch (cause) {
      // A throw is fed back to the model (self-heal), never out of the session.
      const error = new ToolExecutionError(call.toolName, {
        toolCallId: call.toolCallId,
        cause,
        ...(cause instanceof Error && cause.message ? { message: cause.message } : {}),
      });
      settle(batch, call, error.message, true);
    } finally {
      running.delete(call.toolCallId);
    }
  }

  return {
    dispatch(calls, responseId) {
      if (closed || calls.length === 0) return;
      const batch: Batch = { calls, outcomes: new Map(), cancelled: new Set(), flushed: false };
      open.add(batch);
      for (const call of calls) {
        options.emit({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
          ...(responseId ? { responseId } : {}),
        });
      }
      for (const call of calls) void run(batch, call);
    },

    resolveClientCall(toolCallId, result, isError) {
      const pending = clientCalls.get(toolCallId);
      if (!pending) {
        throw new RealtimeError({
          kind: 'tool',
          message: `No client tool call '${toolCallId}' is waiting for a result.`,
        });
      }
      settle(pending.batch, pending.call, result, isError);
    },

    cancel(toolCallIds) {
      const cancelled: string[] = [];
      for (const id of new Set(toolCallIds)) {
        for (const batch of [...open]) {
          const pending =
            batch.calls.some((call) => call.toolCallId === id) &&
            !batch.cancelled.has(id) &&
            !batch.outcomes.has(id);
          if (!pending) continue;
          batch.cancelled.add(id);
          running.get(id)?.abort(new Error(`Tool call '${id}' was cancelled by the provider.`));
          running.delete(id);
          clientCalls.delete(id);
          cancelled.push(id);
          maybeFlush(batch);
        }
      }
      return cancelled;
    },

    close() {
      closed = true;
      for (const controller of running.values()) {
        controller.abort(new Error('The realtime session closed.'));
      }
      running.clear();
      clientCalls.clear();
      open.clear();
    },
  };
}
