/**
 * The headless doctor (2.3 preview, 23.8): why a provider / model /
 * configuration will not work, found before any call. Pure and edge-safe: the
 * Node entry supplies the environment, the Node version and the price lookup,
 * and this module turns them and the model's profile into findings. Nothing
 * here is live-verified; the profile says where its facts come from.
 */
import { resolveModelProfile, type ModelProfile } from '../model-profile';
import { pickObjectStrategy } from '../inference/object-shared';
import { getCapabilities } from '../core/registry';
import { readConfig, withCapabilityOverride } from '../internal/config-symbol';
import type { AgentToolSet } from '../types/agent-run';
import type { CommonCallOptions } from '../types/config';
import type { Dependencies } from '../types/deps';
import type { LanguageModel, ModelSurface } from '../types/model';

/** How serious a finding is: an `error` means the run will not work as configured. */
export type DoctorSeverity = 'error' | 'warning' | 'info';

/**
 * One thing the doctor found (2.3 preview). `code` is stable; `message` is for
 * people. Codes: `node-version`, `node-sqlite`, `missing-api-key`,
 * `key-provider`, `unknown-model`, `model-status`, `unpriced-model`,
 * `price-lookup-failed`, `tools-unsupported`, `tools-unknown`, `tool-protocol`,
 * `structured-output`, `clamped-setting`, `unsupported-setting`,
 * `not-live-verified`.
 */
export interface DoctorFinding {
  severity: DoctorSeverity;
  code: string;
  message: string;
  /** The option it concerns, when there is one. */
  setting?: string;
}

/**
 * What `doctor` checks (2.3 preview): the model and the settings the run will
 * use. A run's options fit as they are; fields the doctor does not read are
 * ignored.
 */
export interface DoctorOptions {
  model: LanguageModel;
  effort?: CommonCallOptions['effort'];
  temperature?: number;
  topP?: number;
  toolChoice?: CommonCallOptions['toolChoice'];
  promptCaching?: CommonCallOptions['promptCaching'];
  budget?: CommonCallOptions['budget'];
  /** A per-call capability override, as on the run. */
  capabilities?: CommonCallOptions['capabilities'];
  /** The run offers tools: a tool set, or `true`. Skills count as tools. */
  tools?: AgentToolSet | boolean;
  skills?: readonly string[];
  /** The run asks for structured output, in this mode. */
  output?: { mode?: 'auto' | 'json' | 'tool' };
  /** `keyProvider` and `priceProvider` are consulted as the run would. */
  deps?: Dependencies;
  /** Where to look for the API key. Default: this process's environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The variable that holds the API key. Default: the provider's usual one, e.g. `ANTHROPIC_API_KEY`. */
  apiKeyEnv?: string;
  /** Default: this process's Node version. */
  nodeVersion?: string;
}

/** A provider / model / configuration report (2.3 preview). Plain JSON, never a secret. */
export interface DoctorReport {
  kind: 'deuz-headless-doctor';
  version: 1;
  /** No finding is an error. */
  ok: boolean;
  model: { provider: string; modelId: string; protocol: ModelSurface };
  /**
   * How well the SDK knows the model: `'pinned'` — its own registry row;
   * `'family'` — the Claude 5.x family rules; `'unknown'` — the conservative
   * fallback. None of them is live-verified.
   */
  support: 'pinned' | 'family' | 'unknown';
  profile: ModelProfile;
  /** How a structured `output` would be requested: native JSON, or a forced tool. */
  structuredOutput: { mode: 'auto' | 'json' | 'tool'; strategy: 'json' | 'tool' };
  /** The price provider (the bundled table by default) has a price for the model. */
  priced: boolean;
  /**
   * Where the run's API key comes from: the factory, a `deps.keyProvider`
   * (not checked), nowhere because the host needs none, or nowhere at all.
   * `inEnvironment` says whether `envVar` is set; its value is never reported.
   */
  apiKey: {
    source: 'factory' | 'key-provider' | 'keyless' | 'missing';
    envVar: string;
    inEnvironment: boolean;
  };
  node: { version: string; required: string; supported: boolean };
  findings: DoctorFinding[];
}

/** What the Node entry measured for {@link diagnose}. */
export interface DoctorFacts {
  env: Readonly<Record<string, string | undefined>>;
  nodeVersion: string;
  /** `undefined` when the price lookup threw (its message is `priceError`). */
  priced: boolean | undefined;
  priceError?: string;
}

/** The variables a provider's key conventionally lives in; the first is reported. */
const KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  xai: ['XAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK'],
  'vertex-anthropic': ['VERTEX_ACCESS_TOKEN'],
  'vertex-google': ['VERTEX_ACCESS_TOKEN'],
  qwen: ['DASHSCOPE_API_KEY'],
  glm: ['ZAI_API_KEY'],
};

function keyEnv(provider: string, override: string | undefined): readonly string[] {
  if (override !== undefined) return [override];
  return KEY_ENV[provider] ?? [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`];
}

/** The Node release the package requires (`engines`). */
const REQUIRED_NODE = '>=22.0.0';

function parseVersion(version: string): { text: string; major: number; minor: number } {
  const text = version.replace(/^v/, '');
  const [major = NaN, minor = 0] = text.split('.').map((part) => Number.parseInt(part, 10));
  return { text, major, minor };
}

const THINKING = 'effort is set (extended thinking is on)';

/** Turn the profile and the measured facts into a report. */
export function diagnose(options: DoctorOptions, facts: DoctorFacts): DoctorReport {
  const findings: DoctorFinding[] = [];
  const add = (severity: DoctorSeverity, code: string, message: string, setting?: string): void => {
    findings.push({ severity, code, message, ...(setting !== undefined ? { setting } : {}) });
  };
  const model = withCapabilityOverride(options.model, options.capabilities);
  const { provider, modelId } = model;
  const profile = resolveModelProfile(model);
  const protocol = profile.protocol;

  // --- Node ---
  const node = parseVersion(facts.nodeVersion);
  const supported = Number.isFinite(node.major) && node.major >= 22;
  if (!supported)
    add(
      'error',
      'node-version',
      `Node ${node.text} is not supported: @deuz-sdk/core needs Node ${REQUIRED_NODE}.`,
    );
  else if ((node.major === 22 && node.minor < 13) || (node.major === 23 && node.minor < 4))
    add(
      'warning',
      'node-sqlite',
      `Node ${node.text} has no unflagged node:sqlite (Node 22.13 or 23.4 and later), which the SQLite stores, such as createSqliteOpsStore, need.`,
    );

  // --- API key ---
  const config = readConfig(model);
  const names = keyEnv(provider, options.apiKeyEnv);
  const envVar = names[0]!;
  const inEnvironment = names.some((name) => (facts.env[name] ?? '') !== '');
  const source = config?.apiKey
    ? 'factory'
    : config?.apiKeyOptional
      ? 'keyless'
      : options.deps?.keyProvider
        ? 'key-provider'
        : 'missing';
  if (source === 'missing') {
    add(
      'error',
      'missing-api-key',
      inEnvironment
        ? `${envVar} is set, but the model's factory has no apiKey: @deuz-sdk/core never reads the environment. Pass it to the factory, e.g. ({ apiKey: process.env.${envVar} }).`
        : `No API key for provider '${provider}': the model's factory has none and ${envVar} is not set. Set ${envVar} and pass it to the factory, or give deps.keyProvider.`,
    );
  } else if (source === 'key-provider') {
    add(
      'info',
      'key-provider',
      'The API key comes from deps.keyProvider; the doctor does not call it.',
    );
  }

  // --- What the SDK knows about the model ---
  const support =
    profile.match === 'exact' ? 'pinned' : profile.match === 'family' ? 'family' : 'unknown';
  if (support === 'unknown') {
    add(
      'warning',
      'unknown-model',
      `No registry row for '${modelId}' on ${provider}/${protocol}: the conservative defaults apply (capabilities unknown, the default output cap). Check the model id, or describe the model with capabilities.`,
    );
  }
  if (profile.status === 'preview' || profile.status === 'deprecated')
    add('warning', 'model-status', `'${modelId}' is documented as ${profile.status}.`);

  // --- Price ---
  const usd = options.budget?.usd !== undefined;
  if (facts.priced === undefined) {
    add(
      'warning',
      'price-lookup-failed',
      `The price lookup failed: ${facts.priceError ?? 'unknown error'}.`,
    );
  } else if (!facts.priced) {
    if (usd && options.budget?.unknownPrice === 'reject')
      add(
        'error',
        'unpriced-model',
        `'${modelId}' has no price, and the budget refuses unpriced models (unknownPrice: 'reject'): every call will be refused.`,
      );
    else if (usd)
      add(
        'warning',
        'unpriced-model',
        `'${modelId}' has no price: the USD budget is not applied to its calls (the run warns once and goes on; token limits still apply). Add a price with createPriceProvider({ table }), or set unknownPrice: 'reject'.`,
      );
    else
      add(
        'info',
        'unpriced-model',
        `'${modelId}' has no price: the run's cost will be reported as incomplete.`,
      );
  }

  // --- Tools ---
  const tools =
    options.tools === true ||
    (typeof options.tools === 'object' && Object.keys(options.tools).length > 0) ||
    (options.skills?.length ?? 0) > 0;
  if (tools) {
    if (profile.capabilities.tools === 'unsupported')
      add('error', 'tools-unsupported', `'${modelId}' takes no tools on ${protocol}.`, 'tools');
    else if (profile.capabilities.tools === 'unknown')
      add('warning', 'tools-unknown', `Whether '${modelId}' takes tools is unknown.`, 'tools');
    if (profile.toolProtocols && !profile.toolProtocols.includes(protocol))
      add(
        'error',
        'tool-protocol',
        `'${modelId}' takes tools only on ${profile.toolProtocols.join(', ')}, not on ${protocol}: use the matching factory.`,
        'tools',
      );
  }

  // --- Structured output ---
  const mode = options.output?.mode ?? 'auto';
  const caps = getCapabilities(model);
  const strategy = pickObjectStrategy(
    { model, mode, ...(options.effort !== undefined ? { effort: options.effort } : {}) },
    caps,
  );
  if (
    options.output &&
    strategy === 'json' &&
    profile.capabilities.structuredOutput !== 'supported'
  )
    add(
      'warning',
      'structured-output',
      `Native structured output is ${profile.capabilities.structuredOutput} for '${modelId}': the JSON output rests on the instructions, and validation asks for repairs.`,
      'output',
    );

  // --- Settings the request changes on the way ---
  const thinking = options.effort !== undefined && options.effort !== 'none';
  const asked: [setting: string, from: string][] = [];
  if (options.effort !== undefined) asked.push(['effort', options.effort]);
  if (options.temperature !== undefined) asked.push(['temperature', '*']);
  if (options.topP !== undefined) asked.push(['topP', '*']);
  if (options.toolChoice === 'required') asked.push(['toolChoice', "'required'"]);
  if (typeof options.toolChoice === 'object') asked.push(['toolChoice', "{ type: 'tool' }"]);
  if (mode === 'tool') asked.push(['mode', "'tool'"]);
  if (options.promptCaching !== undefined) asked.push(['promptCaching', '*']);
  for (const [setting, from] of asked) {
    for (const clamp of profile.clamps) {
      if (clamp.setting !== setting || clamp.from !== from) continue;
      if (clamp.when === THINKING && !thinking) continue;
      add(
        'warning',
        clamp.warning,
        clamp.to === 'dropped'
          ? `${setting} ${from === '*' ? '' : `${from} `}is not sent to '${modelId}'${clamp.when ? ` when ${clamp.when}` : ''}.`
          : `${setting} ${from} is sent to '${modelId}' as ${clamp.to}${clamp.when ? ` when ${clamp.when}` : ''}.`,
        setting,
      );
    }
  }

  add(
    'info',
    'not-live-verified',
    `The profile of '${modelId}' is ${profile.checkedAt ? `from documentation checked ${profile.checkedAt}` : 'not from documentation'}, and not verified against the live API.`,
  );

  return JSON.parse(
    JSON.stringify({
      kind: 'deuz-headless-doctor',
      version: 1,
      ok: findings.every((item) => item.severity !== 'error'),
      model: { provider, modelId, protocol },
      support,
      profile,
      structuredOutput: { mode, strategy },
      priced: facts.priced === true,
      apiKey: { source, envVar, inEnvironment },
      node: { version: node.text, required: REQUIRED_NODE, supported },
      findings,
    } satisfies DoctorReport),
  ) as DoctorReport;
}
