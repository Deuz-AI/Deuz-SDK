/**
 * `@deuz-sdk/react` 2.4 accepts `@deuz-sdk/core` from 2.0 on. A 2.3 core's
 * `uiFromMessages` takes no third parameter, so it hands every message a
 * fresh id; the hook re-applies the stored ids itself, and a restored chat
 * keeps them whatever core sits next to it.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Message } from '@deuz-sdk/core';
import { useChat } from '../src/use-chat';

vi.mock('@deuz-sdk/core/chat', async (importOriginal) => {
  const real = await importOriginal<typeof import('@deuz-sdk/core/chat')>();
  return {
    ...real,
    // The 2.3 signature: the stored ids never reach it.
    uiFromMessages: (messages: Message[], generateId: () => string) =>
      real.uiFromMessages(messages, generateId),
  };
});

describe('useChat({ initialSnapshot }) next to a 2.3 core', () => {
  it('still renders every message under its stored id', () => {
    const messages: Message[] = [
      { role: 'user', content: 'same' },
      { role: 'assistant', content: 'echo' },
      { role: 'user', content: 'same' },
      { role: 'assistant', content: 'echo' },
    ];
    let next = 0;
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        generateId: () => `gen-${next++}`,
        initialSnapshot: { version: 1, messages, messageIds: ['u1', 'a1', 'u1', ''] },
      }),
    );
    // A repeated or empty stored id falls back to a generated one, as with a 2.4 core.
    const ids = result.current.messages.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(['u1', 'a1']);
    expect(ids[2]).toMatch(/^gen-/);
    expect(ids[3]).toMatch(/^gen-/);
    expect(new Set(ids).size).toBe(4);
    expect(result.current.exportSnapshot().messageIds).toEqual(ids);
  });
});
