import type { Adapter, AdapterRequest, BuildContext, ParseContext } from './types';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Part } from '../types/message';
import type { ToolChoice } from '../types/tool';
import type { NormalizedMessage } from '../core/normalize';
import type { DeuzError } from '../errors';
import { extractSystem } from '../core/normalize';
import {
  assertToolSurface,
  describeToolChoice,
  effortWire,
  isForcedToolChoice,
  optionalOutputCap,
  planEffort,
  reportClamp,
} from '../core/request-rules';
import { applyProviderOptions } from '../internal/provider-options';
import { replaysTo } from '../internal/reasoning';
import {
  acceptsDocuments,
  documentFilename,
  resolveMedia,
  toDataUrl,
  toOpenAIImageUrl,
  warnDroppedDocument,
} from '../internal/image';
import { parseSSE } from '../internal/sse';
import { openaiCompatibleAdapter } from './openai-compatible';

// --- request building ---

type InputItem = Record<string, unknown>;

/** What the input mapper needs to decide whether a document can ride this wire. */
interface MediaContext {
  caps: BuildContext['caps'];
  provider: string;
  modelId: string;
  logger: BuildContext['logger'];
  /** Per-call warning sink (1.9): a dropped document is reported, not just logged. */
  warnings: BuildContext['warnings'];
}

function toResponsesInput(messages: NormalizedMessage[], media: MediaContext): InputItem[] {
  const items: InputItem[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === 'reasoning' && part.encrypted && replaysTo(part, 'openai')) {
        // Encrypted reasoning round-trip: replay the item verbatim BEFORE its
        // function_call (signature carries the original item id). Only
        // OpenAI's own items (2.3, F21); summaries are display text only.
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
    // `ImagePart` is the carrier for documents too (the Part union is locked
    // until 2.0) — classify each one instead of assuming an image.
    const mediaParts = m.content.filter(
      (p): p is Extract<Part, { type: 'image' }> => p.type === 'image',
    );

    // `phase` (commentary | final_answer) must be preserved on replayed
    // assistant messages — dropping it degrades gpt-5.3-codex+ performance.
    const phase = (m.providerMetadata?.openai as { phase?: string } | undefined)?.phase;
    const mediaBlocks: InputItem[] = [];
    for (const part of mediaParts) {
      const resolved = resolveMedia(part);
      if (resolved.isImage) {
        mediaBlocks.push({ type: 'input_image', image_url: toOpenAIImageUrl(resolved) });
        continue;
      }
      if (!acceptsDocuments(media.caps)) {
        warnDroppedDocument(
          media.logger,
          {
            provider: media.provider,
            modelId: media.modelId,
            mediaType: resolved.mediaType,
            reason: 'this model has no document/vision capability in the registry',
          },
          media.warnings,
        );
        continue;
      }
      // Responses takes a document as `input_file`: either a hosted `file_url`
      // or an inline `file_data` data: URL + filename.
      mediaBlocks.push(
        resolved.kind === 'url'
          ? { type: 'input_file', file_url: resolved.data }
          : {
              type: 'input_file',
              filename: documentFilename(resolved.mediaType),
              file_data: toDataUrl(resolved),
            },
      );
    }

    if (mediaBlocks.length > 0) {
      const content: InputItem[] = [];
      if (text) content.push({ type: 'input_text', text });
      content.push(...mediaBlocks);
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

/**
 * Map canonical tool choice → Responses API (flat function form). A forced
 * choice the row says the model rejects goes out as auto, reported (2.3).
 */
function mapResponsesToolChoice(
  ctx: BuildContext,
  choice: ToolChoice | undefined,
): string | object | undefined {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'none') return 'none';
  if (ctx.caps.forcedToolChoice === false && isForcedToolChoice(choice)) {
    reportClamp(
      ctx,
      'toolChoice',
      `toolChoice ${describeToolChoice(choice)} was sent as 'auto': ${ctx.call.modelId} rejects a forced tool_choice.`,
    );
    return undefined;
  }
  if (choice === 'required') return 'required';
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', name: choice.toolName };
  }
  return undefined;
}

/** The include list: the caller's entries (if any) plus the encrypted reasoning blob. */
function withEncryptedReasoning(include: unknown): string[] {
  const extra = Array.isArray(include)
    ? include.filter((v): v is string => typeof v === 'string')
    : [];
  return [...new Set(['reasoning.encrypted_content', ...extra])];
}

function buildRequest(ctx: BuildContext): AdapterRequest {
  const { call, messages, caps, options, object, tools } = ctx;
  // The leading system run is `instructions`; a system message later in the
  // history stays in place as a `system` input item (2.3, F22), which
  // `EasyInputMessage` types next to `developer`. 2.2 folded it into
  // `instructions`.
  const { system, rest } = extractSystem(messages, { inPlace: true });
  assertToolSurface(ctx, 'responses');

  // An unknown model's placeholder cap is left off (2.3): the provider's own
  // default bounds it instead of the SDK's 4096 guess.
  const maxOutput = optionalOutputCap(caps, options);
  const body: Record<string, unknown> = {
    model: call.modelId,
    input: toResponsesInput(rest, {
      caps,
      provider: call.provider,
      modelId: call.modelId,
      logger: ctx.logger,
      warnings: ctx.warnings,
    }),
    stream: true,
    ...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
  };
  if (system) body.instructions = system;
  // 'none' is a real OpenAI value (disables reasoning). 'max' is sent only to a
  // model that lists it (gpt-6.1-sol); elsewhere it clamps to xhigh — reported.
  const effort = planEffort(ctx, effortWire('responses', caps, call.modelId));
  if (effort.none) body.reasoning = { effort: 'none' };
  else if (effort.level !== undefined) body.reasoning = { effort: effort.level };
  // F20 (2.3): every Responses request is stateless unless the caller opts in
  // with `providerOptions.<provider>.store: true`. A reasoning model always
  // gets its encrypted reasoning back so the next turn can replay it — with or
  // without tools — which also keeps zero-data-retention organisations working.
  // OpenAI's retention behaviour itself is not live-verified.
  const own = options.providerOptions?.[call.provider];
  body.store = own?.store === true;
  if (caps.reasoning) body.include = withEncryptedReasoning(own?.include);
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
  }
  // A json-strategy object request keeps the call's tools and their tool_choice
  // beside `text.format` (2.3, F15): runAgent's finalization asks with the
  // loop's tools and `toolChoice: 'none'`, so its request prefix stays the
  // loop's. The tool strategy forces its own call instead. Not live-verified.
  if (object?.strategy !== 'tool' && tools && tools.tools.length > 0) {
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
    const tc = mapResponsesToolChoice(ctx, tools.toolChoice);
    if (tc !== undefined) body.tool_choice = tc;
  } else if (!object && options.responseFormat === 'json') {
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

export interface ResponsesUsage {
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
  content_index?: number;
  /** `response.refusal.done`: the refusal text, final. */
  refusal?: string;
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

// output_tokens already includes reasoning_tokens and input_tokens includes the
// cached reads (OpenAI token counting), which is the canonical contract once the
// cached share is split out. A Responses-shaped host that counts reasoning beside
// the output (its total is input + output + reasoning, or the reasoning exceeds
// the output) has it folded in; not live-verified. No cache-write counter exists.
export function mapResponsesUsage(u: ResponsesUsage | undefined): Usage {
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

/**
 * A Responses turn's finish reason, shared with the batch parser. The final
 * response says why it is incomplete: its output limit, or its content filter
 * (2.3; 'stop', or 'tool_calls' after a call, before), which the finish-reason
 * gate must see to hold back a call the turn streamed. A turn that carried the
 * model's refusal is refused the same way (2.3). `max_messages` and `steered`
 * (openai 7.32) end it as a complete response would: their meaning is
 * undocumented beyond the name, and steering needs the WebSocket transport.
 */
export function mapResponsesFinishReason(
  incompleteReason: unknown,
  sawFunctionCall: boolean,
  refused = false,
): FinishReason {
  if (incompleteReason === 'max_output_tokens') return 'length';
  if (incompleteReason === 'content_filter' || refused) return 'content_filter';
  return sawFunctionCall ? 'tool_calls' : 'stop';
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
  // The model's refusal (2.3), per content part as the official accumulator
  // builds it: deltas append, `response.refusal.done` sets the final text.
  // Kept for the caller, never streamed as answer text.
  const refusals = new Map<string, string>();
  const refusalText = (): string => [...refusals.values()].join('');

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
        // One block per reasoning item (2.3, F21), marked as OpenAI's own.
        if (data.delta) {
          yield {
            type: 'reasoning-delta',
            text: data.delta,
            ...(data.item_id ? { id: data.item_id } : {}),
            source: 'openai',
          };
        }
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
            ...(data.item.id ? { id: data.item.id } : {}),
            source: 'openai',
          };
        }
        if (data.item?.type === 'message' && data.item.phase) phase = data.item.phase;
        break;
      case 'response.function_call_arguments.delta': {
        const id = (data.item_id && toolByItem.get(data.item_id)) ?? data.item_id ?? '';
        yield { type: 'tool-call-delta', id, argsTextDelta: data.delta ?? '' };
        break;
      }
      case 'response.refusal.delta': {
        const key = refusalKey(data);
        refusals.set(key, (refusals.get(key) ?? '') + (data.delta ?? ''));
        break;
      }
      case 'response.refusal.done':
        if (typeof data.refusal === 'string') refusals.set(refusalKey(data), data.refusal);
        break;
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
        ctx.usageAvailable?.(
          typeof data.response?.usage?.input_tokens === 'number' &&
            typeof data.response.usage.output_tokens === 'number',
        );
        usage = mapResponsesUsage(data.response?.usage);
        finishReason = mapResponsesFinishReason(
          data.response?.incomplete_details?.reason,
          sawFunctionCall,
          refusalText() !== '',
        );
        break;
      case 'error':
      case 'response.failed':
        yield {
          type: 'error',
          error: mapError(200, { error: data.error }, new Headers(), { provider: ctx.provider }),
        };
        return;
      default:
        break;
    }
  }

  // The refusal rides the batch parser's key: `stopDetailsFrom` reads it as the stop's explanation.
  const refusal = refusalText();
  const openai = { ...(phase ? { phase } : {}), ...(refusal ? { refusal } : {}) };
  yield {
    type: 'finish',
    usage: usage ?? mapResponsesUsage(undefined),
    finishReason,
    ...(Object.keys(openai).length > 0 ? { providerMetadata: { openai } } : {}),
  };
}

/** One refusal content part: its message item and its index in that item. */
function refusalKey(data: ResponsesEvent): string {
  return `${data.item_id ?? ''}:${data.content_index ?? 0}`;
}

// Error envelope is identical to Chat Completions — reuse its mapping.
const mapError: Adapter['mapError'] = (status, body, headers, ctx): DeuzError =>
  openaiCompatibleAdapter.mapError(status, body, headers, ctx);

export const openaiResponsesAdapter: Adapter = { buildRequest, parseStream, mapError };
