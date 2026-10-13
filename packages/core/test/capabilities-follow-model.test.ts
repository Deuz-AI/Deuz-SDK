/**
 * capabilities-follow-model.test.ts (2.3, F26) — the caller's per-call
 * `capabilities` override describes the run's models, so it follows every model
 * switch: a `prepareStep` model and a handoff target, in the legacy loops and in
 * a native run (whose finalization answers with the target's model), and a
 * legacy `fallbackModels` candidate. Before, the switched-to model fell back to
 * its registry row (Anthropic's 4096-token placeholder `max_tokens` for an
 * unknown slug).
 */
import { describe, expect, it } from 'vitest';
import { generateText, streamChat, withFallback, wrapModel } from '../src/index';
import { runAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { handoff } from '../src/inference/handoff';
import { claudeTurn, scriptedFetch, serverError, type ScriptStep } from './fixtures/wire-turns';

const capabilities = { maxOutput: 32_000 };

function claude(id: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createAnthropic({ apiKey: 'k', fetch: wire.fetch })(id), wire };
}

const answer = claudeTurn([{ type: 'text', text: 'done' }]);
const lookup = claudeTurn(
  [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{}' }],
  'tool_use',
);
const transfer = claudeTurn(
  [{ type: 'tool_use', id: 'toolu_t', name: 'transfer_to_expert', json: '{}' }],
  'tool_use',
);
const tools = {
  lookup: { parameters: { type: 'object' as const, properties: {} }, execute: () => 'found' },
};

describe('F26: the capabilities override follows a model switch', () => {
  it('a prepareStep model gets the override (streaming loop)', async () => {
    const root = claude('claude-custom-root', [lookup]);
    const stepped = claude('claude-custom-step', [answer]);
    const result = streamChat({
      model: root.model,
      capabilities,
      prompt: 'go',
      tools,
      maxSteps: 3,
      prepareStep: ({ stepIndex }) => (stepIndex === 1 ? { model: stepped.model } : undefined),
    });
    await result.consume?.();
    expect(root.wire.bodies[0]!.max_tokens).toBe(32_000);
    expect(stepped.wire.bodies[0]!.max_tokens).toBe(32_000);
  });

  it('a handoff target gets the override (buffered loop)', async () => {
    const root = claude('claude-custom-root', [transfer]);
    const expert = claude('claude-custom-expert', [answer]);
    const result = await generateText({
      model: root.model,
      capabilities,
      prompt: 'go',
      maxSteps: 3,
      tools: handoff({ expert: { model: expert.model, instructions: 'You are the expert.' } }),
    });
    expect(result.text).toBe('done');
    expect(expert.wire.bodies[0]!.max_tokens).toBe(32_000);
  });

  it('a native run carries it to the handoff target, finalization included', async () => {
    const root = claude('claude-custom-root', [transfer]);
    const expert = claude('claude-custom-expert', [
      answer,
      claudeTurn([{ type: 'text', text: '{"answer":1}' }]),
    ]);
    const result = await runAgent({
      model: root.model,
      capabilities,
      prompt: 'go',
      tools: handoff({ expert: { model: expert.model } }),
      output: {
        schema: { type: 'object', properties: { answer: { type: 'number' } } },
        mode: 'json',
        validate: (value) => value as { answer: number },
      },
    });
    expect(result.status).toBe('completed');
    expect(expert.wire.bodies).toHaveLength(2);
    expect(expert.wire.bodies.map((body) => body.max_tokens)).toEqual([32_000, 32_000]);
  });

  it('a legacy fallbackModels candidate gets the override (generateText)', async () => {
    const primary = claude('claude-custom-a', [serverError]);
    const fallback = claude('claude-custom-b', [answer]);
    const result = await generateText({
      model: primary.model,
      capabilities,
      prompt: 'go',
      maxRetries: 0,
      fallbackModels: [fallback.model],
    });
    expect(result.text).toBe('done');
    expect(primary.wire.bodies[0]!.max_tokens).toBe(32_000);
    expect(fallback.wire.bodies[0]!.max_tokens).toBe(32_000);
  });

  it('a legacy fallbackModels candidate gets the override (streamChat)', async () => {
    const primary = claude('claude-custom-a', [serverError]);
    const fallback = claude('claude-custom-b', [answer]);
    const result = streamChat({
      model: primary.model,
      capabilities,
      prompt: 'go',
      maxRetries: 0,
      fallbackModels: [fallback.model],
    });
    await result.consume?.();
    expect(fallback.wire.bodies).toHaveLength(1);
    expect(primary.wire.bodies[0]!.max_tokens).toBe(32_000);
    expect(fallback.wire.bodies[0]!.max_tokens).toBe(32_000);
  });

  it('a withFallback candidate gets the override', async () => {
    const primary = claude('claude-custom-a', [serverError]);
    const fallback = claude('claude-custom-b', [answer]);
    const wrapped = wrapModel(primary.model, [withFallback([fallback.model])]);
    const result = await wrapped.generateText({ capabilities, prompt: 'go', maxRetries: 0 });
    expect(result.text).toBe('done');
    expect(primary.wire.bodies[0]!.max_tokens).toBe(32_000);
    expect(fallback.wire.bodies[0]!.max_tokens).toBe(32_000);
  });
});
