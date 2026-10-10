import { expectTypeOf, test } from 'vitest';
import {
  createBatchClient,
  createMemoryBatchJobStore,
  BatchError,
  type BatchClient,
  type BatchClientOptions,
  type BatchJob,
  type BatchJobStore,
  type BatchRequest,
  type BatchResult,
  type BatchStatus,
} from '../src/batch';
import type { ModelPrice, PriceUsageOptions, ServiceTier } from '../src/pricing';
import type { PriceProvider } from '../src/types/deps';
import type { LanguageModel } from '../src/types/model';
import type { Usage } from '../src/types/usage';

declare const model: LanguageModel;
declare const batch: BatchClient;
declare const job: BatchJob;

test('a client is created for one model and drives jobs', () => {
  expectTypeOf(createBatchClient).parameter(0).toEqualTypeOf<BatchClientOptions>();
  expectTypeOf(createBatchClient({ model })).toEqualTypeOf<BatchClient>();
  // @ts-expect-error `model` is required
  createBatchClient({});
  expectTypeOf(batch.submit([{ id: 'a', prompt: 'x' }])).toEqualTypeOf<Promise<BatchJob>>();
  expectTypeOf(batch.status(job)).toEqualTypeOf<Promise<BatchStatus>>();
  expectTypeOf(batch.results(job)).toEqualTypeOf<AsyncIterable<BatchResult>>();
  expectTypeOf(batch.collect(job)).toEqualTypeOf<Promise<BatchResult[]>>();
  expectTypeOf(createMemoryBatchJobStore()).toEqualTypeOf<BatchJobStore>();
  expectTypeOf<BatchError['kind']>().toEqualTypeOf<
    | 'unsupported'
    | 'invalid-request'
    | 'invalid-job'
    | 'not-ended'
    | 'timeout'
    | 'provider'
    | 'store'
  >();
});

test('batch requests are single-turn', () => {
  const request: BatchRequest = { id: 'a', prompt: 'x', maxOutputTokens: 10 };
  void request;
  // @ts-expect-error a batch request has no tools
  const withTools: BatchRequest = { id: 'a', prompt: 'x', tools: {} };
  void withTools;
  expectTypeOf<BatchResult['status']>().toEqualTypeOf<
    'succeeded' | 'errored' | 'cancelled' | 'expired'
  >();
  expectTypeOf<BatchResult['usage']>().toEqualTypeOf<Usage | undefined>();
});

test('price lookups take an optional service tier (additive)', () => {
  expectTypeOf<ServiceTier>().toEqualTypeOf<'standard' | 'batch'>();
  expectTypeOf<Parameters<PriceProvider['priceUsage']>[2]>().toEqualTypeOf<
    PriceUsageOptions | undefined
  >();
  // A 2.2 provider without the third parameter still fits the seam.
  const legacy: PriceProvider = { priceUsage: (_model: string, _usage: Usage) => 1 };
  void legacy;
  expectTypeOf<ModelPrice['batch']>().toEqualTypeOf<Omit<ModelPrice, 'batch'> | undefined>();
});
