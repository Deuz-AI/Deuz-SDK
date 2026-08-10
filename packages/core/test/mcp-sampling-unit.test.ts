import { describe, it, expect, vi } from 'vitest';
import {
  attachRoots,
  buildRootsHandler,
  buildSamplingHandler,
  createRootsBox,
  mcpStopReason,
  normalizeRootUri,
  samplingMessagesToCanonical,
  wrapMcpClient,
  type McpSamplingRequest,
  type RawMcpClient,
} from '../src/mcp/shared';
import { InvalidRequestError } from '../src/errors';
import { createOpenAI } from '../src/openai';
import { sseEvents, sseResponse, mockFetch } from './fixtures/sse';

// ===================================================================
// PURE unit level for MCP sampling + roots: the server calls US.
//
// No server, no transport — the handler factories are pure, so a fake
// `RawMcpClient` and a golden-replay model (factory `fetch`, G1) pin every
// mapping deterministically. The end-to-end pass over a real MCP server lives
// in the http/stdio integration suites.
// ===================================================================

const fakeRaw: RawMcpClient = {
  connect: async () => {},
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  close: async () => {},
};

/** One Chat Completions turn: some text, a finish reason, usage, `[DONE]`. */
function ccDone(text: string, finish: string): string {
  return sseEvents([
    { data: { choices: [{ delta: { content: text }, finish_reason: finish }] } },
    { data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
    { data: '[DONE]' },
  ]);
}

function fakeModel(opts: { text?: string; finish?: string } = {}) {
  const { fetch, calls } = mockFetch(() =>
    sseResponse([ccDone(opts.text ?? 'sampled reply', opts.finish ?? 'stop')]),
  );
  return { model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'), calls };
}

/** Parse a recorded request body — every assertion below is on the wire shape. */
function body(call: { init?: RequestInit }) {
  return JSON.parse(String(call.init!.body));
}

// ===================================================================
// MCP wire shape → canonical Message[]
// ===================================================================

describe('sampling message mapping', () => {
  it('maps text and image blocks, per role, one part per message', () => {
    expect(
      samplingMessagesToCanonical([
        { role: 'user', content: { type: 'text', text: 'summarise this' } },
        { role: 'assistant', content: { type: 'text', text: 'sure' } },
        { role: 'user', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } },
      ]),
    ).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'summarise this' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
      { role: 'user', content: [{ type: 'image', image: 'aGk=', mediaType: 'image/png' }] },
    ]);
  });

  it('omits mediaType when the server sent none; degrades unknown blocks to empty text', () => {
    expect(
      samplingMessagesToCanonical([{ role: 'user', content: { type: 'image', data: 'aGk=' } }]),
    ).toEqual([{ role: 'user', content: [{ type: 'image', image: 'aGk=' }] }]);
    expect(
      samplingMessagesToCanonical([{ role: 'user', content: { type: 'audio', data: 'aGk=' } }]),
    ).toEqual([{ role: 'user', content: [{ type: 'text', text: '' }] }]);
  });
});

// ===================================================================
// The handler drives OUR model — request in, MCP result out
// ===================================================================

describe('buildSamplingHandler', () => {
  it('runs generateText and answers in MCP shape', async () => {
    const { model, calls } = fakeModel({ text: 'the answer' });
    const handler = buildSamplingHandler({ model });

    const result = await handler({
      params: {
        messages: [{ role: 'user', content: { type: 'text', text: 'what is 2+2?' } }],
        systemPrompt: 'Be terse.',
        maxTokens: 512,
        temperature: 0.2,
        stopSequences: ['\n\n'],
        modelPreferences: { hints: [{ name: 'claude' }] },
      },
    });

    expect(result).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'the answer' },
      model: 'gpt-5.5',
      stopReason: 'endTurn',
    });
    // The systemPrompt folds into the leading system turn at the call boundary.
    const sent = body(calls[0]!);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'what is 2+2?' },
    ]);
    expect(sent.max_tokens).toBe(512);
    expect(sent.temperature).toBe(0.2);
    expect(sent.stop).toEqual(['\n\n']);
    // modelPreferences are hints only — the configured model always wins.
    expect(sent.model).toBe('gpt-5.5');
  });

  it('carries an image block onto the wire as a data: URL', async () => {
    const { model, calls } = fakeModel();
    const handler = buildSamplingHandler({ model });

    await handler({
      params: {
        messages: [
          { role: 'user', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } },
        ],
        maxTokens: 64,
      },
    });

    expect(body(calls[0]!).messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }],
      },
    ]);
  });

  it('clamps the server ask to the configured maxTokens ceiling (never raises it)', async () => {
    const high = fakeModel();
    await buildSamplingHandler({ model: high.model, maxTokens: 100 })({
      params: { messages: [], maxTokens: 5_000 },
    });
    expect(body(high.calls[0]!).max_tokens).toBe(100);

    // A request UNDER the ceiling is honoured as-is — the ceiling is a cap, not a floor.
    const low = fakeModel();
    await buildSamplingHandler({ model: low.model, maxTokens: 100 })({
      params: { messages: [], maxTokens: 32 },
    });
    expect(body(low.calls[0]!).max_tokens).toBe(32);

    // No ceiling → whatever the server asked for.
    const open = fakeModel();
    await buildSamplingHandler({ model: open.model })({
      params: { messages: [], maxTokens: 5_000 },
    });
    expect(body(open.calls[0]!).max_tokens).toBe(5_000);
  });

  it('maps the finish reason onto the MCP stopReason', async () => {
    const { model } = fakeModel({ finish: 'length' });
    const result = await buildSamplingHandler({ model })({
      params: { messages: [], maxTokens: 8 },
    });
    expect(result.stopReason).toBe('maxTokens');
  });
});

// ===================================================================
// approve: the HITL gate that runs BEFORE the model call
// ===================================================================

describe('sampling approval', () => {
  it('sees the canonical request with the clamped cap, before any fetch', async () => {
    const { model, calls } = fakeModel();
    const seen: McpSamplingRequest[] = [];
    const handler = buildSamplingHandler({
      model,
      maxTokens: 200,
      approve: (req) => {
        seen.push(req);
        return true;
      },
    });

    await handler({
      params: {
        messages: [{ role: 'user', content: { type: 'text', text: 'ping' } }],
        systemPrompt: 'sys',
        maxTokens: 900,
        temperature: 0.5,
        stopSequences: ['x'],
        modelPreferences: { costPriority: 1 },
      },
    });

    expect(seen).toEqual([
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        systemPrompt: 'sys',
        maxTokens: 200,
        temperature: 0.5,
        stopSequences: ['x'],
        modelPreferences: { costPriority: 1 },
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('refuses (throws) on `false` and never calls the model', async () => {
    const { model, calls } = fakeModel();
    const handler = buildSamplingHandler({ model, approve: () => false });
    await expect(handler({ params: { messages: [], maxTokens: 16 } })).rejects.toThrow(
      /declined by the client/,
    );
    expect(calls).toHaveLength(0);
  });

  it('propagates a thrown approve verbatim (the SDK turns it into a JSON-RPC error)', async () => {
    const { model, calls } = fakeModel();
    const handler = buildSamplingHandler({
      model,
      approve: async () => {
        throw new Error('no consent recorded');
      },
    });
    await expect(handler({ params: { messages: [], maxTokens: 16 } })).rejects.toThrow(
      'no consent recorded',
    );
    expect(calls).toHaveLength(0);
  });
});

// ===================================================================
// finishReason → stopReason table
// ===================================================================

describe('mcpStopReason', () => {
  it('maps the three MCP outcomes and floors everything else to endTurn', () => {
    expect(mcpStopReason('stop')).toBe('endTurn');
    expect(mcpStopReason('length')).toBe('maxTokens');
    expect(mcpStopReason('stop_sequence')).toBe('stopSequence');
    for (const other of ['tool_calls', 'content_filter', 'error', 'aborted', 'anything']) {
      expect(mcpStopReason(other)).toBe('endTurn');
    }
  });
});

// ===================================================================
// roots
// ===================================================================

describe('root URI normalization', () => {
  it('promotes plain paths to file:// and passes a file:// URI through', () => {
    expect(normalizeRootUri('/home/umut/project')).toBe('file:///home/umut/project');
    expect(normalizeRootUri('C:\\Users\\umut\\project')).toBe('file://C:/Users/umut/project');
    expect(normalizeRootUri('file:///already/a/uri')).toBe('file:///already/a/uri');
    // A single-letter "scheme" is a Windows drive, never a URI — the promotion
    // above is what proves the scheme test does not swallow `C:`.
    expect(normalizeRootUri('D:\\data')).toBe('file://D:/data');
  });

  it('refuses every other scheme — MCP RootSchema is `startsWith("file://")`', () => {
    for (const bad of ['https://example.com/repo', 'http://x.dev', 'ftp://f/x', 'mailto:a@b.c']) {
      expect(() => normalizeRootUri(bad)).toThrow(InvalidRequestError);
      expect(() => normalizeRootUri(bad)).toThrow(/file:\/\//);
    }
    // The message names the value, so the offender in a long list is obvious.
    expect(() => normalizeRootUri('https://example.com/repo')).toThrow(/example\.com/);
    // `file:` with ONE slash fails the SDK's literal prefix check too.
    expect(() => normalizeRootUri('file:/single/slash')).toThrow(InvalidRequestError);
  });
});

describe('buildRootsHandler', () => {
  it('answers roots/list from a fixed list, normalized', async () => {
    const handler = buildRootsHandler(createRootsBox(['/srv/app', 'C:\\work', 'file:///lit']));
    expect(await handler()).toEqual({
      roots: [{ uri: 'file:///srv/app' }, { uri: 'file://C:/work' }, { uri: 'file:///lit' }],
    });
  });

  it('rejects a fixed list carrying a non-file scheme at construction', () => {
    // One bad root would make the SERVER reject the whole result, so the box
    // never accepts it: the failure lands where the list was supplied.
    expect(() => createRootsBox(['/ok', 'https://example.com/repo'])).toThrow(InvalidRequestError);
  });

  it('rejects a FUNCTION form when it is read, since it cannot be checked earlier', async () => {
    const handler = buildRootsHandler(createRootsBox(() => ['https://example.com/repo']));
    await expect(handler()).rejects.toThrow(InvalidRequestError);
  });

  it('re-reads a function form on every request (sync and async)', async () => {
    let n = 0;
    const rolling = buildRootsHandler(createRootsBox(async () => [`/run/${++n}`]));
    expect(await rolling()).toEqual({ roots: [{ uri: 'file:///run/1' }] });
    expect(await rolling()).toEqual({ roots: [{ uri: 'file:///run/2' }] });

    const sync = buildRootsHandler(createRootsBox(() => ['/sync']));
    expect(await sync()).toEqual({ roots: [{ uri: 'file:///sync' }] });
  });
});

describe('setRoots', () => {
  it('swaps the box the registered handler reads, then notifies the server', async () => {
    const sendRootsListChanged = vi.fn(async () => {});
    const raw: RawMcpClient = { ...fakeRaw, sendRootsListChanged };
    const box = createRootsBox(['/one']);
    const handler = buildRootsHandler(box); // registered ONCE, before connect
    const client = attachRoots(wrapMcpClient(raw), raw, box);

    expect(await handler()).toEqual({ roots: [{ uri: 'file:///one' }] });
    await client.setRoots(['/two', 'C:\\three']);

    expect(box.value).toEqual(['/two', 'C:\\three']);
    expect(sendRootsListChanged).toHaveBeenCalledTimes(1);
    // The handler was never re-registered — it reads the box.
    expect(await handler()).toEqual({
      roots: [{ uri: 'file:///two' }, { uri: 'file://C:/three' }],
    });
  });

  it('rejects on a client created without a `roots` option (capability never declared)', async () => {
    const client = attachRoots(wrapMcpClient(fakeRaw), fakeRaw);
    await expect(client.setRoots(['/x'])).rejects.toThrow(/needs a `roots` option/);
  });

  it('rejects with an actionable upgrade error when the SDK cannot notify', async () => {
    const client = attachRoots(wrapMcpClient(fakeRaw), fakeRaw, createRootsBox(['/one']));
    await expect(client.setRoots(['/x'])).rejects.toThrow(/\^1\.29\.0/);
  });

  it('refuses a non-file root without swapping the box or notifying', async () => {
    const sendRootsListChanged = vi.fn(async () => {});
    const raw: RawMcpClient = { ...fakeRaw, sendRootsListChanged };
    const box = createRootsBox(['/one']);
    const client = attachRoots(wrapMcpClient(raw), raw, box);

    await expect(client.setRoots(['/two', 'https://example.com/repo'])).rejects.toThrow(
      InvalidRequestError,
    );
    // Validated before the swap: the server's view of our roots is untouched,
    // and it was never told to re-read them.
    expect(box.value).toEqual(['/one']);
    expect(sendRootsListChanged).not.toHaveBeenCalled();
  });
});
