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
