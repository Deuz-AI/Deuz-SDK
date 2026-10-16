// @vitest-environment jsdom
/**
 * The frozen `@deuz-sdk/core/react` hooks are deprecated in 2.4 (spec §3.4):
 * `@deuz-sdk/react` supersedes them and 3.0 removes them. A development build
 * says so once per page; a production build stays silent; nothing else about
 * the hooks changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderHook } from '@testing-library/react';

type FrozenReact = typeof import('../src/react');

/** A fresh copy of the module, so its one-time flag starts unset. */
async function freshModule(): Promise<FrozenReact> {
  vi.resetModules();
  return (await import('../src/react')) as FrozenReact;
}

describe('the frozen @deuz-sdk/core/react hooks (2.4 deprecation)', () => {
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it('warns once per page in a development build, naming the replacement and 3.0', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { useChat, useObject } = await freshModule();
    const chat = renderHook(() => useChat({ api: '/api/chat' }));
    chat.rerender();
    renderHook(() => useObject({ api: '/api/object' }));
    renderHook(() => useChat({ api: '/api/other' }));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('@deuz-sdk/core/react');
    expect(message).toContain('@deuz-sdk/react');
    expect(message).toContain('3.0');
  });

  it('warns from useObject alone too', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { useObject } = await freshModule();
    renderHook(() => useObject({ api: '/api/object' }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { useChat, useObject } = await freshModule();
    renderHook(() => useChat({ api: '/api/chat' }));
    renderHook(() => useObject({ api: '/api/object' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('changes nothing else: the hooks return their 2.3 shape', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { useChat, useObject, createUseChat } = await freshModule();
    const chat = renderHook(() => useChat({ api: '/api/chat' })).result.current;
    expect(Object.keys(chat).sort()).toEqual(
      [
        'addToolApprovalResponse',
        'error',
        'messages',
        'pendingApprovals',
        'regenerate',
        'sendMessage',
        'status',
        'stop',
      ].sort(),
    );
    expect(chat.messages).toEqual([]);
    expect(chat.status).toBe('idle');
    const object = renderHook(() => useObject({ api: '/api/object' })).result.current;
    expect(Object.keys(object).sort()).toEqual(['error', 'isLoading', 'object', 'stop', 'submit']);
    expect(createUseChat()).toBe(useChat);
  });
});
