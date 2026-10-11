/**
 * Scope identity for native runs (2.3): the memory and chat scopes a run binds
 * to, compared without regard to key order or unset fields. Pure and tiny, so
 * the resume binding can use it without loading the memory or chat code.
 */
import type { MemoryScope } from '../memory';

const SCOPE_KEYS = ['userId', 'agentId', 'runId', 'actorId', 'chatId'] as const;

/** A scope as stable JSON: its set fields in a fixed order. */
export function scopeKey(scope: MemoryScope): string {
  return JSON.stringify(
    SCOPE_KEYS.filter((key) => scope[key] !== undefined).map((key) => [key, scope[key]]),
  );
}

/** Every field `parent` pins, `child` pins to the same value. */
export function scopeWithin(child: MemoryScope, parent: MemoryScope): boolean {
  return SCOPE_KEYS.every((key) => parent[key] === undefined || child[key] === parent[key]);
}
