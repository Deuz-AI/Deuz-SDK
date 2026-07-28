import {
  streamChat,
  generateText,
  generateObject,
  streamObject,
  type PromptShorthand,
} from './generate';
import { embed, embedMany } from './inference/embed';
import { attachClientContext } from './internal/client-context';
import { resolveDependencies, createInMemoryBreakerStore } from './internal/resolve-deps';
import type { ClientConfig } from './types/config';
import type { Dependencies } from './types/deps';
import type {
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamChatOptions,
  StreamChatResult,
  StreamObjectResult,
  Embed,
  EmbedMany,
} from './types/methods';

export { resolveDependencies };

/**
 * Optional convenience wrapper. The canonical API is the free functions
 * (`streamChat`, `generateText`, `generateObject`); `createClient` pre-binds
 * shared `deps` + `apiKeys`/`baseUrls` so heavy callers don't repeat them.
 *
 * Every message-taking method carries the SAME `prompt`/`messages` XOR overload
 * pair as its free-function twin (1.9). They are spelled out as METHOD signatures
 * rather than the single-signature `StreamChat`/`GenerateText`/… aliases because a
 * property of function type cannot be overloaded; the aliases still describe one
 * of the two overloads, so an existing `const f: StreamChat = client.streamChat`
 * keeps compiling. Before this, `client.streamChat({ prompt })` worked at RUNTIME
 * (it forwards into `src/generate.ts`, which owns the fold) but did not typecheck.
 * See {@link PromptShorthand}.
 */
export interface DeuzClient {
  readonly config: Readonly<ClientConfig>;
  streamChat(options: StreamChatOptions): StreamChatResult;
  streamChat(options: PromptShorthand<StreamChatOptions>): StreamChatResult;
  generateText(options: GenerateTextOptions): Promise<GenerateTextResult>;
  generateText(options: PromptShorthand<GenerateTextOptions>): Promise<GenerateTextResult>;
  generateObject<T = unknown>(options: GenerateObjectOptions<T>): Promise<GenerateObjectResult<T>>;
  generateObject<T = unknown>(
    options: PromptShorthand<GenerateObjectOptions<T>>,
  ): Promise<GenerateObjectResult<T>>;
  // --- 1.6 additive: full free-function parity. ---
  /** Same synchronous-return contract (G2) as the free `streamObject`. */
  streamObject<T = unknown>(options: GenerateObjectOptions<T>): StreamObjectResult<T>;
  streamObject<T = unknown>(
    options: PromptShorthand<GenerateObjectOptions<T>>,
  ): StreamObjectResult<T>;
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

  // Each forwarder takes the UNION of its two overloads so it satisfies BOTH
  // interface signatures, then hands the value to the free function unchanged —
  // `src/generate.ts` is still the only place that reads the input shape (the
  // `as` is the same narrowing its own overload implementations use). `withShared`
  // re-stashes the client context on the object it returns, and `canonicalize`
  // carries that Symbol over when it rebuilds the options for a `prompt` call, so
  // client-level keys survive the fold (G1).
  return {
    config: Object.freeze({ ...config }),
    streamChat: (options: StreamChatOptions | PromptShorthand<StreamChatOptions>) =>
      streamChat(withShared(options as StreamChatOptions)),
    generateText: (options: GenerateTextOptions | PromptShorthand<GenerateTextOptions>) =>
      generateText(withShared(options as GenerateTextOptions)),
    generateObject: <T = unknown>(
      options: GenerateObjectOptions<T> | PromptShorthand<GenerateObjectOptions<T>>,
    ) => generateObject(withShared(options as GenerateObjectOptions<T>)),
    streamObject: <T = unknown>(
      options: GenerateObjectOptions<T> | PromptShorthand<GenerateObjectOptions<T>>,
    ) => streamObject(withShared(options as GenerateObjectOptions<T>)),
    embed: (options) => embed(withShared(options)),
    embedMany: (options) => embedMany(withShared(options)),
  };
}
