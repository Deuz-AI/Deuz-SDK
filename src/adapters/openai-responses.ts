import type { Adapter, AdapterRequest, BuildContext, ParseContext } from './types';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Part } from '../types/message';
import type { ToolChoice } from '../types/tool';
import type { NormalizedMessage } from '../core/normalize';
import type { DeuzError } from '../errors';
import { extractSystem } from '../core/normalize';
import { applyProviderOptions } from '../internal/provider-options';
import { resolveImage, toOpenAIImageUrl } from '../internal/image';
import { parseSSE } from '../internal/sse';
import { openaiCompatibleAdapter } from './openai-compatible';

// --- request building ---

type InputItem = Record<string, unknown>;

function toResponsesInput(messages: NormalizedMessage[]): InputItem[] {
  const items: InputItem[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === 'reasoning' && part.encrypted) {
        // Encrypted reasoning round-trip: replay the item verbatim BEFORE its
        // function_call (signature carries the original item id).
        items.push({
          type: 'reasoning',
          ...(part.signature ? { id: part.signature } : {}),
          encrypted_content: part.text,
          summary: [],
        });
      } else if (part.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
        });
      } else if (part.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: part.toolUseId,
          output: typeof part.result === 'string' ? part.result : JSON.stringify(part.result),
        });
      }
    }
    const text = m.content
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const images = m.content.filter(
      (p): p is Extract<Part, { type: 'image' }> => p.type === 'image',
    );

    // `phase` (commentary | final_answer) must be preserved on replayed
    // assistant messages — dropping it degrades gpt-5.3-codex+ performance.
    const phase = (m.providerMetadata?.openai as { phase?: string } | undefined)?.phase;
    if (images.length > 0) {
      const content: InputItem[] = [];
      if (text) content.push({ type: 'input_text', text });
      for (const img of images) {
        content.push({ type: 'input_image', image_url: toOpenAIImageUrl(resolveImage(img)) });
      }
      items.push({
        role: m.role === 'tool' ? 'user' : m.role,
        content,
        ...(phase ? { phase } : {}),
      });
    } else if (text) {
      items.push({
        role: m.role === 'tool' ? 'user' : m.role,
        content: text,
        ...(phase ? { phase } : {}),
      });
    }
  }
  return items;
}

/** Map canonical tool choice → Responses API (flat function form). */
function mapResponsesToolChoice(choice: ToolChoice | undefined): string | object | undefined {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', name: choice.toolName };
  }
  return undefined;
}

function buildRequest(ctx: BuildContext): AdapterRequest {
  const { call, messages, caps, options, object, tools } = ctx;
  const { system, rest } = extractSystem(messages);

  const body: Record<string, unknown> = {
    model: call.modelId,
    input: toResponsesInput(rest),
    stream: true,
    max_output_tokens: options.maxOutputTokens ?? caps.maxOutput,
  };
  if (system) body.instructions = system;
  if (caps.reasoning && options.effort !== undefined) {
    // 'none' is a real OpenAI value (disables reasoning); 'max' clamps to xhigh.
    body.reasoning = { effort: options.effort === 'max' ? 'xhigh' : options.effort };
  }
  if (tools && caps.reasoning) {
    // Stateless multi-step tool use: get encrypted reasoning back and replay it.
    body.include = ['reasoning.encrypted_content'];
    body.store = false;
  }
  if (!caps.samplingRestrictions) {
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
  }

  if (object) {
    if (object.strategy === 'json') {
      body.text = {
        format: {
          type: 'json_schema',
          name: object.name ?? 'output',
          strict: true,
          schema: object.schema,
        },
      };
    } else {
      const name = object.name ?? 'json_output';
      body.tools = [
        {
          type: 'function',
          name,
          description: object.description ?? 'Return the structured result.',
          parameters: object.schema,
        },
      ];
      body.tool_choice = { type: 'function', name };
    }
  } else if (tools && tools.tools.length > 0) {
    body.tools = tools.tools.map((t) =>
      t.provider
        ? t.provider // hosted tool (web_search, …) — raw native definition, verbatim
        : {
            type: 'function',
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.parameters,
          },
    );
    const tc = mapResponsesToolChoice(tools.toolChoice);
    if (tc !== undefined) body.tool_choice = tc;
  } else if (options.responseFormat === 'json') {
    body.text = { format: { type: 'json_object' } };
  }

  applyProviderOptions(body, call.provider, options);

  return {
    url: `${call.baseURL}/responses`,
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

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    encrypted_content?: string;
    phase?: string;
  };
  annotation?: { type?: string; url?: string; title?: string };
  response?: {
    usage?: ResponsesUsage;
    status?: string;
    incomplete_details?: { reason?: string };
  };
  error?: { message?: string; code?: string };
}

function mapResponsesUsage(u: ResponsesUsage | undefined): Usage {
  const input = u?.input_tokens ?? 0;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    cachedReadTokens: cached,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: u?.total_tokens ?? input + output,
  };
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  ctx: ParseContext,
): AsyncGenerator<StreamPart> {
  const toolByItem = new Map<string, string>(); // item_id → call_id
  let sawFunctionCall = false;
  let usage: Usage | undefined;
  let finishReason: FinishReason = 'stop';
  let phase: string | undefined; // last assistant message item's phase — round-trips on replay

  for await (const ev of parseSSE(body)) {
    let data: ResponsesEvent;
    try {
      data = JSON.parse(ev.data) as ResponsesEvent;
    } catch {
      continue;
    }
    const type = data.type ?? ev.event;

    switch (type) {
      case 'response.output_text.delta':
        if (data.delta) yield { type: 'text-delta', text: data.delta };
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (data.delta) yield { type: 'reasoning-delta', text: data.delta };
        break;
      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          sawFunctionCall = true;
          const callId = data.item.call_id ?? data.item.id ?? '';
          if (data.item.id) toolByItem.set(data.item.id, callId);
          yield { type: 'tool-call-delta', id: callId, name: data.item.name, argsTextDelta: '' };
        }
        break;
      case 'response.output_item.done':
        // Encrypted reasoning payload (include: reasoning.encrypted_content) —
        // an opaque blob keyed by the item id, replayed verbatim next turn.
        if (data.item?.type === 'reasoning' && data.item.encrypted_content) {
          yield {
            type: 'reasoning-delta',
            text: data.item.encrypted_content,
            signature: data.item.id,
            encrypted: true,
          };
        }
        if (data.item?.type === 'message' && data.item.phase) phase = data.item.phase;
        break;
      case 'response.function_call_arguments.delta': {
        const id = (data.item_id && toolByItem.get(data.item_id)) ?? data.item_id ?? '';
        yield { type: 'tool-call-delta', id, argsTextDelta: data.delta ?? '' };
        break;
      }
      case 'response.output_text.annotation.added':
        // Hosted web_search citations arrive as url_citation annotations.
        if (data.annotation?.type === 'url_citation' && data.annotation.url) {
          yield {
            type: 'source',
            id: ctx.generateId(),
            url: data.annotation.url,
            ...(data.annotation.title ? { title: data.annotation.title } : {}),
          };
        }
        break;
      case 'response.completed':
      case 'response.incomplete':
        usage = mapResponsesUsage(data.response?.usage);
        if (data.response?.incomplete_details?.reason === 'max_output_tokens')
          finishReason = 'length';
        else if (sawFunctionCall) finishReason = 'tool_calls';
        else finishReason = 'stop';
        break;
      case 'error':
      case 'response.failed':
        yield { type: 'error', error: mapError(200, { error: data.error }, new Headers()) };
        return;
      default:
        break;
    }
  }

  yield {
    type: 'finish',
    usage: usage ?? mapResponsesUsage(undefined),
    finishReason,
    ...(phase ? { providerMetadata: { openai: { phase } } } : {}),
  };
}

// Error envelope is identical to Chat Completions — reuse its mapping.
const mapError: Adapter['mapError'] = (status, body, headers): DeuzError =>
  openaiCompatibleAdapter.mapError(status, body, headers);

export const openaiResponsesAdapter: Adapter = { buildRequest, parseStream, mapError };
