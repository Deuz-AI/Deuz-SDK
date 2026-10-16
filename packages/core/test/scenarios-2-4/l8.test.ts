/**
 * Lane L8 acceptance scenarios (new.txt §5.1, area `skill`): a skill draft
 * comes only from a verified run, its projection filters what the model may
 * read, every method step cites the run, and the output is an inert
 * `SKILL.md` that passes `parseSkill` within its own budget. Each scenario
 * builds its run, model, store and dependencies inside.
 */
import { expect } from 'vitest';
import { createInMemoryAgentRunStore, runAgent } from '../../src/agent-run';
import { sha256Digest } from '../../src/internal/digest';
import { parseSkill } from '../../src/skills';
import { proposeSkillFromRun, SkillLearningError } from '../../src/skills/learning';
import { projectRun } from '../../src/skills/learning/projection';
import { createMockModel } from '../../src/testing';
import type { AgentVerification } from '../../src/types/agent-run';
import { SECRETS, draftJson, recordingModel, verifiedRun } from '../fixtures/skill-runs';
import { scenario } from './registry';

const parameters = { type: 'object', properties: {} };

/** A real native run: one tool call, one answer, then the host's verifier. */
async function nativeRun(runId: string, verdict: AgentVerification | undefined) {
  const store = createInMemoryAgentRunStore();
  const model = createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'lookup_policy', id: 'call_p', args: { topic: 'refunds' } }] },
      { text: 'Refunds over 500 euros need a manager approval.' },
    ],
  });
  await runAgent({
    model,
    prompt: 'What does the refund policy say about large refunds?',
    session: { store, scope: 'tenant-s', runId },
    tools: {
      lookup_policy: {
        parameters,
        execute: () => ({ text: 'Refunds over 500 EUR: manager approval.' }),
      },
    },
    ...(verdict ? { verify: () => verdict } : {}),
  });
  return (await store.load(runId))!;
}

const nativeDraft = () =>
  draftJson({
    name: 'refund-policy-lookup',
    description: 'Answers refund policy questions from the policy tool.',
    steps: [
      { text: 'Look the topic up with the policy tool.', sources: ['S2', 'S3'] },
      { text: 'Answer with the threshold and the approval it needs.', sources: ['S4'] },
    ],
    allowedTools: ['lookup_policy'],
  });

scenario('skill', 'source-run-must-be-verified', async () => {
  const verified = await nativeRun('run-verified', { status: 'verified' });
  const inconclusive = await nativeRun('run-inconclusive', { status: 'inconclusive' });
  const unverified = await nativeRun('run-unverified', undefined);
  expect(verified).toMatchObject({ phase: 'terminal', verification: 'verified' });
  expect(unverified).toMatchObject({ phase: 'terminal', result: { status: 'completed' } });

  for (const run of [inconclusive, unverified]) {
    const { model, calls } = recordingModel([{ text: nativeDraft() }]);
    const refused = await proposeSkillFromRun({ run, model, budget: { tokens: 20_000 } }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SkillLearningError);
    expect((refused as SkillLearningError).code).toBe('source_not_eligible');
    expect(calls()).toBe(0);
  }

  const { model, calls } = recordingModel([{ text: nativeDraft() }]);
  const proposal = await proposeSkillFromRun({
    run: verified,
    model,
    budget: { tokens: 20_000 },
  });
  expect(calls()).toBe(1);
  expect(proposal).toMatchObject({
    status: 'proposed',
    evaluation: 'not-evaluated',
    allowedTools: ['lookup_policy'],
    source: { runId: 'run-verified', scope: 'tenant-s', revision: verified.revision },
  });
});

scenario('skill', 'projection-filters-content', async () => {
  const { model, requests } = recordingModel([{ text: draftJson() }]);
  await proposeSkillFromRun({
    run: verifiedRun(),
    model,
    budget: { tokens: 20_000 },
    toolSummaries: { call_3: 'The health check answered ok.' },
  });
  const [body, ...more] = requests();
  expect(more).toEqual([]);
  const wire = JSON.stringify(body);
  // No reasoning (plain, encrypted, redacted), signature, provider metadata,
  // raw tool result, recall, host system prompt or SDK feedback turn.
  expect(Object.entries(SECRETS).filter(([, secret]) => wire.includes(secret))).toEqual([]);
  expect(wire).toContain('tool result health_check (call_3): The health check answered ok.');
  expect(wire).toContain('tool result get_version (call_1): omitted');

  // A projection over the limit is refused before the call, never cut.
  const small = recordingModel([{ text: draftJson() }]);
  const refused = await proposeSkillFromRun({
    run: verifiedRun(),
    model: small.model,
    budget: { tokens: 20_000 },
    maxSourceChars: 200,
  }).catch((error: unknown) => error);
  expect((refused as SkillLearningError).code).toBe('source_too_large');
  expect(small.calls()).toBe(0);
});

scenario('skill', 'steps-cite-sources', async () => {
  const run = verifiedRun();
  const projection = await projectRun(run);
  const items = new Map(projection.items.map((item) => [item.digest, item]));
  const { model } = recordingModel([{ text: draftJson() }]);
  const proposal = await proposeSkillFromRun({ run, model, budget: { tokens: 20_000 } });
  expect(proposal.steps.length).toBeGreaterThan(0);
  for (const step of proposal.steps) {
    expect(step.sources.length).toBeGreaterThan(0);
    for (const ref of step.sources) {
      // Each reference resolves to a projected item of this run, by digest.
      const item = items.get(ref.digest)!;
      expect(item).toBeDefined();
      expect(ref).toMatchObject({ runId: run.runId, messageId: item.messageId });
      expect(await sha256Digest(item.content)).toBe(ref.digest);
      if (item.toolCallId) expect(ref.toolCallId).toBe(item.toolCallId);
    }
  }

  // A step citing an item the record does not have is refused.
  const bad = recordingModel([
    { text: draftJson({ steps: [{ text: 'Invent a step.', sources: ['S40'] }] }) },
  ]);
  const refused = await proposeSkillFromRun({
    run,
    model: bad.model,
    budget: { tokens: 20_000 },
  }).catch((error: unknown) => error);
  expect((refused as SkillLearningError).code).toBe('invalid_proposal');
});

scenario('skill', 'inert-parseskill-valid-output-within-budget', async () => {
  const run = verifiedRun();
  const before = structuredClone(run);
  const { model, requests } = recordingModel([
    { text: draftJson(), usage: { inputTokens: 700, outputTokens: 180 } },
  ]);
  const budget = { tokens: 20_000 };
  const proposal = await proposeSkillFromRun({ run, model, budget });

  // Inert: proposed and not evaluated; a plain JSON value; the run untouched.
  expect(proposal.status).toBe('proposed');
  expect(proposal.evaluation).toBe('not-evaluated');
  expect(JSON.parse(JSON.stringify(proposal))).toEqual(proposal);
  expect(run).toEqual(before);
  // parseSkill-valid, and the manifest is what parseSkill reads.
  const parsed = parseSkill(proposal.skillMd);
  expect(parsed.issues).toEqual([]);
  expect(parsed.manifest).toEqual(proposal.manifest);
  expect(proposal.manifest.name).toMatch(/^[a-z0-9-]{1,64}$/);
  expect(proposal.manifest.description.length).toBeLessThanOrEqual(1024);
  // One call, capped at 2048 output tokens, charged within its own budget.
  expect(requests()).toHaveLength(1);
  const [body] = requests();
  expect(body!.max_tokens ?? body!.max_completion_tokens).toBe(2048);
  expect(proposal.cost.usage.totalTokens).toBe(880);
  expect(proposal.cost.usage.totalTokens).toBeLessThanOrEqual(budget.tokens);

  // A budget that cannot hold the call refuses it before any request.
  const tight = recordingModel([{ text: draftJson() }]);
  await expect(
    proposeSkillFromRun({ run, model: tight.model, budget: { tokens: 500 } }),
  ).rejects.toMatchObject({ code: 'budget_exceeded' });
  expect(tight.calls()).toBe(0);
});
