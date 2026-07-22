import { describe, it, expect, vi } from 'vitest';
import { createBrowserTools } from '../src/browser';
import type { BrowserController } from '../src/types/browser';
import { createInMemoryWorkspace } from '../src/workspace';
import type { ToolExecuteContext } from '../src/types/tool';

const ctx: ToolExecuteContext = { toolCallId: 'call_1', messages: [] };

function mockBrowser(over: Partial<BrowserController> = {}): BrowserController {
  return {
    navigate: vi.fn(async (url: string) => ({ url, title: 'Example', status: 200 })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    readText: vi.fn(async () => 'page text'),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])), // PNG magic
    currentUrl: vi.fn(async () => 'https://example.com'),
    ...over,
  };
}

describe('createBrowserTools', () => {
  it('exposes navigate/click/type/readText/screenshot and drives the controller', async () => {
    const browser = mockBrowser();
    const tools = createBrowserTools(browser);
    expect(Object.keys(tools)).toEqual(['navigate', 'click', 'type', 'readText', 'screenshot']);

    const nav = await tools.navigate!.execute!({ url: 'https://example.com' }, ctx);
    expect(nav).toEqual({ url: 'https://example.com', title: 'Example', status: 200 });

    await tools.type!.execute!({ selector: '#q', text: 'hi', submit: true }, ctx);
    expect(browser.type).toHaveBeenCalledWith('#q', 'hi', { submit: true });

    const read = (await tools.readText!.execute!({ selector: 'main' }, ctx)) as { text: string };
    expect(read.text).toBe('page text');
  });

  it('caps readText output', async () => {
    const browser = mockBrowser({ readText: async () => 'x'.repeat(100) });
    const tools = createBrowserTools(browser, { maxTextChars: 10 });
    const read = (await tools.readText!.execute!({}, ctx)) as { text: string };
    expect(read.text).toContain('truncated');
  });

  it('screenshot saves to a workspace and returns the path (no bytes in context)', async () => {
    const ws = createInMemoryWorkspace();
    const browser = mockBrowser();
    const tools = createBrowserTools(browser, { workspace: ws });
    const shot = (await tools.screenshot!.execute!({ fullPage: true }, ctx)) as {
      savedTo: string;
      bytes: number;
    };
    expect(shot.savedTo).toBe('screenshots/shot-1.png');
    expect(shot.bytes).toBe(4);
    expect(await ws.exists('screenshots/shot-1.png')).toBe(true);
  });

  it('screenshot without a workspace returns only the byte length', async () => {
    const tools = createBrowserTools(mockBrowser());
    const shot = (await tools.screenshot!.execute!({}, ctx)) as { bytes: number; savedTo?: string };
    expect(shot.bytes).toBe(4);
    expect(shot.savedTo).toBeUndefined();
  });

  it('applies needsApproval to navigational tools when requested', () => {
    const tools = createBrowserTools(mockBrowser(), { needsApproval: true });
    expect(tools.navigate!.needsApproval).toBe(true);
    expect(tools.click!.needsApproval).toBe(true);
    expect(tools.readText!.needsApproval).toBeUndefined(); // reads stay ungated
  });
});
