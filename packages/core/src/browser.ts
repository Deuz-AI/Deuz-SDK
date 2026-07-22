/**
 * `@deuz-sdk/core/browser` (1.8) — turn a `BrowserController` seam into tools a
 * model can call to drive a browser: `navigate`, `click`, `type`, `readText`,
 * `screenshot`. Pure Web APIs; the real browser lives behind the seam
 * (`@deuz-sdk/core/browser/node` is the Playwright reference).
 *
 * SECURITY: browser tools reach arbitrary URLs and submit forms — gate them
 * with `approveToolCall` and restrict origins at the backend (lethal-trifecta).
 */
import type { JSONSchema } from './types/schema';
import type { Tool, ToolSet } from './types/tool';
import type { BrowserController } from './types/browser';
import type { Workspace } from './types/workspace';

export type { BrowserController, BrowserNavigateResult } from './types/browser';

function capText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export interface BrowserToolsOptions {
  /** Cap `readText` output fed to the model. Default 20_000 chars. */
  maxTextChars?: number;
  /**
   * When set, `screenshot` writes the PNG bytes here and returns the path
   * (never raw bytes in the model's context). Without it, `screenshot` returns
   * only the byte length.
   */
  workspace?: Workspace;
  /** Directory prefix for saved screenshots. Default `'screenshots'`. */
  screenshotDir?: string;
  /** Route navigational/click/type calls through `approveToolCall`. Default false. */
  needsApproval?: boolean;
}

const navigateParams: JSONSchema = {
  type: 'object',
  properties: { url: { type: 'string', description: 'Absolute URL to open.' } },
  required: ['url'],
  additionalProperties: false,
};
const clickParams: JSONSchema = {
  type: 'object',
  properties: { selector: { type: 'string', description: 'CSS selector to click.' } },
  required: ['selector'],
  additionalProperties: false,
};
const typeParams: JSONSchema = {
  type: 'object',
  properties: {
    selector: { type: 'string', description: 'CSS selector of the input field.' },
    text: { type: 'string', description: 'Text to type.' },
    submit: { type: 'boolean', description: 'Press Enter after typing.' },
  },
  required: ['selector', 'text'],
  additionalProperties: false,
};
const readTextParams: JSONSchema = {
  type: 'object',
  properties: {
    selector: { type: 'string', description: 'Optional CSS selector; omit for the whole page.' },
  },
  additionalProperties: false,
};
const screenshotParams: JSONSchema = {
  type: 'object',
  properties: { fullPage: { type: 'boolean', description: 'Capture the full scrollable page.' } },
  additionalProperties: false,
};

/**
 * Wrap a `BrowserController` as a `ToolSet`. `screenshot` saves to a `Workspace`
 * (when provided) and returns the path instead of dumping bytes into context.
 */
export function createBrowserTools(
  browser: BrowserController,
  options: BrowserToolsOptions = {},
): ToolSet {
  const maxText = options.maxTextChars ?? 20_000;
  const dir = options.screenshotDir ?? 'screenshots';
  const gate = options.needsApproval ? { needsApproval: true as const } : {};
  let shotCount = 0;

  const navigate: Tool = {
    description: 'Open a URL in the browser and return its resolved url + title.',
    parameters: navigateParams,
    ...gate,
    execute: async (args, ctx) => {
      const { url } = args as { url: string };
      return browser.navigate(url, ctx.signal ? { signal: ctx.signal } : undefined);
    },
  };
  const click: Tool = {
    description: 'Click the first element matching a CSS selector.',
    parameters: clickParams,
    ...gate,
    execute: async (args) => {
      const { selector } = args as { selector: string };
      await browser.click(selector);
      return { clicked: selector };
    },
  };
  const type: Tool = {
    description: 'Type text into a field (optionally submit with Enter).',
    parameters: typeParams,
    ...gate,
    execute: async (args) => {
      const { selector, text, submit } = args as {
        selector: string;
        text: string;
        submit?: boolean;
      };
      await browser.type(selector, text, submit !== undefined ? { submit } : undefined);
      return { typedInto: selector, submitted: submit === true };
    },
  };
  const readText: Tool = {
    description: 'Read the visible text of the page or a selector.',
    parameters: readTextParams,
    execute: async (args) => {
      const { selector } = args as { selector?: string };
      const text = await browser.readText(selector);
      return { text: capText(text, maxText) };
    },
  };
  const screenshot: Tool = {
    description: 'Capture a screenshot of the current page.',
    parameters: screenshotParams,
    execute: async (args) => {
      const { fullPage } = args as { fullPage?: boolean };
      const bytes = await browser.screenshot(fullPage !== undefined ? { fullPage } : undefined);
      if (options.workspace?.writeBytes) {
        shotCount += 1;
        const path = `${dir}/shot-${shotCount}.png`;
        await options.workspace.writeBytes(path, bytes);
        return { savedTo: path, bytes: bytes.byteLength };
      }
      return { bytes: bytes.byteLength };
    },
  };

  return { navigate, click, type, readText, screenshot };
}
