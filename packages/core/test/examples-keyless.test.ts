/**
 * The keyless examples (07-12 and 14-20) run end to end and print what their
 * READMEs say they show; 13-headless has its own test, headless-example.test.ts.
 * 16 and 17 also run against offline stand-ins for what their REAL PROVIDER
 * swap changes. The examples import the package by name; here those imports
 * load the sources, so no build is needed. Each run is a fresh instance of the
 * example over one module graph of the sources.
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeSessionOptions, RealtimeWebSocketFactory } from '../src/realtime/index';
import type { CreateMockModelOptions } from '../src/testing';

vi.mock('@deuz-sdk/core', () => import('../src/index'));
vi.mock('@deuz-sdk/core/a2a', () => import('../src/a2a/index'));
vi.mock('@deuz-sdk/core/agent', () => import('../src/agent'));
vi.mock('@deuz-sdk/core/anthropic', () => import('../src/anthropic'));
vi.mock('@deuz-sdk/core/batch', () => import('../src/batch/index'));
vi.mock('@deuz-sdk/core/chat', () => import('../src/chat'));
vi.mock('@deuz-sdk/core/evolve', () => import('../src/evolve'));
vi.mock('@deuz-sdk/core/evolve/sqlite', () => import('../src/node/evolve-sqlite'));
vi.mock('@deuz-sdk/core/goal', () => import('../src/goal/index'));
vi.mock('@deuz-sdk/core/mcp', () => import('../src/mcp/index'));
vi.mock('@deuz-sdk/core/mcp/server', () => import('../src/mcp/server'));
vi.mock('@deuz-sdk/core/memory', () => import('../src/memory'));
vi.mock('@deuz-sdk/core/openai', () => import('../src/openai'));
vi.mock('@deuz-sdk/core/ops', () => import('../src/ops'));
vi.mock('@deuz-sdk/core/ops/sqlite', () => import('../src/node/ops-sqlite'));
vi.mock('@deuz-sdk/core/pricing', () => import('../src/pricing'));
vi.mock('@deuz-sdk/core/schedule', () => import('../src/schedule'));
vi.mock('@deuz-sdk/core/swarm', () => import('../src/swarm'));
vi.mock('@deuz-sdk/core/swarm/sqlite', () => import('../src/node/swarm-sqlite'));
vi.mock('@deuz-sdk/core/ui', () => import('../src/ui'));

/** The temporary directories an example made (09-12 and 16 keep their SQLite file in one). */
const tempDirs = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => {
      const dir = fs.mkdtempSync(prefix);
      tempDirs.push(dir);
      return dir;
    },
  };
});

/**
 * Offline stand-ins for what an example's REAL PROVIDER swap changes. `usage`
 * (16): every scripted reply reports the usage a real tool-enabled call does,
 * instead of the mock's 10 + 5 tokens. `serverNamesResponses` (17): the server
 * picks its own response ids, as the OpenAI Realtime endpoint does; every frame
 * of the scripted socket passes through with only those ids renamed. `gemini`
 * (17): the session talks to a scripted Gemini Live server instead, where the
 * answer to a tool result continues the tool call's turn or is a turn of its own.
 */
const provider = vi.hoisted(() => ({
  usage: undefined as { inputTokens: number; outputTokens: number } | undefined,
  serverNamesResponses: false,
  gemini: undefined as 'same turn' | 'own turn' | undefined,
}));
vi.mock('@deuz-sdk/core/testing', async () => {
  const real = await import('../src/testing');
  return {
    ...real,
    createMockModel: (options: CreateMockModelOptions) =>
      real.createMockModel({
        ...options,
        responses: options.responses.map((response) =>
          provider.usage ? { ...response, usage: provider.usage } : response,
        ),
      }),
  };
});
vi.mock('@deuz-sdk/core/realtime', async () => {
  const real = await import('../src/realtime/index');
  const serverNamed =
    (factory: RealtimeWebSocketFactory): RealtimeWebSocketFactory =>
    (url, init) => {
      const socket = factory(url, init);
      return {
        get readyState() {
          return socket.readyState;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        addEventListener: (type, listener) =>
          socket.addEventListener(type, (event) =>
            listener(
              type === 'message'
                ? {
                    data: String((event as { data: unknown }).data).replace(
                      /"resp_(\d+)"/g,
                      '"resp_Cq7$1Zk"',
                    ),
                  }
                : event,
            ),
          ),
      };
    };
  const geminiServer =
    (answer: 'same turn' | 'own turn'): RealtimeWebSocketFactory =>
    () => {
      const listeners: Record<string, ((event: unknown) => void)[]> = {};
      const fire = (type: string, event: unknown) => listeners[type]?.forEach((fn) => fn(event));
      const reply = (...messages: object[]) => {
        for (const message of messages)
          setTimeout(() => fire('message', { data: JSON.stringify(message) }));
      };
      const turnComplete = { serverContent: { turnComplete: true } };
      const speak = (text: string) => [
        {
          serverContent: {
            modelTurn: {
              parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }],
            },
          },
        },
        { serverContent: { outputTranscription: { text } } },
        turnComplete,
      ];
      const call = {
        functionCalls: [{ id: 'fc_1', name: 'get_weather', args: { city: 'Istanbul' } }],
      };
      setTimeout(() => fire('open', {}));
      return {
        readyState: 1,
        addEventListener: (type, fn) => void (listeners[type] ??= []).push(fn),
        send(data) {
          const message = JSON.parse(data) as {
            setup?: object;
            clientContent?: { turns?: object[]; turnComplete?: boolean };
            toolResponse?: object;
          };
          if (message.setup) reply({ setupComplete: {} });
          else if (message.toolResponse) reply(...speak('Sunny and 24 degrees in Istanbul.'));
          else if (message.clientContent?.turns) reply(...speak('You are welcome!'));
          else if (message.clientContent?.turnComplete) {
            reply({ toolCall: call }, ...(answer === 'own turn' ? [turnComplete] : []));
          }
        },
        close: (code = 1000, reason = '') => void setTimeout(() => fire('close', { code, reason })),
      };
    };
  return {
    ...real,
    createOpenAIRealtime: (settings: Parameters<typeof real.createOpenAIRealtime>[0]) =>
      provider.gemini ? real.createGeminiLive(settings) : real.createOpenAIRealtime(settings),
    createRealtimeSession: (options: RealtimeSessionOptions) => {
      const scripted = options.deps?.webSocket;
      const webSocket = provider.gemini
        ? geminiServer(provider.gemini)
        : provider.serverNamesResponses && scripted
          ? serverNamed(scripted)
          : scripted;
      return real.createRealtimeSession({ ...options, deps: { ...options.deps, webSocket } });
    },
  };
});

let runs = 0;
/**
 * A fresh instance of the example's module: a new query string, not
 * `vi.resetModules()`. A reset keeps the mocked entry points already loaded,
 * so the sources a later example reaches through a new entry point would load
 * a second time, and two module graphs do not share their private symbols (a
 * mock model's config would be invisible to the other graph's inference).
 */
const example = (name: string): string =>
  new URL(`../../../examples/${name}/index.ts?run=${++runs}`, import.meta.url).href;

/**
 * Start an example once. `lines` collects what it prints, one entry per
 * console.log call; `done` settles when its last line has run.
 */
function launch(name: string): { lines: string[]; done: Promise<unknown> } {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  tempDirs.length = 0;
  return { lines, done: import(/* @vite-ignore */ example(name)) };
}

/** Run an example once and return what it printed, one entry per console.log call. */
async function run(name: string): Promise<string[]> {
  const { lines, done } = launch(name);
  await done;
  return lines;
}

/** Whether an example finished within `ms`, or still waits for something. */
async function finishes(done: Promise<unknown>, ms: number): Promise<'finished' | 'still waiting'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Promise<'still waiting'>((resolve) => {
    timer = setTimeout(() => resolve('still waiting'), ms);
  });
  try {
    return await Promise.race([done.then(() => 'finished' as const), waiting]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The printed lines of step `step` ("2) …"), up to the next step's header. */
function section(lines: string[], step: number): string {
  const header = /^\n?(\d+)\) /;
  const start = lines.findIndex((line) => header.exec(line)?.[1] === String(step));
  expect(start, `no step ${step}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && header.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The last run kept its files in one temporary directory and removed it when it finished. */
function expectTempDirRemoved(): void {
  expect(tempDirs).toHaveLength(1);
  expect(existsSync(tempDirs[0]!), tempDirs[0]).toBe(false);
}

describe('examples/07-native-agent', () => {
  it('suspends on an approval, resumes the same run, and repairs the output before accepting it', async () => {
    const lines = await run('07-native-agent');
    const first = section(lines, 1);
    const resumed = section(lines, 2);

    // The gated tool suspends the run with its pending approval; nothing has run yet.
    expect(first).toContain('status: suspended');
    expect(first).toContain('waiting for approval: refund({"orderId":"A-17","amountUsd":42})');
    expect(first).toMatch(/checkpoint: phase=\w+, revision=[1-9]\d*/);
    expect(first).not.toContain('[tool]');

    // resumeAgent continues the run: the approved tool runs once.
    expect(resumed.match(/\[tool\] refund\(A-17, \$42\) executed/g)).toHaveLength(1);
    // The first finalization misses a field: a repair, then validation and the verifier accept it.
    expect(resumed).toMatch(
      /\[validate\] rejected \{"orderId":"A-17"\}; the engine asks for a repair[\s\S]*\[validate\] accepted[\s\S]*\[verify\] refundedUsd=42: verified/,
    );
    // Only `completed` carries the output, validated and typed.
    expect(resumed).toContain('status: completed');
    expect(resumed).toContain('output: {"orderId":"A-17","refundedUsd":42,"status":"refunded"}');
  }, 30_000);
});

describe('examples/08-dynamic-swarm', () => {
  it('spawns a scout per lead on a shared blackboard, then rounds that go deeper once', async () => {
    const lines = await run('08-dynamic-swarm');
    const spawned = section(lines, 1);
    const rounds = section(lines, 2);

    // The planner's validated output spawns one scout per lead and a digest, under the planner.
    expect(spawned).toMatch(
      /task\.completed plan\n(?:.*\n)*?.*task\.spawned plan\/scout1 \[plan\]/,
    );
    expect(spawned).toContain('task.spawned plan/scout2 [plan]');
    expect(spawned).toContain('task.spawned plan/digest [plan]');
    // The scouts post on the leads group's channel; scout2 reads scout1's note before it posts.
    expect(spawned).toContain('channel.posted plan/scout1 [leads]');
    expect(spawned).toContain('channel.posted plan/scout2 [leads]');
    expect(spawned).toMatch(
      /blackboard_read\(\{\}\) -> \[\{"sequence":1,"from":"plan\/scout1",.*\n.*blackboard_post\(/,
    );
    // The digest waits for both scouts, then pages the channel.
    expect(spawned).toMatch(/task\.completed plan\/scout2\n(?:.*\n)*?.*task\.started plan\/digest/);
    expect(spawned).toContain(
      'digest: ["#1 The retry docs never mention jitter.","#2 Issues #41 and #57 show synchronized retry storms."]',
    );
    expect(spawned).toContain('run.settled [completed]');

    // Rounds: one explorer, then the consolidator sends two agents into a deep round, then stops.
    expect(rounds.match(/task\.spawned \S+\/wide\.\d+ /g)).toHaveLength(1);
    expect(rounds.match(/task\.spawned \S+\/deep\.\d+ /g)).toHaveLength(2);
    expect(rounds).toMatch(/last consolidator: \{.*"stopped":true/);
    expect(rounds).toContain('run.settled [completed]');
  }, 30_000);
});

describe('examples/09-durable-ops', () => {
  it('takes a crashed run over once its lease lapses, fences the stale writer, cancels and drains', async () => {
    const lines = await run('09-durable-ops');
    const crashed = section(lines, 1);
    const recovered = section(lines, 2);
    const fenced = section(lines, 3);
    const cancelled = section(lines, 4);
    const drained = section(lines, 5);

    // While the crashed executor's lease is live, recover() leaves its run alone.
    expect(crashed).toContain('[worker-a] crashes in the middle of crunch');
    expect(crashed).toContain('worker-b recover(): 0 taken over, the lease is still live');
    // Once it lapses, recover() takes the run over and replays only the interrupted safe task.
    expect(recovered).toContain('recover(): 1 taken over, 0 failed');
    expect(recovered).toContain('[worker-b] runs crunch');
    expect(recovered).not.toContain('[worker-b] runs fetch');
    expect(recovered).toContain(
      'nightly: completed (fetch=completed crunch=completed report=completed)',
    );
    // The revision fence rejects the crashed executor's late write.
    expect(fenced).toContain("worker-a's result rejects: SwarmLeaseError 'lost'");
    expect(fenced).toContain('the stored crunch result is still "crunch by worker-b"');
    // A cancel from another worker, and the answer for a finished run.
    expect(cancelled).toContain('requestCancel(backfill): signalled');
    expect(cancelled).toContain('backfill: cancelled (scan=cancelled)');
    expect(cancelled).toContain('requestCancel(nightly): settled');
    // A drain leaves the rest pending, and another worker resumes it.
    expect(drained).toContain('drained on worker-b: suspended (build=completed ship=pending)');
    expect(drained).toContain('[worker-c] runs ship');
    expect(drained).toContain('resumed on worker-c: completed (build=completed ship=completed)');
    expectTempDirRemoved();
  }, 30_000);
});

describe('examples/10-evolve', () => {
  it('evolves on SQLite and resumes the stored generation with zero model calls', async () => {
    const lines = await run('10-evolve');
    const killed = section(lines, 1);
    const resumed = section(lines, 2);

    // Candidates get deterministic ids; generation 2 is stored, then the commit never returns.
    expect(killed).toMatch(/g2-i0-s0 score [\d.]+\n.*g2-i0-s1 score [\d.]+/);
    expect(killed).toContain('... generation 2 is stored but never committed');
    expect(killed).not.toContain('[replayed from the store]');

    // The resume replays both stored slots instead of paying for them again.
    const candidates = resumed.split('\n').filter((line) => /g\d+-i\d+-s\d+ /.test(line));
    expect(candidates).toHaveLength(2);
    for (const line of candidates) expect(line).toContain('[replayed from the store]');
    expect(resumed).toContain('model calls made by the resume: 0');
    expect(resumed).toMatch(/completed \(\w+\) at generation 2/);
    // The diff multiplies the Leibniz terms by ten: the best beats the initial program.
    const initial = Number(/g0-i0-s0 score ([\d.]+)/.exec(killed)?.[1]);
    const best = Number(/best: g\d+-i\d+-s\d+, score ([\d.]+)/.exec(resumed)?.[1]);
    expect(best).toBeGreaterThan(initial);
    expect(resumed).toContain('terms *= 10;');
    expectTempDirRemoved();
  }, 30_000);
});

describe('examples/11-schedules-and-signals', () => {
  it('runs each occurrence once across processes, catches up, and dedupes a verified webhook', async () => {
    const lines = await run('11-schedules-and-signals');
    const ticked = section(lines, 1);
    const caughtUp = section(lines, 2);
    const webhook = section(lines, 3);

    // The durable claim runs the minute once; the other process reports a duplicate.
    const monday = `digest@${Date.parse('2026-01-05T09:00:00Z')}`;
    expect(ticked.match(/run digest@/g)).toHaveLength(1);
    expect(ticked).toContain(`run ${monday} (2026-01-05 09:00)`);
    expect(ticked).toContain('process A: 2026-01-05 09:00 ran');
    expect(ticked).toContain('process B: 2026-01-05 09:00 duplicate');
    // The restarted process runs the three missed days and skips the one that ran.
    expect(caughtUp.match(/run digest@/g)).toHaveLength(3);
    expect(caughtUp).toContain(
      'process B: 2026-01-05 09:00 duplicate, 2026-01-06 09:00 ran, 2026-01-07 09:00 ran, 2026-01-08 09:00 ran',
    );
    // A dispatch that throws gives the delivery id back, so the retry runs; a redelivery is a duplicate.
    expect(webhook).toContain('delivery d-1 -> 500');
    expect(webhook).toContain('sender retries d-1 -> 202');
    expect(webhook).toMatch(/d-1 delivered again -> 200 .*"duplicate":true/);
    expect(webhook.match(/queued d-1/g)).toHaveLength(1);
    // A body that does not match its signature is refused.
    expect(webhook).toContain('forged d-2 -> 401');
    expectTempDirRemoved();
  }, 30_000);
});

describe('examples/12-persistent-budgets', () => {
  it('shares one per-user budget across a native run and a swarm until it denies a call', async () => {
    const lines = await run('12-persistent-budgets');
    const native = section(lines, 1);
    const swarm = section(lines, 2);
    const denied = section(lines, 3);

    // Every call settles the usage the model reports: 10 input and 5 output tokens.
    expect(native).toContain('run-1 for user:42 -> completed, 15 tokens');
    expect(native).toContain('user:42: 15 tokens used, limit 75 per 24 h');
    // The swarm is admitted against the same scope, with a warning on the way.
    const warned = /\[warning\] user:42 at (\d+)% of its tokens/.exec(swarm);
    expect(Number(warned?.[1])).toBeGreaterThanOrEqual(70);
    expect(swarm).toContain('swarm: completed (a=completed b=completed c=completed)');
    expect(swarm).toContain('user:42: 60 tokens used, limit 75 per 24 h');
    // The next estimate no longer fits: the run fails before its model call.
    expect(denied).toMatch(/run-2 for user:42 -> failed, 0 tokens \(budget_exceeded: /);
    expect(denied).toContain('user:42: 60 tokens used, limit 75 per 24 h');
    // Another user's scope is untouched.
    expect(denied).toContain('run-3 for user:7 -> completed, 15 tokens');
    expect(denied).toContain('user:7: 15 tokens used, limit 75 per 24 h');
    expectTempDirRemoved();
  }, 30_000);
});

describe('examples/14-native-memory-chat', () => {
  it('recalls once, extracts after completion, fails over, and repairs the chat projection', async () => {
    const lines = await run('14-native-memory-chat');
    const first = section(lines, 1);
    const second = section(lines, 2);
    const repair = section(lines, 3);

    // Fail-over: the primary answers 503, the fallback serves the run.
    expect(first).toContain('[primary] 503');
    expect(first).toMatch(/\[warning: fallbackModels\] openai\/gpt-5\.2 failed/);
    expect(first).toContain('status: completed');
    // Nothing is stored yet, so the first run recalls nothing.
    expect(first).toContain('recall: empty');
    // Extraction after completion: one fact, written under the run's id.
    expect(first).toContain('extraction: completed, mutations: 1');
    expect(first).toContain(`memory: "Ada's order A-17 arrived broken." (written by run ada-1)`);
    // The checkpoint records the fail-over and the model the run calls now.
    expect(first).toContain('models: openai/gpt-5.2 failed at model step 1');
    expect(first).toContain('models: the run calls mock/mock-model now');
    // The chat projection with stable message ids.
    expect(first).toContain('chat-1: ada-1:0 user, ada-1:1 assistant');

    // One recall, before the first of the run's three model calls, as a system message.
    expect(second).toContain('recall: recalled, 1 memory, at index 3');
    expect(second).toContain(`system: "Relevant memories:\\n- Ada's order A-17 arrived broken."`);
    expect(second).toContain('memory searches: 1, model calls: 3');
    expect(second).toContain('[tool] track_order(A-17)');
    // The failed model is skipped for the rest of the run: one 503 only.
    expect(second.match(/\[primary\] 503/g)).toHaveLength(1);
    // The chat store fails; the run still completes and records the failure.
    expect(second).toMatch(/\[warning: chat\] The chat projection of run ada-2 could not be saved/);
    expect(second).toContain('status: completed');
    expect(second).toContain('chat projection: failed, 0 of 7 messages acknowledged');

    // reconcileAgentRun writes the projection the run could not.
    expect(repair).toContain('{"runId":"ada-2","chat":"saved"}');
    expect(repair).toContain(
      'a second pass finds nothing behind: {"runId":"ada-2","chat":"current"}',
    );
    expect(repair).toContain(
      'chat-1: ada-1:0 user, ada-1:1 assistant, ada-2:2 user, ada-2:3 system, ada-2:4 assistant, ada-2:5 tool, ada-2:6 assistant',
    );
  }, 30_000);
});

describe('examples/15-native-ui-bridge', () => {
  it('suspends on an approval, resumes in one request, and delivers the typed output once', async () => {
    const lines = await run('15-native-ui-bridge');
    const start = section(lines, 1);
    const resume = section(lines, 2);
    const replay = section(lines, 3);

    // The first leg ends suspended: the approval is a pending action on the client.
    expect(start).toMatch(/\[agent\] seq \d+: running \(run refund-1\)/);
    expect(start).toContain('[turn] refund: approval-requested');
    expect(start).toMatch(/\[agent\] seq \d+: suspended, waiting for 1 approval/);
    expect(start).toContain('pending action: approve refund({"orderId":"A-17","amountUsd":42})?');
    expect(start).not.toContain('[server] refund');

    // One request with the run id and the verdict resumes it to the typed output.
    expect(resume).toContain('[server] refund(A-17, $42) executed');
    expect(resume).toMatch(/\[agent\] seq \d+: running, phase finalizing/);
    expect(resume).toMatch(/\[agent\] seq \d+: completed/);
    // The finalization streams drafts of the output, before the terminal frame.
    expect(resume).toMatch(
      /phase finalizing\n(?:.*\n)*?.*\[agent\] seq \d+: running, draft \{.*\n(?:.*\n)*?.*\[agent\] seq \d+: completed/,
    );
    expect(resume).toContain('output: {"orderId":"A-17","refundedUsd":42,"status":"refunded"}');
    expect(resume).toContain('receipt: $42.00 refunded on order A-17');

    // Every frame's seq is its event id, growing across both legs of the run.
    const seqs = lines.flatMap((line) => {
      const match = /\[agent\] seq (\d+):/.exec(line);
      return match ? [Number(match[1])] : [];
    });
    expect(seqs.length).toBeGreaterThan(4);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // A replay of the journal rebuilds the terminal state, output included, and applies nothing twice.
    expect(replay).toContain(
      'a fresh client folds it into: completed {"orderId":"A-17","refundedUsd":42,"status":"refunded"}',
    );
    expect(replay).toContain('the state this client holds comes back unchanged: true');
  }, 30_000);
});

describe('examples/16-goals-and-wakeups', () => {
  it('wakes a goal on a schedule and on an event, one claimed and leased run per wake', async () => {
    const lines = await run('16-goals-and-wakeups');
    const created = section(lines, 1);
    const night = section(lines, 2);
    const deploy = section(lines, 3);
    const later = section(lines, 4);

    // A goal that waits for the nightly schedule's wakeup.
    expect(created).toContain('goal links-fixed: active, revision 1');
    expect(created).toContain('waiting for a wakeup at 2026-10-13 02:00 (schedule nightly-links)');

    // The durable claim gives the occurrence to one worker; the other sees a duplicate.
    expect(night).toContain('worker A: nightly-links@1791856800000 (2026-10-13 02:00) ran');
    expect(night).toContain('worker B: nightly-links@1791856800000 (2026-10-13 02:00) duplicate');
    // The occurrence's event wakes the goal, and one native run works on it, under a lease.
    expect(night).toContain('event nightly-links@1791856800000: applied, goal active');
    expect(night).toContain('[tool] check_links: 3 broken links');
    expect(night).toMatch(/worker B's sweep: .+ looks stale; resume refused: lease_held/);
    expect(night).toContain('run completed');
    // Acceptance rests on the tool's report, so the goal waits for the next deploy.
    expect(night).toContain('no-broken-links: failed (tool evidence link-check-1)');
    expect(night).toContain('goal waiting for signal docs-deploy');

    // The deploy webhook's event wakes the goal; its delivery id is claimed once.
    expect(deploy).toContain('worker B: delivery deploy-812 claimed');
    expect(deploy).toContain('event deploy-812: applied, goal active');
    expect(deploy).toContain('[tool] check_links: 0 broken links');
    expect(deploy).toContain('no-broken-links: passed (tool evidence link-check-2)');
    expect(deploy).toContain('goal completed (accepted)');
    expect(deploy).toContain('worker A: delivery deploy-812 duplicate, nothing dispatched');

    // The schedule fires again, but an ended goal ignores the event and nothing runs.
    expect(later).toContain('event nightly-links@1791943200000: ignored (terminal)');
    expect(later).not.toContain('[tool]');
    expect(later).toContain('worker A: nightly-links@1791943200000 (2026-10-14 02:00) ran');
    expectTempDirRemoved();
  }, 30_000);

  it('fits the usage a real tool-enabled call reports into the goal budget', async () => {
    // Anthropic adds its tool-use system prompt to every call that has tools.
    provider.usage = { inputTokens: 430, outputTokens: 45 };
    try {
      const lines = await run('16-goals-and-wakeups');
      const night = section(lines, 2);
      const deploy = section(lines, 3);

      // The first night's charge leaves budget, so the goal waits for the deploy.
      expect(night).toContain('run completed');
      expect(night).toContain('goal waiting for signal docs-deploy');
      expect(deploy).toContain('event deploy-812: applied, goal active');
      // Each run's usage is a charge on the goal: two runs of two calls.
      expect(deploy).toMatch(/goal completed \(accepted\), spent 1900 of \d+ tokens/);
      expect(section(lines, 4)).toContain('ignored (terminal)');
    } finally {
      provider.usage = undefined;
    }
  }, 30_000);

  it('prints a spent budget as the hold it is, not as the wait it refuses', async () => {
    provider.usage = { inputTokens: 900_000, outputTokens: 100_000 };
    try {
      const night = section(await run('16-goals-and-wakeups'), 2);
      expect(night).toContain('run completed');
      expect(night).toMatch(
        /wait for signal docs-deploy rejected \(budget-exhausted\): goal waiting \(budget\), spent 2000000 of \d+ tokens/,
      );
      expect(night).not.toContain('goal waiting for signal docs-deploy');
    } finally {
      provider.usage = undefined;
    }
  }, 30_000);
});

describe('examples/17-realtime-offline', () => {
  it('takes a spoken question, runs the tool in process, speaks the answer and prices it', async () => {
    const lines = await run('17-realtime-offline');
    const output = lines.join('\n');
    const asked = section(lines, 2);
    const followUp = section(lines, 3);

    // connect() configures the session and resolves on session-ready.
    expect(section(lines, 1)).toMatch(/\[sent\] session\.update\n(?:.*\n)*?.*session-ready/);
    // The question goes in as PCM16 chunks, then a manual commit and a response request.
    expect(asked.match(/\[sent\] input_audio_buffer\.append \(\d+ bytes\)/g)).toHaveLength(3);
    expect(asked).toMatch(/\[sent\] input_audio_buffer\.commit\n.*\[sent\] response\.create/);
    expect(asked).toContain('input-transcript-done: "What is the weather in Istanbul?"');
    // The call runs here once its response completed; its result goes back with a new response.create.
    expect(asked).toContain('tool-call: get_weather({"city":"Istanbul"})');
    expect(asked).toMatch(
      /response-done \(\S+, completed\)\n(?:.*\n)*?.*\[tool\] get_weather\(Istanbul\) runs in this process/,
    );
    expect(asked).toMatch(
      /\[sent\] conversation\.item\.create \(function_call_output\)\n.*\[sent\] response\.create/,
    );
    // The model speaks its answer: audio chunks with a transcript.
    expect(asked).toMatch(/audio-delta: \d+ bytes/);
    expect(asked).toContain('output-transcript-done: "Sunny and 24 degrees in Istanbul."');
    // A typed follow-up gets a second spoken answer.
    expect(followUp).toContain('[sent] conversation.item.create (message)');
    expect(followUp).toContain('output-transcript-done: "You are welcome!"');

    // Every response's usage, split by modality and priced, comes before its response-done...
    const usage = [
      ...output.matchAll(
        /usage \((\S+)\): text (\d+) in \/ (\d+) out, audio (\d+) in \/ (\d+) out = \$([\d.]+)/g,
      ),
    ];
    expect(usage).toHaveLength(3);
    for (const [line, id] of usage) {
      expect(output.indexOf(`response-done (${id},`)).toBeGreaterThan(output.indexOf(line));
    }
    // ...and the session total adds them up.
    const sum = (pick: (match: RegExpMatchArray) => number) =>
      usage.reduce((total, match) => total + pick(match), 0);
    const total = /session total: (\d+) tokens \((\d+) audio\), \$([\d.]+)/.exec(section(lines, 4));
    expect(Number(total?.[1])).toBe(
      sum((m) => Number(m[2]) + Number(m[3]) + Number(m[4]) + Number(m[5])),
    );
    expect(Number(total?.[2])).toBe(sum((m) => Number(m[4]) + Number(m[5])));
    expect(Number(total?.[3])).toBeCloseTo(
      sum((m) => Number(m[6])),
      6,
    );
  }, 30_000);

  /** Run 17 against the stand-in for its real provider: it must get to its last step. */
  async function swapped(): Promise<string[]> {
    const { lines, done } = launch('17-realtime-offline');
    // Offline it takes well under a second; a wait for an id only the script uses never ends.
    expect(await finishes(done, 10_000), lines.join('\n')).toBe('finished');
    return lines;
  }

  it('waits on the order of events, so a server that names its own responses gets to the end', async () => {
    provider.serverNamesResponses = true;
    try {
      const lines = await swapped();
      const asked = section(lines, 2);
      const followUp = section(lines, 3);

      // The tool round trip and the whole spoken answer belong to step 2.
      expect(asked).toContain('tool-call: get_weather({"city":"Istanbul"})');
      expect(asked).toContain('[tool] get_weather(Istanbul) runs in this process');
      expect(asked).toContain('output-transcript-done: "Sunny and 24 degrees in Istanbul."');
      expect(asked).toMatch(/response-done \(resp_Cq72Zk, completed\)$/);
      // The follow-up's answer, then the close.
      expect(followUp).toContain('output-transcript-done: "You are welcome!"');
      expect(followUp).toMatch(/response-done \(resp_Cq73Zk, completed\)$/);
      expect(section(lines, 4)).toContain(
        'session-closed (1000 client closed, closed by the client)',
      );
    } finally {
      provider.serverNamesResponses = false;
    }
  }, 30_000);

  it.each([
    ["continues the tool call's turn", 'same turn'],
    ['is a turn of its own', 'own turn'],
  ] as const)(
    'gets to the end on a Gemini Live wire where the answer to a tool result %s',
    async (_answer, turn) => {
      provider.gemini = turn;
      try {
        const lines = await swapped();
        const asked = section(lines, 2);
        expect(asked).toContain('[tool] get_weather(Istanbul) runs in this process');
        expect(asked).toMatch(
          /"Sunny and 24 degrees in Istanbul\."[\s\S]*response-done \(\S+, completed\)$/,
        );
        expect(section(lines, 3)).toMatch(
          /"You are welcome!"[\s\S]*response-done \(\S+, completed\)$/,
        );
        expect(section(lines, 4)).toContain('session-closed');
      } finally {
        provider.gemini = undefined;
      }
    },
    30_000,
  );
});

describe('examples/18-batch-offline', () => {
  it('holds the budget at submit, settles each result at batch rates, and runs an unpriced batch', async () => {
    const lines = await run('18-batch-offline');
    const submitted = section(lines, 1);
    const polled = section(lines, 2);
    const read = section(lines, 3);
    const unpriced = section(lines, 4);

    // Each request reserves a priced hold when the batch is submitted; holds stay open up to 25 h.
    expect(submitted).toContain('on claude-sonnet-5-5: holds stay open up to 25 h (holdMs)');
    expect(submitted.match(/ticket-\d: hold reserved: \d+ tokens, \$[\d.]+/g)).toHaveLength(3);
    expect(submitted).toMatch(/ledger: \$0 spent, \$[\d.]+ held, budget \$0\.05/);
    // wait polls until the batch ends.
    expect(polled).toContain('[status] running (in_progress): 3 processing');
    expect(polled).toContain('[status] completed (ended): 2 succeeded, 1 expired');

    // A result settles its hold before it is handed out: the two that succeeded at batch rates...
    expect(read).toContain('ticket-1 succeeded: {"category":"bug","urgent":true}');
    expect(read).toContain('ticket-2 succeeded: {"category":"billing","urgent":true}');
    const prices = [...read.matchAll(/\$([\d.]+) at batch rates \(\$([\d.]+) standard\)/g)];
    expect(prices).toHaveLength(2);
    for (const [, batch, standard] of prices) expect(Number(batch)).toBeLessThan(Number(standard));
    const settled = [...read.matchAll(/hold settled: \d+ tokens, \$([\d.]+)/g)];
    expect(settled).toHaveLength(2);
    // ...the expired one, which never ran, releases its hold.
    expect(read).toMatch(/ticket-3 expired: never ran, so never billed\n\s*hold released/);
    const spent = /ledger: \$([\d.]+) spent, \$0 held/.exec(read);
    expect(Number(spent?.[1])).toBeCloseTo(
      settled.reduce((total, [, usd]) => total + Number(usd), 0),
      6,
    );

    // A model without a batch price still runs: a warning, and a hold that counts tokens only.
    expect(unpriced).toContain('[warning] unpriced-model: claude-sonnet-4-5');
    expect(unpriced).toMatch(/ticket-4: hold reserved: \d+ tokens, no price/);
    expect(unpriced).toContain('ticket-4 succeeded: {"category":"question","urgent":false}');
    expect(unpriced).toMatch(/hold unknown: \d+ tokens, cost unknown/);
  }, 30_000);
});

describe('examples/19-mcp-server', () => {
  it('serves tools and an agent over MCP 2026-07-28, asking the client user before a refund', async () => {
    const lines = await run('19-mcp-server');
    const listed = section(lines, 2);
    const called = section(lines, 3);
    const approvals = section(lines, 4);
    const agent = section(lines, 5);

    // With the v2 MCP packages installed, the in-process client negotiates MCP 2026-07-28.
    expect(section(lines, 1)).toContain('SDK line v2, MCP 2026-07-28, server support-desk 1.0.0');
    // tools/list: the two tools and the agent.
    for (const name of ['lookup_order', 'refund_order', 'support_agent'])
      expect(listed).toContain(`   ${name}: `);
    // A structured result is the value; a tool that throws comes back as an error with its message.
    expect(called).toContain('-> {"orderId":"A-17","status":"delivered damaged","totalUsd":42}');
    expect(called).toContain('-> error: There is no order Z-9.');
    // Each refund asks the client's user first: accepted, it runs; declined, it is denied unrun.
    expect(approvals).toMatch(
      /the user answers: accept .*\n.*\[server\] refund_order\(A-17\) runs\n.*-> \{"orderId":"A-17","refundedUsd":42\}/,
    );
    expect(approvals).toMatch(/the user answers: decline\n.*-> error: Tool call denied/);
    expect(approvals).not.toContain('[server] refund_order(B-2) runs');
    // One MCP call runs a whole native run on the server, its own tool call included.
    expect(agent).toContain('[server] lookup_order(B-2) runs');
    expect(agent).toContain('-> "Order B-2 is in transit. It should arrive within two days."');
  }, 30_000);
});

describe('examples/20-a2a-agent', () => {
  it('waits for an approval over A2A, refuses an answer that does not fit, and delivers the artifact', async () => {
    const lines = await run('20-a2a-agent');
    const asked = section(lines, 1);
    const refused = section(lines, 2);
    const approved = section(lines, 3);
    const task = section(lines, 4);

    // The client found the agent through its card; the run waits for an approval, nothing has run.
    expect(asked).toContain('the client asks Table booker for a booking');
    expect(asked).toContain('TASK_STATE_INPUT_REQUIRED');
    expect(asked).toContain(
      'pending: approval of bookTable {"restaurant":"Lokanta","guests":2,"time":"19:30"}',
    );
    // Text alone does not answer it: INVALID_PARAMS, and the task still waits.
    expect(refused).toMatch(/INVALID_PARAMS: /);
    expect(refused).toContain('still TASK_STATE_INPUT_REQUIRED');
    expect(`${asked}\n${refused}`).not.toContain('[agent] bookTable ran');
    // The approval in a data part resumes the run; its validated output is the booking artifact.
    expect(approved.match(/\[agent\] bookTable ran/g)).toHaveLength(1);
    expect(approved).toContain('TASK_STATE_COMPLETED');
    expect(approved).toContain(
      `artifact 'booking': {"reference":"LOK-1930-2","restaurant":"Lokanta","guests":2,"time":"19:30"}`,
    );
    // The task is the native run.
    expect(task).toContain('run id = task id');
    expect(task).toContain('status completed');
  }, 30_000);
});
