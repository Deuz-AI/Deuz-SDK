import type {
  LanguageModel,
  ModelSurface,
  EmbeddingModel,
  EmbeddingModelSurface,
} from '../types/model';
import type { Logger } from '../types/deps';

/**
 * Single source of truth for per-model behavior. Everything capability-aware
 * (which params to send, structured-output strategy, quirk handling, default
 * max_tokens) reads from here. Unknown slugs DO NOT throw — new models ship
 * constantly — they fall back to a CONSERVATIVE default row by (provider,
 * surface) and `logger.warn`, so a future `claude-opus-4-9` still works.
 */
export interface ModelCapabilities {
  provider: string;
  surface: ModelSurface;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Native structured output (json_schema / output_config). */
  structuredOutput: boolean;
  /** Explicit prompt-cache breakpoints are controllable (Anthropic). */
  caching: boolean;
  nativePdf: boolean;
  audio: boolean;
  contextWindow: number;
  maxOutput: number;
  /** Provider returns usage on EVERY chunk → take the LAST (Gemini-compat). */
  usagePerChunk: boolean;
  /** Streaming tool deltas all arrive with index=0 → order-based slotting. */
  toolIndexAllZero: boolean;
  /** Reasoning models reject temperature/topP/max_tokens → strip them. */
  samplingRestrictions: boolean;
  /** How reasoning depth is sent to Anthropic: manual `thinking.budget_tokens`
   *  (pre-4.7) vs `output_config.effort` (Opus 4.7+, Sonnet 5, Fable 5 —
   *  budget_tokens returns 400 there). Non-Anthropic wires ignore this. */
  effortWire: 'budget_tokens' | 'output_config';
  /** False when this row is a fallback for an unknown slug. */
  known: boolean;
}

type Row = Omit<ModelCapabilities, 'known'>;

function row(provider: string, surface: ModelSurface, over: Partial<Row>): Row {
  return {
    provider,
    surface,
    vision: false,
    tools: true,
    reasoning: false,
    structuredOutput: true,
    caching: false,
    nativePdf: false,
    audio: false,
    contextWindow: 128_000,
    maxOutput: 8_192,
    usagePerChunk: false,
    toolIndexAllZero: false,
    samplingRestrictions: false,
    effortWire: 'budget_tokens',
    ...over,
  };
}

// 2026-current slugs (pinned; adjust at launch). See plan's wire reference.
const REGISTRY: Record<string, Row> = {
  // --- Anthropic (surface 'anthropic') ---
  'claude-fable-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true, // temperature/top_p/top_k non-default → 400
  }),
  'claude-sonnet-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-8': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-7': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-6': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  }),
  'claude-sonnet-4-6': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'claude-haiku-4-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 200_000,
    maxOutput: 64_000,
  }),

  // --- OpenAI Chat Completions (no reasoning on this wire) ---
  'gpt-5.5': row('openai', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  }),
  'gpt-5.5-pro': row('openai', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  }),

  // --- OpenAI Responses (reasoning + tools live here) ---
  'gpt-5.4': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  'gpt-5.4-mini': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  'o4-mini': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 200_000,
    maxOutput: 100_000,
  }),

  // --- xAI Grok (Chat Completions wire; reasoning on by default) ---
  'grok-4.3': row('xai', 'chat_completions', {
    vision: true,
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  }),

  // --- Google Gemini via OpenAI-compat (limited surface; usage-per-chunk quirk) ---
  'gemini-3.1-pro': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-3.5-flash': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-2.5-pro': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-2.5-flash': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
};

// --- Gemini NATIVE (generateContent) rows — surface:'native', keyed separately
// from the compat rows so the SAME slug can be used on either wire. ---
const NATIVE_REGISTRY: Record<string, Row> = {
  'gemini-3-pro': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-3.5-flash': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-2.5-pro': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-2.5-flash': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
};

/** Conservative fallback for an unknown slug — risky flags default OFF. */
function defaultRow(provider: string, surface: ModelSurface): Row {
  const isGeminiCompat = provider === 'google' && surface === 'chat_completions';
  return row(provider, surface, {
    tools: false,
    reasoning: false,
    structuredOutput: false,
    contextWindow: 128_000,
    maxOutput: 4_096, // conservative — feeds Anthropic max_tokens; too-high would 400/truncate
    usagePerChunk: isGeminiCompat,
    toolIndexAllZero: isGeminiCompat,
  });
}

/** Native-Gemini fallback for an unknown `surface:'native'` slug (full caps ON). */
function defaultNativeRow(): Row {
  return row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  });
}

/** Resolve capabilities for a model descriptor; warns (once-ish) on unknown slugs. */
export function getCapabilities(model: LanguageModel, logger?: Logger): ModelCapabilities {
  // Native surface is keyed in its own table so a slug can serve both wires.
  if (model.surface === 'native') {
    const nrow = NATIVE_REGISTRY[model.modelId];
    if (nrow) return { ...nrow, known: true };
    logger?.warn(`Unknown native model '${model.modelId}' — using Gemini-native defaults.`, {
      provider: model.provider,
      modelId: model.modelId,
      surface: model.surface,
    });
    return { ...defaultNativeRow(), known: false };
  }

  const known = REGISTRY[model.modelId];
  if (known) return { ...known, known: true };
  logger?.warn(
    `Unknown model '${model.modelId}' — using conservative ${model.provider}/${model.surface} defaults.`,
    {
      provider: model.provider,
      modelId: model.modelId,
      surface: model.surface,
    },
  );
  return { ...defaultRow(model.provider, model.surface), known: false };
}

// ===================================================================
// Embedding capabilities (Faz 3) — kept SEPARATE from ModelCapabilities so
// chat rows are untouched and the two model kinds never cross-contaminate.
// ===================================================================

export interface EmbeddingCapabilities {
  provider: string;
  surface: EmbeddingModelSurface;
  /** False only for a slug we explicitly know is NOT an embedding model. */
  embedding: boolean;
  /** Native output dimension (before optional Matryoshka truncation). */
  embeddingDimensions: number;
  /** Max inputs per request (provider-enforced; drives chunk-batching). */
  embeddingMaxBatch: number;
  /** Provider returns a usage/token count on the response. */
  reportsUsage: boolean;
  /** `encoding_format: 'base64'` is accepted (compact wire for large batches). */
  supportsBase64: boolean;
  /** A task-type / input-type hint is accepted. */
  supportsTaskType: boolean;
  /** False when this row is a fallback for an unknown slug. */
  known: boolean;
}

type EmbeddingRow = Omit<EmbeddingCapabilities, 'known'>;

function embRow(
  provider: string,
  surface: EmbeddingModelSurface,
  over: Partial<EmbeddingRow>,
): EmbeddingRow {
  return {
    provider,
    surface,
    embedding: true,
    embeddingDimensions: 1536,
    embeddingMaxBatch: 96,
    reportsUsage: false,
    supportsBase64: false,
    supportsTaskType: false,
    ...over,
  };
}

// 2026-pinned embedding slugs; verify dims/limits at publish (see openQuestions).
const EMBEDDING_REGISTRY: Record<string, EmbeddingRow> = {
  // --- OpenAI ---
  'text-embedding-3-small': embRow('openai', 'openai-embeddings', {
    embeddingDimensions: 1536,
    embeddingMaxBatch: 2048,
    reportsUsage: true,
    supportsBase64: true,
  }),
  'text-embedding-3-large': embRow('openai', 'openai-embeddings', {
    embeddingDimensions: 3072,
    embeddingMaxBatch: 2048,
    reportsUsage: true,
    supportsBase64: true,
  }),

  // --- Google Gemini (native embeddings) ---
  'gemini-embedding-001': embRow('google', 'gemini-embeddings', {
    embeddingDimensions: 3072,
    embeddingMaxBatch: 100,
    reportsUsage: false,
    supportsTaskType: true,
  }),
  'text-embedding-004': embRow('google', 'gemini-embeddings', {
    embeddingDimensions: 768,
    embeddingMaxBatch: 100,
    reportsUsage: false,
    supportsTaskType: true,
  }),

  // --- Voyage AI (optional catalog) ---
  'voyage-3.5': embRow('voyage', 'voyage-embeddings', {
    embeddingDimensions: 1024,
    embeddingMaxBatch: 1000,
    reportsUsage: true,
    supportsBase64: true,
    supportsTaskType: true,
  }),
  'voyage-3.5-lite': embRow('voyage', 'voyage-embeddings', {
    embeddingDimensions: 1024,
    embeddingMaxBatch: 1000,
    reportsUsage: true,
    supportsBase64: true,
    supportsTaskType: true,
  }),
};

/** Conservative fallback for an unknown embedding slug (risky flags OFF). */
function defaultEmbeddingRow(provider: string, surface: EmbeddingModelSurface): EmbeddingRow {
  const dims = surface === 'gemini-embeddings' ? 768 : 1024;
  return embRow(provider, surface, {
    embeddingDimensions: dims,
    embeddingMaxBatch: 96,
    reportsUsage: false,
    supportsBase64: false,
    supportsTaskType: surface !== 'openai-embeddings',
  });
}

/** Resolve embedding capabilities; warns on unknown slugs (mirrors getCapabilities). */
export function getEmbeddingCapabilities(
  model: EmbeddingModel,
  logger?: Logger,
): EmbeddingCapabilities {
  const known = EMBEDDING_REGISTRY[model.modelId];
  if (known) return { ...known, known: true };
  logger?.warn(
    `Unknown embedding model '${model.modelId}' — using conservative ${model.provider}/${model.surface} defaults.`,
    { provider: model.provider, modelId: model.modelId, surface: model.surface },
  );
  return { ...defaultEmbeddingRow(model.provider, model.surface), known: false };
}
