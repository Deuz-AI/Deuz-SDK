/**
 * The composite flow of spec §5.1 with a React client: the reviewer's page is
 * `useChat` from @deuz-sdk/react, restored from a snapshot, on the host's
 * native agent route and its resume endpoint (core's durable stream journal).
 *
 * The server side is the core end-to-end harness (packages/core/test/e2e-2-4):
 * a durable scheduler fires the goal's inbox, the goal supervisor runs the V3
 * run with context and versioned memory up to its gated publish, and the host
 * dies three times (after a memory commit, during the Docker start, between
 * the Docker step and its receipt). The client:
 *
 * - mounts from a snapshot the host built for the suspended run (its pending
 *   approval and the native run gate) and approves;
 * - loses its connection when the host dies during the Docker start; the hook
 *   continues from the resume endpoint by itself (`durable-stream`), held by
 *   a load balancer until a host is back;
 * - when the next host dies too, the page is reloaded: `exportSnapshot()`
 *   captures the turn and its cursor, a new hook restores it and
 *   `reconnect()`s to the third host, which completes the run.
 *
 * Every frame the hook read is checked once, in order, against the journal;
 * the message ids survive the reload; the goal ends verified. Three rounds on
 * clean stores, never retried.
 */
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { applyUIPart, createAssistantTurn, sealAssistantTurn } from '@deuz-sdk/core/chat';
import type { ChatSnapshotV1 } from '../../src/index';
import { useChat, type UseChatOptions, type UseChatResult } from '../../src/use-chat';
import {
  DOCKER_OPERATION,
  FINAL_OK,
  GOAL_ID,
  PROMPT,
  RUN_ID,
  SECRET_MARK,
  createFlowEnv,
  disposeFakeDocker,
  disposeFlowEnv,
  dockerHarness,
  runMainFlow,
  storedFrames,
  type FlowClient,
  type HostProcess,
} from '../../../core/test/e2e-2-4/harness';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
afterAll(() => disposeFakeDocker());

/**
 * A load balancer in front of the host processes: a request goes to the live
 * host, and while none is up it is held until one is (or the page leaves).
 */
class Balancer {
  private live: HostProcess | undefined;
  private held: { resolve: (proc: HostProcess) => void; reject: (error: unknown) => void }[] = [];

  /** Requests held until a host is up. */
  get waiting(): number {
    return this.held.length;
  }

  up(proc: HostProcess): void {
    this.live = proc;
    for (const request of this.held.splice(0)) request.resolve(proc);
  }

  host(): Promise<HostProcess> {
    if (this.live?.alive) return Promise.resolve(this.live);
    return new Promise((resolve, reject) => this.held.push({ resolve, reject }));
  }

  /** The page went away: its held requests are abandoned. */
  abandon(): void {
    for (const request of this.held.splice(0))
      request.reject(new DOMException('The page went away.', 'AbortError'));
  }
}

/** One connection's bytes, exactly as the hook read them. */
interface Connection {
  kind: 'post' | 'resume';
  lastEventId?: string;
  text: string;
}

/**
 * Records what the hook reads, chunk by chunk, as it reads it (a pull stream
 * without a queue of its own, so nothing is counted that the hook never got).
 */
function recorded(connections: Connection[], connection: Connection, response: Response): Response {
  connections.push(connection);
  const reader = response.body?.getReader();
  if (!reader) return response;
  const decoder = new TextDecoder();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) return controller.close();
          connection.text += decoder.decode(value, { stream: true });
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: response.status, headers: response.headers });
}

/** The ids of the complete frames in a connection's text (a cut-off frame never reached the hook). */
function frameIds(text: string): number[] {
  const ids: number[] = [];
  const complete = text.slice(0, text.lastIndexOf('\n\n') + 2);
  for (const block of complete.split('\n\n')) {
    let id: number | undefined;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim());
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (id !== undefined && data !== '[DONE]') ids.push(id);
  }
  return ids;
}

type Hook = RenderHookResult<UseChatResult, unknown>;

/** The reviewer's page, as a `FlowClient` for the harness. */
function reviewerPage() {
  const balancer = new Balancer();
  const connections: Connection[] = [];
  const cursors: (string | undefined)[] = [];
  let snapshot: ChatSnapshotV1 | undefined;
  let approving: Promise<void> | undefined;
  let hook: Hook | undefined;

  const options = (initialSnapshot: ChatSnapshotV1): UseChatOptions => ({
    api: '/api/goals/nightly-report/chat',
    initialSnapshot,
    fetch: async (_url, init) => {
      const proc = await balancer.host();
      const response = await proc.route.post(
        JSON.parse(String(init?.body)) as Parameters<HostProcess['route']['post']>[0],
        init?.headers,
      );
      return recorded(connections, { kind: 'post', text: '' }, response);
    },
    resume: {
      endpoint: async (ctx) => {
        cursors.push(ctx.lastEventId);
        const proc = await balancer.host();
        return recorded(
          connections,
          {
            kind: 'resume',
            ...(ctx.lastEventId ? { lastEventId: ctx.lastEventId } : {}),
            text: '',
          },
          proc.route.resume(ctx),
        );
      },
    },
  });

  /** Waits until `proc` died and the hook's next request is held by the balancer. */
  const heldAfterDeath = (proc: HostProcess) =>
    waitFor(
      () => {
        expect(proc.alive).toBe(false);
        expect(balancer.waiting).toBeGreaterThan(0);
      },
      {
        timeout: 120_000,
        interval: 25,
        onTimeout: (error) => {
          const state = hook?.result.current;
          error.message += ` [host ${proc.name} alive=${proc.alive}, held=${balancer.waiting}, hook=${state?.status} ${String(state?.error ?? '')}, connections=${connections.map((c) => c.kind).join(',')}]`;
          return error;
        },
      },
    );

  const client: FlowClient = {
    async approve(proc, pending) {
      balancer.up(proc);
      // The host builds the page's snapshot from the suspended run: the
      // prompt, its pending approval, and the native run the verdict resumes.
      // A native gate restores with the settled turn it belongs to: the
      // gated call and its approval request, folded as the stream would.
      let turn = createAssistantTurn(`${RUN_ID}:gate`);
      for (const request of pending) {
        turn = applyUIPart(turn, {
          type: 'tool-call',
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input,
        });
        turn = applyUIPart(turn, { type: 'tool-approval-request', ...request });
      }
      const initial: ChatSnapshotV1 = {
        version: 1,
        messages: [{ role: 'user', content: PROMPT }],
        messageIds: ['goal-prompt'],
        pendingApprovals: pending,
        gate: { runId: RUN_ID, turn: sealAssistantTurn(turn) },
      };
      hook = renderHook(() => useChat(options(JSON.parse(JSON.stringify(initial)))));
      expect(hook.result.current.pendingApprovals).toEqual(pending);
      act(() => {
        approving = hook!.result.current.addToolApprovalResponse({
          approvalId: pending[0]!.approvalId,
          approved: true,
        });
      });
      // The host dies during the Docker start: the read drops and the hook
      // continues from the resume endpoint, held until a host is back.
      await heldAfterDeath(proc);
    },
    async reconnect(proc, phase) {
      if (phase === 'p3') {
        balancer.up(proc);
        // The held continuation reaches this host, which dies too.
        await heldAfterDeath(proc);
        // The reviewer reloads the page: the turn and its cursor go into a snapshot.
        snapshot = hook!.result.current.exportSnapshot();
        // The page goes away: its read stops, its held request is abandoned.
        act(() => hook!.result.current.stop());
        hook!.unmount();
        balancer.abandon();
        await approving!.catch(() => undefined);
        return;
      }
      balancer.up(proc);
      hook = renderHook(() => useChat(options(JSON.parse(JSON.stringify(snapshot)))));
      await act(async () => {
        await hook!.result.current.reconnect();
      });
      await waitFor(() => expect(hook!.result.current.status).toBe('idle'), {
        timeout: 120_000,
      });
    },
  };
  return {
    client,
    connections,
    cursors,
    hook: () => hook!,
    snapshot: () => snapshot!,
  };
}

describe('the composite flow with a React client', () => {
  for (const round of [1, 2, 3])
    it(`round ${round}: approves from a snapshot, survives three host crashes and replays every frame once`, async () => {
      const docker = await dockerHarness();
      const env = await createFlowEnv('sqlite', docker);
      try {
        const page = reviewerPage();
        const facts = await runMainFlow(env, page.client);
        const proc = facts.last;
        expect(facts.crashes).toMatchObject({
          p1: 'memory-commit',
          p2: 'docker-start-outcome',
          p3: 'docker-artifact',
        });

        // The snapshot taken at the reload: the unsettled turn and its cursor.
        const snapshot = page.snapshot();
        expect(snapshot.messageIds).toEqual(['goal-prompt']);
        expect(snapshot.turn?.message.id).toBe(`${RUN_ID}:turn`);
        expect(snapshot.cursor).toBeDefined();
        expect(snapshot.pendingApprovals ?? []).toEqual([]);

        // The page after the reload: one assistant turn under the id the
        // stream's start gave it, the run completed, nothing doubled.
        const { result } = page.hook();
        expect(result.current.status).toBe('idle');
        expect(result.current.agent).toMatchObject({
          status: 'completed',
          runId: RUN_ID,
          output: FINAL_OK,
        });
        expect(result.current.messages.map((m) => [m.id, m.role])).toEqual([
          ['goal-prompt', 'user'],
          [`${RUN_ID}:turn`, 'assistant'],
        ]);
        const assistant = result.current.messages[1]!;
        expect(assistant.content).toBe(FINAL_OK);
        const calls = assistant.toolCalls ?? [];
        expect(calls.filter((call) => call.toolCallId === 'job-1')).toEqual([
          expect.objectContaining({
            toolName: 'run_report_job',
            state: 'result',
            output: expect.objectContaining({ ok: true, operationId: DOCKER_OPERATION }),
          }),
        ]);
        expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(calls.length);
        expect(JSON.stringify(result.current.messages)).not.toContain(SECRET_MARK);

        // Every frame the hook read, across the POST, the automatic continuation
        // and the reload's reconnect, arrived once and in order: exactly the
        // journal's committed frames.
        expect(page.connections.map((c) => c.kind)).toEqual(['post', 'resume', 'resume']);
        const read = page.connections.flatMap((c) => frameIds(c.text));
        const stored = await storedFrames(proc);
        expect(read).toEqual(
          stored.filter((record) => record.part.type !== 'done').map((record) => record.seq),
        );
        // Each continuation asked from the last frame its hook had read: the
        // first page after the POST and after the second crash (that request
        // was held, then abandoned at the reload), the reloaded page from its
        // snapshot's cursor.
        const lastRead = (c: { text: string }) => String(frameIds(c.text).at(-1));
        const [post, continuation] = page.connections;
        expect(snapshot.cursor).toBe(lastRead(continuation!));
        expect(page.cursors).toEqual([lastRead(post!), lastRead(continuation!), snapshot.cursor]);

        // The host side ended where the core test checks it in detail.
        const goal = (await proc.supervisor.get(env.scope, GOAL_ID))!.goal;
        expect(goal).toMatchObject({ status: 'completed' });
        expect(env.outbox).toHaveLength(1);
        expect(docker.facts(env.scope, DOCKER_OPERATION)).toMatchObject({
          containers: 1,
          starts: 1,
        });
      } finally {
        await disposeFlowEnv(env);
        await docker.dispose();
      }
    });
});
