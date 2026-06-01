import { describe, it, expect } from 'vitest';
import {
  submitImagine,
  submitAction,
  fetchTask,
  waitForTask,
  imagine,
  type MidjourneyTask,
} from '../src/midjourney';
import { APICallError, AuthenticationError, TimeoutError } from '../src/errors';

/** JSON fetch double over a per-URL handler; records requests. */
function jsonFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const { status = 200, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Deterministic clock: setTimeout fires immediately; now() advances by `step` each read. */
function fakeClock(step = 1000) {
  let t = 0;
  return {
    now: () => (t += step),
    setTimeout: (fn: () => void) => {
      fn();
      return () => {};
    },
  };
}

describe('submitImagine', () => {
  it('POSTs to /mj/submit/imagine with Bearer auth and returns the task id', async () => {
    const { fetch, calls } = jsonFetch(() => ({
      body: { code: 1, description: 'Submit success', result: '14988' },
    }));
    const res = await submitImagine({ apiKey: 'sk-y', fetch, prompt: 'a robot --ar 1:1' });

    expect(res).toMatchObject({ taskId: '14988', code: 1 });
    expect(calls[0]!.url).toBe('https://yunwu.ai/mj/submit/imagine');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-y');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ prompt: 'a robot --ar 1:1' });
  });

  it('passes base64Array + notifyHook when provided', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: { code: 1, result: 't1' } }));
    await submitImagine({
      apiKey: 'k',
      fetch,
      prompt: 'p',
      base64Array: ['data:image/png;base64,AAAA'],
      notifyHook: 'https://cb',
    });
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.base64Array).toEqual(['data:image/png;base64,AAAA']);
    expect(body.notifyHook).toBe('https://cb');
  });

  it('throws when the relay returns no task id', async () => {
    const { fetch } = jsonFetch(() => ({ body: { code: 4, description: 'banned prompt' } }));
    await expect(submitImagine({ apiKey: 'k', fetch, prompt: 'x' })).rejects.toBeInstanceOf(
      APICallError,
    );
  });

  it('maps a 500 relay error', async () => {
    const { fetch } = jsonFetch(() => ({
      status: 500,
      body: { detail: 'no channel', type: 'yunwu_api_error' },
    }));
    await expect(submitImagine({ apiKey: 'k', fetch, prompt: 'x' })).rejects.toBeInstanceOf(
      APICallError,
    );
  });

  it('throws AuthenticationError with no key (before fetch)', async () => {
    let fetched = false;
    const fetchImpl = (async () => ((fetched = true), new Response('{}'))) as typeof fetch;
    await expect(submitImagine({ fetch: fetchImpl, prompt: 'x' })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(fetched).toBe(false);
  });
});

describe('submitAction', () => {
  it('POSTs taskId + customId to /mj/submit/action', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: { code: 1, result: 'child-1' } }));
    const res = await submitAction({
      apiKey: 'k',
      fetch,
      taskId: 'parent',
      customId: 'MJ::JOB::upsample::1::abc',
    });
    expect(res.taskId).toBe('child-1');
    expect(calls[0]!.url).toBe('https://yunwu.ai/mj/submit/action');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      taskId: 'parent',
      customId: 'MJ::JOB::upsample::1::abc',
    });
  });
});

describe('fetchTask', () => {
  it('returns the task when present', async () => {
    const task: MidjourneyTask = {
      id: 't1',
      status: 'SUCCESS',
      imageUrl: 'https://img/x.png',
      progress: '100%',
    };
    const { fetch, calls } = jsonFetch(() => ({ body: task }));
    const got = await fetchTask('t1', { apiKey: 'k', fetch });
    expect(got).toMatchObject({ id: 't1', status: 'SUCCESS', imageUrl: 'https://img/x.png' });
    expect(calls[0]!.url).toBe('https://yunwu.ai/mj/task/t1/fetch');
  });

  it('returns null for an unknown-task envelope ({code:4})', async () => {
    const { fetch } = jsonFetch(() => ({ body: { code: 4, description: '任务不存在' } }));
    expect(await fetchTask('nope', { apiKey: 'k', fetch })).toBeNull();
  });
});

describe('waitForTask', () => {
  it('polls until SUCCESS and reports progress', async () => {
    const snaps: MidjourneyTask[] = [
      { id: 't', status: 'IN_PROGRESS', progress: '50%' },
      { id: 't', status: 'SUCCESS', progress: '100%', imageUrl: 'https://img/done.png' },
    ];
    let i = 0;
    const { fetch } = jsonFetch(() => ({ body: snaps[Math.min(i++, snaps.length - 1)] }));
    const seen: string[] = [];
    const task = await waitForTask('t', {
      apiKey: 'k',
      fetch,
      deps: { clock: fakeClock() },
      onProgress: (t) => seen.push(t.status),
    });
    expect(task.status).toBe('SUCCESS');
    expect(task.imageUrl).toBe('https://img/done.png');
    expect(seen).toEqual(['IN_PROGRESS', 'SUCCESS']);
  });

  it('times out if the task never finishes', async () => {
    const { fetch } = jsonFetch(() => ({
      body: { id: 't', status: 'IN_PROGRESS', progress: '10%' },
    }));
    await expect(
      waitForTask('t', { apiKey: 'k', fetch, timeoutMs: 5000, deps: { clock: fakeClock(3000) } }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('imagine (submit + wait convenience)', () => {
  it('submits then polls to completion', async () => {
    let phase = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/submit/imagine')
        ? { code: 1, result: 'task-9' }
        : phase++ === 0
          ? { id: 'task-9', status: 'IN_PROGRESS', progress: '20%' }
          : { id: 'task-9', status: 'SUCCESS', imageUrl: 'https://img/final.png' };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const task = await imagine({
      apiKey: 'k',
      fetch: fetchImpl,
      prompt: 'a deuz robot',
      deps: { clock: fakeClock() },
    });
    expect(task).toMatchObject({
      id: 'task-9',
      status: 'SUCCESS',
      imageUrl: 'https://img/final.png',
    });
  });
});
