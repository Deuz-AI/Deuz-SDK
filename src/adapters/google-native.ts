import type { Adapter, AdapterRequest, BuildContext, ParseContext } from './types';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Part } from '../types/message';
import type { NormalizedMessage } from '../core/normalize';
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
import { resolveImage } from '../internal/image';
import { parseSSE } from '../internal/sse';
import { parseRetryAfterMs } from '../internal/http';
import { toGeminiSchema } from '../schema/gemini';

// ===================================================================
// Wire types (REST v1beta — camelCase, NOT the snake_case proto).
// ===================================================================

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
}

// --- request building ---

/** gemini-3* uses thinkingLevel; gemini-2.5* uses thinkingBudget (never both → 400). */
function usesThinkingLevel(modelId: string): boolean {
  return /^gemini-3/.test(modelId);
}

/** gemini-3* accepts the fuller responseJsonSchema; 2.5 uses the restricted responseSchema. */
function usesJsonSchema(modelId: string): boolean {
  return /^gemini-3/.test(modelId);
}

const BUDGET_MAP: Record<string, number> = {
  low: 4096,
  medium: 12288,
  high: 24576,
  xhigh: 32768,
  max: 32768,
};

/** Pro-tier Gemini 3 models accept only low/high thinking levels. */
function levelOnlyLowHigh(modelId: string): boolean {
  return /^gemini-3(\.\d+)?-pro/.test(modelId);
}

function thinkingLevelFor(modelId: string, effort: string): string {
  const full: Record<string, string> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
  const level = full[effort] ?? 'low';
  if (levelOnlyLowHigh(modelId)) return level === 'high' ? 'high' : 'low';
  return level;
}

function partToGemini(part: Part, toolNameById: Map<string, string>): GeminiPart | null {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image': {
      const img = resolveImage(part);
      if (img.kind === 'url') return { fileData: { mimeType: img.mediaType, fileUri: img.url! } };
      return { inlineData: { mimeType: img.mediaType, data: img.data } };
    }
    case 'tool_use': {
      const sig =
        (part.providerMetadata?.google as { thoughtSignature?: string } | undefined)
          ?.thoughtSignature ?? (part.providerMetadata?.thoughtSignature as string | undefined);
      const gp: GeminiPart = { functionCall: { name: part.name, args: part.input } };
      if (sig) gp.thoughtSignature = sig;
      return gp;
    }
    case 'tool_result': {
      const name = toolNameById.get(part.toolUseId) ?? part.toolUseId;
      const response =
        typeof part.result === 'string' ? { result: part.result } : (part.result as object);
      return { functionResponse: { name, response } };
    }
    case 'reasoning': {
      // Echo thought summary; carry the signature so multi-step tool use round-trips.
      const gp: GeminiPart = { text: part.text, thought: true };
      if (part.signature) gp.thoughtSignature = part.signature;
      return gp;
    }
    default:
      return null;
  }
}

function toGeminiContents(messages: NormalizedMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
} {
  const sys = extractSystem(messages);

  // First pass: map tool_use id → function name so tool_result can reference it.
  const toolNameById = new Map<string, string>();
  for (const m of sys.rest) {
    for (const p of m.content) {
      if (p.type === 'tool_use') toolNameById.set(p.id, p.name);
    }
  }

  const contents: GeminiContent[] = [];
  for (const m of sys.rest) {
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts = m.content
      .map((p) => partToGemini(p, toolNameById))
      .filter((p): p is GeminiPart => p !== null);
    if (parts.length) contents.push({ role, parts });
  }

  return {
    ...(sys.system ? { systemInstruction: { parts: [{ text: sys.system }] } } : {}),
    contents,
  };
}

function mapToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice || choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.toolName] } };
  }
  return { functionCallingConfig: { mode: 'AUTO' } };
}

function buildRequest(ctx: BuildContext): AdapterRequest {
  const { call, messages, caps, options, object, tools } = ctx;
  const { systemInstruction, contents } = toGeminiContents(messages);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: options.maxOutputTokens ?? caps.maxOutput,
  };
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.topP !== undefined) generationConfig.topP = options.topP;
  if (options.stopSequences) generationConfig.stopSequences = options.stopSequences;

  // Thinking (gate strictly by model family — never send both level AND budget).
  if (caps.reasoning && options.effort && options.effort !== 'none') {
    if (usesThinkingLevel(call.modelId)) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: thinkingLevelFor(call.modelId, options.effort),
      };
    } else {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: BUDGET_MAP[options.effort] ?? 12288,
      };
    }
  }

  // Structured output (json strategy → responseSchema / responseJsonSchema).
  if (object) {
    generationConfig.responseMimeType = 'application/json';
    if (usesJsonSchema(call.modelId)) {
      generationConfig.responseJsonSchema = toGeminiSchema(object.schema, { jsonSchemaMode: true });
    } else {
      generationConfig.responseSchema = toGeminiSchema(object.schema);
    }
  } else if (options.responseFormat === 'json') {
    generationConfig.responseMimeType = 'application/json';
  }

  const body: Record<string, unknown> = { contents, generationConfig };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  if (tools && !object) {
    body.tools = [
      {
        functionDeclarations: tools.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: toGeminiSchema(t.parameters),
        })),
      },
    ];
    body.toolConfig = mapToolChoice(tools.toolChoice);
  }

  // Opaque explicit-cache passthrough (the cacheStore seam creates it elsewhere).
  const cached = (options as { cachedContent?: string }).cachedContent;
  if (cached) body.cachedContent = cached;

  // Two transports share the SAME body + SSE parser; only URL + auth differ:
  //  - AI Studio: {baseURL}/v1beta/models/{model}:streamGenerateContent, x-goog-api-key
  //  - Vertex AI: {baseURL}/v1/projects/{p}/locations/{l}/publishers/google/models/{model}
  //               :streamGenerateContent, Authorization: Bearer <OAuth2 token>
  const vertex = call.vertex;
  const url = vertex
    ? `${call.baseURL}/v1/projects/${vertex.project}/locations/${vertex.location}` +
      `/publishers/google/models/${call.modelId}:streamGenerateContent?alt=sse`
    : `${call.baseURL}/v1beta/models/${call.modelId}:streamGenerateContent?alt=sse`;

  const headers: Record<string, string> = vertex
    ? {
        'content-type': 'application/json',
        authorization: `Bearer ${call.apiKey}`,
        ...call.headers,
      }
    : { 'content-type': 'application/json', 'x-goog-api-key': call.apiKey, ...call.headers };

  return {
    // streamGenerateContent + alt=sse is MANDATORY for an SSE stream.
    url,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  };
}

// --- stream parsing ---

export function mapGeminiUsage(u: GeminiUsageMetadata | undefined): Usage {
  const prompt = u?.promptTokenCount ?? 0;
  const cached = u?.cachedContentTokenCount ?? 0;
  const audio = (u?.promptTokensDetails ?? [])
    .concat(u?.candidatesTokensDetails ?? [])
    .filter((d) => d.modality === 'AUDIO')
    .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
  const usage: Usage = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u?.candidatesTokenCount ?? 0,
    reasoningTokens: u?.thoughtsTokenCount ?? 0,
    cachedReadTokens: cached,
    cacheWriteTokens: 0, // Gemini has no per-request cache-write counter
    cacheWrite1hTokens: 0,
    totalTokens: u?.totalTokenCount ?? prompt + (u?.candidatesTokenCount ?? 0),
  };
  if (audio > 0) usage.audioTokens = audio;
  return usage;
}

function mapFinishReason(reason: string | undefined, sawFunctionCall: boolean): FinishReason {
  // STOP-BUG guard: a tool turn finishes as 'STOP' — override when a call was seen.
  if (sawFunctionCall) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    case 'STOP':
      return 'stop';
    default:
      return 'stop'; // enum evolves — handle defensively
  }
}

interface GeminiStreamEvent {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  ctx: ParseContext,
): AsyncGenerator<StreamPart> {
  let lastUsage: GeminiUsageMetadata | undefined;
  let lastFinish: string | undefined;
  let sawFunctionCall = false;
  let blocked: string | undefined;

  for await (const ev of parseSSE(body)) {
    // Gemini SSE has NO '[DONE]' sentinel — loop until the stream ends.
    let event: GeminiStreamEvent;
    try {
      event = JSON.parse(ev.data) as GeminiStreamEvent;
    } catch {
      continue;
    }
    if (event.usageMetadata) lastUsage = event.usageMetadata; // last-wins
    if (event.promptFeedback?.blockReason) blocked = event.promptFeedback.blockReason;

    const candidate = event.candidates?.[0];
    if (!candidate) continue;
    if (candidate.finishReason) lastFinish = candidate.finishReason;

    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall) {
        sawFunctionCall = true;
        yield {
          type: 'tool-call-delta',
          id: ctx.generateId(),
          name: part.functionCall.name,
          // Gemini sends complete args per part — emit one full delta.
          argsTextDelta: JSON.stringify(part.functionCall.args ?? {}),
          ...(part.thoughtSignature
            ? { providerMetadata: { google: { thoughtSignature: part.thoughtSignature } } }
            : {}),
        };
      } else if (part.thought) {
        yield {
          type: 'reasoning-delta',
          text: part.text ?? '',
          ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
        };
      } else if (typeof part.text === 'string') {
        yield { type: 'text-delta', text: part.text };
      }
    }

    // Grounding citations → canonical source parts.
    for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
      if (chunk.web?.uri) {
        yield { type: 'source', id: ctx.generateId(), url: chunk.web.uri, title: chunk.web.title };
      }
    }
  }

  const finishReason = blocked ? 'content_filter' : mapFinishReason(lastFinish, sawFunctionCall);
  yield { type: 'finish', usage: mapGeminiUsage(lastUsage), finishReason };
}

// --- error mapping ---

function mapError(status: number, body: unknown, headers: Headers): DeuzError {
  const envelope = (body ?? {}) as { error?: { message?: string; status?: string } };
  const err = envelope.error;
  const message = err?.message ?? `Provider request failed (HTTP ${status}).`;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = { message, provider: 'google', upstreamType: err?.status, retryAfterMs };

  if (status === 401 || status === 403)
    return new AuthenticationError({ ...base, statusCode: status });
  if (status === 404) return new ModelNotFoundError({ ...base, statusCode: 404 });
  if (status === 429) return new RateLimitError({ ...base, statusCode: 429 });
  if (status === 529) return new OverloadedError({ ...base, statusCode: 529 });
  if (status >= 400 && status < 500)
    return new InvalidRequestError({ ...base, statusCode: status });
  return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
}

export const googleNativeAdapter: Adapter = { buildRequest, parseStream, mapError };
