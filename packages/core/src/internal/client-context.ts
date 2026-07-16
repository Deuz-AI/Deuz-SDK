import type { ClientConfig } from '../types/config';

/**
 * `createClient` pre-binds `apiKeys` / `baseUrls`. The canonical API is the free
 * functions, whose options have no place for client config, so we stash it on
 * the forwarded options object under a private Symbol (same trick as the
 * provider-config symbol). resolve-call reads it as the LOWEST-priority key/url
 * source — it is NOT turned into a keyProvider (that would invert precedence).
 */
export interface ClientContext {
  apiKeys?: ClientConfig['apiKeys'];
  baseUrls?: ClientConfig['baseUrls'];
}

const CLIENT_CTX = Symbol('deuz.clientContext');

export function attachClientContext<O extends object>(options: O, ctx: ClientContext): O {
  Object.defineProperty(options, CLIENT_CTX, {
    value: ctx,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return options;
}

export function readClientContext(options: object): ClientContext | undefined {
  return (options as { [CLIENT_CTX]?: ClientContext })[CLIENT_CTX];
}
