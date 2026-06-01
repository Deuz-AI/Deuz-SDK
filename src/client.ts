import { streamChat, generateText, generateObject } from './generate';
import { attachClientContext } from './internal/client-context';
import { resolveDependencies, createInMemoryBreakerStore } from './internal/resolve-deps';
import type { ClientConfig } from './types/config';
import type { Dependencies } from './types/deps';
import type {
  StreamChat,
  GenerateText,
  GenerateObject,
  GenerateObjectOptions,
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
  };
}
