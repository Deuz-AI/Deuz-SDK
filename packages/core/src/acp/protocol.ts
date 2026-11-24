/**
 * acp/protocol.ts — constants of the Agent Client Protocol as implemented here
 * (2.5): the protocol version, the method names, the error codes and the
 * `_meta` keys of Deuz's extensions. Edge-safe, no imports.
 */

/**
 * The ACP protocol version this module implements: the integer major version
 * both sides send in `initialize`. An agent answers a client asking for any
 * other version with this one, as the spec's version negotiation requires.
 */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The release of the ACP JSON schema the wire types were written against
 * (`schema/v1/schema.json`, github.com/agentclientprotocol/agent-client-protocol).
 * Informational: ACP negotiates only {@link ACP_PROTOCOL_VERSION}.
 */
export const ACP_SCHEMA_VERSION = '1.34.1';

/** Methods a client calls on an agent. */
export const ACP_AGENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
} as const;

/** Methods an agent calls on a client. */
export const ACP_CLIENT_METHODS = {
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  readTextFile: 'fs/read_text_file',
  writeTextFile: 'fs/write_text_file',
} as const;

/** The protocol-level notification that cancels one request, in either direction. */
export const ACP_CANCEL_REQUEST_METHOD = '$/cancel_request';

/** JSON-RPC and ACP error codes (`ErrorCode`). */
export const ACP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

/**
 * The reverse-DNS prefix of Deuz's ACP extensions (the spec's extensibility
 * rule: `_meta` keys and `_`-methods are namespaced by a domain the
 * implementer controls; `io.github.deuz-ai` is the project's GitHub org).
 */
export const ACP_DEUZ_NAMESPACE = 'io.github.deuz-ai';

/**
 * Deuz's `_meta` keys. `budget` holds an `AcpDeuzBudget`; `receipts` an
 * `AcpDeuzReceipt[]`; `signedApprovals` is `true` in the agent capabilities
 * when permission verdicts are bound to HMAC-signed approval tokens.
 */
export const ACP_DEUZ_META = {
  budget: `${ACP_DEUZ_NAMESPACE}/budget`,
  receipts: `${ACP_DEUZ_NAMESPACE}/receipts`,
  signedApprovals: `${ACP_DEUZ_NAMESPACE}/signedApprovals`,
} as const;

/**
 * Deuz's extension request: `{ sessionId }` in, the session's `AcpDeuzBudget`
 * out. A client checks `agentCapabilities._meta[ACP_DEUZ_META.budget]` first.
 */
export const ACP_DEUZ_BUDGET_METHOD = `_${ACP_DEUZ_NAMESPACE}/budget`;
