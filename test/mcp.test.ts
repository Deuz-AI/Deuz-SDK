import { describe, it, expect } from 'vitest';
import {
  wrapMcpClient,
  mcpToolsToToolSet,
  extractContent,
  type RawMcpClient,
} from '../src/mcp/shared';

const fakeRaw: RawMcpClient = {
  connect: async () => {},
  listTools: async () => ({
    tools: [
      {
        name: 'scrape',
        description: 'Scrape a URL',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
    ],
  }),
  callTool: async (req) => ({
    content: [{ type: 'text', text: `scraped:${(req.arguments as { url: string }).url}` }],
  }),
  close: async () => {},
};

describe('MCP → ToolSet mapping', () => {
  it('maps MCP tools to a ToolSet whose execute calls callTool', async () => {
    const client = wrapMcpClient(fakeRaw);
    const tools = await client.listTools();
    expect(Object.keys(tools)).toEqual(['scrape']);
    expect(tools.scrape!.parameters).toMatchObject({ type: 'object' });

    const out = await tools.scrape!.execute!(
      { url: 'https://x.com' },
      { toolCallId: '1', messages: [] },
    );
    expect(out).toBe('scraped:https://x.com');
  });

  it('namespaces tool names when combining servers', () => {
    const tools = mcpToolsToToolSet(fakeRaw, [{ name: 'scrape' }], 'firecrawl');
    expect(Object.keys(tools)).toEqual(['firecrawl_scrape']);
  });

  it('extractContent joins text and throws on isError (self-heal)', () => {
    expect(extractContent({ content: [{ type: 'text', text: 'ok' }] })).toBe('ok');
    expect(() =>
      extractContent({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    ).toThrow('boom');
  });
});

describe('structuredContent + outputSchema (MCP 2025-11-25)', () => {
  it('prefers structuredContent verbatim over the text join', () => {
    expect(
      extractContent({
        content: [{ type: 'text', text: '{"temp":22}' }], // redundant serialization per spec
        structuredContent: { temp: 22 },
      }),
    ).toEqual({ temp: 22 });
    expect(extractContent({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it('isError wins: throws even when structuredContent is present', () => {
    expect(() =>
      extractContent({
        content: [{ type: 'text', text: 'bad input' }],
        isError: true,
        structuredContent: { code: 42 },
      }),
    ).toThrow('bad input');
    // No text blocks → the error message falls back to the structured JSON.
    expect(() => extractContent({ isError: true, structuredContent: { code: 42 } })).toThrow(
      '{"code":42}',
    );
  });

  it('copies outputSchema through to Tool.outputSchema (metadata only)', () => {
    const out = { type: 'object', properties: { temp: { type: 'number' } } };
    const tools = mcpToolsToToolSet(fakeRaw, [{ name: 'weather', outputSchema: out }]);
    expect(tools.weather!.outputSchema).toEqual(out);
    const bare = mcpToolsToToolSet(fakeRaw, [{ name: 'plain' }]);
    expect('outputSchema' in bare.plain!).toBe(false);
  });
});

describe('resources + prompts', () => {
  it('listResources auto-paginates (cursor forwarded, pages merged)', async () => {
    const cursors: Array<string | undefined> = [];
    const raw: RawMcpClient = {
      ...fakeRaw,
      listResources: async (params) => {
        cursors.push(params?.cursor);
        return params?.cursor === 'c1'
          ? { resources: [{ uri: 'file://b', name: 'b' }] }
          : { resources: [{ uri: 'file://a', name: 'a' }], nextCursor: 'c1' };
      },
    };
    const resources = await wrapMcpClient(raw).listResources();
    expect(resources.map((r) => r.uri)).toEqual(['file://a', 'file://b']);
    expect(cursors).toEqual([undefined, 'c1']);
  });

  it('pagination stops at the safety cap on an endless cursor', async () => {
    let pages = 0;
    const raw: RawMcpClient = {
      ...fakeRaw,
      listPrompts: async () => {
        pages++;
        return { prompts: [{ name: `p${pages}` }], nextCursor: 'again' };
      },
    };
    const prompts = await wrapMcpClient(raw).listPrompts();
    expect(pages).toBe(100);
    expect(prompts).toHaveLength(100);
  });

  it('readResource unwraps contents; getPrompt passes args verbatim', async () => {
    const raw: RawMcpClient = {
      ...fakeRaw,
      readResource: async ({ uri }) => ({
        contents: [{ uri, text: 'hello', mimeType: 'text/plain' }],
      }),
      getPrompt: async (params) => ({
        description: 'greeting prompt',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `hi ${params.arguments?.name ?? '?'}` },
          },
        ],
      }),
    };
    const client = wrapMcpClient(raw);
    expect(await client.readResource('file://x')).toEqual([
      { uri: 'file://x', text: 'hello', mimeType: 'text/plain' },
    ]);
    const prompt = await client.getPrompt('greet', { name: 'umut' });
    expect(prompt.description).toBe('greeting prompt');
    expect(prompt.messages[0]).toMatchObject({ role: 'user' });
  });

  it('rejects with an actionable upgrade error when the SDK lacks a method', async () => {
    await expect(wrapMcpClient(fakeRaw).listResources()).rejects.toThrow(/\^1\.29\.0/);
    await expect(wrapMcpClient(fakeRaw).getPrompt('x')).rejects.toThrow(/\^1\.29\.0/);
  });
});
