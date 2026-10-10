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
 * The Anthropic and Responses usage mappings repeat their adapters' private
 * ones; `test/batch-parse.test.ts` holds them to the adapters' results.
 */
import { mapGeminiUsage } from '../adapters/google-native';
import { mapOpenAIUsage } from '../adapters/openai-compatible';
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

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
  server_tool_use?: { web_search_requests?: number; code_execution_requests?: number };
  iterations?: AnthropicUsage[];
}

/** As `buildUsage` in adapters/anthropic.ts: iterations are summed, thinking is a share of output. */
function anthropicUsage(input: AnthropicUsage, outputTokens: number): Usage {
  if (input.iterations && input.iterations.length > 0) {
    return input.iterations
      .map((it) => anthropicUsage({ ...it, iterations: undefined }, it.output_tokens ?? 0))
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
  const serverTools =
    (input.server_tool_use?.web_search_requests ?? 0) +
    (input.server_tool_use?.code_execution_requests ?? 0);
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: input.output_tokens_details?.thinking_tokens ?? 0,
    cachedReadTokens: cacheRead,
    cacheWriteTokens: Math.max(0, cacheWriteTotal - cacheWrite1h),
    cacheWrite1hTokens: cacheWrite1h,
    ...(serverTools > 0 ? { serverToolUses: serverTools } : {}),
    totalTokens: inputTokens + cacheRead + cacheWriteTotal + outputTokens,
  };
}

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
    usage: anthropicUsage(usage, usage.output_tokens ?? 0),
    usageAvailable:
      typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number',
    ...(stopDetails ? { stopDetails } : {}),
    ...(details ? { providerMetadata: { anthropic: { stop_details: details } } } : {}),
  };
}

// --- OpenAI Responses ---

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/** As `mapResponsesUsage` in adapters/openai-responses.ts. */
function responsesUsage(u: ResponsesUsage | undefined): Usage {
  const input = u?.input_tokens ?? 0;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const reported = u?.output_tokens ?? 0;
  const reasoning = u?.output_tokens_details?.reasoning_tokens ?? 0;
  const reasoningApart =
    reasoning > 0 && (reasoning > reported || u?.total_tokens === input + reported + reasoning);
  const output = reasoningApart ? reported + reasoning : reported;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedReadTokens: cached,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: u?.total_tokens ?? input + output,
  };
}

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
  // The streaming adapter knows max_output_tokens only; the final body also
  // says when a content filter cut the reply off.
  const finishReason: FinishReason =
    reason === 'max_output_tokens'
      ? 'length'
      : reason === 'content_filter'
        ? 'content_filter'
        : toolCalls.length > 0
          ? 'tool_calls'
          : 'stop';
  const openai: Json = {
    ...(phase ? { phase } : {}),
    ...(refusal ? { refusal } : {}),
  };
  const failure = isObject(body.error) ? body.error : undefined;
  return {
    text: out,
    reasoning,
    toolCalls,
    finishReason,
    usage: responsesUsage(usage),
    usageAvailable:
      typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number',
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

function chatFinish(reason: unknown): FinishReason {
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
  return {
    text: text(message.content),
    reasoning: text(message.reasoning_content),
    toolCalls,
    finishReason: chatFinish(choice?.finish_reason),
    usage: mapOpenAIUsage(usage as Parameters<typeof mapOpenAIUsage>[0]),
    usageAvailable:
      typeof usage?.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number',
    ...(refusal ? { providerMetadata: { openai: { refusal } } } : {}),
  };
}

// --- Gemini generateContent ---

const GEMINI_FILTERED = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
]);

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
  const reason = candidate?.finishReason;
  // The streaming adapter's STOP-bug guard: a function call finishes as 'STOP'.
  const finishReason: FinishReason = blocked
    ? 'content_filter'
    : toolCalls.length > 0
      ? 'tool_calls'
      : reason === 'MAX_TOKENS'
        ? 'length'
        : typeof reason === 'string' && GEMINI_FILTERED.has(reason)
          ? 'content_filter'
          : 'stop';
  const usage = isObject(body.usageMetadata) ? body.usageMetadata : undefined;
  return {
    text: out,
    reasoning,
    toolCalls,
    finishReason,
    usage: mapGeminiUsage(usage as Parameters<typeof mapGeminiUsage>[0]),
    usageAvailable:
      typeof usage?.promptTokenCount === 'number' && typeof usage.candidatesTokenCount === 'number',
  };
}
