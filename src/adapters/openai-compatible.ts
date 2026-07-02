import type { Adapter, AdapterRequest, BuildContext, ParseContext } from './types';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Part } from '../types/message';
import type { ToolChoice } from '../types/tool';
import type { NormalizedMessage } from '../core/normalize';
import type { DeuzError } from '../errors';
import {
  APICallError,
  AuthenticationError,
  ContextOverflowError,
  InvalidRequestError,
  ModelNotFoundError,
  OverloadedError,
  RateLimitError,
} from '../errors';
import { resolveImage, toOpenAIImageUrl } from '../internal/image';
import { applyProviderOptions } from '../internal/provider-options';
import { parseSSE } from '../internal/sse';
import { parseRetryAfterMs } from '../internal/http';

// --- request building ---

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider round-trip (e.g. Gemini `{ google: { thought_signature } }`). */
  extra_content?: unknown;
}

type OpenAIContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentBlock[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAIMessages(
  messages: NormalizedMessage[],
  useDeveloperRole: boolean,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    const role =
      m.role === 'system' && useDeveloperRole
        ? 'developer'
        : m.role === 'system'
          ? 'system'
          : m.role;

    const toolResults = m.content.filter(
      (p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result',
    );
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
        });
      }
      continue;
    }

    const toolUses = m.content.filter(
      (p): p is Extract<Part, { type: 'tool_use' }> => p.type === 'tool_use',
    );
    const text = m.content
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');

    if (toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id,
          type: 'function',
          function: {
            name: t.name,
            arguments: typeof t.input === 'string' ? t.input : JSON.stringify(t.input),
          },
          ...(t.providerMetadata?.extra_content
            ? { extra_content: t.providerMetadata.extra_content }
            : {}),
        })),
      });
    } else {
      const imageParts = m.content.filter(
        (p): p is Extract<Part, { type: 'image' }> => p.type === 'image',
      );
      if (imageParts.length > 0) {
        const blocks: OpenAIContentBlock[] = [];
        if (text) blocks.push({ type: 'text', text });
        for (const img of imageParts) {
          blocks.push({
            type: 'image_url',
            image_url: { url: toOpenAIImageUrl(resolveImage(img)) },
          });
        }
        out.push({ role, content: blocks });
      } else {
        // Reasoning parts have no Chat Completions round-trip — dropped here.
        out.push({ role, content: text });
      }
    }
  }
  return out;
}

/** Map canonical tool choice → OpenAI. undefined ⇒ omit (provider default 'auto'). */
function mapOpenAIToolChoice(choice: ToolChoice | undefined): string | object | undefined {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', function: { name: choice.toolName } };
  }
  return undefined;
}

function buildRequest(ctx: BuildContext): AdapterRequest {
  const { call, messages, caps, options, object, tools } = ctx;
  const reasoning = caps.reasoning;
  const restricted = caps.samplingRestrictions;

  const body: Record<string, unknown> = {
    model: call.modelId,
    messages: toOpenAIMessages(messages, restricted),
    stream: true,
  };

  // Reasoning models use max_completion_tokens and reject sampling params.
  const maxTokens = options.maxOutputTokens ?? caps.maxOutput;
  if (restricted) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
  }
  if (options.stopSequences) body.stop = options.stopSequences;
  if (reasoning && options.effort !== undefined) {
    // OpenAI accepts 'none' as a real value; 'max' is Anthropic-only → clamp.
    body.reasoning_effort = options.effort === 'max' ? 'xhigh' : options.effort;
  }

  // Stream-usage opt-in. Despite docs claiming Gemini-compat emits usage on
  // every chunk regardless, in practice it stays silent without this flag — so
  // we always send it and still keep only the LAST usage (registry.usagePerChunk).
  body.stream_options = { include_usage: true };

  if (object) {
    if (object.strategy === 'json') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: object.name ?? 'output', strict: true, schema: object.schema },
      };
    } else {
      const name = object.name ?? 'json_output';
      body.tools = [
        {
          type: 'function',
          function: {
            name,
            description: object.description ?? 'Return the structured result.',
            parameters: object.schema,
          },
        },
      ];
      body.tool_choice = { type: 'function', function: { name } };
    }
  } else if (tools) {
    body.tools = tools.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters,
      },
    }));
    const tc = mapOpenAIToolChoice(tools.toolChoice);
    if (tc !== undefined) body.tool_choice = tc;
    if (tools.allowParallel === false) body.parallel_tool_calls = false;
  } else if (options.responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }

  applyProviderOptions(body, call.provider, options);

  return {
    url: `${call.baseURL}/chat/completions`,
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

// --- stream parsing ---

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: unknown;
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage | null;
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapOpenAIUsage(u: OpenAIUsage | null | undefined): Usage {
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  const audio =
    (u?.prompt_tokens_details?.audio_tokens ?? 0) +
    (u?.completion_tokens_details?.audio_tokens ?? 0);
  const usage: Usage = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedReadTokens: cached,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: u?.total_tokens ?? prompt + completion,
  };
  if (audio > 0) usage.audioTokens = audio;
  return usage;
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  _ctx: ParseContext,
): AsyncGenerator<StreamPart> {
  let lastUsage: OpenAIUsage | null | undefined;
  let finishReason: FinishReason = 'stop';
  const toolIdByIndex = new Map<number, string>();

  for await (const ev of parseSSE(body)) {
    if (ev.data === '[DONE]') break;
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(ev.data) as OpenAIChunk;
    } catch {
      continue;
    }
    if (chunk.usage) lastUsage = chunk.usage; // usagePerChunk → last wins

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (delta?.content) yield { type: 'text-delta', text: delta.content };
    if (delta?.reasoning_content) yield { type: 'reasoning-delta', text: delta.reasoning_content };
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        let id = tc.id ?? toolIdByIndex.get(index);
        if (tc.id) toolIdByIndex.set(index, tc.id);
        if (!id) id = `tool_${index}`;
        yield {
          type: 'tool-call-delta',
          id,
          ...(tc.function?.name ? { name: tc.function.name } : {}),
          argsTextDelta: tc.function?.arguments ?? '',
          ...(tc.extra_content ? { providerMetadata: { extra_content: tc.extra_content } } : {}),
        };
      }
    }
    if (choice.finish_reason) finishReason = mapFinish(choice.finish_reason);
  }

  yield { type: 'finish', usage: mapOpenAIUsage(lastUsage), finishReason };
}

// --- error mapping ---

function mapError(status: number, body: unknown, headers: Headers): DeuzError {
  const envelope = (body ?? {}) as { error?: { message?: string; type?: string; code?: string } };
  const err = envelope.error;
  const message = err?.message ?? `Provider request failed (HTTP ${status}).`;
  const requestId = headers.get('x-request-id') ?? undefined;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = { message, requestId, upstreamType: err?.type ?? err?.code, retryAfterMs };

  if (err?.code === 'context_length_exceeded' || err?.type === 'context_length_exceeded') {
    return new ContextOverflowError({ ...base, statusCode: 400 });
  }
  if (status === 401) return new AuthenticationError({ ...base, statusCode: 401 });
  if (status === 403) return new AuthenticationError({ ...base, statusCode: 403 });
  if (status === 404) return new ModelNotFoundError({ ...base, statusCode: 404 });
  if (status === 429) return new RateLimitError({ ...base, statusCode: 429 });
  if (status === 529) return new OverloadedError({ ...base, statusCode: 529 });
  if (status >= 400 && status < 500)
    return new InvalidRequestError({ ...base, statusCode: status });
  return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
}

export const openaiCompatibleAdapter: Adapter = { buildRequest, parseStream, mapError };
