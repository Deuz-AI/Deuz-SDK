/**
 * Source runs for `proposeSkillFromRun` (2.4, spec §2.6): a terminal,
 * completed and verified native run, as a 2.3 envelope with its transcript,
 * the same run without a transcript (its history carries the SDK's own turns)
 * and as a V3 envelope. Every piece of content the projection must drop
 * carries a SECRET marker, so a test can search the request body for it.
 */
import type { AgentRunEnvelope, AgentToolReceipt } from '../../src/types/agent-run';
import type { AgentRunEnvelopeV3 } from '../../src/types/agent-run-v3';
import type { Message } from '../../src/types/message';
import { readConfig } from '../../src/internal/config-symbol';
import { createMockModel, type MockResponse } from '../../src/testing';
import type { LanguageModel } from '../../src/types/model';

/** Content markers that must never reach the proposal request. */
export const SECRETS = {
  reasoning: 'SECRET-REASONING-chain',
  encrypted: 'SECRET-ENCRYPTED-blob',
  redacted: 'SECRET-REDACTED-data',
  signature: 'SECRET-SIGNATURE',
  providerMetadata: 'SECRET-PROVIDER-META',
  rawResult: 'SECRET-RAW-RESULT',
  recall: 'SECRET-RECALL-memory',
  system: 'SECRET-SYSTEM-instructions',
  verifier: 'SECRET-VERIFIER-feedback',
  contextBlock: 'SECRET-CONTEXT-record',
  summary: 'SECRET-COMPACTION-summary',
  image: 'SECRET-IMAGE-bytes',
} as const;

/** The SDK's own finalization turn (agent-run.ts FINALIZE_PROMPT). */
export const FINALIZE_PROMPT =
  'Now provide the final output in the required format, based on the work above.';

const TASK = 'Deploy the billing service to staging and confirm the health check.';

/** The run's turns, by transcript index. */
function turns(): Message[] {
  return [
    // 0: the caller's input.
    { role: 'user', content: TASK },
    // 1: the run's recall (SDK-internal, system).
    { role: 'system', content: `Relevant memories: ${SECRETS.recall}` },
    // 2: step 1.
    {
      role: 'assistant',
      providerMetadata: { openai: { phase: SECRETS.providerMetadata } },
      content: [
        { type: 'reasoning', text: SECRETS.reasoning, signature: SECRETS.signature },
        {
          type: 'text',
          text: 'I will read the deployed version first.',
          providerMetadata: { google: { thoughtSignature: SECRETS.providerMetadata } },
        },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_version',
          input: { service: 'billing' },
          providerMetadata: { google: { thought_signature: SECRETS.providerMetadata } },
        },
      ],
    },
    // 3
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          result: { version: '1.4.2', token: SECRETS.rawResult },
        },
      ],
    },
    // 4: step 2.
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: SECRETS.encrypted, encrypted: true },
        { type: 'text', text: 'Deploying 1.4.3 to staging.' },
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'deploy',
          input: { service: 'billing', env: 'staging', version: '1.4.3' },
        },
      ],
    },
    // 5
    {
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: 'call_2', result: `deployed ${SECRETS.rawResult}` },
      ],
    },
    // 6: step 3.
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: SECRETS.redacted, redacted: true },
        {
          type: 'tool_use',
          id: 'call_3',
          name: 'health_check',
          input: { service: 'billing', env: 'staging' },
        },
        { type: 'tool_use', id: 'call_4', name: 'page_oncall', input: { reason: 'smoke' } },
      ],
    },
    // 7
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_3',
          result: { status: 'ok', detail: SECRETS.rawResult },
        },
        {
          type: 'tool_result',
          toolUseId: 'call_4',
          result: `permission denied ${SECRETS.rawResult}`,
          isError: true,
        },
      ],
    },
    // 8: the verifier's feedback (SDK-internal).
    { role: 'user', content: `${SECRETS.verifier}: mention the version.` },
    // 9: the final answer.
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Billing 1.4.3 is live on staging; the health check passed.' },
      ],
    },
  ];
}

function receipt(modelStep: number, toolCallId: string, toolName: string): AgentToolReceipt {
  return {
    modelStep,
    toolCallId,
    toolName,
    input: {},
    stage: 'completed',
    rawResult: SECRETS.rawResult,
    modelOutput: SECRETS.rawResult,
  };
}

const RECEIPTS: Record<string, AgentToolReceipt> = {
  '1:call_1': receipt(1, 'call_1', 'get_version'),
  '2:call_2': receipt(2, 'call_2', 'deploy'),
  '3:call_3': receipt(3, 'call_3', 'health_check'),
  '3:call_4': { ...receipt(3, 'call_4', 'page_oncall'), stage: 'failed', error: 'denied' },
};

const USAGE = {
  inputTokens: 900,
  outputTokens: 300,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 1200,
};

/** A verified 2.3 envelope (version 2) whose transcript marks the SDK's own turns. */
export function verifiedRun(overrides: Partial<AgentRunEnvelope> = {}): AgentRunEnvelope {
  const messages = turns();
  return {
    kind: 'deuz-agent-run',
    version: 2,
    runId: 'run-billing',
    revision: 7,
    scope: 'tenant-a',
    phase: 'terminal',
    messages: [{ role: 'system', content: SECRETS.system }, ...messages],
    usage: USAGE,
    modelSteps: 4,
    finalizationAttempts: 1,
    verificationAttempts: 2,
    checkpoints: {},
    verification: 'verified',
    toolResults: structuredClone(RECEIPTS),
    transcript: {
      messages: structuredClone(messages),
      input: 1,
      internal: [1, 8],
      synced: { length: messages.length + 1 },
    },
    result: {
      status: 'completed',
      output: 'Billing 1.4.3 is live on staging; the health check passed.',
      runId: 'run-billing',
      text: 'Billing 1.4.3 is live on staging; the health check passed.',
      messages: [],
      usage: USAGE,
      modelSteps: 4,
      verification: 'verified',
    },
    ...overrides,
  };
}

/**
 * The same run without a transcript (no chat, no memory): its history holds
 * the host's system prompt, a compacted summary, a compiler block, the SDK's
 * finalization and repair turns and the default verifier feedback.
 */
export function verifiedRunWithoutTranscript(): AgentRunEnvelope {
  const run = verifiedRun();
  const messages = turns();
  delete run.transcript;
  run.messages = [
    { role: 'system', content: SECRETS.system },
    {
      role: 'user',
      content: [{ type: 'text', text: `[Earlier conversation summarized]\n${SECRETS.summary}` }],
    },
    messages[0]!,
    {
      role: 'user',
      content: `<deuz_context pass="1" step="1">\nReference data.\n<record source="memory" kind="memory" id="m1">\n${SECRETS.contextBlock}\n</record>\n</deuz_context>`,
    },
    {
      role: 'user',
      content: [{ type: 'image', image: SECRETS.image, mediaType: 'image/png' }],
    },
    ...messages.slice(2, 8),
    { role: 'user', content: FINALIZE_PROMPT },
    { role: 'assistant', content: 'draft' },
    {
      role: 'user',
      content: 'The final output failed validation: bad shape. Return a corrected final output.',
    },
    { role: 'assistant', content: 'draft 2' },
    { role: 'user', content: 'The output was rejected. Produce a corrected final answer.' },
    messages[9]!,
  ];
  return run;
}

/** The same run as a V3 envelope. */
export function verifiedRunV3(): AgentRunEnvelopeV3 {
  const { memory: _memory, ...run } = verifiedRun();
  return { ...run, version: 3 };
}

/** A mock model whose requests can be read back. */
export function recordingModel(responses: MockResponse[]): {
  model: LanguageModel;
  calls: () => number;
  requests: () => Record<string, unknown>[];
} {
  const model = createMockModel({ responses });
  const config = readConfig(model)!;
  const inner = config.fetch!;
  const bodies: string[] = [];
  config.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return inner(input, init);
  }) as typeof fetch;
  return {
    model,
    calls: () => bodies.length,
    requests: () => bodies.map((body) => JSON.parse(body) as Record<string, unknown>),
  };
}

/**
 * A well-formed draft for the fixture run, as the model would answer. Its
 * item ids follow the transcript projection: S1 task, S2/S3 step 1 text and
 * call, S4 its result, S5/S6 step 2, S7 its result, S8/S9 step 3's calls,
 * S10/S11 their results, S12 the final answer.
 */
export function draftJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'staging-deploy-check',
    description:
      'Deploys a service to staging and confirms its health check. Use when a service must be promoted to staging safely.',
    steps: [
      { text: 'Read the version currently deployed.', sources: ['S2', 'S3'] },
      { text: 'Deploy the next version to staging.', sources: ['S5', 'S6'] },
      { text: 'Run the health check and report the version.', sources: ['S8', 'S10', 'S12'] },
    ],
    limitations: ['Shown for one service only.'],
    allowedTools: ['get_version', 'deploy', 'health_check'],
    ...overrides,
  });
}
