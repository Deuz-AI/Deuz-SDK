/**
 * Final-JSON parsers (2.3, BA2). A batch result is the provider's complete,
 * non-streaming reply, so each wire gets a parser of its own; all four
 * normalize to what the streaming adapters produce for the same reply: usage
 * per the 2.3 contract (`outputTokens` includes reasoning, `inputTokens`
 * excludes cache reads) and the same finish reasons. Shapes come from the
 * providers' SDK types (`@anthropic-ai/sdk` 0.133 `Message`, `openai` 7.32
 * `Response` / `ChatCompletion`, `@google/genai` 2.28 `GenerateContentResponse`);
 * not live-verified.
 *
 * Usage goes through each wire's own adapter mapper, so a batch reply bills
 * exactly as the streamed reply would; `test/batch-parse.test.ts` pins it.
 * The OpenAI and Gemini finish reasons go through the adapters' mappers too
 * (2.3, K4), and an OpenAI refusal's stop details through the normalizer
 * every result shares.
 */
import { mapAnthropicUsage, type AnthropicUsage } from '../adapters/anthropic';
import { mapGeminiFinishReason, mapGeminiUsage } from '../adapters/google-native';
import { mapChatFinishReason, mapOpenAIUsage } from '../adapters/openai-compatible';
import {
  mapResponsesFinishReason,
  mapResponsesUsage,
  type ResponsesUsage,
} from '../adapters/openai-responses';
import { stopDetailsFrom } from '../internal/stop-details';
import type { StopDetails } from '../types/methods';
import type { ModelSurface } from '../types/model';
import type { FinishReason, Usage } from '../types/usage';

/** A tool call in the reply: its arguments as the wire sent them (an object or JSON text). */
export interface ParsedToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** One final reply, normalized across the four wires. */
export interface ParsedReply {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly ParsedToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /** False when the provider did not report the usage counters (F02): the cost is unknown. */
  readonly usageAvailable: boolean;
  readonly stopDetails?: StopDetails;
  readonly providerMetadata?: Record<string, unknown>;
  /** A failure the provider reported inside an otherwise successful body. */
  readonly error?: { readonly code?: string; readonly message: string };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const EMPTY: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
};

const WIRES: Record<ModelSurface, string> = {
  anthropic: 'an Anthropic Messages',
  responses: 'an OpenAI Responses',
  chat_completions: 'a Chat Completions',
  native: 'a Gemini generateContent',
};

/** Normalize one final reply body of `surface`. Never throws. */
export function parseReply(surface: ModelSurface, body: unknown): ParsedReply {
  if (!isObject(body)) {
    return {
      text: '',
      reasoning: '',
      toolCalls: [],
      finishReason: 'error',
      usage: EMPTY,
      usageAvailable: false,
      error: { message: `The batch result is not ${WIRES[surface]} response.` },
    };
  }
  switch (surface) {
    case 'anthropic':
      return parseMessage(body);
    case 'responses':
      return parseResponse(body);
    case 'chat_completions':
      return parseCompletion(body);
    case 'native':
      return parseGenerateContent(body);
  }
}

// --- Anthropic Messages ---

function anthropicFinish(reason: unknown): FinishReason {
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

function parseMessage(body: Json): ParsedReply {
  let out = '';
  let reasoning = '';
  const toolCalls: ParsedToolCall[] = [];
  for (const block of list(body.content)) {
    if (!isObject(block)) continue;
    if (block.type === 'text') out += text(block.text);
    else if (block.type === 'thinking') reasoning += text(block.thinking);
    // server_tool_use blocks are provider-executed — never a call of ours.
    else if (block.type === 'tool_use' && typeof block.name === 'string')
      toolCalls.push({ name: block.name, input: block.input });
  }
  const usage = (isObject(body.usage) ? body.usage : {}) as AnthropicUsage;
  const details = isObject(body.stop_details) ? body.stop_details : undefined;
  const stopDetails: StopDetails | undefined =
    details && typeof details.type === 'string'
      ? {
          type: details.type,
          ...(typeof details.category === 'string' || details.category === null
            ? { category: details.category }
            : {}),
          ...(typeof details.explanation === 'string' || details.explanation === null
            ? { explanation: details.explanation }
            : {}),
        }
      : undefined;
  return {
    text: out,
    reasoning,
    toolCalls,
    finishReason: anthropicFinish(body.stop_reason),
    usage: mapAnthropicUsage(usage, usage.output_tokens ?? 0),
    usageAvailable:
      typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number',
    ...(stopDetails ? { stopDetails } : {}),
    ...(details ? { providerMetadata: { anthropic: { stop_details: details } } } : {}),
  };
}

// --- OpenAI Responses ---

function parseResponse(body: Json): ParsedReply {
  let out = '';
  let reasoning = '';
  let refusal = '';
  let phase: string | undefined;
  const toolCalls: ParsedToolCall[] = [];
  for (const item of list(body.output)) {
    if (!isObject(item)) continue;
    if (item.type === 'message') {
      for (const part of list(item.content)) {
        if (!isObject(part)) continue;
        if (part.type === 'output_text') out += text(part.text);
        else if (part.type === 'refusal') refusal += text(part.refusal);
      }
      if (typeof item.phase === 'string') phase = item.phase;
    } else if (item.type === 'reasoning') {
      for (const part of [...list(item.summary), ...list(item.content)])
        if (isObject(part)) reasoning += text(part.text);
    } else if (item.type === 'function_call' && typeof item.name === 'string') {
      toolCalls.push({ name: item.name, input: item.arguments });
    }
  }
  const usage = isObject(body.usage) ? (body.usage as ResponsesUsage) : undefined;
  const reason = isObject(body.incomplete_details) ? body.incomplete_details.reason : undefined;
  const finishReason = mapResponsesFinishReason(reason, toolCalls.length > 0, refusal !== '');
  const openai: Json = {
    ...(phase ? { phase } : {}),
    ...(refusal ? { refusal } : {}),
  };
  const stopDetails = stopDetailsFrom({ openai });
  const failure = isObject(body.error) ? body.error : undefined;
  return {
    text: out,
    reasoning,
    toolCalls,
    finishReason,
    usage: mapResponsesUsage(usage),
    usageAvailable:
      typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number',
    ...(stopDetails ? { stopDetails } : {}),
    ...(Object.keys(openai).length > 0 ? { providerMetadata: { openai } } : {}),
    ...(failure
      ? {
          error: {
            ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
            message: text(failure.message) || 'The response failed.',
          },
        }
      : {}),
  };
}

// --- OpenAI Chat Completions ---

function parseCompletion(body: Json): ParsedReply {
  const choice = list(body.choices).find(isObject);
  const message = choice && isObject(choice.message) ? choice.message : {};
  const toolCalls: ParsedToolCall[] = [];
  for (const call of list(message.tool_calls)) {
    if (isObject(call) && isObject(call.function) && typeof call.function.name === 'string')
      toolCalls.push({ name: call.function.name, input: call.function.arguments });
  }
  const usage = isObject(body.usage) ? body.usage : undefined;
  const refusal = text(message.refusal);
  const providerMetadata = refusal ? { openai: { refusal } } : undefined;
  const stopDetails = stopDetailsFrom(providerMetadata);
  return {
    text: text(message.content),
    reasoning: text(message.reasoning_content),
    toolCalls,
    finishReason: mapChatFinishReason(choice?.finish_reason, refusal !== ''),
    usage: mapOpenAIUsage(usage as Parameters<typeof mapOpenAIUsage>[0]),
    usageAvailable:
      typeof usage?.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number',
    ...(stopDetails ? { stopDetails } : {}),
    ...(providerMetadata ? { providerMetadata } : {}),
  };
}

// --- Gemini generateContent ---

function parseGenerateContent(body: Json): ParsedReply {
  const candidate = list(body.candidates).find(isObject);
  const content = candidate && isObject(candidate.content) ? candidate.content : {};
  let out = '';
  let reasoning = '';
  const toolCalls: ParsedToolCall[] = [];
  for (const part of list(content.parts)) {
    if (!isObject(part)) continue;
    if (isObject(part.functionCall) && typeof part.functionCall.name === 'string')
      toolCalls.push({ name: part.functionCall.name, input: part.functionCall.args ?? {} });
    else if (part.thought === true) reasoning += text(part.text);
    else out += text(part.text);
  }
  const blocked =
    isObject(body.promptFeedback) && typeof body.promptFeedback.blockReason === 'string';
  const reason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined;
  // The streaming adapter's own mapping, its STOP-bug guard included.
  const finishReason = mapGeminiFinishReason(reason, toolCalls.length > 0, blocked);
  const usage = isObject(body.usageMetadata) ? body.usageMetadata : undefined;
  return {
    text: out,
    reasoning,
    toolCalls,
    finishReason,
    usage: mapGeminiUsage(usage as Parameters<typeof mapGeminiUsage>[0]),
    usageAvailable:
      typeof usage?.promptTokenCount === 'number' && typeof usage.candidatesTokenCount === 'number',
    // The raw value under the streaming adapter's key (2.3).
    ...(reason ? { providerMetadata: { google: { finishReason: reason } } } : {}),
  };
}
