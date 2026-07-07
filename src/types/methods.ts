import type { CommonCallOptions } from './config';
import type { Usage, FinishReason } from './usage';
import type { StreamPart } from './stream';
import type { Message } from './message';
import type { StandardSchemaV1, JSONSchema } from './schema';
import type { StepResult, ToolCall, ToolResult, ToolApprovalRequest } from './tool';
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
  /**
   * Durable run id — present only when the call carried `session` (or came
   * from `resumeStreamFromCheckpoint`). Known synchronously. Additive (1.5).
   */
  runId?: string;
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
  /**
   * Present when the loop broke on a client-mode approval: the calls awaiting
   * a verdict. Resume by calling again with `approvalResponses`. Additive.
   */
  pendingApprovals?: ToolApprovalRequest[];
  /**
   * SDK-level metadata. `deuz.stoppedBy` names the user-provided `stopWhen`
   * condition that ended the loop (e.g. 'totalTokensExceed') — absent when the
   * loop ended naturally or on the implicit `maxSteps` bound. Additive (1.4).
   */
  providerMetadata?: Record<string, Record<string, unknown>>;
  /**
   * Durable run id — present only when the call carried `session` (or came
   * from `resumeFromCheckpoint`). Pass it to `resumeFromCheckpoint` to
   * continue a suspended/crashed run. Additive (1.5).
   */
  runId?: string;
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

// --- streamObject (streaming structured output; additive) ---

/**
 * Recursive partial: every property optional at every depth. Array elements
 * are themselves partial (a trailing element may still be streaming in).
 * Non-object leaves (and `unknown`) pass through unchanged.
 */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface StreamObjectResult<T = unknown> {
  /**
   * Best-effort partial objects as JSON streams in (json strategy). Emits only
   * when the parsed value changes. Tool-strategy models buffer and emit the
   * final validated object once. Iteration rejects on transport errors and on
   * final-validation failure (mirrors `textStream`'s throw-on-error).
   */
  partialObjectStream: AsyncIterable<DeepPartial<T>>;
  /** The final, schema-validated object. Rejects with `NoObjectGeneratedError`. */
  object: Promise<T>;
  /** Resolve even when final validation fails (the tokens were still spent). */
  usage: Promise<Usage>;
  finishReason: Promise<FinishReason>;
}

/**
 * Like `generateObject` but streaming. Returns synchronously (G2): the request
 * starts lazily on first output access; failures surface as rejections, never
 * a synchronous throw. Unlike `generateObject` there is NO repair retry —
 * emitted partials cannot be un-streamed.
 */
export type StreamObject = <T = unknown>(
  options: GenerateObjectOptions<T>,
) => StreamObjectResult<T>;

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
