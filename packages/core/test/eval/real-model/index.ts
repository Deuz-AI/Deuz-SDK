/**
 * Real-model eval tasks (2.3, roadmap 23.7): the twins of five offline tasks,
 * bound to a real provider. Same start state, tools and acceptance; the model
 * decides, so these measure a model on the SDK rather than the SDK alone, and
 * their numbers are a separate experiment from the offline baseline.
 *
 * Never run under `npm test`. `npm run test:live` runs them through
 * test/live/eval-real-model.live.test.ts, skipping every task whose key is
 * missing. Not live-verified: no run against a provider was made for 2.3, so
 * there are no real-model results and no comparison with other SDKs.
 *
 * Model IDs come from the SDK's own registry and price table (checked offline
 * in real-model-manifests.test.ts), so a USD budget applies to every call.
 */
import { createAnthropic } from '../../../src/anthropic';
import { createGoogleNative } from '../../../src/google';
import { createOpenAI, createOpenAIResponses } from '../../../src/openai';
import { createPriceProvider } from '../../../src/pricing';
import type { LanguageModel } from '../../../src/types/model';
import type { EvalTaskManifest, EvalTaskModel } from '../../../src/testing';
import type { TaskModel } from '../support';
import { gatedDeploy, deployApproved } from '../tasks/approval';
import { researchRivers, sourcedAnswer } from '../tasks/research';
import { extractInvoice, invoiceExtraction } from '../tasks/structured-output';
import { configMigration, fixRange, migrateConfigs, offByOne } from '../tasks/workspace';

/** Reads a key by name: the live runner's `.env.smoke`, or nothing offline. */
export type KeyLookup = (name: string) => string | undefined;

const KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

const MODELS = {
  sonnet: {
    provider: 'anthropic',
    id: 'claude-sonnet-5-5',
    protocol: 'messages',
    effort: 'medium',
  },
  haiku: { provider: 'anthropic', id: 'claude-haiku-5-5', protocol: 'messages' },
  gpt: { provider: 'openai', id: 'gpt-5.4-mini', protocol: 'responses', effort: 'medium' },
  gemini: { provider: 'google', id: 'gemini-3.5-flash', protocol: 'native' },
} satisfies Record<string, EvalTaskModel>;

/** The provider's model for a manifest's model descriptor. Building it dials nothing. */
export function providerModel(model: EvalTaskModel, apiKey: string): LanguageModel {
  const id = model.id!;
  switch (model.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(id);
    case 'openai':
      return (model.protocol === 'responses' ? createOpenAIResponses : createOpenAI)({ apiKey })(
        id,
      );
    case 'google':
      return createGoogleNative({ apiKey })(id);
    default:
      throw new Error(`no real-model provider for ${String(model.provider)}`);
  }
}

/** A real provider's model under the manifest's budget, each request capped. */
function real(model: EvalTaskModel, key: KeyLookup): TaskModel {
  const name = KEYS[model.provider!]!;
  return {
    model: () => {
      const apiKey = key(name);
      if (!apiKey) throw new Error(`${name} is not set`);
      return providerModel(model, apiKey);
    },
    prices: createPriceProvider(),
    ...(model.effort !== undefined ? { effort: model.effort as TaskModel['effort'] } : {}),
    // Bounds what the ledger reserves per call, so the USD budget admits a loop.
    maxOutputTokens: 4_096,
    enforceBudget: true,
  };
}

/** An offline task's start state, tools and acceptance, on a real provider. */
function twin(
  base: EvalTaskManifest,
  model: EvalTaskModel,
  bind: (on: TaskModel) => NonNullable<EvalTaskManifest['run']>,
  key: KeyLookup,
  usd: number,
): EvalTaskManifest {
  return {
    ...base,
    id: `real/${base.id}`,
    tier: 'real-model',
    model,
    env: [KEYS[model.provider!]!],
    budget: { usd },
    timeoutMs: 180_000,
    // A real model varies run to run: three attempts give a success rate.
    repeats: 3,
    run: bind(real(model, key)),
  };
}

/** The real-model tasks, reading keys through `key` only when a task runs. */
export function realModelTasks(key: KeyLookup): EvalTaskManifest[] {
  return [
    twin(offByOne, MODELS.sonnet, fixRange, key, 0.5),
    twin(configMigration, MODELS.gpt, migrateConfigs, key, 0.25),
    twin(sourcedAnswer, MODELS.gemini, researchRivers, key, 0.25),
    twin(invoiceExtraction, MODELS.haiku, extractInvoice, key, 0.1),
    twin(deployApproved, MODELS.gpt, (on) => gatedDeploy(on, true), key, 0.25),
  ];
}
