import type { CommonCallOptions } from './config';
import type { Usage, FinishReason } from './usage';
import type { StreamPart } from './stream';
import type { Message } from './message';
import type { StandardSchemaV1, JSONSchema } from './schema';
import type { StepResult, ToolCall, ToolResult } from './tool';
import type { EmbeddingModel } from './model';
import type { Dependencies, UsageMeta } from './deps';

// --- streamChat ---
export type StreamChatOptions = CommonCallOptions;

export interface StreamChatResult {
  /** Text-only projection of the stream. */
  textStream: AsyncIterable<string>;
  /** Full canonical event stream. */
  fullStream: AsyncIterable<StreamPart>;
  /** Resolves once the stream finishes. */
  usage: Promise<Usage>;
  finishReason: Promise<FinishReason>;
}

export type StreamChat = (options: StreamChatOptions) => StreamChatResult;

// --- generateText (non-streaming) ---
export type GenerateTextOptions = CommonCallOptions;

export interface GenerateTextResult {
  text: string;
  /** Total usage summed across all agentic steps. */
  usage: Usage;
  finishReason: FinishReason;
  /** Messages to append to history (assistant + tool turns across all steps). */
  response: { messages: Message[] };
  /** Per-step breakdown (present when `tools` were used). Additive. */
  steps?: StepResult[];
  /** Last step's tool calls / results (convenience). Additive. */
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export type GenerateText = (options: GenerateTextOptions) => Promise<GenerateTextResult>;

// --- generateObject (structured output) ---
export interface GenerateObjectOptions<T = unknown> extends CommonCallOptions {
  schema: StandardSchemaV1<unknown, T> | JSONSchema;
  schemaName?: string;
  schemaDescription?: string;
  /** Strategy: native json-schema, tool-call coercion, or auto-pick by capability. */
  mode?: 'auto' | 'json' | 'tool';
}

export interface GenerateObjectResult<T = unknown> {
  object: T;
  usage: Usage;
  finishReason: FinishReason;
}

export type GenerateObject = <T = unknown>(
  options: GenerateObjectOptions<T>,
) => Promise<GenerateObjectResult<T>>;

// --- embed / embedMany (Faz 3) ---

/**
 * Canonical task hint, mapped to each provider's own enum (OpenAI ignores it;
 * Gemini → RETRIEVAL_QUERY/RETRIEVAL_DOCUMENT/…; Voyage → input_type).
 */
export type EmbeddingTaskType =
  | 'search_query'
  | 'search_document'
  | 'similarity'
  | 'classification'
  | 'clustering'
  | 'question_answering'
  | 'fact_verification'
  | 'code_retrieval_query';

export interface EmbedOptions {
  model: EmbeddingModel;
  value: string;
  /** Matryoshka truncation (OpenAI `dimensions` / Gemini `outputDimensionality` / Voyage `output_dimension`). */
  dimensions?: number;
  taskType?: EmbeddingTaskType;
  /** Optional document title (Gemini RETRIEVAL_DOCUMENT only; dropped elsewhere). */
  title?: string;
  /** L2-normalize the returned vector(s) (default false). Useful after dimension truncation. */
  normalize?: boolean;
  signal?: AbortSignal;
  maxRetries?: number;
  headers?: Record<string, string>;
  deps?: Dependencies;
  onUsage?: (usage: Usage, meta: UsageMeta) => void;
}

export interface EmbedResult {
  embedding: number[];
  usage: Usage;
}

export type Embed = (options: EmbedOptions) => Promise<EmbedResult>;

export interface EmbedManyOptions extends Omit<EmbedOptions, 'value'> {
  values: string[];
  /** Override the per-request batch size (default: model's `embeddingMaxBatch`). */
  maxBatchSize?: number;
  /** Max concurrent sub-batch requests (default 5). */
  maxConcurrency?: number;
}

export interface EmbedManyResult {
  embeddings: number[][];
  usage: Usage;
}

export type EmbedMany = (options: EmbedManyOptions) => Promise<EmbedManyResult>;
