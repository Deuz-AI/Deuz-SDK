/**
 * Batch request bodies (2.3, BA2). Every body comes from the model's own wire
 * adapter (`buildRequest`), exactly as `generateText` / `generateObject` build
 * it, and is then made non-streaming: `stream` and `stream_options` are
 * removed. A batch request therefore carries the same request rules (effort
 * mapping, sampling restrictions, output caps, structured output, OpenAI
 * `store: false`) as the same call made directly.
 */
import { anthropicAdapter } from '../adapters/anthropic';
import { googleNativeAdapter } from '../adapters/google-native';
import { openaiCompatibleAdapter } from '../adapters/openai-compatible';
import { openaiResponsesAdapter } from '../adapters/openai-responses';
import type { Adapter, ObjectRequest } from '../adapters/types';
import { inputShapeError, normalizeMessages, resolveInputMessages } from '../core/normalize';
import { getCapabilities, type ModelCapabilities } from '../core/registry';
import { assertNoLoopOptions, pickObjectStrategy } from '../inference/object-shared';
import { readConfig } from '../internal/config-symbol';
import { wireOutputCap } from '../internal/output-cap';
import type { ResolvedCall } from '../internal/resolve-call';
import { unsupportedSetting, type WarningSink } from '../internal/warnings';
import { toJSONSchema } from '../schema/bridge';
import type { CommonCallOptions } from '../types/config';
import type { Logger, ResolvedDependencies } from '../types/deps';
import type { CallWarning } from '../types/methods';
import type { LanguageModel, ModelSurface } from '../types/model';
import type { JSONSchema, StandardSchemaV1 } from '../types/schema';
import { BatchError } from './errors';
import type { BatchProtocol, BatchRequest } from './types';

/** The adapters batch requests are built with (one per batching wire). */
function adapterFor(surface: ModelSurface): Adapter {
  switch (surface) {
    case 'anthropic':
      return anthropicAdapter;
    case 'chat_completions':
      return openaiCompatibleAdapter;
    case 'responses':
      return openaiResponsesAdapter;
    case 'native':
      return googleNativeAdapter;
  }
}

/**
 * The batch API a model's requests go to. Only the providers' own APIs batch:
 * OpenAI (Responses and Chat Completions), Anthropic Messages and Gemini
 * generateContent on the Developer API. Vertex AI, Bedrock, Azure and the other
 * OpenAI-compatible hosts have batch APIs of their own that this module does
 * not speak.
 */
export function protocolFor(model: LanguageModel): BatchProtocol {
  if (readConfig(model)?.vertex === undefined) {
    const { provider, surface } = model;
    if (provider === 'openai' && (surface === 'responses' || surface === 'chat_completions'))
      return 'openai';
    if (provider === 'anthropic' && surface === 'anthropic') return 'anthropic';
    if (provider === 'google' && surface === 'native') return 'gemini';
  }
  throw new BatchError({
    kind: 'unsupported',
    provider: model.provider,
    message:
      `${model.provider}/${model.modelId} on the ${model.surface} wire has no batch API here: ` +
      '@deuz-sdk/core/batch sends OpenAI (Responses, Chat Completions), Anthropic Messages and ' +
      'Gemini generateContent batches to their own APIs.',
  });
}

/** What one prepared request carries into the protocol and the hold. */
export interface PreparedRequest {
  readonly id: string;
  /** The non-streaming wire body. */
  readonly body: Record<string, unknown>;
  /** The headers the adapter put on the request (factory headers, `anthropic-beta`, …). */
  readonly headers: Readonly<Record<string, string>>;
  /** Structured output: how the reply carries the object, and the schema that validates it. */
  readonly object?: {
    readonly strategy: 'json' | 'tool';
    readonly toolName?: string;
    readonly schema: StandardSchemaV1 | JSONSchema;
  };
  /** The call options the body was built from; the hold's estimate reads them. */
  readonly options: CommonCallOptions;
  readonly caps: ModelCapabilities;
}

export interface PrepareInput {
  /** The client's model, with any `capabilities` override applied. */
  readonly model: LanguageModel;
  readonly call: ResolvedCall;
  readonly deps: ResolvedDependencies;
  readonly warnings: WarningSink;
  /**
   * A token or USD bound applies to the batch's holds (F12): a row that
   * documents no output limit then sends its placeholder cap, so the hold
   * bounds what the provider may bill.
   */
  readonly bounded: boolean;
}

/** Record a warning in the batch's sink and log it once, as the inference pump does. */
export function reporter(warnings: WarningSink, logger: Logger): (warning: CallWarning) => void {
  return (warning) => {
    if (!warnings.add(warning, { mirror: false })) return;
    logger.warn(warning.message, {
      warning: warning.type,
      ...(warning.setting !== undefined ? { setting: warning.setting } : {}),
    });
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message: string, cause?: unknown): BatchError {
  return new BatchError({ kind: 'invalid-request', message, cause });
}

/** Refuse a batch that cannot be sent, before any request is built or reserved. */
export function validateRequests(requests: readonly BatchRequest[]): void {
  if (!Array.isArray(requests) || requests.length === 0)
    throw invalid('A batch needs at least one request.');
  const seen = new Set<string>();
  for (const request of requests) {
    if (request === null || typeof request !== 'object')
      throw invalid('Every batch request must be an object.');
    const id: unknown = request.id;
    if (typeof id !== 'string' || !ID.test(id))
      throw invalid(
        `Batch request id ${JSON.stringify(id)?.slice(0, 80)} must be 1-64 letters, digits, "_" or "-".`,
      );
    if (seen.has(id)) throw invalid(`Batch request id "${id}" is used twice.`);
    seen.add(id);
    const shape = inputShapeError(request, `batch request "${id}"`);
    if (shape) throw invalid(shape.message, shape);
    const loop = assertNoLoopOptions(request as unknown as CommonCallOptions, 'generateObject');
    if (loop.length > 0)
      throw invalid(
        `Batch request "${id}" is a single turn and cannot honour: ${loop.join(', ')}.`,
      );
  }
}

/** The call options a batch request maps onto. */
const CALL_KEYS = [
  'temperature',
  'maxOutputTokens',
  'topP',
  'stopSequences',
  'effort',
  'responseFormat',
  'providerOptions',
  'promptCaching',
  'executionEstimate',
] as const satisfies readonly (keyof BatchRequest & keyof CommonCallOptions)[];

/**
 * Build every request's non-streaming body through the model's adapter.
 * Warnings the same call would report (a dropped or clamped setting, an
 * unknown model) go to `input.warnings`, once per batch.
 */
export async function prepareRequests(
  requests: readonly BatchRequest[],
  input: PrepareInput,
): Promise<PreparedRequest[]> {
  validateRequests(requests);
  const { model, call, deps, warnings } = input;
  const adapter = adapterFor(model.surface);
  const report = reporter(warnings, deps.logger);
  // One model per batch: its row is resolved (and an unknown slug reported) once.
  const caps = getCapabilities(model, deps.logger, undefined, warnings);
  const prepared: PreparedRequest[] = [];
  for (const request of requests) {
    const options: CommonCallOptions = { model, messages: resolveInputMessages(request) };
    for (const key of CALL_KEYS) {
      if (request[key] !== undefined) Object.assign(options, { [key]: request[key] });
    }
    reportDroppedSettings(options, caps, report);
    // F12: under a bound, a row with no documented output limit sends its
    // placeholder, so the hold covers what the provider may bill.
    const capped =
      input.bounded && wireOutputCap(model.surface, caps, options, model.modelId) === undefined;
    const callOptions: CommonCallOptions = capped
      ? { ...options, maxOutputTokens: caps.maxOutput }
      : options;
    if (capped)
      report({
        type: 'clamped-setting',
        setting: 'maxOutputTokens',
        message:
          `maxOutputTokens ${caps.maxOutput} was sent: ${model.modelId} documents no output ` +
          'limit and the batch has a budget; pass maxOutputTokens to raise it.',
      });
    let object: ObjectRequest | undefined;
    if (request.schema !== undefined) {
      object = {
        schema: await toJSONSchema(request.schema),
        name: request.schemaName,
        description: request.schemaDescription,
        strategy: pickObjectStrategy({ model, mode: request.mode, effort: request.effort }, caps),
      };
      if (request.mode === 'tool' && object.strategy === 'json')
        report({
          type: 'clamped-setting',
          setting: 'mode',
          message:
            `mode 'tool' was sent as the json strategy (native structured output): ${model.modelId} ` +
            (caps.forcedToolChoice === false
              ? 'rejects a forced tool_choice.'
              : 'thinks on this request, and a forced tool_choice does not combine with thinking.'),
        });
    }
    const { init } = adapter.buildRequest({
      call,
      messages: normalizeMessages(callOptions.messages),
      caps,
      options: callOptions,
      generateId: deps.generateId,
      object,
      logger: deps.logger,
      warnings,
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    delete body.stream;
    delete body.stream_options;
    // Gemini's adapter always asks for native JSON; the other wires force the
    // named tool for the tool strategy.
    const strategy = object && model.surface !== 'native' ? object.strategy : 'json';
    prepared.push({
      id: request.id,
      body,
      headers: { ...(init.headers as Record<string, string>) },
      ...(object && request.schema !== undefined
        ? {
            object: {
              strategy,
              ...(strategy === 'tool' ? { toolName: object.name ?? 'json_output' } : {}),
              schema: request.schema,
            },
          }
        : {}),
      options: callOptions,
      caps,
    });
  }
  return prepared;
}

/**
 * The settings a wire drops before the request is built, reported as the
 * inference pump reports them for the same call (core/inference.ts).
 */
function reportDroppedSettings(
  options: CommonCallOptions,
  caps: ModelCapabilities,
  report: (warning: CallWarning) => void,
): void {
  const { model } = options;
  if (caps.samplingRestrictions && model.surface !== 'native') {
    const why = `${model.modelId} restricts sampling parameters (a reasoning model rejects them)`;
    if (options.temperature !== undefined)
      report(
        unsupportedSetting('temperature', `temperature was dropped from the request: ${why}.`),
      );
    if (options.topP !== undefined)
      report(unsupportedSetting('topP', `topP was dropped from the request: ${why}.`));
  }
  if (!caps.reasoning && options.effort !== undefined && options.effort !== 'none')
    report(
      unsupportedSetting(
        'effort',
        `effort '${options.effort}' was dropped from the request: ${model.provider}/${model.modelId} ` +
          'has no reasoning capability in the registry (pass `capabilities: { reasoning: true }` if it does).',
      ),
    );
}
