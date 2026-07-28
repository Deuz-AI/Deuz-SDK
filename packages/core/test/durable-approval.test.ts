import { describe, it, expect, vi } from 'vitest';
import { createApprovalSigner } from '../src/durable';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { ToolApprovalRequest } from '../src/types/tool';
import type { Clock } from '../src/types/deps';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const REQUEST: ToolApprovalRequest = {
  approvalId: 'toolu_1',
  toolCallId: 'toolu_1',
  toolName: 'deleteFile',
  input: { path: '/tmp/x' },
};

function fixedClock(now: number): Clock {
  return { now: () => now, setTimeout: () => () => {} };
}

describe('createApprovalSigner (WebCrypto HMAC-SHA256)', () => {
  it('sign → verify round-trips the payload (approval + runId + issuedAt)', async () => {
    const signer = createApprovalSigner({ secret: 's3cret', clock: fixedClock(1000) });
    const token = await signer.sign(REQUEST, { runId: 'run-1' });
    expect(typeof token).toBe('string');
    const payload = await signer.verify(token);
    expect(payload).toMatchObject({
      approvalId: 'toolu_1',
      toolCallId: 'toolu_1',
      toolName: 'deleteFile',
      input: { path: '/tmp/x' },
      runId: 'run-1',
      issuedAt: 1000,
    });
  });

  it('is deterministic for the same payload, secret, and clock', async () => {
    const a = createApprovalSigner({ secret: 's', clock: fixedClock(5) });
    const b = createApprovalSigner({ secret: 's', clock: fixedClock(5) });
    expect(await a.sign(REQUEST)).toBe(await b.sign(REQUEST));
  });

  it('rejects a tampered payload', async () => {
    const signer = createApprovalSigner({ secret: 's3cret', clock: fixedClock(0) });
    const token = await signer.sign(REQUEST);
    const [head, body, sig] = token.split('.');
    // Flip the payload to approve a DIFFERENT tool with the same signature.
    const forged = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/')));
    forged.toolName = 'transferMoney';
    const forgedB64 = btoa(JSON.stringify(forged))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await signer.verify(`${head}.${forgedB64}.${sig}`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const alice = createApprovalSigner({ secret: 'alice', clock: fixedClock(0) });
    const mallory = createApprovalSigner({ secret: 'mallory', clock: fixedClock(0) });
    const token = await mallory.sign(REQUEST);
    expect(await alice.verify(token)).toBeNull();
  });

  it('rejects garbage tokens without throwing', async () => {
    const signer = createApprovalSigner({ secret: 's' });
    expect(await signer.verify('')).toBeNull();
    expect(await signer.verify('not-a-token')).toBeNull();
    expect(await signer.verify('a.b.c')).toBeNull();
    expect(await signer.verify('v1.%%%.###')).toBeNull();
  });

  it('enforces maxAgeMs against the injected clock', async () => {
    const signer = createApprovalSigner({ secret: 's', clock: fixedClock(1000) });
    const token = await signer.sign(REQUEST);
    const later = createApprovalSigner({ secret: 's', clock: fixedClock(61_000) });
    expect(await later.verify(token, { maxAgeMs: 60_000 })).toBeNull(); // expired
    expect(await later.verify(token, { maxAgeMs: 120_000 })).not.toBeNull(); // still valid
    expect(await later.verify(token)).not.toBeNull(); // no expiry by default
  });

  it('signs large payloads without a RangeError (loop-based base64, no spread)', async () => {
    const signer = createApprovalSigner({ secret: 's', clock: fixedClock(0) });
    const big: ToolApprovalRequest = { ...REQUEST, input: { body: 'x'.repeat(300_000) } };
    const token = await signer.sign(big);
    const payload = await signer.verify(token);
    expect((payload?.input as { body: string }).body).toHaveLength(300_000);
  });

  it('throws synchronously on an empty secret (no unhandled importKey rejection)', () => {
    expect(() => createApprovalSigner({ secret: '' })).toThrow(/secret/);
  });

  it('rejects tokens with trailing segments (strict three-part shape)', async () => {
    const signer = createApprovalSigner({ secret: 's', clock: fixedClock(0) });
    const token = await signer.sign(REQUEST);
    expect(await signer.verify(`${token}.extra`)).toBeNull();
    expect(await signer.verify(`${token}.`)).toBeNull();
  });
});

// ===================================================================
// 1.9 — a signed-approval refusal must reach the UI as a DENIAL
// Signature enforcement denies on the safe side, and the reason it records is
// the only explanation a user ever gets. Before 1.9 it died in the loop and the
// UI drew "deleteFile failed", which reads like a bug in the tool.
// ===================================================================
const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

/** Anthropic text turn — the model's reaction to the settled denial. */
const FINAL_TURN = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Understood.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 4 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

/** A suspended turn: one gated `tool_use` awaiting a verdict. */
const PENDING_HISTORY = [
  { role: 'user' as const, content: 'clean up /tmp/x' },
  {
    role: 'assistant' as const,
    content: [
      { type: 'tool_use' as const, id: 'toolu_1', name: 'deleteFile', input: { path: '/tmp/x' } },
    ],
  },
];

describe('signed-approval denial reaches the UI (1.9)', () => {
  it('a FORGED token denies, and the tool-state part says denied + why', async () => {
    const signer = createApprovalSigner({ secret: 'topsecret', clock: fixedClock(1_000) });
    // Same payload, wrong secret: verification fails, so the resume DENIES.
    const forged = await createApprovalSigner({ secret: 'mallory', clock: fixedClock(1_000) }).sign(
      REQUEST,
    );
    const deleteFile = vi.fn(async () => 'deleted');
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL_TURN])]);

    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: { deleteFile: { parameters: SCHEMA, execute: deleteFile, needsApproval: true } },
      maxSteps: 5,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true, token: forged }],
    });
    const states: Extract<StreamPart, { type: 'tool-state' }>[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-state') states.push(part);
    }

    expect(deleteFile).not.toHaveBeenCalled();
    expect(states).toEqual([
      {
        type: 'tool-state',
        toolCallId: 'toolu_1',
        toolName: 'deleteFile',
        state: 'error',
        denied: true,
        deniedReason: 'Approval token missing, invalid, expired, or bound to another run.',
      },
    ]);
    // The model still sees the same is_error tool_result it did before 1.9.
    expect(String(calls[0]!.init!.body)).toContain('Approval token missing');
  });

  it('a VALID token executes and the terminal part carries no denial fields', async () => {
    const signer = createApprovalSigner({ secret: 'topsecret', clock: fixedClock(1_000) });
    const token = await signer.sign(REQUEST);
    const deleteFile = vi.fn(async () => 'deleted');
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_TURN])]);

    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: { deleteFile: { parameters: SCHEMA, execute: deleteFile, needsApproval: true } },
      maxSteps: 5,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true, token }],
    });
    const states: Extract<StreamPart, { type: 'tool-state' }>[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-state') states.push(part);
    }

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(states.map((s) => s.state)).toEqual(['executing', 'complete']);
    expect(states.every((s) => s.denied === undefined)).toBe(true);
  });
});
