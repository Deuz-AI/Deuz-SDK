/**
 * `@deuz-sdk/core/browser/node` — `createPlaywrightBrowser`.
 *
 * `playwright` is an OPTIONAL peer and is NOT a devDependency of this package,
 * so `npm test` must stay hermetic on a machine with no browsers installed.
 * Everything that can be proven without a browser is proven against an injected
 * FAKE chromium (`vi.doMock('playwright', …)`): the option plumbing, the lazy
 * single launch, and the actionable install error. The one thing a fake cannot
 * prove — that the real Playwright surface still matches our structural
 * `ChromiumLike`/`PageLike` shims — sits behind `describe.skipIf` and only runs
 * where the peer is actually installed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createPlaywrightBrowser, type PlaywrightBrowserOptions } from '../src/node/browser';
import type { BrowserController } from '../src/types/browser';

/**
 * Probed at collection time. The package alone is not enough — `npm i playwright`
 * without `npx playwright install chromium` leaves no binary to launch — so the
 * real-launch block also requires the executable to exist.
 */
const chromiumAvailable = await (async (): Promise<boolean> => {
  try {
    const pw = (await import('playwright' as string)) as {
      chromium: { executablePath(): string };
    };
    return existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

// --- The fake chromium the mocked peer hands back ---------------------------

interface Call {
  method: string;
  args: unknown[];
}

function fakePlaywright(init: { gotoReturnsNull?: boolean } = {}): {
  chromium: unknown;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]): T => {
      calls.push({ method, args });
      return result;
    };

  const page = {
    goto: record('goto', Promise.resolve(init.gotoReturnsNull ? null : { status: () => 204 })),
    click: record('click', Promise.resolve()),
    fill: record('fill', Promise.resolve()),
    innerText: record('innerText', Promise.resolve('visible text')),
    screenshot: record('screenshot', Promise.resolve(new Uint8Array([137, 80, 78, 71]))),
    url: record('url', 'https://example.test/after-redirect'),
    title: record('title', Promise.resolve('Example Title')),
    keyboard: { press: record('keyboard.press', Promise.resolve()) },
  };
  const browser = {
    newPage: record('newPage', Promise.resolve(page)),
    close: record('browser.close', Promise.resolve()),
  };
  const chromium = { launch: record('launch', Promise.resolve(browser)) };
  return { chromium, calls };
}

/**
 * Mock the optional peer and re-import the module under the mock registry, so
 * the lazy `import('playwright')` inside `loadChromium` resolves to the fake.
 * `of(method)` returns the recorded calls for one page/browser method.
 */
async function withFakePlaywright(
  init: { options?: PlaywrightBrowserOptions; gotoReturnsNull?: boolean } = {},
): Promise<{ browser: BrowserController; of: (m: string) => Call[] }> {
  const { chromium, calls } = fakePlaywright(init);
  vi.doMock('playwright', () => ({ chromium }));
  vi.resetModules();
  const { createPlaywrightBrowser: fresh } = await import('../src/node/browser');
  return {
    browser: fresh(init.options),
    of: (m) => calls.filter((c) => c.method === m),
  };
}

afterEach(() => {
  vi.doUnmock('playwright');
  vi.resetModules();
});

describe('createPlaywrightBrowser — shape and lifecycle (no browser needed)', () => {
  it('returns a full BrowserController synchronously, launching nothing', () => {
    // Construction must not touch the peer — that is what makes the factory
    // safe to call on a machine that never installs playwright.
    const browser = createPlaywrightBrowser();
    expect(Object.keys(browser).sort()).toEqual([
      'click',
      'close',
      'currentUrl',
      'navigate',
      'readText',
      'screenshot',
      'type',
    ]);
    for (const method of Object.values(browser)) expect(method).toBeTypeOf('function');
  });

  it('close() before any launch is a no-op (never loads the peer)', async () => {
    const browser = createPlaywrightBrowser();
    await expect(browser.close!()).resolves.toBeUndefined();
  });

  it('raises the actionable install error when the peer is absent', async () => {
    // Forced rather than relying on the host: this must hold on a dev machine
    // that DOES have playwright installed too.
    vi.doMock('playwright', () => {
      throw new Error("Cannot find package 'playwright'");
    });
    vi.resetModules();
    const { createPlaywrightBrowser: fresh } = await import('../src/node/browser');
    const browser = fresh();
    // Every method funnels through ensure() → loadChromium(), so the message
    // must be actionable no matter which one the caller hit first.
    await expect(browser.navigate('https://example.test')).rejects.toThrow(
      /requires the optional peer `playwright`.*npx playwright install chromium/s,
    );
    await expect(browser.readText()).rejects.toThrow(/npm i playwright/);
    await expect(browser.screenshot()).rejects.toThrow(/npm i playwright/);
  });
});

describe('createPlaywrightBrowser — option plumbing against a fake chromium', () => {
  it('launches headless by default, lazily, exactly once for the whole session', async () => {
    const { browser, of } = await withFakePlaywright();
    expect(of('launch')).toHaveLength(0); // nothing yet

    await browser.navigate('https://example.test');
    await browser.click('#go');
    await browser.currentUrl();

    expect(of('launch')).toHaveLength(1);
    expect(of('launch')[0]!.args).toEqual([{ headless: true }]);
    expect(of('newPage')).toHaveLength(1); // the page is reused across calls
  });

  it('forwards headless:false', async () => {
    const { browser, of } = await withFakePlaywright({ options: { headless: false } });
    await browser.currentUrl();
    expect(of('launch')[0]!.args).toEqual([{ headless: false }]);
  });

  it('threads the default 30s timeout into every page action', async () => {
    const { browser, of } = await withFakePlaywright();
    await browser.navigate('https://example.test');
    await browser.click('#submit');
    await browser.type('#q', 'hello');
    await browser.readText('main');

    expect(of('goto')[0]!.args).toEqual([
      'https://example.test',
      { waitUntil: 'load', timeout: 30_000 },
    ]);
    expect(of('click')[0]!.args).toEqual(['#submit', { timeout: 30_000 }]);
    expect(of('fill')[0]!.args).toEqual(['#q', 'hello', { timeout: 30_000 }]);
    expect(of('innerText')[0]!.args).toEqual(['main', { timeout: 30_000 }]);
  });

  it('honours a custom timeoutMs', async () => {
    const { browser, of } = await withFakePlaywright({ options: { timeoutMs: 1500 } });
    await browser.navigate('https://example.test');
    await browser.click('#x');
    expect(of('goto')[0]!.args[1]).toEqual({ waitUntil: 'load', timeout: 1500 });
    expect(of('click')[0]!.args[1]).toEqual({ timeout: 1500 });
  });

  it('navigate() reports the RESOLVED url + title + status (not the requested url)', async () => {
    const { browser } = await withFakePlaywright();
    expect(await browser.navigate('https://example.test/before')).toEqual({
      url: 'https://example.test/after-redirect',
      title: 'Example Title',
      status: 204,
    });
  });

  it('navigate() omits status when the backend has no main response (e.g. a data: url)', async () => {
    const { browser } = await withFakePlaywright({ gotoReturnsNull: true });
    const result = await browser.navigate('data:text/html,<p>hi</p>');
    expect(result).toEqual({ url: 'https://example.test/after-redirect', title: 'Example Title' });
    expect('status' in result).toBe(false); // omitted, not undefined
  });

  it('type() presses Enter only when submit is requested', async () => {
    const { browser, of } = await withFakePlaywright();
    await browser.type('#q', 'no submit');
    expect(of('keyboard.press')).toHaveLength(0);
    await browser.type('#q', 'with submit', { submit: true });
    expect(of('keyboard.press')[0]!.args).toEqual(['Enter']);
  });

  it('readText() defaults to the whole body; screenshot() forwards fullPage', async () => {
    const { browser, of } = await withFakePlaywright();
    expect(await browser.readText()).toBe('visible text');
    expect(of('innerText')[0]!.args[0]).toBe('body');

    expect(Array.from(await browser.screenshot({ fullPage: true }))).toEqual([137, 80, 78, 71]);
    expect(of('screenshot')[0]!.args).toEqual([{ fullPage: true }]);
    await browser.screenshot();
    expect(of('screenshot')[1]!.args).toEqual([{}]); // option omitted, not `undefined`
  });

  it('close() releases the browser and the next call launches a fresh one', async () => {
    const { browser, of } = await withFakePlaywright();
    await browser.currentUrl();
    await browser.close!();
    expect(of('browser.close')).toHaveLength(1);

    await browser.currentUrl();
    expect(of('launch')).toHaveLength(2); // state reset, so it relaunches
    await browser.close!();
    await browser.close!(); // idempotent: browser is already undefined
    expect(of('browser.close')).toHaveLength(2);
  });
});

/**
 * The only block that needs a real browser. It is SKIPPED wherever the optional
 * peer or its chromium binary is absent — including this repo's own `npm test`,
 * which does not install playwright — so it is here to catch a Playwright API
 * rename (our `PageLike` shim is structural and unchecked), not as routine
 * coverage. Network-free: it navigates a `data:` URL only.
 */
describe.skipIf(!chromiumAvailable)(
  'createPlaywrightBrowser — real Chromium (peer present)',
  () => {
    it('drives a real page: our structural PageLike shim still matches Playwright', async () => {
      const browser = createPlaywrightBrowser({ timeoutMs: 30_000 });
      try {
        const result = await browser.navigate(
          'data:text/html,<title>Deuz</title><p id="p">hello</p>',
        );
        expect(result.url.startsWith('data:text/html')).toBe(true);
        expect(result.title).toBe('Deuz');
        expect(await browser.readText('#p')).toBe('hello');
        expect((await browser.screenshot()).byteLength).toBeGreaterThan(0);
        expect(await browser.currentUrl()).toBe(result.url);
      } finally {
        await browser.close!();
      }
    }, 120_000);
  },
);
