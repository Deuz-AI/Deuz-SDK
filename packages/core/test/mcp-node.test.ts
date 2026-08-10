/**
 * `./mcp/node` — the file-backed token store (round-trip, atomic write, 0600,
 * corrupt-file tolerance) and the loopback redirect listener (real local HTTP:
 * a code resolves, an `?error=` rejects, a lapsed deadline rejects).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTokenStore, createLoopbackRedirect } from '../src/node/mcp';

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'deuz-mcp-')), name);
}

// chmod on Windows only toggles the read-only bit, so the POSIX-mode assertion
// has nothing to check there.
const posix = process.platform !== 'win32';

describe('createFileTokenStore', () => {
  it('round-trips through the file and survives a new store instance', async () => {
    const path = tempPath('tokens.json');
    const store = createFileTokenStore({ path });

    expect(await store.get('tokens:https://a/mcp')).toBeUndefined();
    await store.set('tokens:https://a/mcp', '{"access_token":"at"}');
    await store.set('server-url', 'https://a/mcp');
    expect(await store.get('tokens:https://a/mcp')).toBe('{"access_token":"at"}');

    // A second process reads the same file — this is the whole point of the
    // store (an in-memory one loses the refresh token on every restart).
    const reopened = createFileTokenStore({ path });
    expect(await reopened.get('server-url')).toBe('https://a/mcp');

    await store.delete('tokens:https://a/mcp');
    expect(await reopened.get('tokens:https://a/mcp')).toBeUndefined();
    expect(await reopened.get('server-url')).toBe('https://a/mcp');
  });

  it('keeps concurrent writes from clobbering each other (read-modify-write)', async () => {
    const path = tempPath('tokens.json');
    const store = createFileTokenStore({ path });
    // The SDK saves the verifier and the tokens back-to-back without awaiting.
    await Promise.all([
      store.set('code-verifier:s', 'v'),
      store.set('tokens:s', '{"access_token":"at"}'),
      store.set('client-info:s', '{"client_id":"c"}'),
    ]);
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    expect(Object.keys(written).sort()).toEqual(['client-info:s', 'code-verifier:s', 'tokens:s']);
  });

  it('creates the file 0600 — it holds live refresh tokens', async () => {
    const path = tempPath('tokens.json');
    await createFileTokenStore({ path }).set('tokens:s', 'secret');
    if (!posix) return;
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('treats a corrupt file as empty and repairs it on the next write', async () => {
    const path = tempPath('tokens.json');
    await writeFile(path, '{ this is not json', 'utf8');
    const store = createFileTokenStore({ path });

    expect(await store.get('tokens:s')).toBeUndefined();
    await store.set('tokens:s', 'fresh');
    expect(await store.get('tokens:s')).toBe('fresh');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'tokens:s': 'fresh' });
  });

  it('ignores non-string entries rather than handing them back as tokens', async () => {
    const path = tempPath('tokens.json');
    await writeFile(path, JSON.stringify({ 'tokens:s': { nested: true }, ok: 'yes' }), 'utf8');
    const store = createFileTokenStore({ path });
    expect(await store.get('tokens:s')).toBeUndefined();
    expect(await store.get('ok')).toBe('yes');
  });

  it('creates missing parent directories on the first write', async () => {
    const path = join(tempPath('nested'), 'deep', 'tokens.json');
    const store = createFileTokenStore({ path });
    await store.set('server-url', 'https://a/mcp');
    expect(await store.get('server-url')).toBe('https://a/mcp');
  });
});

describe('createLoopbackRedirect', () => {
  it('resolves the ?code= from a real request and answers a closeable page', async () => {
    const loopback = await createLoopbackRedirect();
    try {
      expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const response = await fetch(`${loopback.redirectUri}?code=auth-code-1&state=xyz`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toMatch(/close this window/i);
      expect(await loopback.waitForCode()).toBe('auth-code-1');
      // Single-shot: the same code is handed to every later waiter.
      expect(await loopback.waitForCode()).toBe('auth-code-1');
    } finally {
      await loopback.close();
      await loopback.close(); // idempotent — callers put this in a finally
    }
  });

  it('honours an explicit path and 404s anything else', async () => {
    const loopback = await createLoopbackRedirect({ path: '/oauth/done' });
    try {
      expect(loopback.redirectUri).toMatch(/\/oauth\/done$/);
      const stray = await fetch(
        `http://127.0.0.1:${new URL(loopback.redirectUri).port}/favicon.ico`,
      );
      expect(stray.status).toBe(404);
      await stray.text();

      await fetch(`${loopback.redirectUri}?code=deep-path`);
      expect(await loopback.waitForCode()).toBe('deep-path');
    } finally {
      await loopback.close();
    }
  });

  it('rejects on ?error= with the server-supplied reason', async () => {
    const loopback = await createLoopbackRedirect();
    try {
      const response = await fetch(
        `${loopback.redirectUri}?error=access_denied&error_description=User%20said%20no`,
      );
      expect(response.status).toBe(400);
      await response.text();
      await expect(loopback.waitForCode()).rejects.toThrow(/access_denied — User said no/);
    } finally {
      await loopback.close();
    }
  });

  it('rejects a redirect that carries neither code nor error', async () => {
    const loopback = await createLoopbackRedirect();
    try {
      await (await fetch(loopback.redirectUri)).text();
      await expect(loopback.waitForCode()).rejects.toThrow(/neither `code` nor `error`/);
    } finally {
      await loopback.close();
    }
  });

  it('rejects when the deadline lapses — the wait starts at creation', async () => {
    const loopback = await createLoopbackRedirect({ timeoutMs: 20 });
    try {
      await expect(loopback.waitForCode()).rejects.toThrow(/Timed out after 20ms/);
    } finally {
      await loopback.close();
    }
  });

  it('closing before a code arrives fails the pending wait instead of leaking it', async () => {
    const loopback = await createLoopbackRedirect();
    const pending = loopback.waitForCode();
    await loopback.close();
    await expect(pending).rejects.toThrow(/closed before an authorization code arrived/);
  });
});
