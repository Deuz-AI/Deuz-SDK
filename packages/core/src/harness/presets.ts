/**
 * harness/presets.ts — how to start the known coding harnesses as ACP agents
 * and point their model traffic at a deuz meter (2.5). The facts were read
 * from documentation on the `checkedAt` date; the Claude Code and Codex
 * presets were also run live on 2026-11-24 (see their `verification.notes`).
 * `verification` says how far each one is confirmed. Edge-safe: data only.
 */
import type { HarnessPreset, HarnessSpec } from './types';

const CHECKED_AT = '2026-11-23';

/**
 * The environment variables that switch Claude Code to another model
 * provider (Amazon Bedrock, Bedrock Mantle, Google Cloud's Agent Platform,
 * Microsoft Foundry, Claude Platform on AWS, Claude Models on Google Cloud),
 * as Claude Code's environment-variable reference lists them on 2026-11-24.
 * Its traffic then ignores `ANTHROPIC_BASE_URL` and goes around the meter.
 */
export const CLAUDE_CODE_PROVIDER_SWITCHES: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
];

/**
 * Claude Code through its ACP adapter (`@agentclientprotocol/claude-agent-acp`,
 * formerly `@zed-industries/claude-code-acp`), metered as Anthropic Messages.
 * `ANTHROPIC_BASE_URL` is documented for Claude Code itself; the adapter runs
 * Claude Code through the Claude Agent SDK, which starts the CLI with the
 * adapter's environment, so the variable reaches it (the adapter's README does
 * not say so in words). Without `ANTHROPIC_API_KEY` a claude.ai subscription
 * login still goes through the meter (Claude Code's docs say a base URL alone
 * keeps the login); the meter then prices that traffic at API rates although
 * the subscription is not billed per token.
 *
 * Run live on 2026-11-24 (Windows 11, Node 26.13.0, Claude Code 2.1.331,
 * claude-agent-acp 0.110.1 with claude-agent-sdk 0.3.330, subscription
 * login): see `verification.notes`. The adapter starts sessions in the
 * permission mode of the user's Claude Code settings (`bypassPermissions`,
 * or `auto` when none is set), and in those modes it sends no permission
 * requests. So the preset opens each session with
 * `allowDangerouslySkipPermissions: false` in `_meta` and switches it to the
 * `default` mode, where every tool call is asked about; the run fails if the
 * adapter refuses the switch. With a budget, `runHarness` refuses to start
 * while a provider switch ({@link CLAUDE_CODE_PROVIDER_SWITCHES}) is set.
 * Claude Code's settings files can set the same variables (`env`), and those
 * are not checked.
 */
export const claudeCodeHarness: HarnessPreset = {
  name: 'claude-code',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  windowsShell: true,
  meterable: 'anthropic',
  env: (meterUrl) => ({ ANTHROPIC_BASE_URL: meterUrl }),
  unmeteredEnv: CLAUDE_CODE_PROVIDER_SWITCHES,
  sessionMode: 'default',
  sessionMeta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
  verification: {
    acpEntryPoint: 'documented',
    baseUrl: 'documented',
    verifiedLive: true,
    checkedAt: '2026-11-24',
    sources: [
      'https://github.com/agentclientprotocol/claude-agent-acp',
      'https://code.claude.com/docs/en/env-vars',
      'https://code.claude.com/docs/en/llm-gateway',
    ],
    notes:
      'Verified live on 2026-11-24 (Windows 11, Node 26.13.0, Claude Code 2.1.331, @agentclientprotocol/claude-agent-acp 0.110.1 ' +
      'with @anthropic-ai/claude-agent-sdk 0.3.330, claude.ai subscription login, no API key, model haiku = claude-haiku-5-5): ' +
      '`npx -y @agentclientprotocol/claude-agent-acp` starts through a shell on Windows and picks up the subscription login; ' +
      'ANTHROPIC_BASE_URL reaches Claude Code, which sends HEAD /api/hello and POST /v1/messages to the meter with its OAuth bearer ' +
      '(no count_tokens, model listing or telemetry on the base URL); every /v1/messages was measured and priced, and the declared ' +
      'cost (usage_update) matched the measured one within $0.000001. A 402 from the meter ended the turn after one request, with no retry. ' +
      'Permission requests arrive only when the session is in the `default` mode: the adapter takes its start mode from the ' +
      "user's settings (here bypassPermissions, which wrote a file a deny policy should have stopped). Sending session/new with " +
      '_meta.claudeCode.options.allowDangerouslySkipPermissions false and then session/set_mode "default" made the edit request ' +
      'arrive and the policy deny it (the adapter logged that it ignored bypassPermissions); the preset now does both. ' +
      "runHarness('claude-code') with this preset, re-run live the same day: result.sessionMode 'default', the edit permission " +
      'request arrived, a deny-writes policy refused it and the file was not written (toolCalls observed 1, decided 1, denied 1, ' +
      'observedOnly 0); measured $0.011074 against declared $0.01107382, comparison consistent. ' +
      'CLAUDE_CODE_EXECUTABLE selects an installed claude. Remote Control is disabled when the ' +
      'base URL is not api.anthropic.com.',
  },
};

/** The Codex model provider the {@link codexHarness} preset defines to reach the meter. */
const CODEX_METER_PROVIDER = 'deuz-meter';

/**
 * Codex CLI through its ACP adapter (`@agentclientprotocol/codex-acp`), metered
 * as OpenAI Responses over HTTP. The preset defines its own Codex model
 * provider in the adapter's `CODEX_CONFIG` (the adapter passes
 * `model_provider` and `model_providers.<id>` to Codex at start): base URL
 * `<meter>/v1`, `wire_api = "responses"`, `requires_openai_auth = true`
 * (Codex's own login is used, ChatGPT or API key) and
 * `supports_websockets = false`. Both settings are needed: a ChatGPT login
 * ignores `OPENAI_BASE_URL`, and Codex's built-in provider sends its turns over
 * a Responses WebSocket, which the meter cannot carry. `OPENAI_BASE_URL` is
 * still set for older adapters.
 *
 * Where the meter must forward depends on the login, and the preset cannot
 * tell which one Codex has. An API key needs the default OpenAI upstream
 * (`https://api.openai.com`). A ChatGPT login needs ChatGPT's Codex backend,
 * mounted at `/v1`:
 * `meter: { upstreams: [{ provider: 'openai', kind: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex', mount: '/v1' }] }`.
 * That traffic is billed to the ChatGPT plan, not per token; the meter prices
 * it at API rates. Run live on 2026-11-24 with a ChatGPT login: see
 * `verification.notes`.
 */
export const codexHarness: HarnessPreset = {
  name: 'codex',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/codex-acp'],
  windowsShell: true,
  meterable: 'openai',
  env: (meterUrl) => ({
    OPENAI_BASE_URL: `${meterUrl}/v1`,
    CODEX_CONFIG: JSON.stringify({
      model_provider: CODEX_METER_PROVIDER,
      model_providers: {
        [CODEX_METER_PROVIDER]: {
          name: 'deuz meter',
          base_url: `${meterUrl}/v1`,
          wire_api: 'responses',
          requires_openai_auth: true,
          supports_websockets: false,
        },
      },
    }),
  }),
  verification: {
    acpEntryPoint: 'documented',
    baseUrl: 'partial',
    // Run live (see notes), but before the meter read the ChatGPT backend's
    // replies (no content-type) as SSE; that fix is unit-tested only, so
    // metering is not confirmed live.
    verifiedLive: false,
    checkedAt: '2026-11-24',
    sources: [
      'https://github.com/agentclientprotocol/codex-acp',
      'https://learn.chatgpt.com/docs/config-file/config-advanced',
      'https://learn.chatgpt.com/docs/config-file/environment-variables',
    ],
    notes:
      'Verified live on 2026-11-24 with a ChatGPT login and no API key (Windows 11, Node 26.13.0, model gpt-5.6-luna, reasoning ' +
      'effort low). Codex CLI 0.166.0 on its own: OPENAI_BASE_URL is ignored (no request reached the meter); the turn goes over a ' +
      "Responses WebSocket to ChatGPT's Codex backend (https://chatgpt.com/backend-api/codex, path /responses), with GET /models " +
      'and analytics on the same host. -c openai_base_url moves the built-in provider, but it still opens a WebSocket (GET ' +
      '/v1/responses upgrade) and fails when that is refused, with no HTTP fallback. A custom provider with requires_openai_auth = ' +
      'true and supports_websockets = false sends POST <base_url>/responses (SSE, stream: true) with the ChatGPT bearer and ' +
      'chatgpt-account-id headers; through the meter with the Codex backend as upstream it completed, Codex said OK, and a 402 ' +
      'from the meter was retried five times (6 requests, none forwarded) before Codex exited 1. The backend answers /responses ' +
      'with no content-type, so the meter as run then read the stream as JSON, found no usage and charged the estimate; with ' +
      'text/event-stream forced it measured 10,484 input + 5 output tokens, as Codex reported. The meter now reads a 2xx reply ' +
      'to a stream: true request as SSE unless its content-type says JSON (unit test only; not re-run live). Through the ACP adapter ' +
      '(@agentclientprotocol/codex-acp 2.10.0, bundled Codex 0.171.0) runHarness with this preset and the /v1-mounted backend ' +
      'upstream started on Windows through a shell, used the stored ChatGPT login without an ACP authenticate call, routed ' +
      'POST /v1/responses through the meter and ended the turn with "OK"; the adapter sent no usage_update cost. API-key login ' +
      'was not tried (no key here), nor a ChatGPT login against the default api.openai.com upstream.',
  },
};

/**
 * Gemini CLI in ACP mode (`gemini --acp`). Its model traffic is Google's
 * Gemini API, which the meter does not speak (it meters Anthropic Messages and
 * OpenAI Chat/Responses only), so nothing is rerouted: a Gemini run has
 * declared cost only and NO measured cost and NO budget ceiling. Older Gemini
 * CLI releases used `--experimental-acp`.
 */
export const geminiCliHarness: HarnessPreset = {
  name: 'gemini-cli',
  command: 'gemini',
  args: ['--acp'],
  windowsShell: true,
  meterable: 'none',
  env: () => ({}),
  verification: {
    acpEntryPoint: 'documented',
    baseUrl: 'unsupported',
    verifiedLive: false,
    checkedAt: CHECKED_AT,
    sources: ['https://geminicli.com/docs/cli/acp-mode/'],
    notes:
      '`gemini --acp` is the documented ACP mode (older guides: --experimental-acp). GOOGLE_GEMINI_BASE_URL reroutes traffic ' +
      'according to third-party gateway guides only, and the meter cannot meter the Gemini API, so the preset sets nothing.',
  },
};

/**
 * OpenCode in ACP mode (`opencode acp`). Base URLs are provider options in
 * OpenCode's config (`provider.<id>.options.baseURL`), and
 * `OPENCODE_CONFIG_CONTENT` carries inline config as the last override layer,
 * so the preset sets the Anthropic and OpenAI providers' `baseURL` there (to
 * `<meter>/v1`). This replaces any `OPENCODE_CONFIG_CONTENT` the environment
 * already had. OpenCode's v2 docs moved to `providers.<id>.settings.baseURL`;
 * the preset uses the v1 shape. Providers other than Anthropic and OpenAI are
 * not rerouted.
 */
export const opencodeHarness: HarnessPreset = {
  name: 'opencode',
  command: 'opencode',
  args: ['acp'],
  windowsShell: true,
  meterable: 'anthropic+openai',
  env: (meterUrl) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        anthropic: { options: { baseURL: `${meterUrl}/v1` } },
        openai: { options: { baseURL: `${meterUrl}/v1` } },
      },
    }),
  }),
  verification: {
    acpEntryPoint: 'documented',
    baseUrl: 'partial',
    verifiedLive: false,
    checkedAt: CHECKED_AT,
    sources: [
      'https://opencode.ai/docs/acp/',
      'https://opencode.ai/docs/providers/',
      'https://opencode.ai/v1/docs/config/',
    ],
    notes:
      '`opencode acp` is documented. provider.<id>.options.baseURL is documented (v1 schema; v2 uses providers.<id>.settings.baseURL). ' +
      'OPENCODE_CONFIG_CONTENT is listed in the v1 config load order, but its value format (a JSON string) is not spelled out.',
  },
};

/** The known harnesses by name. */
export const HARNESS_PRESETS = {
  'claude-code': claudeCodeHarness,
  codex: codexHarness,
  'gemini-cli': geminiCliHarness,
  opencode: opencodeHarness,
} as const satisfies Record<string, HarnessPreset>;

/** A preset name. */
export type HarnessPresetName = keyof typeof HARNESS_PRESETS;

/** The default environment of a {@link HarnessSpec} without its own `env`: both API families. */
export function defaultHarnessEnv(meterUrl: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: meterUrl, OPENAI_BASE_URL: `${meterUrl}/v1` };
}

/** A preset by name, a preset, or a spec, as one resolved shape. @internal */
export function resolveHarness(harness: HarnessPresetName | HarnessPreset | HarnessSpec): {
  name: string;
  command: string;
  args: readonly string[];
  windowsShell: boolean;
  meterable: HarnessPreset['meterable'] | 'unknown';
  env: (meterUrl: string) => Record<string, string>;
  unmeteredEnv: readonly string[];
  sessionMode?: string;
  sessionMeta?: HarnessPreset['sessionMeta'];
} {
  if (typeof harness === 'string') {
    const preset = (HARNESS_PRESETS as Record<string, HarnessPreset>)[harness];
    if (!preset)
      throw new TypeError(
        `Unknown harness preset '${harness}'. Known: ${Object.keys(HARNESS_PRESETS).join(', ')}.`,
      );
    return resolveHarness(preset);
  }
  if (
    !harness ||
    typeof harness.command !== 'string' ||
    harness.command === '' ||
    typeof harness.name !== 'string' ||
    harness.name === ''
  ) {
    throw new TypeError('A harness needs a non-empty name and command.');
  }
  const preset = 'verification' in harness ? harness : undefined;
  return {
    name: harness.name,
    command: harness.command,
    args: harness.args ?? [],
    windowsShell: harness.windowsShell ?? false,
    meterable: preset ? preset.meterable : 'unknown',
    env: harness.env ? (url) => harness.env!(url) : defaultHarnessEnv,
    unmeteredEnv: harness.unmeteredEnv ?? (preset ? [] : CLAUDE_CODE_PROVIDER_SWITCHES),
    ...(harness.sessionMode !== undefined ? { sessionMode: harness.sessionMode } : {}),
    ...(harness.sessionMeta !== undefined ? { sessionMeta: harness.sessionMeta } : {}),
  };
}
