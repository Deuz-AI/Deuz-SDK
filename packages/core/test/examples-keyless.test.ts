/**
 * The keyless 2.3 examples (14-16) run end to end and print what they show,
 * and 17 runs against offline stand-ins for the real providers its README
 * swaps in. The examples import the package by name; here those imports load
 * the sources, so no build is needed. Each run is a fresh import of the example.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeSessionOptions, RealtimeWebSocketFactory } from '../src/realtime/index';

vi.mock('@deuz-sdk/core', () => import('../src/index'));
vi.mock('@deuz-sdk/core/agent', () => import('../src/agent'));
vi.mock('@deuz-sdk/core/chat', () => import('../src/chat'));
vi.mock('@deuz-sdk/core/goal', () => import('../src/goal/index'));
vi.mock('@deuz-sdk/core/memory', () => import('../src/memory'));
vi.mock('@deuz-sdk/core/openai', () => import('../src/openai'));
vi.mock('@deuz-sdk/core/ops', () => import('../src/ops'));
vi.mock('@deuz-sdk/core/ops/sqlite', () => import('../src/node/ops-sqlite'));
vi.mock('@deuz-sdk/core/pricing', () => import('../src/pricing'));
vi.mock('@deuz-sdk/core/schedule', () => import('../src/schedule'));
vi.mock('@deuz-sdk/core/testing', () => import('../src/testing'));
vi.mock('@deuz-sdk/core/ui', () => import('../src/ui'));

/**
 * Example 17's REAL PROVIDER swap, still offline. `serverNamesResponses`: the
 * server picks its own response ids, as the OpenAI Realtime endpoint does; every
 * frame of the scripted socket passes through with only those ids renamed.
 * `gemini`: the session talks to a scripted Gemini Live server instead, where the
 * answer to a tool result continues the tool call's turn or is a turn of its own.
 */
const provider = vi.hoisted(() => ({
  serverNamesResponses: false,
  gemini: undefined as 'same turn' | 'own turn' | undefined,
}));
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

const example = (name: string): string =>
  new URL(`../../../examples/${name}/index.ts`, import.meta.url).href;

/**
 * Start an example once. `lines` collects what it prints, one entry per
 * console.log call; `done` settles when its last line has run.
 */
function start(name: string): { lines: string[]; done: Promise<unknown> } {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  vi.resetModules();
  return { lines, done: import(/* @vite-ignore */ example(name)) };
}

/** Run an example once and return what it printed, one entry per console.log call. */
async function run(name: string): Promise<string[]> {
  const { lines, done } = start(name);
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

    // A replay of the journal rebuilds the state, and applies nothing twice.
    expect(replay).toContain('a fresh client folds it into: completed');
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
  }, 30_000);
});

describe('examples/17-realtime-offline', () => {
  /** Run 17 against the stand-in for its real provider: it must get to its last step. */
  async function swapped(): Promise<string[]> {
    const { lines, done } = start('17-realtime-offline');
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
