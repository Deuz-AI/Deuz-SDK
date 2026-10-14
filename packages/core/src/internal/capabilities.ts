/**
 * The capability handshake (2.4): a server announces the chat and stream
 * features it supports, once in a response header and once as the stream's
 * first frame (for a client that cannot read headers), and a client uses only
 * what was announced. A response without the header comes from an older core:
 * the client keeps its 2.3 behaviour. This is separate from the v1/v2 wire
 * negotiation (`negotiateDeuzStreamVersion`), which it does not change.
 *
 * The strings are wire contracts. `@deuz-sdk/react` keeps its own copies (its
 * core peer is `^2.0.0`, so it never imports a core symbol that 2.3 lacks):
 * never rename one; add a new string instead. Edge-safe.
 */

/** The response header a server lists its capabilities in. */
export const DEUZ_CAPABILITIES_HEADER = 'x-deuz-capabilities';

/** Every capability a 2.4 server can announce. */
export const DEUZ_CAPABILITY = {
  /**
   * Every stored message reaches the UI with its stable id
   * (`ChatRecord.messageIds`), so a client dedupes and replays by id, never
   * by text.
   */
  messageIds: 'message-ids',
  /** The server takes and returns a `ChatSnapshotV1` (`initialSnapshot` / `exportSnapshot`). */
  chatSnapshot: 'chat-snapshot-v1',
  /**
   * Frames are committed to a `DurableStreamStateStore` before they are sent,
   * so a replay from `Last-Event-ID` has no gap and never repeats a frame.
   */
  durableStream: 'durable-stream',
  /** Chat writes are compare-and-set on a revision (`ConditionalChatStore`). */
  conditionalChat: 'conditional-chat',
} as const;

/** One capability string a 2.4 server can announce. */
export type DeuzCapability = (typeof DEUZ_CAPABILITY)[keyof typeof DEUZ_CAPABILITY];

/** Every capability this build knows. */
export const DEUZ_CAPABILITIES: readonly DeuzCapability[] = Object.values(DEUZ_CAPABILITY);

/**
 * The first frame of a stream from a server that announces capabilities: the
 * same list as the header. Wired into the UI stream union by the stream lane.
 */
export interface DeuzCapabilitiesPart {
  type: 'capabilities';
  capabilities: string[];
}

const TOKEN = /^[a-z0-9-]+$/;

/**
 * The header value for `capabilities`: each once, sorted, joined by `', '`.
 * Throws a TypeError for a string that is not a lower-case token.
 */
export function formatDeuzCapabilities(capabilities: Iterable<string>): string {
  const unique = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || !TOKEN.test(capability))
      throw new TypeError(`A capability must be a lower-case token, got ${String(capability)}`);
    unique.add(capability);
  }
  return [...unique].sort().join(', ');
}

/**
 * The capabilities a response (or request, or header value) announces:
 * trimmed, lower-cased, empty items dropped. Unknown strings are kept, so a
 * caller checks only the ones it knows. No header is an empty set.
 */
export function parseDeuzCapabilities(
  source: Request | Response | Headers | string | null | undefined,
): ReadonlySet<string> {
  const raw =
    typeof source === 'string' || source == null
      ? source
      : (source instanceof Headers ? source : source.headers).get(DEUZ_CAPABILITIES_HEADER);
  const capabilities = new Set<string>();
  for (const item of (raw ?? '').split(',')) {
    const capability = item.trim().toLowerCase();
    if (capability) capabilities.add(capability);
  }
  return capabilities;
}
