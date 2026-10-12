/**
 * ui-agent.test.ts (2.3, roadmap 23.5) — the native UI bridge.
 *
 * `toDeuzAgentStreamResponse` serializes a `streamAgent` / `resumeStreamAgent`
 * run to the Deuz UI wire: the run's own parts exactly as the legacy wire
 * frames them, plus `data-agent` frames for what only a native run has (its
 * identity, a sequence, its phases, drafts of the output, and the terminal
 * state). `agentStateFromParts` folds those frames on the client, and every
 * frame applies at most once.
 *
 * Offline: the runs use `createMockModel` or a replayed Anthropic wire.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { applyUIPart, createAssistantTurn } from '../src/chat';
import { createMockModel } from '../src/testing';
import {
  agentStateFromParts,
  createInMemoryStreamStateStore,
  readDeuzStream,
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
  type DeuzAgentFrame,
  type DeuzUIPart,
} from '../src/ui';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

const parameters = { type: 'object' as const, properties: {} };
const answerOutput = {
  mode: 'json' as const,
  schema: {
    type: 'object',
    properties: { answer: { type: 'number' } },
    required: ['answer'],
  },
  validate(value: unknown): { answer: number } {
    const answer = (value as { answer?: unknown } | null)?.answer;
    if (typeof answer !== 'number') throw new Error('answer must be a number');
    return { answer };
  },
};

/** Every SSE event of a response body, with its `id:` when it has one. */
async function sseOf(response: Response): Promise<Array<{ id?: number; data: string }>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      let id: number | undefined;
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) id = Number(line.slice(4));
        if (line.startsWith('data: ')) data = line.slice(6);
      }
      return { ...(id !== undefined ? { id } : {}), data };
    });
}

const partsOf = (events: Array<{ data: string }>): DeuzUIPart[] =>
  events.filter((e) => e.data !== '[DONE]').map((e) => JSON.parse(e.data) as DeuzUIPart);

const framesOf = (parts: DeuzUIPart[]): DeuzAgentFrame[] =>
  parts
    .filter((p) => p.type === 'data-agent')
    .map((p) => (p as { payload: unknown }).payload as DeuzAgentFrame);

async function collect(response: Response): Promise<DeuzUIPart[]> {
  const parts: DeuzUIPart[] = [];
  for await (const part of readDeuzStream(response)) parts.push(part);
  return parts;
}

describe('toDeuzAgentStreamResponse', () => {
  it('frames a run: identity, sequence, phases, drafts and the typed final output', async () => {
    const stream = streamAgent({
      model: createMockModel({ responses: [{ text: 'ok' }, { text: '{"answer": 42}' }] }),
      prompt: 'x',
      tools: { work: { parameters, execute: () => 'w' } },
      output: answerOutput,
    });
    const events = await sseOf(
      toDeuzAgentStreamResponse(stream, { runId: 'run-1', messageId: 'msg-1' }),
    );
    const parts = partsOf(events);
    // The legacy framing of the run's own parts is unchanged.
    expect(parts[0]).toEqual({ type: 'start', messageId: 'msg-1' });
    expect(parts.filter((p) => p.type === 'text-delta').length).toBeGreaterThan(0);
    // Every agent frame names its own SSE event id as its sequence.
    const agentEvents = events.filter((e) => e.data.startsWith('{"type":"data-agent"'));
    expect(agentEvents.length).toBeGreaterThan(3);
    for (const event of agentEvents) {
      const part = JSON.parse(event.data) as { id: string; payload: DeuzAgentFrame };
      expect(part.payload.seq).toBe(event.id);
      expect(part.id).toBe(part.payload.kind);
    }
    const frames = framesOf(parts);
    expect(frames[0]).toMatchObject({ kind: 'run', runId: 'run-1', status: 'running' });
    expect(frames.map((f) => f.kind)).toContain('partial');
    expect(
      frames.filter((f) => f.kind === 'phase').map((f) => (f as { phase: string }).phase),
    ).toEqual(['running', 'finalizing']);
    const result = frames.at(-1)!;
    expect(result).toMatchObject({
      kind: 'result',
      status: 'completed',
      output: { answer: 42 },
      modelSteps: 2,
    });
    // A draft is never the output: only the result frame carries `output`.
    for (const frame of frames.slice(0, -1)) expect(frame).not.toHaveProperty('output');
    expect(events.at(-1)!.data).toBe('[DONE]');
  });

  it('subscribes before anything else can start the run', async () => {
    const stream = streamAgent({
      model: createMockModel({ responses: [{ text: 'hello' }] }),
      prompt: 'x',
    });
    const response = toDeuzAgentStreamResponse(stream, { runId: 'early' });
    // The route awaits the result before anyone reads the body.
    expect((await stream.result).status).toBe('completed');
    const parts = await collect(response);
    const text = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { text: string }).text)
      .join('');
    expect(text).toBe('hello');
    expect(framesOf(parts).map((f) => f.kind)).toEqual(['run', 'phase', 'phase', 'result']);
  });

  it('a stream passed in after it ended still reports its terminal state', async () => {
    const stream = streamAgent({
      model: createMockModel({ responses: [{ text: 'late' }] }),
      prompt: 'x',
    });
    await stream.result; // consumed before the serializer subscribed: its events are gone
    const parts = await collect(toDeuzAgentStreamResponse(stream, { runId: 'late' }));
    expect(parts.some((p) => p.type === 'text-delta')).toBe(false);
    expect(agentStateFromParts(parts)).toMatchObject({ status: 'completed', output: 'late' });
  });

  it('suspends with the pending approvals and client calls, then the resumed leg continues the sequence', async () => {
    const agentRuns = createInMemoryAgentRunStore();
    const streams = createInMemoryStreamStateStore();
    const options = {
      model: createMockModel({
        responses: [
          {
            toolCalls: [
              { toolName: 'publish', id: 'p1', args: { doc: 7 } },
              { toolName: 'locate', id: 'c1', args: { q: 'here' } },
            ],
          },
          { text: 'Published.' },
        ],
      }),
      prompt: 'publish it',
      session: { store: agentRuns, runId: 'run-2', scope: 'tenant' },
      tools: {
        publish: { parameters, needsApproval: true, execute: () => 'published' },
        locate: { parameters },
      },
    };
    const wire = { store: streams, streamId: 'run-2', runId: 'run-2' };
    const first = partsOf(await sseOf(toDeuzAgentStreamResponse(streamAgent(options), wire)));
    const suspended = agentStateFromParts(first);
    expect(suspended).toMatchObject({
      runId: 'run-2',
      status: 'suspended',
      pendingApprovals: [{ toolCallId: 'p1', toolName: 'publish', input: { doc: 7 } }],
      pendingClientCalls: [{ toolCallId: 'c1', toolName: 'locate', input: { q: 'here' } }],
    });
    if (suspended.status !== 'suspended') throw new Error('unreachable');
    const approvalId = suspended.pendingApprovals[0]!.approvalId;

    const second = await sseOf(
      toDeuzAgentStreamResponse(
        resumeStreamAgent({
          ...options,
          approvalResponses: [{ approvalId, approved: true }],
          clientToolResults: [{ toolCallId: 'c1', output: { at: 'home' } }],
        }),
        wire,
      ),
    );
    const firstLast = suspended.seq;
    const resumedFrames = framesOf(partsOf(second));
    expect(resumedFrames[0]!.kind).toBe('run');
    expect(resumedFrames[0]!.seq).toBeGreaterThan(firstLast);
    // A continued leg does not start a second message.
    expect(partsOf(second).some((p) => p.type === 'start')).toBe(false);
    const done = agentStateFromParts(partsOf(second), suspended);
    expect(done).toMatchObject({ status: 'completed', output: 'Published.', runId: 'run-2' });
    expect(done).not.toHaveProperty('pendingApprovals');
  });

  it('native stream → disconnect → resume read → approval → terminal output', async () => {
    const agentRuns = createInMemoryAgentRunStore();
    const streams = createInMemoryStreamStateStore();
    const options = {
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'deploy', id: 'd1', args: {} }] }, { text: 'Live.' }],
      }),
      prompt: 'deploy',
      session: { store: agentRuns, runId: 'run-3', scope: 'tenant' },
      tools: { deploy: { parameters, needsApproval: true, execute: () => 'deployed' } },
    };
    const wire = { store: streams, streamId: 'run-3', runId: 'run-3' };
    const response = toDeuzAgentStreamResponse(streamAgent(options), wire);
    // The client reads up to the first agent frame and goes away.
    const reader = response.body!.getReader();
    let received = '';
    while (!received.includes('"data-agent"')) {
      received += new TextDecoder().decode((await reader.read()).value);
    }
    await reader.cancel();
    const seen = partsOf(
      received
        .split('\n\n')
        .filter((b) => b.includes('data: '))
        .map((b) => ({ data: b.slice(b.indexOf('data: ') + 6) })),
    );
    const cursor = Math.max(...framesOf(seen).map((f) => f.seq));
    // The run still reaches its terminal state on the server, into the journal.
    const deadline = Date.now() + 2000;
    while ((await agentRuns.load('run-3'))?.result === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // A late reader replays after its cursor and lands on the same terminal frame.
    const replayed = await collect(
      resumeDeuzStreamResponse(streams, 'run-3', {
        lastEventId: String(cursor),
        idleTimeoutMs: 500,
      }),
    );
    const state = agentStateFromParts(replayed, agentStateFromParts(seen));
    expect(state.status).toBe('suspended');
    if (state.status !== 'suspended') throw new Error('unreachable');
    const resumed = await collect(
      toDeuzAgentStreamResponse(
        resumeStreamAgent({
          ...options,
          approvalResponses: [
            { approvalId: state.pendingApprovals[0]!.approvalId, approved: true },
          ],
        }),
        wire,
      ),
    );
    expect(agentStateFromParts(resumed, state)).toMatchObject({
      status: 'completed',
      output: 'Live.',
    });
  });

  it('reports a cancelled run as stopped, without an output or an error', async () => {
    const controller = new AbortController();
    controller.abort();
    const parts = await collect(
      toDeuzAgentStreamResponse(
        streamAgent({
          model: createMockModel({ responses: [{ text: 'never' }] }),
          prompt: 'x',
          signal: controller.signal,
        }),
      ),
    );
    const state = agentStateFromParts(parts);
    expect(state).toMatchObject({ status: 'stopped', reason: 'aborted' });
    expect(state).not.toHaveProperty('output');
    expect(parts.some((p) => p.type === 'error')).toBe(false);
  });

  it('reports a failure as a failed frame and one error part', async () => {
    const parts = await collect(
      toDeuzAgentStreamResponse(
        streamAgent({
          model: createMockModel({ responses: [{ text: 'x' }] }),
          prompt: 'x',
          maxSteps: 0,
        }),
      ),
    );
    expect(agentStateFromParts(parts)).toMatchObject({
      status: 'failed',
      error: { name: 'TypeError', message: 'maxSteps must be a positive integer.' },
    });
    expect(parts.filter((p) => p.type === 'error')).toEqual([
      { type: 'error', message: 'maxSteps must be a positive integer.' },
    ]);
  });

  it('redacts a credential in the failed frame and in the error part', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const { fetch } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: `invalid x-api-key ${secret}` },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const parts = await collect(
      toDeuzAgentStreamResponse(
        streamAgent({
          model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
          prompt: 'x',
        }),
      ),
    );
    const state = agentStateFromParts(parts);
    if (state.status !== 'failed') throw new Error(`expected a failed run, got ${state.status}`);
    // Masked, not dropped: the message still says what failed.
    expect(state.error.message).toContain('invalid x-api-key');
    expect(state.error.message).not.toContain(secret);
    const errors = parts.filter((p) => p.type === 'error');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).toContain('invalid x-api-key');
    expect(JSON.stringify(parts)).not.toContain(secret);
  });

  it('shows a refusal with its stop details', async () => {
    const refusal = { type: 'refusal', category: 'cyber', explanation: 'Not that.' };
    const { fetch } = mockFetch(() =>
      sseResponse([
        sseEvents([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: { usage: { input_tokens: 5, output_tokens: 1 } },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'No.' },
            },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'refusal', stop_details: refusal },
              usage: { output_tokens: 3 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ]),
    );
    const parts = await collect(
      toDeuzAgentStreamResponse(
        streamAgent({
          model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
          prompt: 'x',
        }),
      ),
    );
    expect(agentStateFromParts(parts)).toMatchObject({
      status: 'stopped',
      reason: 'refusal',
      stopDetails: refusal,
    });
  });

  it('never puts the transcript, raw tool results or receipts on the wire', async () => {
    const parts = await collect(
      toDeuzAgentStreamResponse(
        streamAgent({
          model: createMockModel({
            responses: [
              { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
              { text: 'ok' },
            ],
          }),
          prompt: 'x',
          tools: {
            lookup: {
              parameters,
              execute: () => ({ answer: 1, hidden: 'private-raw-result' }),
              toModelOutput: (value: { answer: number }) => ({ safe: value.answer }),
            },
          },
        }),
      ),
    );
    const wire = JSON.stringify(parts);
    expect(wire).not.toContain('private-raw-result');
    expect(wire).toContain('"safe":1'); // the model's projection, as on the legacy wire
    const result = framesOf(parts).at(-1)!;
    expect(Object.keys(result).sort()).toEqual(
      ['kind', 'modelSteps', 'output', 'runId', 'seq', 'status', 'usage'].sort(),
    );
  });

  it('sends no agent frames to a client that negotiated wire v1', async () => {
    const events = await sseOf(
      toDeuzAgentStreamResponse(
        streamAgent({ model: createMockModel({ responses: [{ text: 'hi' }] }), prompt: 'x' }),
        { wireVersion: 'v1' },
      ),
    );
    expect(events.some((e) => e.id !== undefined)).toBe(false);
    expect(partsOf(events).some((p) => p.type.startsWith('data-'))).toBe(false);
    expect(partsOf(events).map((p) => p.type)).toContain('text-delta');
  });
});

describe('toDeuzAgentStreamResponse — a refused leg stays off the journal', () => {
  /** A run suspended on one approval, journaled under its run id. */
  async function suspendedRun(execute: () => unknown, scope = 'tenant-a') {
    const runs = createInMemoryAgentRunStore();
    const streams = createInMemoryStreamStateStore();
    const options = {
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'publish', id: 'p1', args: {} }] },
          { text: 'Published.' },
        ],
      }),
      prompt: 'publish',
      session: { store: runs, runId: 'run-r', scope },
      tools: { publish: { parameters, needsApproval: true, execute } },
    };
    const wire = { store: streams, streamId: 'run-r', runId: 'run-r' };
    const suspended = agentStateFromParts(
      await collect(toDeuzAgentStreamResponse(streamAgent(options), wire)),
    );
    if (suspended.status !== 'suspended') throw new Error('not suspended');
    const approvalResponses = [
      { approvalId: suspended.pendingApprovals[0]!.approvalId, approved: true },
    ];
    return { runs, streams, options, wire, suspended, approvalResponses };
  }

  const seqsOf = async (streams: ReturnType<typeof createInMemoryStreamStateStore>) => {
    const seqs: number[] = [];
    for await (const record of streams.read('run-r')) seqs.push(record.seq);
    return seqs;
  };

  it('a second resume while the run executes is refused on its own response, not in the journal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = await suspendedRun(async () => {
      entered();
      await gate;
      return 'published';
    });
    const resume = () =>
      toDeuzAgentStreamResponse(
        resumeStreamAgent({ ...run.options, approvalResponses: run.approvalResponses }),
        run.wire,
      );
    // One tab resumes the run; its tool is running.
    const live = collect(resume());
    await executing;
    const before = await seqsOf(run.streams);
    // Another tab (or a double submit) resumes the same run.
    const refused = await sseOf(resume());
    // The client sees the refusal: a failed run and one error part, with no event ids,
    // so its resume cursor stays where the journal is.
    expect(refused.every((event) => event.id === undefined)).toBe(true);
    const parts = partsOf(refused);
    expect(agentStateFromParts(parts)).toMatchObject({
      status: 'failed',
      error: { message: 'This native run already has an active executor.' },
    });
    expect(parts.filter((p) => p.type === 'error')).toHaveLength(1);
    expect(await seqsOf(run.streams)).toEqual(before);
    release();
    expect(agentStateFromParts(await live)).toMatchObject({ status: 'completed' });
    // Every seq of the journal belongs to one record, and the live leg's frames line up with them.
    const seqs = await seqsOf(run.streams);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(seqs.map((_, index) => index));
  });

  it("another tenant's refused resume never reaches the owner's replay", async () => {
    const run = await suspendedRun(() => 'published');
    const cursor = (await seqsOf(run.streams)).at(-1)!;
    const attacker = await collect(
      toDeuzAgentStreamResponse(
        resumeStreamAgent({
          ...run.options,
          session: { ...run.options.session, scope: 'tenant-b' },
          approvalResponses: run.approvalResponses,
        }),
        run.wire,
      ),
    );
    expect(agentStateFromParts(attacker).status).toBe('failed');
    expect((await run.runs.load('run-r'))?.result?.status).toBe('suspended');
    expect((await seqsOf(run.streams)).at(-1)).toBe(cursor);
    const replay = await collect(
      resumeDeuzStreamResponse(run.streams, 'run-r', {
        lastEventId: String(cursor),
        idleTimeoutMs: 50,
      }),
    );
    expect(agentStateFromParts(replay, run.suspended).status).toBe('suspended');
  });

  it('a fresh run refused before it began journals nothing, not even its start', async () => {
    const streams = createInMemoryStreamStateStore();
    const parts = await collect(
      toDeuzAgentStreamResponse(
        streamAgent({ model: createMockModel({ responses: [] }), prompt: 'x', maxSteps: 0 }),
        { store: streams, streamId: 'fresh', runId: 'fresh', messageId: 'msg-1' },
      ),
    );
    expect(parts[0]).toEqual({ type: 'start', messageId: 'msg-1' });
    expect(agentStateFromParts(parts).status).toBe('failed');
    expect(streams.lastSeq('fresh')).toBeUndefined();
  });

  it('an admitted leg is journaled as before, its frames numbered by the journal', async () => {
    const run = await suspendedRun(() => 'published');
    const before = (await seqsOf(run.streams)).at(-1)!;
    const events = await sseOf(
      toDeuzAgentStreamResponse(
        resumeStreamAgent({ ...run.options, approvalResponses: run.approvalResponses }),
        run.wire,
      ),
    );
    expect(events[0]!.id).toBe(before + 1);
    expect(agentStateFromParts(partsOf(events), run.suspended)).toMatchObject({
      status: 'completed',
      output: 'Published.',
    });
    expect((await seqsOf(run.streams)).at(-1)).toBe(events.at(-1)!.id);
  });
});

describe('agentStateFromParts', () => {
  const frame = (payload: DeuzAgentFrame): DeuzUIPart => ({
    type: 'data-agent',
    id: payload.kind,
    payload,
  });
  const run = frame({ kind: 'run', seq: 1, runId: 'r', status: 'running' });
  const phase = frame({ kind: 'phase', seq: 2, phase: 'finalizing' });
  const draft = frame({ kind: 'partial', seq: 3, attempt: 0, value: { answer: 4 } });
  const element = frame({ kind: 'element', seq: 4, attempt: 0, index: 0, value: 'a' });
  const result = frame({
    kind: 'result',
    seq: 5,
    runId: 'r',
    status: 'completed',
    output: { answer: 42 },
    modelSteps: 1,
  });

  it('starts idle and applies frames in sequence', () => {
    expect(agentStateFromParts([])).toEqual({ status: 'idle', seq: -1 });
    const running = agentStateFromParts([run, phase, draft, element]);
    expect(running).toEqual({
      status: 'running',
      seq: 4,
      runId: 'r',
      phase: 'finalizing',
      partial: { attempt: 0, value: { answer: 4 } },
      elements: { attempt: 0, values: ['a'] },
    });
    expect(agentStateFromParts([result], running)).toEqual({
      status: 'completed',
      seq: 5,
      runId: 'r',
      phase: 'finalizing',
      output: { answer: 42 },
      modelSteps: 1,
    });
  });

  it('applies a duplicated frame once: a replay of everything changes nothing', () => {
    const once = agentStateFromParts([run, phase, draft, element, result]);
    const again = agentStateFromParts([run, phase, draft, element, result], once);
    expect(again).toBe(once);
    const twice = agentStateFromParts([run, run, draft, draft, draft]);
    expect(twice).toEqual(agentStateFromParts([run, draft]));
  });

  it('never moves backwards on an out-of-order frame', () => {
    const done = agentStateFromParts([result]);
    const late = agentStateFromParts([draft, run, phase], done);
    expect(late).toBe(done);
    expect(late).toMatchObject({ status: 'completed', output: { answer: 42 } });
    expect(late).not.toHaveProperty('partial');
  });

  it('starts over for another run with a later sequence', () => {
    const first = agentStateFromParts([run, result]);
    const next = agentStateFromParts(
      [frame({ kind: 'run', seq: 9, runId: 'other', status: 'running' })],
      first,
    );
    expect(next).toEqual({ status: 'running', seq: 9, runId: 'other' });
  });

  it('a resumed leg clears the suspension it continues', () => {
    const suspended = agentStateFromParts([
      run,
      frame({
        kind: 'result',
        seq: 6,
        runId: 'r',
        status: 'suspended',
        pendingApprovals: [{ approvalId: 'a', toolCallId: 't', toolName: 'n', input: {} }],
        pendingClientCalls: [],
        modelSteps: 1,
      }),
    ]);
    expect(suspended.status).toBe('suspended');
    const resumed = agentStateFromParts(
      [frame({ kind: 'run', seq: 7, runId: 'r', status: 'running' })],
      suspended,
    );
    expect(resumed).toEqual({ status: 'running', seq: 7, runId: 'r' });
  });

  it('ignores malformed frames and every other part', () => {
    const state = agentStateFromParts([
      { type: 'text-delta', text: 'hi' },
      { type: 'data-agent', payload: null },
      { type: 'data-agent', payload: { kind: 'run', seq: -1, status: 'running' } },
      { type: 'data-agent', payload: { kind: 'run', seq: '1', status: 'running' } },
      { type: 'data-agent', payload: { kind: 'result', seq: 1, status: 'exploded' } },
      { type: 'data-agent', payload: { kind: 'partial', seq: 2 } },
      { type: 'data-other', payload: { kind: 'run', seq: 3, status: 'running' } },
      {
        type: 'data-agent',
        payload: {
          kind: 'result',
          seq: 4,
          status: 'suspended',
          pendingApprovals: [{ approvalId: 7 }],
          pendingClientCalls: 'nope',
        },
      },
    ] as DeuzUIPart[]);
    expect(state).toEqual({ status: 'idle', seq: -1 });
  });
});

describe('applyUIPart and agent frames', () => {
  it('folds a valid agent frame into turn.agent, not into the data channel', () => {
    const turn = applyUIPart(createAssistantTurn('m'), {
      type: 'data-agent',
      id: 'run',
      payload: { kind: 'run', seq: 0, runId: 'r', status: 'running' },
    });
    expect(turn.agent).toEqual({ status: 'running', seq: 0, runId: 'r' });
    expect(turn.dataParts).toEqual([]);
    expect(turn.message.parts).toBeUndefined();
    // A duplicate returns the same turn.
    expect(
      applyUIPart(turn, {
        type: 'data-agent',
        id: 'run',
        payload: { kind: 'run', seq: 0, runId: 'r', status: 'running' },
      }),
    ).toBe(turn);
  });

  it("keeps an app's own data-agent part a data part", () => {
    const turn = applyUIPart(createAssistantTurn('m'), {
      type: 'data-agent',
      payload: { mood: 'happy' },
    });
    expect(turn.agent).toBeUndefined();
    expect(turn.dataParts).toEqual([{ name: 'agent', payload: { mood: 'happy' } }]);
  });
});

describe('readDeuzStream onEventId (2.3)', () => {
  it('reports the event id of each part before it is yielded, never for [DONE]', async () => {
    const body = [
      'id: 4\ndata: {"type":"text-delta","text":"a"}\n\n',
      'data: {"type":"data-ping","payload":1}\n\n', // a transient frame: no id of its own
      'id: 5\ndata: {"type":"finish","finishReason":"stop","usage":{}}\n\n',
      'id: 6\ndata: [DONE]\n\n',
    ].join('');
    const seen: string[] = [];
    const order: string[] = [];
    for await (const part of readDeuzStream(new Response(body), {
      onEventId: (id) => {
        seen.push(id);
        order.push(`id:${id}`);
      },
    })) {
      order.push(part.type);
    }
    expect(seen).toEqual(['4', '5']);
    expect(order).toEqual(['id:4', 'text-delta', 'data-ping', 'id:5', 'finish']);
  });

  it('reports nothing for a wire v1 body', async () => {
    const seen: string[] = [];
    for await (const _part of readDeuzStream(
      new Response('data: {"type":"text-delta","text":"a"}\n\ndata: [DONE]\n\n'),
      { onEventId: (id) => seen.push(id) },
    )) {
      /* drain */
    }
    expect(seen).toEqual([]);
  });
});
