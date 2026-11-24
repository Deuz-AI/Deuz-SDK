/**
 * Everything that reads the shape of the AI SDK language-model specification
 * (`LanguageModelV4`, AI SDK 7) lives here, so a future spec change touches one
 * file: usage mapping, the prompt estimate, the price key and which stream
 * parts count as the first byte.
 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { Usage } from '@deuz-sdk/core';

/** The AI SDK identity of a model: what `priceKey` and receipts see. */
export interface DeuzModelRef {
  /** AI SDK provider id, such as `'openai.responses'` or `'anthropic.messages'`. */
  readonly provider: string;
  /** AI SDK model id, such as `'gpt-5-mini'`. */
  readonly modelId: string;
}

/** Characters per token of Deuz's prompt heuristic (the same ratio core uses). */
const CHARS_PER_TOKEN = 3.6;
/** Framing overhead charged per prompt message. */
const TOKENS_PER_MESSAGE = 4;
/** Flat estimate for one file part (an image or a short document). */
const TOKENS_PER_FILE = 1_600;

/**
 * Convert AI SDK usage to Deuz's canonical `Usage`, whose input buckets are
 * disjoint (full-rate input, cache reads, cache writes) and whose
 * `outputTokens` already includes reasoning. Returns `undefined` when the
 * provider reported neither an input nor an output total: the call's usage is
 * unknown and its estimate stays held.
 */
export function toDeuzUsage(usage: LanguageModelV4Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const outputTotal =
    output.total ??
    (output.text !== undefined || output.reasoning !== undefined
      ? (output.text ?? 0) + (output.reasoning ?? 0)
      : undefined);
  const cacheRead = input.cacheRead ?? 0;
  const cacheWrite = input.cacheWrite ?? 0;
  const inputTotal =
    input.total ??
    (input.noCache !== undefined ? input.noCache + cacheRead + cacheWrite : undefined);
  if (inputTotal === undefined && outputTotal === undefined) return undefined;
  const fullRate = input.noCache ?? Math.max(0, (inputTotal ?? 0) - cacheRead - cacheWrite);
  const outputTokens = outputTotal ?? 0;
  return {
    inputTokens: fullRate,
    outputTokens,
    reasoningTokens: Math.min(output.reasoning ?? 0, outputTokens),
    cachedReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: 0,
    totalTokens: (inputTotal ?? fullRate + cacheRead + cacheWrite) + outputTokens,
  };
}

/** JSON without binary payloads: a file's bytes are charged as a flat file estimate. */
function textOf(value: unknown, files: { count: number }): string {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (
          item instanceof Uint8Array ||
          item instanceof ArrayBuffer ||
          (typeof URL !== 'undefined' && item instanceof URL)
        ) {
          files.count++;
          return '';
        }
        return item;
      }) ?? ''
    );
  } catch {
    return '';
  }
}

/**
 * A conservative prompt-token estimate from characters: every message's text,
 * tool inputs and results, and the tool definitions, at 3.6 characters per
 * token, plus a flat 1 600 tokens per file part and 4 per message. No
 * tokenizer: real usage can be higher (dense code, non-Latin scripts, PDFs).
 */
export function estimatePromptTokens(params: LanguageModelV4CallOptions): number {
  const files = { count: 0 };
  let chars = 0;
  for (const message of params.prompt) {
    if (message.role === 'system') {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          chars += part.text.length;
          break;
        case 'file':
          files.count++;
          break;
        default:
          chars += textOf(part, files).length;
      }
    }
  }
  if (params.tools?.length) chars += textOf(params.tools, files).length;
  if (params.responseFormat?.type === 'json' && params.responseFormat.schema)
    chars += textOf(params.responseFormat.schema, files).length;
  return (
    Math.ceil(chars / CHARS_PER_TOKEN) +
    params.prompt.length * TOKENS_PER_MESSAGE +
    files.count * TOKENS_PER_FILE
  );
}

/** `us.`, `eu.`, `apac.`, `global.` … cross-region inference prefixes on Bedrock. */
const BEDROCK_REGION = /^(?:us|eu|apac|global|us-gov|jp|au|ca)\./;
const BEDROCK_VENDOR =
  /^(?:anthropic|meta|amazon|mistral|cohere|deepseek|openai|ai21|writer|qwen|moonshot)\./;
const BEDROCK_VERSION = /-v\d+(?::\d+)?$/;

/**
 * The Deuz price key of an AI SDK model, before Deuz's own lookup (which also
 * drops one vendor prefix such as `openai/` and a trailing snapshot date):
 * - Vertex ids lose their `@version` suffix (`claude-sonnet-4-5@20250929`);
 * - Bedrock ids lose their region and vendor prefixes and `-v1:0` suffix
 *   (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`);
 * - every other id is used as is (`gpt-5-mini`, gateway `openai/gpt-5-mini`).
 *
 * Azure deployment names and custom ids need the `priceKey` option.
 */
export function defaultPriceKey(model: DeuzModelRef): string {
  let id = model.modelId.replace(/@[^/@]+$/, '');
  if (model.provider.includes('bedrock') || BEDROCK_VENDOR.test(id.replace(BEDROCK_REGION, ''))) {
    const bare = id.replace(BEDROCK_REGION, '');
    if (BEDROCK_VENDOR.test(bare))
      id = bare.replace(BEDROCK_VENDOR, '').replace(BEDROCK_VERSION, '');
  }
  return id || model.modelId;
}

/**
 * Stream parts that are not content: metadata, keep-alives and errors. Any
 * other part is the first byte, after which an attempt can no longer fail over.
 */
const NON_CONTENT = new Set<LanguageModelV4StreamPart['type']>([
  'stream-start',
  'response-metadata',
  'ping',
  'raw',
  'error',
  'finish',
]);

/** True for a part after which an error is final (no fail-over). */
export function isContentPart(part: LanguageModelV4StreamPart): boolean {
  return !NON_CONTENT.has(part.type);
}
