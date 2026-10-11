/**
 * doctor (2.3 preview, 23.8): why a provider / model / configuration will not
 * work, reported before any call and without one.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createDeepSeek, createOllama, createPerplexity } from '../src/providers-compat';
import { HEADLESS_EXIT_CODES, doctor, exitCodeFor } from '../src/node/headless';
import type { DoctorReport } from '../src/node/headless';

const codes = (report: DoctorReport) => report.findings.map((finding) => finding.code);
const finding = (report: DoctorReport, code: string) =>
  report.findings.find((item) => item.code === code);

/** A fetch that fails the test if anything dials out. */
const noNetwork = vi.fn(async () => {
  throw new Error('doctor must not make a network call');
}) as unknown as typeof fetch;

const node = { nodeVersion: '24.19.0', env: {} };

describe('doctor (headless preview)', () => {
  it('reports a known, priced model: its profile, support level and output strategy', async () => {
    const model = createAnthropic({ apiKey: 'sk-test', fetch: noNetwork })('claude-opus-5-5');
    const report = await doctor({ model, effort: 'max', output: { mode: 'tool' }, ...node });
    expect(report).toMatchObject({
      kind: 'deuz-headless-doctor',
      version: 1,
      ok: true,
      model: { provider: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic' },
      support: 'pinned',
      priced: true,
      apiKey: { source: 'factory', envVar: 'ANTHROPIC_API_KEY', inEnvironment: false },
      node: { version: '24.19.0', supported: true },
      structuredOutput: { mode: 'tool', strategy: 'json' },
    });
    expect(report.profile.protocol).toBe('anthropic');
    expect(report.profile.effort.levels).toContain('max');
    expect(report.profile.liveVerified).toBe(false);
    // The forced tool strategy cannot be taken: reported, not an error.
    expect(finding(report, 'clamped-setting')).toMatchObject({
      severity: 'warning',
      setting: 'mode',
    });
    expect(codes(report)).not.toContain('unknown-model');
    expect(codes(report)).toContain('not-live-verified');
    expect(JSON.stringify(report)).not.toContain('sk-test');
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(noNetwork).not.toHaveBeenCalled();
    expect(exitCodeFor(report)).toBe(0);
  });

  it('reports the settings a model changes or drops', async () => {
    const model = createAnthropic({ apiKey: 'k' })('claude-opus-5-5');
    const report = await doctor({ model, temperature: 0.2, toolChoice: 'required', ...node });
    const settings = report.findings
      .filter((item) => item.code === 'unsupported-setting' || item.code === 'clamped-setting')
      .map((item) => item.setting);
    expect(settings).toEqual(expect.arrayContaining(['temperature', 'toolChoice']));
    expect(report.ok).toBe(true);
  });

  it('warns about an unknown model: conservative defaults, nothing verified', async () => {
    const model = createOpenAI({ apiKey: 'k' })('gpt-imaginary-9');
    const report = await doctor({ model, ...node });
    expect(report.support).toBe('unknown');
    expect(report.profile.match).toBe('fallback');
    expect(finding(report, 'unknown-model')).toMatchObject({ severity: 'warning' });
    expect(report.ok).toBe(true);
  });

  it('warns about an unpriced model under a USD budget, and errors in strict mode', async () => {
    const model = createDeepSeek({ apiKey: 'k' })('deepseek-v4-pro');
    const lenient = await doctor({ model, budget: { usd: 5 }, ...node });
    expect(lenient.priced).toBe(false);
    expect(finding(lenient, 'unpriced-model')).toMatchObject({ severity: 'warning' });
    expect(lenient.ok).toBe(true);

    const strict = await doctor({ model, budget: { usd: 5, unknownPrice: 'reject' }, ...node });
    expect(finding(strict, 'unpriced-model')).toMatchObject({ severity: 'error' });
    expect(strict.ok).toBe(false);
    expect(exitCodeFor(strict)).toBe(HEADLESS_EXIT_CODES.doctor);

    const unbudgeted = await doctor({ model, ...node });
    expect(finding(unbudgeted, 'unpriced-model')).toMatchObject({ severity: 'info' });
  });

  it('uses the caller price provider when deps carry one', async () => {
    const model = createDeepSeek({ apiKey: 'k' })('deepseek-v4-pro');
    const report = await doctor({
      model,
      budget: { usd: 5 },
      deps: { priceProvider: { priceUsage: () => 0.01 } },
      ...node,
    });
    expect(report.priced).toBe(true);
    expect(codes(report)).not.toContain('unpriced-model');
  });

  it('finds a missing API key, and a key left in the environment', async () => {
    const model = createAnthropic()('claude-opus-5-5');
    const missing = await doctor({ model, ...node });
    expect(missing.apiKey).toEqual({
      source: 'missing',
      envVar: 'ANTHROPIC_API_KEY',
      inEnvironment: false,
    });
    expect(finding(missing, 'missing-api-key')).toMatchObject({ severity: 'error' });
    expect(finding(missing, 'missing-api-key')!.message).toContain('ANTHROPIC_API_KEY');
    expect(exitCodeFor(missing)).toBe(HEADLESS_EXIT_CODES.doctor);

    // Core never reads the environment: a key there still has to reach the factory.
    const unpassed = await doctor({
      model,
      nodeVersion: '24.19.0',
      env: { ANTHROPIC_API_KEY: 'sk-secret' },
    });
    expect(unpassed.apiKey).toMatchObject({ source: 'missing', inEnvironment: true });
    expect(finding(unpassed, 'missing-api-key')!.message).toMatch(/factory/);
    expect(JSON.stringify(unpassed)).not.toContain('sk-secret');

    const named = await doctor({
      model,
      apiKeyEnv: 'MY_KEY',
      env: { MY_KEY: 'x' },
      nodeVersion: '24.0.0',
    });
    expect(named.apiKey).toMatchObject({ envVar: 'MY_KEY', inEnvironment: true });
  });

  it('needs no key for a keyless local host, and trusts a key provider', async () => {
    const local = await doctor({ model: createOllama()('qwen3'), ...node });
    expect(local.apiKey.source).toBe('keyless');
    expect(codes(local)).not.toContain('missing-api-key');

    const provided = await doctor({
      model: createAnthropic()('claude-opus-5-5'),
      deps: { keyProvider: { getKey: () => 'k' } },
      ...node,
    });
    expect(provided.apiKey.source).toBe('key-provider');
    expect(provided.ok).toBe(true);
  });

  it('reports tools a model cannot take, or takes only on another protocol', async () => {
    const sonar = await doctor({
      model: createPerplexity({ apiKey: 'k' })('sonar'),
      tools: true,
      ...node,
    });
    expect(finding(sonar, 'tools-unsupported')).toMatchObject({ severity: 'error' });

    const chat = await doctor({
      model: createOpenAI({ apiKey: 'k' })('gpt-6.1-sol'),
      tools: { look: { description: 'Look.', parameters: { type: 'object' } } },
      ...node,
    });
    expect(finding(chat, 'tool-protocol')).toMatchObject({ severity: 'error' });
    expect(finding(chat, 'tool-protocol')!.message).toContain('responses');

    const responses = await doctor({
      model: createOpenAIResponses({ apiKey: 'k' })('gpt-6.1-sol'),
      tools: true,
      ...node,
    });
    expect(codes(responses)).not.toContain('tool-protocol');
    expect(responses.ok).toBe(true);
  });

  it('rejects an unsupported Node version and flags one without node:sqlite', async () => {
    const model = createAnthropic({ apiKey: 'k' })('claude-opus-5-5');
    const old = await doctor({ model, nodeVersion: 'v20.11.1', env: {} });
    expect(old.node).toMatchObject({ version: '20.11.1', supported: false });
    expect(finding(old, 'node-version')).toMatchObject({ severity: 'error' });
    expect(old.ok).toBe(false);

    const early = await doctor({ model, nodeVersion: '22.5.0', env: {} });
    expect(early.node.supported).toBe(true);
    expect(finding(early, 'node-sqlite')).toMatchObject({ severity: 'warning' });
    expect(codes(await doctor({ model, nodeVersion: '22.13.0', env: {} }))).not.toContain(
      'node-sqlite',
    );
  });

  it('reads the environment and Node version of this process by default', async () => {
    const report = await doctor({ model: createOllama()('qwen3') });
    expect(report.node.version).toBe(process.versions.node);
  });
});
