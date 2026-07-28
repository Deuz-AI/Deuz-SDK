import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createMockModel } from '../src/testing';
import { applyUIPart, createAssistantTurn } from '../src/chat';
import { readDeuzStream, toDeuzStreamResponse } from '../src/ui';
import type { AssistantTurnState } from '../src/chat';
import type { Message } from '../src/types/message';
import type { JSONSchema } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import type { VerifyStepContext } from '../src/types/config';

type FalseFinishPart = Extract<StreamPart, { type: 'false-finish' }>;
type FinishPart = Extract<StreamPart, { type: 'finish' }>;
type VerifyStreamPart = Extract<StreamPart, { type: 'verify' }>;

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const rejectionsOf = (parts: StreamPart[]): FalseFinishPart[] =>
  parts.filter((p): p is FalseFinishPart => p.type === 'false-finish');
const finishOf = (parts: StreamPart[]): FinishPart | undefined =>
  parts.find((p): p is FinishPart => p.type === 'finish');
const modelCallsIn = (parts: StreamPart[]): number =>
  parts.filter((p) => p.type === 'step-start').length;

/**
 * The scripted model never calls this tool — it is here only to route the call
 * through the agentic LOOP: `inference/stream-chat.ts` dispatches a call with no
 * `tools`/`chat`/`memory`/`verifyStep` straight to the single-turn stream, and
 * only the loop evaluates the natural-completion hooks.
 */
const ROUTING_TOOLS = {
  noop: {
    description: 'never called by the scripted model',
    parameters: { type: 'object', properties: {}, additionalProperties: false } as JSONSchema,
    execute: async (): Promise<string> => 'unused',
  },
};

describe('verifyStep (buffered generateText)', () => {
  it('re-drives the loop on a rejection and marks verified once it passes', async () => {
    const model = createMockModel({ responses: [{ text: 'draft one' }, { text: 'final answer' }] });
    const attempts: number[] = [];
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'answer me' }],
      verifyStep: (ctx: VerifyStepContext) => {
        attempts.push(ctx.attempt);
        return ctx.attempt === 0 ? { ok: false, feedback: 'be more precise' } : { ok: true };
      },
    });
    expect(attempts).toEqual([0, 1]); // one retry
    expect(res.text).toBe('final answer');
    expect(res.providerMetadata?.deuz?.verified).toBe(true);
    // The rejected feedback was injected as a user turn before the retry.
    expect(
      res.response.messages.some((m) => m.role === 'user' && m.content === 'be more precise'),
    ).toBe(true);
  });

  it('retry:false accepts an unverified answer as-is (single model call)', async () => {
    const model = createMockModel({ responses: [{ text: 'good enough' }] });
    let calls = 0;
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'x' }],
      verifyStep: () => {
        calls++;
        return { ok: false, retry: false };
      },
    });
    expect(calls).toBe(1);
    expect(res.text).toBe('good enough');
    expect(res.providerMetadata?.deuz?.verified).toBe(false);
  });

  it('maxVerifyAttempts caps the number of retries', async () => {
    const model = createMockModel({ responses: [{ text: 'nope' }] }); // repeats
    const attempts: number[] = [];
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'x' }],
      maxVerifyAttempts: 2,
      verifyStep: (ctx) => {
        attempts.push(ctx.attempt);
        return { ok: false, feedback: 'again' };
      },
    });
    expect(attempts).toEqual([0, 1]); // attempt 1: 1+1 < 2 is false → stop
    expect(res.providerMetadata?.deuz?.verified).toBe(false);
  });
});

describe('verifyStep (streaming streamChat)', () => {
  it('emits a verify part per evaluation and re-drives on rejection', async () => {
    const model = createMockModel({ responses: [{ text: 'draft' }, { text: 'final' }] });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'answer' }],
      verifyStep: (ctx) => (ctx.attempt === 0 ? { ok: false, feedback: 'redo' } : { ok: true }),
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);

    const verifyParts = parts.filter(
      (p): p is Extract<StreamPart, { type: 'verify' }> => p.type === 'verify',
    );
    expect(verifyParts).toHaveLength(2);
    expect(verifyParts[0]).toMatchObject({
      attempt: 0,
      ok: false,
      willRetry: true,
      feedback: 'redo',
    });
    expect(verifyParts[1]).toMatchObject({ attempt: 1, ok: true, willRetry: false });

    const finish = parts.find(
      (p): p is Extract<StreamPart, { type: 'finish' }> => p.type === 'finish',
    );
    expect(finish?.providerMetadata?.deuz).toMatchObject({ verified: true });
  });

  it('carries the verdict all the way to the UI wire and the chat reducer (1.9)', async () => {
    // 1.8 emitted the canonical part but `toUIPart` dropped it, so no UI could
    // ever show a verdict. End-to-end: canonical → wire → reducer state.
    const model = createMockModel({ responses: [{ text: 'draft' }, { text: 'final' }] });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'answer' }],
      verifyStep: (ctx) => (ctx.attempt === 0 ? { ok: false, feedback: 'redo' } : { ok: true }),
    });

    let turn: AssistantTurnState = createAssistantTurn('m1');
    for await (const part of readDeuzStream(toDeuzStreamResponse(result, { messageId: 'm1' }))) {
      turn = applyUIPart(turn, part);
    }
    expect(turn.verifications).toEqual([
      { type: 'verify', stepIndex: 0, attempt: 0, ok: false, willRetry: true, feedback: 'redo' },
      { type: 'verify', stepIndex: 1, attempt: 1, ok: true, willRetry: false },
    ]);
    // …and the same run's terminal usage/finishReason are no longer discarded.
    expect(turn.finishReason).toBe('stop');
    expect(turn.usage?.totalTokens).toBeGreaterThan(0);
  });
});

describe('doneWhen / false-finish guard (1.9, N2, buffered loop)', () => {
  it('re-drives a premature finish and accepts the second answer', async () => {
    const model = createMockModel({ responses: [{ text: 'half done' }, { text: 'ALL DONE' }] });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'do both halves' }],
      doneWhen: ({ text }) => text.includes('ALL DONE'),
    });
    expect(res.text).toBe('ALL DONE');
    expect(res.steps).toHaveLength(2);
    // The nudge is a real user turn in the returned history.
    expect(
      res.response.messages.some((m) => m.role === 'user' && typeof m.content === 'string'),
    ).toBe(true);
    expect(res.providerMetadata?.deuz?.stoppedBy).toBeUndefined();
  });

  it('routes a TOOL-LESS call through the loop — the option is never silently ignored', async () => {
    // Regression guard: `doneWhen` only has a natural-completion boundary inside
    // the loop, so a call with no tools/chat/memory/verifyStep must still be
    // routed there. Before the dispatch fix this returned 'nope' unchanged.
    const model = createMockModel({ responses: [{ text: 'nope' }, { text: 'yes done' }] });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'finish it' }],
      doneWhen: ({ text }) => text.includes('done'),
    });
    expect(res.text).toBe('yes done');
  });

  it('accepts the answer and marks stoppedBy once the guard budget is spent', async () => {
    const model = createMockModel({ responses: [{ text: 'never done' }] });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'go' }],
      doneWhen: () => false,
      falseFinishGuard: { maxRetries: 2 },
    });
    expect(res.text).toBe('never done');
    expect(res.providerMetadata?.deuz?.stoppedBy).toBe('false-finish');
  });

  it('is byte-identical to 1.8 when doneWhen is absent', async () => {
    const model = createMockModel({ responses: [{ text: 'once' }] });
    const res = await generateText({ model, messages: [{ role: 'user', content: 'go' }] });
    expect(res.text).toBe('once');
    expect(res.steps ?? []).toHaveLength(0);
    expect(res.providerMetadata?.deuz?.stoppedBy).toBeUndefined();
  });
});

describe('doneWhen / false-finish guard (1.9, N2, streaming loop)', () => {
  it('re-drives a premature finish and accepts the second answer', async () => {
    const model = createMockModel({ responses: [{ text: 'half done' }, { text: 'ALL DONE' }] });
    const judged: string[] = [];
    const stepMessages: Message[][] = [];
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'do both halves' }],
      tools: ROUTING_TOOLS,
      doneWhen: ({ text }) => {
        judged.push(text);
        return text.includes('ALL DONE');
      },
      prepareStep: ({ messages }) => {
        stepMessages.push(messages);
        return undefined;
      },
    });
    const parts = await collect(result.fullStream);

    expect(judged).toEqual(['half done', 'ALL DONE']);
    expect(modelCallsIn(parts)).toBe(2);
    expect(rejectionsOf(parts)).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
    ]);
    // The nudge was injected as a user turn BEFORE the second model call.
    expect(stepMessages).toHaveLength(2);
    const secondCall = stepMessages[1]!;
    const nudge = secondCall.at(-1)!;
    expect(nudge.role).toBe('user');
    expect(String(nudge.content)).toContain('not finished yet');
    // The first call's history is untouched by the retry (immutable history).
    expect(stepMessages[0]!).toHaveLength(1);
    // An answer the guard accepted carries no give-up marker.
    expect(finishOf(parts)?.providerMetadata).toBeUndefined();
    await expect(result.finishReason).resolves.toBe('stop');
  });

  it('emits exactly one part per rejection, all before the terminal finish', async () => {
    // The last scripted response repeats, so the model never stops declaring done.
    const model = createMockModel({ responses: [{ text: 'nope' }] });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools: ROUTING_TOOLS,
      doneWhen: () => false,
    });
    const parts = await collect(result.fullStream);

    // Default budget: TWO re-drives (DEFAULT_FALSE_FINISH_RETRIES), so three
    // rejections — the last one gives up.
    expect(rejectionsOf(parts)).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
      { type: 'false-finish', stepIndex: 1, attempt: 1, willRetry: true },
      { type: 'false-finish', stepIndex: 2, attempt: 2, willRetry: false },
    ]);
    expect(modelCallsIn(parts)).toBe(3);
    const finishIndex = parts.findIndex((p) => p.type === 'finish');
    expect(finishIndex).toBe(parts.length - 1); // terminal
    for (const rejection of rejectionsOf(parts)) {
      expect(parts.indexOf(rejection)).toBeLessThan(finishIndex);
    }
    // Giving up ACCEPTS the answer and records why it stands.
    expect(finishOf(parts)?.providerMetadata?.deuz).toEqual({ stoppedBy: 'false-finish' });
    await expect(result.finishReason).resolves.toBe('stop');
  });

  it('falseFinishGuard:false reports the rejection without re-driving', async () => {
    const model = createMockModel({ responses: [{ text: 'nope' }] });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools: ROUTING_TOOLS,
      doneWhen: () => false,
      falseFinishGuard: false,
    });
    const parts = await collect(result.fullStream);

    expect(modelCallsIn(parts)).toBe(1); // observation-only
    expect(rejectionsOf(parts)).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: false },
    ]);
    expect(finishOf(parts)?.providerMetadata?.deuz).toEqual({ stoppedBy: 'false-finish' });
  });

  it('runs before verifyStep, and the two retry budgets stay independent', async () => {
    // doneWhen rejects 'bad' and accepts 'ok'; verifyStep rejects its own first
    // attempt. The interleaving proves BOTH documented rules at once.
    const model = createMockModel({
      responses: [{ text: 'bad' }, { text: 'ok' }, { text: 'bad' }, { text: 'ok' }],
    });
    const order: string[] = [];
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools: ROUTING_TOOLS,
      doneWhen: ({ text }) => {
        order.push(`done(${text})`);
        return text === 'ok';
      },
      verifyStep: (ctx) => {
        order.push(`verify(${ctx.attempt})`);
        return ctx.attempt === 0 ? { ok: false, feedback: 'redo' } : { ok: true };
      },
    });
    const parts = await collect(result.fullStream);

    // doneWhen FIRST every round; a rejection that re-drives short-circuits
    // verification (no verify() between the two done(bad) entries and their
    // re-drives), and each counter advances only on its OWN rejections.
    expect(order).toEqual([
      'done(bad)', // step 0 rejected → re-drive, verifyStep never consulted
      'done(ok)',
      'verify(0)', // step 1 accepted by the guard → verification rejects it
      'done(bad)', // step 2 rejected again → re-drive, still no verification
      'done(ok)',
      'verify(1)', // step 3 accepted by both
    ]);
    expect(modelCallsIn(parts)).toBe(4);
    expect(rejectionsOf(parts)).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
      // attempt 1: the verify retry in between did NOT consume a guard re-drive.
      { type: 'false-finish', stepIndex: 2, attempt: 1, willRetry: true },
    ]);
    const verifications = parts.filter((p): p is VerifyStreamPart => p.type === 'verify');
    expect(verifications.map((v) => [v.stepIndex, v.attempt, v.ok, v.willRetry])).toEqual([
      [1, 0, false, true],
      // attempt 1: the guard's re-drive did NOT consume a verify attempt either.
      [3, 1, true, false],
    ]);
    // Both budgets still had room, so nothing gave up: verdict only.
    expect(finishOf(parts)?.providerMetadata?.deuz).toEqual({ verified: true });
  });

  it('a give-up marker is dropped again when a later round genuinely finishes', async () => {
    // The guard gives up on step 0 (budget 0), but verifyStep then re-drives and
    // the guard ACCEPTS step 1 — so the answer that ships was not accepted over
    // an objection and must not be marked as if it were.
    const model = createMockModel({ responses: [{ text: 'bad' }, { text: 'ok' }] });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools: ROUTING_TOOLS,
      doneWhen: ({ text }) => text === 'ok',
      falseFinishGuard: { maxRetries: 0 },
      verifyStep: (ctx) => (ctx.attempt === 0 ? { ok: false, feedback: 'redo' } : { ok: true }),
    });
    const parts = await collect(result.fullStream);

    expect(modelCallsIn(parts)).toBe(2);
    expect(rejectionsOf(parts)).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: false },
    ]);
    expect(finishOf(parts)?.providerMetadata?.deuz).toEqual({ verified: true });
  });

  it('a throwing doneWhen propagates as an error part, never a sync throw (G2)', async () => {
    // Caller code, like prepareStep/verifyStep: a broken guard fails loudly
    // instead of silently disarming itself.
    const model = createMockModel({ responses: [{ text: 'x' }] });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools: ROUTING_TOOLS,
      doneWhen: () => {
        throw new Error('predicate exploded');
      },
    });
    const parts = await collect(result.fullStream);

    expect(parts.at(-1)).toMatchObject({ type: 'error' });
    expect(parts.some((p) => p.type === 'finish')).toBe(false);
    expect(rejectionsOf(parts)).toEqual([]);
    await expect(result.usage).rejects.toThrow('predicate exploded');
    await expect(result.finishReason).rejects.toThrow('predicate exploded');
  });
});
