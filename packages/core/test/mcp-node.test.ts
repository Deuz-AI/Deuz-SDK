/**
 * `./mcp/node` — the file-backed token store (round-trip, atomic write, 0600,
 * corrupt-file tolerance) and the loopback redirect listener (real local HTTP:
 * a code resolves, an `?error=` rejects, a lapsed deadline rejects, and a
 * redirect that does not echo the listener's `state` is refused).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTokenStore, createLoopbackRedirect } from '../src/node/mcp';
import type { LoopbackRedirect } from '../src/node/mcp';

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'deuz-mcp-')), name);
}

/** The URL a compliant authorization server would redirect to — state echoed. */
function callback(loopback: LoopbackRedirect, query: string): string {
  const state = loopback.state === undefined ? '' : `&state=${encodeURIComponent(loopback.state)}`;
  return `${loopback.redirectUri}?${query}${state}`;
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

      const response = await fetch(callback(loopback, 'code=auth-code-1'));
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

      await fetch(callback(loopback, 'code=deep-path'));
      expect(await loopback.waitForCode()).toBe('deep-path');
    } finally {
      await loopback.close();
    }
  });

  it('rejects on ?error= with the server-supplied reason', async () => {
    const loopback = await createLoopbackRedirect();
    try {
      const response = await fetch(
        callback(loopback, 'error=access_denied&error_description=User%20said%20no'),
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
      await (await fetch(callback(loopback, ''))).text();
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

  it('accepts an injected authorization code that does not echo the state', async () => {
    const loopback = await createLoopbackRedirect();
    try {
      // Anything on this machine can reach a loopback port: another local
      // process, or any page open in the user's browser. Without the state echo
      // it can hand the listener an authorization code of its own choosing.
      const noState = await fetch(`${loopback.redirectUri}?code=attacker-code`);
      expect(noState.status).toBe(400);
      await noState.text();

      const wrongState = await fetch(`${loopback.redirectUri}?code=attacker-code&state=guessed`);
      expect(wrongState.status).toBe(400);
      await wrongState.text();

      // Neither forgery ended the wait — the real redirect still wins.
      await (await fetch(callback(loopback, 'code=real-code'))).text();
      expect(await loopback.waitForCode()).toBe('real-code');
    } finally {
      await loopback.close();
    }
  });

  it('mints a fresh unguessable state for every listener', async () => {
    const a = await createLoopbackRedirect();
    const b = await createLoopbackRedirect();
    try {
      // 32 random bytes, base64url → 43 chars, URL-safe.
      expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(b.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a.state).not.toBe(b.state);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('honours a caller-supplied state, and `state: false` turns the check off', async () => {
    const pinned = await createLoopbackRedirect({ state: 'state-from-the-host' });
    try {
      expect(pinned.state).toBe('state-from-the-host');
      const wrong = await fetch(`${pinned.redirectUri}?code=c0&state=state-from-the-hosT`);
      expect(wrong.status).toBe(400);
      await wrong.text();
      await (await fetch(`${pinned.redirectUri}?code=c1&state=state-from-the-host`)).text();
      expect(await pinned.waitForCode()).toBe('c1');
    } finally {
      await pinned.close();
    }

    const unguarded = await createLoopbackRedirect({ state: false });
    try {
      expect(unguarded.state).toBeUndefined();
      await (await fetch(`${unguarded.redirectUri}?code=c2`)).text();
      expect(await unguarded.waitForCode()).toBe('c2');
    } finally {
      await unguarded.close();
    }
  });

  it('binds 127.0.0.1 only, so no other host on the network can reach the callback', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((nic) => nic !== undefined && nic.family === 'IPv4' && !nic.internal)?.address;
    const loopback = await createLoopbackRedirect();
    try {
      expect(loopback.redirectUri.startsWith('http://127.0.0.1:')).toBe(true);
      // Nothing to prove against on a runner with no non-loopback interface.
      if (external === undefined) return;
      // A wildcard (0.0.0.0) bind ANSWERS here; 127.0.0.1 refuses the connection.
      // A host firewall can also drop it, which reads the same way — the point
      // is only that no reply carrying an authorization code ever comes back.
      await expect(
        fetch(callback(loopback, 'code=from-the-lan').replace('127.0.0.1', external), {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toBeTruthy();
    } finally {
      await loopback.close();
    }
  });
});
