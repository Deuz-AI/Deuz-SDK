/**
 * `@deuz-sdk/core/acp` (2.5) — the Agent Client Protocol: serve a native Deuz
 * agent to ACP editors (`serveAcpAgent`), and drive any ACP agent from code
 * (`connectAcpAgent`). JSON-RPC 2.0 written by hand against ACP protocol
 * version 1 (`ACP_PROTOCOL_VERSION`), over a web-stream transport; the stdio
 * adapters (serve on process stdin/stdout, spawn an agent and connect) are in
 * `@deuz-sdk/core/acp/stdio`. Zero dependencies, edge-safe.
 */
export {
  ACP_AGENT_METHODS,
  ACP_CANCEL_REQUEST_METHOD,
  ACP_CLIENT_METHODS,
  ACP_DEUZ_BUDGET_METHOD,
  ACP_DEUZ_META,
  ACP_DEUZ_NAMESPACE,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_VERSION,
} from './protocol';
export { AcpError, acpInvalidParams } from './errors';
export type { AcpErrorKind, AcpErrorOptions } from './errors';
export { createInMemoryAcpTransportPair, createNdjsonTransport } from './transport';
export type { AcpTransport, NdjsonTransportOptions } from './transport';
export { createAcpPeer } from './peer';
export type {
  AcpNotificationHandler,
  AcpPeer,
  AcpPeerOptions,
  AcpRequestContext,
  AcpRequestHandler,
} from './peer';
export { createInMemoryAcpSessionStore, formatUsd, serveAcpAgent } from './agent';
export type {
  AcpAgentBudgetOptions,
  AcpAgentConnection,
  AcpAgentEngine,
  AcpAgentOptions,
  AcpAgentRunOptions,
  AcpAgentTurnContext,
  AcpSessionRecord,
  AcpSessionStore,
} from './agent';
export { connectAcpAgent } from './client';
export type {
  AcpClientConnection,
  AcpClientFileSystem,
  AcpClientOptions,
  AcpClientSession,
  AcpDeclaredUsage,
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPromptOptions,
  AcpPromptResult,
  AcpPromptTurn,
  AcpToolCallState,
} from './client';
export type * from './types';
