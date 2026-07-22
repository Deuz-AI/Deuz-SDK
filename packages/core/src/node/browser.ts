/**
 * Node-only `BrowserController` backed by Playwright (1.8) — the reference
 * "Computer" for autonomous agents. Ships as `@deuz-sdk/core/browser/node`.
 * `playwright` is an OPTIONAL peer, imported lazily (like every other node
 * surface), so the edge-safe core never resolves it and consumers who don't do
 * browser control never install it.
 *
 * Install: `npm i playwright && npx playwright install chromium`.
 *
 * SECURITY: this drives a real browser on the host. Restrict the origins you
 * let an agent reach and gate navigational tools with `approveToolCall`.
 */
import type { BrowserController, BrowserNavigateResult } from '../types/browser';

// Minimal Playwright shapes; `as string` keeps tsup's dts builder from
// statically resolving the optional peer (matches rag-node.ts).
interface ResponseLike {
  status(): number;
}
interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<ResponseLike | null>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  innerText(selector: string, opts?: { timeout?: number }): Promise<string>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  url(): string;
  title(): Promise<string>;
  keyboard: { press(key: string): Promise<void> };
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface ChromiumLike {
  launch(opts?: { headless?: boolean }): Promise<BrowserLike>;
}
interface PlaywrightModule {
  chromium: ChromiumLike;
}

async function loadChromium(): Promise<ChromiumLike> {
  try {
    const pw = (await import('playwright' as string)) as unknown as PlaywrightModule;
    return pw.chromium;
  } catch (err) {
    throw new Error(
      'createPlaywrightBrowser requires the optional peer `playwright`. Install it with `npm i playwright && npx playwright install chromium`.',
      { cause: err },
    );
  }
}

export interface PlaywrightBrowserOptions {
  /** Launch headless (default true). */
  headless?: boolean;
  /** Default navigation/action timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

/**
 * A `BrowserController` that drives Chromium via Playwright. The browser launches
 * lazily on the first call and is reused; `close()` releases it.
 */
export function createPlaywrightBrowser(options: PlaywrightBrowserOptions = {}): BrowserController {
  const timeout = options.timeoutMs ?? 30_000;
  let browser: BrowserLike | undefined;
  let page: PageLike | undefined;

  const ensure = async (): Promise<PageLike> => {
    if (page) return page;
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: options.headless ?? true });
    page = await browser.newPage();
    return page;
  };

  return {
    async navigate(url: string): Promise<BrowserNavigateResult> {
      const p = await ensure();
      const res = await p.goto(url, { waitUntil: 'load', timeout });
      return {
        url: p.url(),
        title: await p.title(),
        ...(res ? { status: res.status() } : {}),
      };
    },
    async click(selector: string): Promise<void> {
      const p = await ensure();
      await p.click(selector, { timeout });
    },
    async type(selector: string, text: string, opts?: { submit?: boolean }): Promise<void> {
      const p = await ensure();
      await p.fill(selector, text, { timeout });
      if (opts?.submit) await p.keyboard.press('Enter');
    },
    async readText(selector?: string): Promise<string> {
      const p = await ensure();
      return p.innerText(selector ?? 'body', { timeout });
    },
    async screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array> {
      const p = await ensure();
      return p.screenshot(opts?.fullPage !== undefined ? { fullPage: opts.fullPage } : {});
    },
    async currentUrl(): Promise<string> {
      const p = await ensure();
      return p.url();
    },
    async close(): Promise<void> {
      await browser?.close();
      browser = undefined;
      page = undefined;
    },
  };
}
