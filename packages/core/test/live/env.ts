/**
 * Key loading for the live smoke tests.
 *
 * Reads `.env.smoke` at the repo root (gitignored) and falls back to the real
 * environment, so CI can inject secrets without a file. Parsing is deliberately
 * minimal — `KEY=value`, `#` comments, blank lines — because a dotenv dependency
 * for three lines of parsing is not worth adding to a zero-dependency package.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../../../../.env.smoke');

let fileEnv: Record<string, string> = {};
try {
  fileEnv = Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=');
        return eq === -1 ? undefined : [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
      })
      .filter((pair): pair is [string, string] => pair !== undefined),
  );
} catch {
  // No file is the normal case for a contributor without credentials.
}

/** The key, or undefined — which is how every suite here decides to skip. */
export function key(name: string): string | undefined {
  const value = fileEnv[name] ?? process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Last 4 characters only, matching `internal/redact.ts`. Used in the log lines
 * these tests print so a run is traceable without ever showing a credential.
 */
export function fingerprint(secret: string): string {
  return `…${secret.slice(-4)}`;
}

/**
 * Run `fn`, but treat a provider quota as a skip rather than a failure.
 *
 * A 429 says the account ran out of allowance, which is a fact about the key and
 * not evidence the SDK is wrong — free tiers hand them out readily, and several
 * suites sharing one key will trip them. Anything else propagates: an auth
 * error, a malformed request or a bad mapping still has to fail loudly, because
 * those are exactly what these tests exist to catch.
 */
export async function skipOnQuota(
  ctx: { skip: () => void },
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    const status = (error as { statusCode?: number } | undefined)?.statusCode;
    if (code === 'rate_limit' || status === 429) {
      // eslint-disable-next-line no-console
      console.warn('[live] skipped: provider returned 429 (quota), not an SDK failure');
      ctx.skip();
      return;
    }
    throw error;
  }
}
