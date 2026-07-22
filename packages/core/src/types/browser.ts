/**
 * Browser control (1.8 additive) — the seam an autonomous agent uses to drive a
 * real browser (Manus's "Computer": a live Chromium it navigates, clicks, and
 * reads). Storage/host-agnostic: `@deuz-sdk/core/browser/node` ships a
 * Playwright adapter, and any remote/browserless backend implements the same
 * methods. The edge layer (`createBrowserTools`) turns the seam into tools.
 *
 * SECURITY: a browser tool lets the model reach arbitrary URLs and submit
 * forms. Combined with private data + an outbound channel it is the classic
 * exfiltration "lethal trifecta" — gate destructive/navigational calls with
 * `approveToolCall` and restrict origins at the backend.
 */

/** The result of a navigation. */
export interface BrowserNavigateResult {
  url: string;
  title?: string;
  /** HTTP status of the main response, when the backend exposes it. */
  status?: number;
}

/**
 * A controllable browser page. Methods are intentionally small and high-level
 * so a model can drive them through tools; a backend maps them to Playwright,
 * Puppeteer, a remote CDP session, etc.
 */
export interface BrowserController {
  /** Navigate to a URL and wait for load; returns the resolved url + title. */
  navigate(url: string, options?: { signal?: AbortSignal }): Promise<BrowserNavigateResult>;
  /** Click the first element matching a CSS selector. */
  click(selector: string): Promise<void>;
  /** Type text into a field; `submit` presses Enter afterwards. */
  type(selector: string, text: string, options?: { submit?: boolean }): Promise<void>;
  /** Read visible text of an element (or the whole page when no selector). */
  readText(selector?: string): Promise<string>;
  /** Capture a PNG screenshot as raw bytes. */
  screenshot(options?: { fullPage?: boolean }): Promise<Uint8Array>;
  /** The current page URL. */
  currentUrl(): Promise<string>;
  /** Optional: release the underlying browser/page. */
  close?(): Promise<void>;
}
