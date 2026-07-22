import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createMockModel } from '../src/testing';
import type { StreamPart } from '../src/types/stream';
import type { VerifyStepContext } from '../src/types/config';

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
});
