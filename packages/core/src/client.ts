import { streamChat, generateText, generateObject, streamObject } from './generate';
import { embed, embedMany } from './inference/embed';
import { attachClientContext } from './internal/client-context';
import { resolveDependencies, createInMemoryBreakerStore } from './internal/resolve-deps';
import type { ClientConfig } from './types/config';
import type { Dependencies } from './types/deps';
import type {
  StreamChat,
  GenerateText,
  GenerateObject,
  GenerateObjectOptions,
  StreamObject,
  Embed,
  EmbedMany,
} from './types/methods';

export { resolveDependencies };

/**
 * Optional convenience wrapper. The canonical API is the free functions
 * (`streamChat`, `generateText`, `generateObject`); `createClient` pre-binds
 * shared `deps` + `apiKeys`/`baseUrls` so heavy callers don't repeat them.
 */
export interface DeuzClient {
  readonly config: Readonly<ClientConfig>;
  streamChat: StreamChat;
  generateText: GenerateText;
  generateObject: GenerateObject;
  // --- 1.6 additive: full free-function parity. ---
  /** Same synchronous-return contract (G2) as the free `streamObject`. */
  streamObject: StreamObject;
  embed: Embed;
  embedMany: EmbedMany;
}

export function createClient(config: ClientConfig = {}): DeuzClient {
  const shared = config.deps ?? {};
  // G11: the circuit-breaker store is resolved ONCE per client, not per call —
  // otherwise every call would get a fresh in-memory breaker and it would never
  // trip.
  const sharedBreaker = shared.breakerStore ?? createInMemoryBreakerStore();
  const clientContext = { apiKeys: config.apiKeys, baseUrls: config.baseUrls };

  const withShared = <O extends { deps?: Dependencies }>(options: O): O => {
    const merged = {
      ...options,
      deps: { breakerStore: sharedBreaker, ...shared, ...options.deps },
    };
    // Stash apiKeys/baseUrls for resolve-call (lowest-priority key source, G1).
    attachClientContext(merged, clientContext);
    return merged;
  };

  return {
    config: Object.freeze({ ...config }),
    streamChat: (options) => streamChat(withShared(options)),
    generateText: (options) => generateText(withShared(options)),
    generateObject: <T = unknown>(options: GenerateObjectOptions<T>) =>
      generateObject(withShared(options)),
    streamObject: <T = unknown>(options: GenerateObjectOptions<T>) =>
      streamObject(withShared(options)),
    embed: (options) => embed(withShared(options)),
    embedMany: (options) => embedMany(withShared(options)),
  };
}
