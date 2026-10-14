import type { CommonCallOptions } from './config';
import type { Usage, FinishReason } from './usage';
import type { StreamPart } from './stream';
import type { Message } from './message';
import type { StandardSchemaV1, JSONSchema } from './schema';
import type { StepResult, ToolCall, ToolResult, ToolApprovalRequest } from './tool';
import type { EmbeddingModel } from './model';
import type { Dependencies, UsageMeta } from './deps';
import type { MemoryMutation } from '../memory';

/**
 * A non-fatal notice about how the call was actually executed (1.9 additive).
 * Warnings NEVER fail a run — they report the silent degradations that used to
 * be invisible: a sampling param the wire cannot express, a value clamped to the
 * model's ceiling, an unknown slug served from the conservative fallback row, a
 * tool the surface cannot carry.
 *
 * `type` is an OPEN string union in spirit — 'other' is the escape hatch, so
 * treat unknown members defensively rather than switching exhaustively.
 *
 * `unpriced-model` (2.3): the model has no price, so a USD budget could not be
 * applied to that call. The call still runs and token limits still apply; set
 * `unknownPrice: 'reject'` to refuse unpriced models instead.
 *
 * 2.4 adds five members; each is described on the union below.
 */
export interface CallWarning {
  type:
    | 'unsupported-setting'
    | 'clamped-setting'
    | 'unknown-model'
    | 'unsupported-tool'
    | 'unpriced-model'
    /**
     * 2.4: memory recall left out records whose stored vector does not match
     * the current embedder (another dimension or `embeddingModelId`). They stay
     * out of the vector ranking and are still found by text search. Reported
     * once per mismatch, not once per record.
     */
    | 'embedding-mismatch'
    /**
     * 2.4: a call made for the run (a memory LLM callback, an embedder, a
     * verifier) reported no usage. It is recorded as unaccounted, never as
     * free; a strict budget (`unknownPrice: 'reject'`) requires an accounted
     * adapter instead.
     */
    | 'unaccounted-usage'
    /**
     * 2.4: an optional context source (memory, RAG, transcript, skills) failed
     * while the context was compiled, and the package was built without it. A
     * required source that fails stops the model call instead.
     */
    | 'context-source-failed'
    /**
     * 2.4: the legacy resumable stream could not read from or write to its
     * `StreamStateStore`. The frames still reach the client, but that leg is
     * not journaled and cannot be replayed. A durable stream fails closed
     * instead.
     */
    | 'stream-store-error'
    /**
     * 2.4: `reconcileAgentRun` found fewer records of an interrupted native
     * memory extraction than it planned. The extraction is not marked
     * completed (it stays `'failed'`, with `mutations` counting what was
     * found), and the missing facts are not written.
     */
    | 'memory-extraction-partial'
    | 'other';
  /** The option that triggered it, when there is one (e.g. 'topP', 'effort'). */
  setting?: string;
  /** Human-readable explanation. Never contains secrets (P0 redaction). */
  message: string;
}

/**
 * Why the provider stopped a turn early, when it explained it (2.3 additive).
 * Anthropic's `stop_details` on a refusal (`stop_reason: 'refusal'`), and an
 * OpenAI refusal as `{ type: 'refusal', explanation: <the refusal text> }`,
 * both surfaced as `finishReason: 'content_filter'`. The raw provider data also
 * stays on finish parts as `providerMetadata.anthropic.stop_details` or
 * `providerMetadata.openai.refusal`.
 */
export interface StopDetails {
  /** What the detail explains, e.g. `'refusal'`. Treat unknown values defensively. */
  type: string;
  /** Provider category, when given (Anthropic refusal categories such as `'cyber'`). */
  category?: string | null;
  /** Provider explanation, when given. */
  explanation?: string | null;
}

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
   * The provider's explanation of the stop (2.3 additive), when it gave one —
   * e.g. a refusal's category. Resolves together with `finishReason`, with
   * `undefined` when the provider explained nothing or the caller aborted, and
   * rejects when the call failed. The raw provider object also stays on the
   * `finish` part's `providerMetadata`. See {@link StopDetails}.
   */
  stopDetails?: Promise<StopDetails | undefined>;
  /**
   * Durable run id — present only when the call carried `session` (or came
   * from `resumeStreamFromCheckpoint`). Known synchronously. Additive (1.5).
   */
  runId?: string;
  /**
   * Observation settlement (1.6.1 additive) — present only when an observer
   * (or tracer) was active. Resolves once every observation enrichment for
   * this call has been emitted (e.g. an async priceProvider cost event).
   * Await it BEFORE closing observers: `await res.observation?.settled`.
   */
  observation?: { settled: Promise<void> };
  /**
   * Memory extraction settlement (1.7 additive, D1) — present only when the
   * call carried `memory` with extraction on. Resolves with the applied
   * mutations once the post-run extract→reconcile pass finishes (empty on
   * suspension/error). Never rejects. Await it on serverless runtimes.
   */
  memory?: Promise<MemoryMutation[]>;
  /**
   * Non-fatal execution notices (1.9 additive). Resolves together with `usage`
   * and `finishReason` — the full set is only known once the run is over. Never
   * rejects; a failed run resolves with whatever was collected. See
   * {@link CallWarning}. Live warnings also arrive on `fullStream` as a
   * `warning` part.
   */
  warnings?: Promise<CallWarning[]>;
  /**
   * Drain the stream to completion, discarding output (1.9 additive).
   *
   * Why this exists (G2): the pump is LAZY — it starts on first access of an
   * output and only advances while someone pulls. When NOBODY iterates (the
   * classic case: a client disconnects from a serverless handler, or the result
   * object is returned and never read), the run never reaches its terminal
   * boundary, so chat persistence, durable checkpoints, `onFinish` and memory
   * extraction NEVER RUN. `consume()` drains the stream so those terminal
   * effects complete:
   *
   *   const res = streamChat({ … });
   *   ctx.waitUntil(res.consume?.());
   *
   * It MUST NEVER reject — mid-stream failures go to `onError` (and remain on
   * `fullStream` as an `error` part), consistent with the never-throw contract.
   * Calling it alongside a normal iteration is safe: the broadcaster fans the
   * single pump out to every consumer.
   *
   * Optional ONLY because `deferStream` in `src/middleware.ts` builds a PARTIAL
   * `StreamChatResult`; once that forwards the full shape it can be tightened
   * to required.
   */
  consume?: (options?: { onError?: (error: unknown) => void }) => Promise<void>;
}

export type StreamChat = (options: StreamChatOptions) => StreamChatResult;

// --- generateText (non-streaming) ---
export type GenerateTextOptions = CommonCallOptions;

export interface GenerateTextResult {
  text: string;
  /** Total usage summed across all agentic steps. */
  usage: Usage;
  finishReason: FinishReason;
  /**
   * The provider's explanation of the last turn's stop (2.3 additive), when it
   * gave one — e.g. a refusal's category. See {@link StopDetails}.
   */
  stopDetails?: StopDetails;
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
  /**
   * Observation settlement (1.6.1 additive) — present only when an observer
   * (or tracer) was active. Resolves once every observation enrichment for
   * this call has been emitted (e.g. an async priceProvider cost event).
   * Await it BEFORE closing observers: `await res.observation?.settled`.
   */
  observation?: { settled: Promise<void> };
  /**
   * Memory extraction settlement (1.7 additive, D1) — present only when the
   * call carried `memory` with extraction on. Resolves with the applied
   * mutations once the post-run extract→reconcile pass finishes (empty on
   * suspension). Never rejects. Await it on serverless runtimes.
   */
  memory?: Promise<MemoryMutation[]>;
  /**
   * Non-fatal execution notices collected across every step (1.9 additive) —
   * clamped/unsupported settings, unknown-model fallbacks, tools the wire could
   * not carry. See {@link CallWarning}.
   */
  warnings?: CallWarning[];
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
  /**
   * The provider's explanation of the stop (2.3 additive), when it gave one —
   * e.g. a refusal's category. See {@link StopDetails}.
   */
  stopDetails?: StopDetails;
  /**
   * Non-fatal execution notices (1.9 additive) — e.g. an unknown slug forcing
   * the 'tool' strategy because the fallback row reports no native structured
   * output. See {@link CallWarning}.
   */
  warnings?: CallWarning[];
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
  /**
   * The provider's explanation of the stop (2.3 additive), e.g. a refusal's
   * category. Resolves together with `usage` and `finishReason`, before the
   * final validation, so a refused request is explained even when `object`
   * rejects; `undefined` when the provider explained nothing. Rejects when the
   * call failed. See {@link StopDetails}.
   */
  stopDetails?: Promise<StopDetails | undefined>;
  /**
   * Non-fatal execution notices (1.9 additive). Resolves together with `usage`
   * and `finishReason`; never rejects. See {@link CallWarning}.
   */
  warnings?: Promise<CallWarning[]>;
  /**
   * Drain the stream to completion, discarding output (1.9 additive) — same
   * contract as {@link StreamChatResult.consume}: the pump is LAZY (G2), so
   * without a consumer the terminal effects (`onFinish`, chat persistence,
   * durable checkpoints, memory extraction) never run. MUST NEVER reject;
   * failures are reported through `onError`.
   *
   * Optional for the same reason as on `StreamChatResult` — partial result
   * objects built by `src/middleware.ts` do not forward it yet.
   */
  consume?: (options?: { onError?: (error: unknown) => void }) => Promise<void>;
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
  /**
   * Observation settlement (1.6.1 additive) — present only when an observer
   * (or tracer) was active. Resolves once every observation enrichment for
   * this call has been emitted (e.g. an async priceProvider cost event).
   * Await it BEFORE closing observers: `await res.observation?.settled`.
   */
  observation?: { settled: Promise<void> };
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
  /**
   * Observation settlement (1.6.1 additive) — present only when an observer
   * (or tracer) was active. Resolves once every observation enrichment for
   * this call has been emitted (e.g. an async priceProvider cost event).
   * Await it BEFORE closing observers: `await res.observation?.settled`.
   */
  observation?: { settled: Promise<void> };
}

export type EmbedMany = (options: EmbedManyOptions) => Promise<EmbedManyResult>;
