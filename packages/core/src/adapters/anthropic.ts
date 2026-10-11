import type { Adapter, AdapterRequest, BuildContext, ParseContext, WireTool } from './types';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Part } from '../types/message';
import type { ToolChoice } from '../types/tool';
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
import { extractSystem } from '../core/normalize';
import type { EffortLevel } from '../core/registry';
import {
  anthropicMaxTokens,
  atMostHigh,
  describeToolChoice,
  effortWire,
  planEffort,
  reportClamp,
  reportDrop,
} from '../core/request-rules';
import { applyProviderOptions } from '../internal/provider-options';
import { replaysTo } from '../internal/reasoning';
import {
  bindsThinkingToPrefix,
  toolSetChangeOf,
  type ToolSetChange,
} from '../internal/stable-prefix';
import { acceptsDocuments, resolveMedia, warnDroppedDocument } from '../internal/image';
import { parseSSE } from '../internal/sse';
import { parseRetryAfterMs } from '../internal/http';

const ANTHROPIC_VERSION = '2023-06-01';

// --- request building ---

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

/** What `partToBlock` needs to decide whether a document can ride this wire. */
interface MediaContext {
  caps: BuildContext['caps'];
  provider: string;
  modelId: string;
  logger: BuildContext['logger'];
  /** Per-call warning sink (1.9): a dropped document is reported, not just logged. */
  warnings: BuildContext['warnings'];
}

/**
 * Returns null when the part cannot be carried: a dropped document (warned),
 * or reasoning this wire must not replay (see the `reasoning` case).
 */
function partToBlock(part: Part, media: MediaContext): AnthropicBlock | null {
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
      // Claude's own blocks ride back exactly as they came (2.3, F21), between
      // Claude models too: the API drops the ones the model cannot read.
      // Another provider's reasoning is never a thinking block (an OpenAI
      // encrypted item used to go out as one), and a thinking block without
      // its signature is always rejected.
      if (!replaysTo(part, 'anthropic')) return null;
      if (part.redacted) return { type: 'redacted_thinking', data: part.text };
      if (!part.signature) return null;
      return { type: 'thinking', thinking: part.text, signature: part.signature };
    case 'image': {
      // `ImagePart` carries documents too (the Part union is locked until 2.0)
      // — a PDF must become a `document` block, never an `image` one: /v1/messages
      // 400s on `image` with a non-image media_type.
      const img = resolveMedia(part);
      if (!img.isImage) {
        if (!acceptsDocuments(media.caps)) {
          warnDroppedDocument(
            media.logger,
            {
              provider: media.provider,
              modelId: media.modelId,
              mediaType: img.mediaType,
              reason: 'this model has no document/vision capability in the registry',
            },
            media.warnings,
          );
          return null;
        }
        if (img.kind === 'url') {
          return { type: 'document', source: { type: 'url', url: img.data } };
        }
        return {
          type: 'document',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        };
      }
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

/**
 * Map canonical tool choice → Anthropic. A forced choice the model cannot take
 * (`forcedOk` false: the row says so, or extended thinking is on) falls back
 * to auto — reported as a `clamped-setting`, never silent (2.3).
 */
function mapAnthropicToolChoice(
  ctx: BuildContext,
  choice: ToolChoice | undefined,
  forcedOk: boolean,
  allowParallel: boolean | undefined,
): Record<string, unknown> {
  const dp = allowParallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (!choice || choice === 'auto') return { type: 'auto', ...dp };
  if (!forcedOk) {
    const why =
      ctx.caps.forcedToolChoice === false
        ? 'rejects a forced tool_choice'
        : 'rejects a forced tool_choice while extended thinking is on';
    reportClamp(
      ctx,
      'toolChoice',
      `toolChoice ${describeToolChoice(choice)} was sent as 'auto': ${ctx.call.modelId} ${why}.`,
    );
    return { type: 'auto', ...dp };
  }
  if (choice === 'required') return { type: 'any', ...dp };
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'tool', name: choice.toolName, ...dp };
  }
  return { type: 'auto', ...dp };
}

// --- thinking block binding (2.3, F21 with F22) ---
//
// Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking block's
// signature to the conversation before it (Anthropic API reference, cached
// 2026-10-06). On accounts opened from 2026-08-31 a replayed block whose prefix
// changed fails the request with 400. The loops keep the prefix stable (F22,
// `internal/stable-prefix.ts`); a request that sends thinking back to such a
// model still asks the API to drop a mismatched block instead, as the safety
// net for a history edited elsewhere. Shapes from @anthropic-ai/sdk 0.133.0's
// beta types; not live-verified.

const BLOCK_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Set `thinking.block_binding` on `body`; returns whether the request carries
 * one (and so needs the beta header). The default is `drop_block` when the
 * request replays thinking to a binding model. `providerOptions.<provider>
 * .thinking.block_binding` replaces it: an object is sent as given, `null`
 * sends none. Only `adaptive` and `enabled` thinking can carry a binding, so a
 * request that turned thinking off (`effort: 'none'`) carries none. The
 * caller's other `thinking` fields ride along when the request sets no thinking
 * of its own; when it does, its own wins, as for every provider option.
 */
function applyBlockBinding(
  ctx: BuildContext,
  body: Record<string, unknown>,
  /** The request replays thinking to a model that binds it to the prefix. */
  bindsReplay: boolean,
): boolean {
  const own = ctx.options.providerOptions?.[ctx.call.provider];
  const caller = isRecord(own?.thinking) ? own.thinking : undefined;
  const explicit = caller !== undefined && Object.hasOwn(caller, 'block_binding');
  const binding = explicit
    ? caller.block_binding
    : bindsReplay
      ? { prefix_mismatch_behavior: 'drop_block' }
      : undefined;
  if (binding === undefined) return false;
  const adapter = isRecord(body.thinking) ? body.thinking : undefined;
  if (!isRecord(binding)) {
    // An explicit "no binding": strip the field from the caller's thinking.
    // A key left without a value keeps the raw option off the wire (it is not
    // re-merged, and JSON drops it) when nothing else of it remains.
    if (!adapter && caller) {
      const { block_binding: _none, ...rest } = caller;
      body.thinking = Object.keys(rest).length > 0 ? rest : undefined;
    }
    return false;
  }
  const base = adapter ?? caller ?? {};
  const type = base.type ?? 'adaptive';
  if (type !== 'adaptive' && type !== 'enabled') return false;
  body.thinking = { ...base, type, block_binding: binding };
  return true;
}

// --- tool-set changes (2.3, F22) ---
//
// A request to a model that binds thinking to the prefix carries the same
// `tools` array on every step; a step that offers another set appends a system
// message whose change renders as `tool_removal` / `tool_addition` blocks
// (@anthropic-ai/sdk 0.133.0 BetaRequestToolRemovalBlock /
// BetaRequestToolAdditionBlock, one `role: 'system'` message as the SDK's own
// tool runner sends them). A tool declared in `tools` with the same definition
// is referenced by name; any other addition carries its definition inline.
// Not live-verified.

const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01';
const INLINE_TOOLS_BETA = 'inline-tools-2026-09-15';

/** A wire tool as a `tools` entry. */
function toAnthropicTool(t: WireTool): Record<string, unknown> {
  return t.provider
    ? t.provider // provider-executed tool — raw native definition, verbatim
    : {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.parameters,
      };
}

/** The blocks of a tool-set change: removals first, then additions, each in its order. */
function toolChangeBlocks(change: ToolSetChange, declared: WireTool[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = change.remove.map((name) => ({
    type: 'tool_removal',
    tool: { type: 'tool_reference', name },
  }));
  for (const tool of change.add) {
    const same = declared.find((t) => t.name === tool.name);
    blocks.push({
      type: 'tool_addition',
      tool:
        same && JSON.stringify(same) === JSON.stringify(tool)
          ? { type: 'tool_reference', name: tool.name }
          : { type: 'tool_definition', definition: toAnthropicTool(tool) },
    });
  }
  return blocks;
}

/** `headers` with `beta` added to `anthropic-beta` (a caller's list is kept). */
function withBeta(headers: Record<string, string>, beta: string): Record<string, string> {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'anthropic-beta');
  const listed = key
    ? headers[key]!.split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
  if (listed.includes(beta)) return headers;
  const next = { ...headers };
  if (key) delete next[key];
  next[key ?? 'anthropic-beta'] = [...listed, beta].join(',');
  return next;
}

function buildRequest(ctx: BuildContext): AdapterRequest {
  const { call, messages, caps, options } = ctx;
  // Claude 5.x binds thinking to the transcript prefix (2.3, F22): a system
  // message appended mid-conversation rides in place as a `role: 'system'`
  // message (GA `MessageParam`) instead of rewriting the top-level `system`.
  // Older models keep the 2.2 fold; whether they accept the role is not
  // live-verified.
  const bound = bindsThinkingToPrefix({
    provider: call.provider,
    modelId: call.modelId,
    surface: 'anthropic',
  });
  const { system, rest } = extractSystem(messages, { inPlace: bound });

  const media: MediaContext = {
    caps,
    provider: call.provider,
    modelId: call.modelId,
    logger: ctx.logger,
    warnings: ctx.warnings,
  };
  // The tools the request declares: what a tool-set change may reference.
  const declared = ctx.object?.strategy !== 'tool' ? (ctx.tools?.tools ?? []) : [];
  // Blocks keep the order the model produced them in (2.3, F21): thinking
  // between tool calls stays there, since a moved block is a modified prefix.
  const wireMessages = rest
    .map((m) => {
      const content = m.content
        .map((p) => partToBlock(p, media))
        .filter((b): b is AnthropicBlock => b !== null);
      // A tool-set change rides on a system message (2.3, F22).
      const change = m.role === 'system' ? toolSetChangeOf(m) : undefined;
      if (change) content.push(...toolChangeBlocks(change, declared));
      return { role: m.role === 'tool' ? 'user' : m.role, content };
    })
    // A mid-conversation system message with nothing to say is not sent.
    .filter((m) => m.role !== 'system' || m.content.length > 0);

  // Opus 4.7+/Sonnet 5/Fable 5/Claude 5.x: budget_tokens returns 400 — effort
  // rides output_config. Every value changed on the way is reported (2.3): see
  // core/request-rules.ts.
  const wire = effortWire('anthropic', caps, call.modelId);
  const useOutputConfig = wire.field === 'output_config.effort';
  const effort = planEffort(ctx, wire);
  let budget: number | undefined;
  let outputEffort: EffortLevel | undefined;
  let thinking: Record<string, unknown> | undefined;
  if (effort.thinkingOff) {
    // `effort: 'none'` on a model that can turn thinking off. That is only
    // allowed at effort ≤ high: a documented default within the limit is left
    // alone, any other is pinned to the lowest effort — and reported (F26).
    thinking = { type: effort.thinkingOff };
    if (useOutputConfig && !atMostHigh(caps.effortDefault)) {
      outputEffort = 'low';
      const why =
        caps.effortDefault === undefined
          ? 'documents no default effort'
          : `defaults to effort '${caps.effortDefault}'`;
      reportClamp(
        ctx,
        'effort',
        `effort 'none' was sent as thinking.type '${effort.thinkingOff}' with output_config.effort ` +
          `'low': ${call.modelId} turns thinking off only at effort high or below, and ${why}.`,
      );
    }
  } else if (effort.level !== undefined) {
    if (useOutputConfig) {
      outputEffort = effort.level;
    } else {
      budget = effort.budget;
      thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  // Adaptive thinking runs whenever an effort level rides output_config.
  const thinkingOn = budget !== undefined || (useOutputConfig && effort.level !== undefined);

  // `max_tokens` is REQUIRED on this wire, so an unknown model's placeholder is
  // still sent; the registry's `unknown-model` warning names that default and
  // the two ways to raise it (2.3).
  const requested = options.maxOutputTokens;
  const maxTokens = anthropicMaxTokens(caps, requested, budget);
  if (requested !== undefined && maxTokens !== requested) {
    reportClamp(
      ctx,
      'maxOutputTokens',
      `maxOutputTokens ${requested} was raised to ${maxTokens}: thinking.budget_tokens ` +
        `${budget} needs room for the answer (${call.modelId}).`,
    );
  }

  const body: Record<string, unknown> = {
    model: call.modelId,
    max_tokens: maxTokens,
    messages: wireMessages,
    stream: true,
  };
  if (system) body.system = system;
  if (thinking) body.thinking = thinking;
  if (budget !== undefined) {
    // Anthropic requires temperature unset (=1) when thinking is enabled. A
    // restricted row already reported the drop (core/inference.ts).
    if (!caps.samplingRestrictions) {
      const why = `extended thinking (thinking.budget_tokens) on ${call.modelId} runs at the default`;
      if (options.temperature !== undefined) {
        reportClamp(ctx, 'temperature', `temperature was dropped from the request: ${why}.`);
      }
      if (options.topP !== undefined) {
        reportClamp(ctx, 'topP', `topP was dropped from the request: ${why}.`);
      }
    }
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
  } else if (options.promptCaching) {
    reportDrop(
      ctx,
      'promptCaching',
      `promptCaching was dropped from the request: ${call.modelId} has no prompt-caching ` +
        'capability in the registry (pass capabilities: { caching: true } if it does).',
    );
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
  }
  // A json-strategy object request keeps the call's tools and their tool_choice
  // beside `output_config.format` (2.3, F15): runAgent's finalization asks with
  // the loop's tools and `toolChoice: 'none'`, so its request prefix (prompt
  // cache, preserved thinking) stays the loop's. The tool strategy forces its
  // own call instead. Not live-verified.
  if (ctx.object?.strategy !== 'tool' && ctx.tools && ctx.tools.tools.length > 0) {
    body.tools = ctx.tools.tools.map(toAnthropicTool);
    body.tool_choice = mapAnthropicToolChoice(
      ctx,
      ctx.tools.toolChoice,
      // The row's word wins; otherwise the historical rule: no forcing while thinking.
      caps.forcedToolChoice ?? !thinkingOn,
      ctx.tools.allowParallel,
    );
  }

  // Effort rides output_config on adaptive-thinking models; merge with the
  // json-strategy `output_config.format` set above when both are present.
  if (outputEffort !== undefined) {
    body.output_config = {
      ...(body.output_config as Record<string, unknown> | undefined),
      effort: outputEffort,
    };
  }

  const replaysThinking = wireMessages.some(
    (m) =>
      m.role === 'assistant' &&
      m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
  );
  let extraHeaders = applyBlockBinding(ctx, body, replaysThinking && bound)
    ? withBeta(call.headers, BLOCK_BINDING_BETA)
    : call.headers;
  const changeBlocks = wireMessages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'tool_addition' || b.type === 'tool_removal');
  if (changeBlocks.length > 0) {
    extraHeaders = withBeta(extraHeaders, TOOL_CHANGES_BETA);
    if (changeBlocks.some((b) => (b.tool as { type: string }).type === 'tool_definition')) {
      extraHeaders = withBeta(extraHeaders, INLINE_TOOLS_BETA);
    }
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
          ...extraHeaders,
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
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
  };
}

// --- stream parsing ---

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
  server_tool_use?: { web_search_requests?: number; code_execution_requests?: number };
  /** Per-attempt usage from server-side fallbacks / compaction — sum for billing. */
  iterations?: AnthropicUsage[];
}

/** One `input_transformations` entry (beta thinking-binding-controls-2026-08-01). */
interface AnthropicInputTransformation {
  /** `thinking_dropped` | `thinking_mismatch_allowed`; more may be added. */
  type?: string;
  /** `messages.{i}.content.{j}` of the request. */
  path?: string;
  reason?: string;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage; input_transformations?: unknown };
  /** Final `message_delta` only, after a mid-stream server-side model fallback. */
  input_transformations?: unknown;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    tool_use_id?: string;
    content?: unknown;
    /** `thinking` blocks: the text and signature so far (both empty when streamed). */
    thinking?: string;
    signature?: string;
    /** `redacted_thinking` blocks: the opaque payload, complete in the start event. */
    data?: string;
  };
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
  /** Server-side context editing report (`{ applied_edits: [...] }`) — opaque pass-through. */
  context_management?: unknown;
  error?: { type?: string; message?: string };
}

/** `count` thinking block(s), worded. */
function blocks(count: number): string {
  return `${count} thinking block${count === 1 ? '' : 's'}`;
}

/** `reason at path, path; reason at path` — at most five paths per reason. */
function describeTransformations(entries: AnthropicInputTransformation[]): string {
  const byReason = new Map<string, string[]>();
  for (const entry of entries) {
    const reason = typeof entry.reason === 'string' ? entry.reason : 'unknown reason';
    const paths = byReason.get(reason) ?? [];
    if (typeof entry.path === 'string') paths.push(entry.path);
    byReason.set(reason, paths);
  }
  return [...byReason]
    .map(([reason, paths]) => {
      if (paths.length === 0) return reason;
      const shown = paths.slice(0, 5).join(', ');
      return `${reason} at ${shown}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`;
    })
    .join('; ');
}

/**
 * The response's `input_transformations` (2.3) as ONE typed warning: blocks the
 * API removed before the model saw them, and blocks that failed the
 * conversation check but were shown anyway. The raw entries ride the finish
 * part as `providerMetadata.anthropic.input_transformations`.
 */
function transformationWarning(
  entries: AnthropicInputTransformation[] | undefined,
): StreamPart | undefined {
  if (!entries || entries.length === 0) return undefined;
  const dropped = entries.filter((e) => e.type === 'thinking_dropped');
  const allowed = entries.filter((e) => e.type === 'thinking_mismatch_allowed');
  const other = entries.filter(
    (e) => e.type !== 'thinking_dropped' && e.type !== 'thinking_mismatch_allowed',
  );
  const said: string[] = [];
  if (dropped.length > 0) {
    said.push(
      `removed ${blocks(dropped.length)} from the request (${describeTransformations(dropped)}), ` +
        'so the model did not see that reasoning',
    );
  }
  if (allowed.length > 0) {
    said.push(
      `${blocks(allowed.length)} failed the conversation check ` +
        `(${describeTransformations(allowed)}) and ${allowed.length === 1 ? 'was' : 'were'} ` +
        'shown to the model anyway, because the check is not enforced for this request',
    );
  }
  if (other.length > 0) {
    const kinds = [...new Set(other.map((e) => (typeof e.type === 'string' ? e.type : '?')))];
    said.push(`made ${other.length} other change(s) (${kinds.join(', ')})`);
  }
  return {
    type: 'warning',
    warning: {
      type: 'other',
      setting: 'thinking.block_binding',
      message:
        `Anthropic changed the request's input: ${said.join('; ')}. ` +
        'See providerMetadata.anthropic.input_transformations.',
    },
  };
}

/**
 * Block identity for a reasoning delta (2.3, F21): the content block index
 * keeps consecutive thinking blocks apart (each has its own signature, and a
 * merged block is a modified one), and the source marks the family whose API
 * signed it, so no other provider is ever sent it.
 */
function reasoningBlock(index: number): { id: string; source: 'anthropic' } {
  return { id: String(index), source: 'anthropic' };
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

export function mapAnthropicUsage(input: AnthropicUsage, outputTokens: number): Usage {
  // Fallbacks/compaction report per-attempt usage in `iterations` while the
  // top-level usage covers only the serving attempt — sum iterations instead.
  // An entry carries token counters only (@anthropic-ai/sdk 0.133.0,
  // `BetaIterationsUsage`): the server tool requests and the thinking-token
  // detail are reported at the top level alone, so they are kept from there.
  if (input.iterations && input.iterations.length > 0) {
    const top = mapAnthropicUsage({ ...input, iterations: undefined }, outputTokens);
    const attempts = input.iterations.map((it) =>
      mapAnthropicUsage({ ...it, iterations: undefined }, it.output_tokens ?? 0),
    );
    const sum = (count: (u: Usage) => number): number =>
      attempts.reduce((total, u) => total + count(u), 0);
    const output = sum((u) => u.outputTokens);
    const reasoning = sum((u) => u.reasoningTokens);
    const toolUses = sum((u) => u.serverToolUses ?? 0);
    // Whichever view is the more complete one, so nothing is counted twice.
    const serverTools = Math.max(toolUses, top.serverToolUses ?? 0);
    return {
      inputTokens: sum((u) => u.inputTokens),
      outputTokens: output,
      // A share of the summed output, never more than it.
      reasoningTokens: Math.min(output, Math.max(reasoning, top.reasoningTokens)),
      cachedReadTokens: sum((u) => u.cachedReadTokens),
      cacheWriteTokens: sum((u) => u.cacheWriteTokens),
      cacheWrite1hTokens: sum((u) => u.cacheWrite1hTokens),
      ...(serverTools > 0 ? { serverToolUses: serverTools } : {}),
      totalTokens: sum((u) => u.totalTokens),
    };
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
    // Thinking tokens bill inside output_tokens; the detail field breaks them out
    // as a subset, so it is never priced on top of outputTokens.
    reasoningTokens: input.output_tokens_details?.thinking_tokens ?? 0,
    cachedReadTokens: cacheRead,
    cacheWriteTokens: Math.max(0, cacheWriteTotal - cacheWrite1h),
    cacheWrite1hTokens: cacheWrite1h,
    ...(serverTools > 0 ? { serverToolUses: serverTools } : {}),
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
  let contextManagement: unknown;
  /** What the API changed in the request's input (block binding, 2.3); `[]` when nothing. */
  let inputTransformations: AnthropicInputTransformation[] | undefined;
  const toolIds = new Map<number, string>();
  let finishEmitted = false;

  /** Finish-part providerMetadata — only attached when there is something to carry. */
  const finishMeta = (): { providerMetadata?: Record<string, unknown> } => {
    const anthropic: Record<string, unknown> = {
      ...(stopDetails ? { stop_details: stopDetails } : {}),
      ...(contextManagement !== undefined ? { contextManagement } : {}),
      ...(inputTransformations?.length ? { input_transformations: inputTransformations } : {}),
    };
    return Object.keys(anthropic).length > 0 ? { providerMetadata: { anthropic } } : {};
  };

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
      // Final here when streaming (beta thinking-binding-controls-2026-08-01).
      if (Array.isArray(data.message?.input_transformations)) {
        inputTransformations = data.message.input_transformations.filter(
          isRecord,
        ) as AnthropicInputTransformation[];
      }
    } else if (type === 'content_block_start') {
      const idx = data.index ?? 0;
      const block = data.content_block;
      if (block?.type === 'thinking') {
        // A streamed block starts empty; its text and signature follow as
        // deltas. Anything the start already carries is part of the block.
        if (block.thinking || block.signature) {
          yield {
            type: 'reasoning-delta',
            text: block.thinking ?? '',
            ...(block.signature ? { signature: block.signature } : {}),
            ...reasoningBlock(idx),
          };
        }
      } else if (block?.type === 'redacted_thinking') {
        // Complete in the start event: opaque data that rides back unchanged.
        yield {
          type: 'reasoning-delta',
          text: block.data ?? '',
          redacted: true,
          ...reasoningBlock(idx),
        };
      } else if (block?.type === 'tool_use' && block.id) {
        toolIds.set(idx, block.id);
        yield { type: 'tool-call-delta', id: block.id, name: block.name, argsTextDelta: '' };
      } else if (block?.type === 'web_search_tool_result') {
        // Provider-executed search results → canonical source parts (citations).
        const results = Array.isArray(block.content) ? block.content : [];
        let i = 0;
        for (const r of results as { url?: string; title?: string }[]) {
          if (!r.url) continue;
          yield {
            type: 'source',
            id: `${block.tool_use_id ?? 'srv'}:${i++}`,
            url: r.url,
            ...(r.title ? { title: r.title } : {}),
          };
        }
      }
      // server_tool_use blocks are provider-executed — never a local tool call.
    } else if (type === 'content_block_delta') {
      const idx = data.index ?? 0;
      const d = data.delta;
      if (d?.type === 'text_delta' && d.text !== undefined) {
        yield { type: 'text-delta', text: d.text };
      } else if (d?.type === 'thinking_delta' && d.thinking !== undefined) {
        yield { type: 'reasoning-delta', text: d.thinking, ...reasoningBlock(idx) };
      } else if (d?.type === 'signature_delta' && d.signature !== undefined) {
        yield {
          type: 'reasoning-delta',
          text: '',
          signature: d.signature,
          ...reasoningBlock(idx),
        };
      } else if (d?.type === 'input_json_delta') {
        // Only blocks registered as client tool_use stream tool-call deltas;
        // server_tool_use argument deltas are skipped (provider executes them).
        const id = toolIds.get(idx);
        if (id !== undefined) {
          yield { type: 'tool-call-delta', id, argsTextDelta: d.partial_json ?? '' };
        }
      }
    } else if (type === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.delta?.stop_details) stopDetails = data.delta.stop_details;
      if (data.context_management !== undefined) contextManagement = data.context_management;
      // Present only after a mid-stream server-side model fallback: the
      // serving model's report replaces message_start's.
      if (Array.isArray(data.input_transformations)) {
        inputTransformations = data.input_transformations.filter(
          isRecord,
        ) as AnthropicInputTransformation[];
      }
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
      _ctx.usageAvailable?.(
        typeof inputUsage.input_tokens === 'number' && typeof inputUsage.output_tokens === 'number',
      );
      const notice = transformationWarning(inputTransformations);
      if (notice) yield notice;
      yield {
        type: 'finish',
        usage: mapAnthropicUsage(inputUsage, outputTokens),
        finishReason: mapStopReason(stopReason),
        ...finishMeta(),
      };
    } else if (type === 'error') {
      yield { type: 'error', error: mapError(200, data, new Headers()) };
      return;
    }
  }

  if (!finishEmitted) {
    _ctx.usageAvailable?.(false);
    const notice = transformationWarning(inputTransformations);
    if (notice) yield notice;
    yield {
      type: 'finish',
      usage: mapAnthropicUsage(inputUsage, outputTokens),
      finishReason: mapStopReason(stopReason),
      ...finishMeta(),
    };
  }
}

// --- error mapping ---

/**
 * Anthropic has no machine-readable code for "the history no longer fits": an
 * over-long prompt comes back as a plain 400 `invalid_request_error` whose
 * MESSAGE is the only signal ("prompt is too long: 210000 tokens > 200000
 * maximum"), and an oversized body as a 413 `request_too_large`. Both mean the
 * same thing to a caller, and mapping them to `ContextOverflowError` (2.0) is
 * what lets the loop's overflow recovery force a compaction and retry instead
 * of failing the run — the OpenAI-compatible wire has had that since it ships
 * `context_length_exceeded` as a code.
 */
const CONTEXT_OVERFLOW_RE = /prompt is too long|exceed.*context|input length.*maximum/i;

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

  // Ahead of the `errType` switch: both shapes below would otherwise land on
  // `request_too_large`/`invalid_request_error` and lose the overflow signal.
  if (status === 413 || (status === 400 && CONTEXT_OVERFLOW_RE.test(message))) {
    return new ContextOverflowError({ ...base, statusCode: status });
  }

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
