import type { Adapter, AdapterRequest, BuildContext, ParseContext } from './types';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Part } from '../types/message';
import type { ToolChoice } from '../types/tool';
import type { DeuzError } from '../errors';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  OverloadedError,
  RateLimitError,
} from '../errors';
import { extractSystem } from '../core/normalize';
import { applyProviderOptions } from '../internal/provider-options';
import { resolveImage } from '../internal/image';
import { parseSSE } from '../internal/sse';
import { parseRetryAfterMs } from '../internal/http';

const ANTHROPIC_VERSION = '2023-06-01';

// --- request building ---

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

function partToBlock(part: Part): AnthropicBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool_use':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolUseId,
        content: typeof part.result === 'string' ? part.result : JSON.stringify(part.result),
        ...(part.isError ? { is_error: true } : {}),
      };
    case 'reasoning':
      return part.redacted
        ? { type: 'redacted_thinking', data: part.text }
        : {
            type: 'thinking',
            thinking: part.text,
            ...(part.signature ? { signature: part.signature } : {}),
          };
    case 'image': {
      const img = resolveImage(part);
      if (img.kind === 'url') {
        return { type: 'image', source: { type: 'url', url: img.data } };
      }
      return {
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      };
    }
  }
}

/** Reasoning/thinking blocks MUST come first in an Anthropic content array. */
function orderReasoningFirst(blocks: AnthropicBlock[]): AnthropicBlock[] {
  const thinking = blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  const rest = blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  return [...thinking, ...rest];
}

const THINKING_BUDGET: Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', number> = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
  xhigh: 48_000,
  max: 48_000,
};

/** Map canonical tool choice → Anthropic. Forced choice is illegal with thinking → fall back to auto. */
function mapAnthropicToolChoice(
  choice: ToolChoice | undefined,
  thinkingOn: boolean,
  allowParallel: boolean | undefined,
): Record<string, unknown> {
  const dp = allowParallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (!choice || choice === 'auto' || thinkingOn) return { type: 'auto', ...dp };
  if (choice === 'required') return { type: 'any', ...dp };
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'tool', name: choice.toolName, ...dp };
  }
  return { type: 'auto', ...dp };
}

function buildRequest(ctx: BuildContext): AdapterRequest {
  const { call, messages, caps, options } = ctx;
  const { system, rest } = extractSystem(messages);

  const wireMessages = rest.map((m) => ({
    role: m.role === 'tool' ? 'user' : m.role,
    content: orderReasoningFirst(m.content.map(partToBlock)),
  }));

  const effortOn = caps.reasoning && options.effort !== undefined && options.effort !== 'none';
  // Opus 4.7+/Sonnet 5/Fable 5: budget_tokens returns 400 — effort rides output_config.
  const useOutputConfig = caps.effortWire === 'output_config';
  const thinkingOn = effortOn && !useOutputConfig;
  const maxTokens = options.maxOutputTokens ?? caps.maxOutput;

  const body: Record<string, unknown> = {
    model: call.modelId,
    max_tokens: thinkingOn
      ? Math.max(maxTokens, THINKING_BUDGET[options.effort as keyof typeof THINKING_BUDGET] + 1_024)
      : maxTokens,
    messages: wireMessages,
    stream: true,
  };
  if (system) body.system = system;
  if (thinkingOn) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: THINKING_BUDGET[options.effort as keyof typeof THINKING_BUDGET],
    };
    // Anthropic requires temperature unset (=1) when thinking is enabled.
  } else if (!caps.samplingRestrictions) {
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
  }
  if (options.stopSequences) body.stop_sequences = options.stopSequences;
  if (options.promptCaching && caps.caching) {
    // Top-level automatic caching (Feb 2026): the API manages the breakpoint.
    body.cache_control = {
      type: 'ephemeral',
      ...(options.promptCaching === 'auto-1h' ? { ttl: '1h' } : {}),
    };
  }

  if (ctx.object) {
    if (ctx.object.strategy === 'json') {
      body.output_config = { format: { type: 'json_schema', schema: ctx.object.schema } };
    } else {
      const toolName = ctx.object.name ?? 'json_output';
      body.tools = [
        {
          name: toolName,
          description: ctx.object.description ?? 'Return the structured result.',
          input_schema: ctx.object.schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: toolName };
    }
  } else if (ctx.tools) {
    body.tools = ctx.tools.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.parameters,
    }));
    body.tool_choice = mapAnthropicToolChoice(
      ctx.tools.toolChoice,
      thinkingOn || (effortOn && useOutputConfig),
      ctx.tools.allowParallel,
    );
  }

  // Effort rides output_config on adaptive-thinking models; merge with the
  // json-strategy `output_config.format` set above when both are present.
  if (effortOn && useOutputConfig) {
    body.output_config = {
      ...(body.output_config as Record<string, unknown> | undefined),
      effort: options.effort,
    };
  }

  applyProviderOptions(body, call.provider, options);

  // Claude on Vertex AI: same Messages body, but model goes in the URL,
  // `anthropic_version` goes in the body, and auth is an OAuth Bearer token.
  if (call.vertex) {
    body.anthropic_version = 'vertex-2023-10-16';
    delete body.model;
    return {
      url: `${call.baseURL}/v1/projects/${call.vertex.project}/locations/${call.vertex.location}/publishers/anthropic/models/${call.modelId}:streamRawPredict`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${call.apiKey}`,
          ...call.headers,
        },
        body: JSON.stringify(body),
      },
    };
  }

  return {
    url: `${call.baseURL}/v1/messages`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': call.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...call.headers,
      },
      body: JSON.stringify(body),
    },
  };
}

// --- stream parsing ---

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
  /** Per-attempt usage from server-side fallbacks / compaction — sum for billing. */
  iterations?: AnthropicUsage[];
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_details?: { type?: string; category?: string | null; explanation?: string | null };
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

function mapStopReason(reason: string | null): FinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function buildUsage(input: AnthropicUsage, outputTokens: number): Usage {
  // Fallbacks/compaction report per-attempt usage in `iterations` while the
  // top-level usage covers only the serving attempt — sum iterations instead.
  if (input.iterations && input.iterations.length > 0) {
    return input.iterations
      .map((it) => buildUsage({ ...it, iterations: undefined }, it.output_tokens ?? 0))
      .reduce((acc, u) => ({
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
        reasoningTokens: acc.reasoningTokens + u.reasoningTokens,
        cachedReadTokens: acc.cachedReadTokens + u.cachedReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
        cacheWrite1hTokens: acc.cacheWrite1hTokens + u.cacheWrite1hTokens,
        totalTokens: acc.totalTokens + u.totalTokens,
      }));
  }
  const cacheRead = input.cache_read_input_tokens ?? 0;
  const cacheWriteTotal = input.cache_creation_input_tokens ?? 0;
  const cacheWrite1h = input.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const inputTokens = input.input_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    // Thinking tokens bill inside output_tokens; the detail field breaks them out.
    reasoningTokens: input.output_tokens_details?.thinking_tokens ?? 0,
    cachedReadTokens: cacheRead,
    cacheWriteTokens: Math.max(0, cacheWriteTotal - cacheWrite1h),
    cacheWrite1hTokens: cacheWrite1h,
    totalTokens: inputTokens + cacheRead + cacheWriteTotal + outputTokens,
  };
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  _ctx: ParseContext,
): AsyncGenerator<StreamPart> {
  let inputUsage: AnthropicUsage = {};
  let outputTokens = 0;
  let stopReason: string | null = null;
  let stopDetails: unknown;
  const toolIds = new Map<number, string>();
  let finishEmitted = false;

  for await (const ev of parseSSE(body)) {
    if (ev.event === 'ping') continue;
    let data: AnthropicEvent;
    try {
      data = JSON.parse(ev.data) as AnthropicEvent;
    } catch {
      continue;
    }
    const type = data.type ?? ev.event;

    if (type === 'message_start') {
      if (data.message?.usage) {
        inputUsage = data.message.usage;
        outputTokens = data.message.usage.output_tokens ?? 0;
      }
    } else if (type === 'content_block_start') {
      const idx = data.index ?? 0;
      const block = data.content_block;
      if (block?.type === 'tool_use' && block.id) {
        toolIds.set(idx, block.id);
        yield { type: 'tool-call-delta', id: block.id, name: block.name, argsTextDelta: '' };
      }
    } else if (type === 'content_block_delta') {
      const idx = data.index ?? 0;
      const d = data.delta;
      if (d?.type === 'text_delta' && d.text !== undefined) {
        yield { type: 'text-delta', text: d.text };
      } else if (d?.type === 'thinking_delta' && d.thinking !== undefined) {
        yield { type: 'reasoning-delta', text: d.thinking };
      } else if (d?.type === 'signature_delta' && d.signature !== undefined) {
        yield { type: 'reasoning-delta', text: '', signature: d.signature };
      } else if (d?.type === 'input_json_delta') {
        yield {
          type: 'tool-call-delta',
          id: toolIds.get(idx) ?? '',
          argsTextDelta: d.partial_json ?? '',
        };
      }
    } else if (type === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.delta?.stop_details) stopDetails = data.delta.stop_details;
      if (data.usage) {
        if (data.usage.output_tokens !== undefined) outputTokens = data.usage.output_tokens;
        // The final message_delta carries output_tokens_details / iterations;
        // merge but never clobber message_start's input_tokens with undefined.
        inputUsage = {
          ...inputUsage,
          ...data.usage,
          input_tokens: data.usage.input_tokens ?? inputUsage.input_tokens,
        };
      }
    } else if (type === 'message_stop') {
      finishEmitted = true;
      yield {
        type: 'finish',
        usage: buildUsage(inputUsage, outputTokens),
        finishReason: mapStopReason(stopReason),
        ...(stopDetails ? { providerMetadata: { anthropic: { stop_details: stopDetails } } } : {}),
      };
    } else if (type === 'error') {
      yield { type: 'error', error: mapError(200, data, new Headers()) };
      return;
    }
  }

  if (!finishEmitted) {
    yield {
      type: 'finish',
      usage: buildUsage(inputUsage, outputTokens),
      finishReason: mapStopReason(stopReason),
      ...(stopDetails ? { providerMetadata: { anthropic: { stop_details: stopDetails } } } : {}),
    };
  }
}

// --- error mapping ---

function mapError(status: number, body: unknown, headers: Headers): DeuzError {
  const envelope = (body ?? {}) as {
    error?: { type?: string; message?: string };
    request_id?: string;
  };
  const errType = envelope.error?.type;
  const message = envelope.error?.message ?? `Anthropic request failed (HTTP ${status}).`;
  const requestId = headers.get('request-id') ?? envelope.request_id ?? undefined;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = { message, provider: 'anthropic', requestId, upstreamType: errType, retryAfterMs };

  switch (errType) {
    case 'authentication_error':
      return new AuthenticationError({ ...base, statusCode: 401 });
    case 'permission_error':
      return new AuthenticationError({ ...base, statusCode: 403 });
    case 'not_found_error':
      return new ModelNotFoundError({ ...base, statusCode: 404 });
    case 'rate_limit_error':
      return new RateLimitError({ ...base, statusCode: 429 });
    case 'overloaded_error':
      return new OverloadedError({ ...base, statusCode: 529 });
    case 'request_too_large':
      return new InvalidRequestError({ ...base, statusCode: 413 });
    case 'invalid_request_error':
      return new InvalidRequestError({
        ...base,
        statusCode: status >= 400 && status < 500 ? status : 400,
      });
    case 'api_error':
      return new APICallError({ ...base, statusCode: 500, isRetryable: true });
    default:
      return mapByStatus(status, base);
  }
}

function mapByStatus(
  status: number,
  base: {
    message: string;
    provider: string;
    requestId?: string;
    upstreamType?: string;
    retryAfterMs?: number;
  },
): DeuzError {
  if (status === 401 || status === 403)
    return new AuthenticationError({ ...base, statusCode: status });
  if (status === 404) return new ModelNotFoundError({ ...base, statusCode: status });
  if (status === 429) return new RateLimitError({ ...base, statusCode: status });
  if (status === 529) return new OverloadedError({ ...base, statusCode: status });
  if (status >= 400 && status < 500)
    return new InvalidRequestError({ ...base, statusCode: status });
  return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
}

export const anthropicAdapter: Adapter = { buildRequest, parseStream, mapError };
