/**
 * acp/types.ts — the Agent Client Protocol wire types this module speaks (2.5).
 *
 * Written by hand against the ACP v1 JSON schema (`schema/v1/schema.json` of
 * github.com/agentclientprotocol/agent-client-protocol, schema release 1.34.1,
 * protocol version `1`), so `@deuz-sdk/core` keeps zero runtime dependencies.
 * Only the subset Deuz sends or reads is typed: initialization, authentication,
 * `session/new`, `session/load`, `session/prompt`, `session/cancel`,
 * `session/update`, `session/request_permission`, `fs/read_text_file` and
 * `fs/write_text_file`. Every object type the spec gives a `_meta` field keeps
 * it, for extensions (`_meta` keys are reverse-DNS names, see
 * {@link ACP_DEUZ_META}). Fields the spec marks optional stay optional, and a
 * peer may send fields this file does not name: they are passed through.
 */

/** `_meta`: the spec's extension slot on most protocol objects. */
export type AcpMeta = Record<string, unknown>;

/** A JSON-RPC request id. ACP allows a string, a number or `null`. */
export type AcpRequestId = string | number | null;

/** Name and version of an ACP client or agent (`Implementation`). */
export interface AcpImplementation {
  name: string;
  version: string;
  title?: string | null;
  _meta?: AcpMeta | null;
}

/** `ClientCapabilities.fs`. */
export interface AcpFileSystemCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
  _meta?: AcpMeta | null;
}

/** What a client supports, sent with `initialize`. Omitted means unsupported. */
export interface AcpClientCapabilities {
  fs?: AcpFileSystemCapabilities;
  /** The client supports every `terminal/*` method. */
  terminal?: boolean;
  /** Advertises `plan_update` / `plan_removed`; Deuz sends the baseline `plan` update only. */
  plan?: AcpMeta | null;
  session?: AcpMeta | null;
  auth?: { terminal?: boolean; _meta?: AcpMeta | null };
  _meta?: AcpMeta | null;
}

/** `PromptCapabilities`: which content blocks a prompt may carry beyond text and resource links. */
export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
  _meta?: AcpMeta | null;
}

/** What an agent supports, answered to `initialize`. */
export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: { http?: boolean; sse?: boolean; _meta?: AcpMeta | null };
  sessionCapabilities?: AcpMeta;
  auth?: AcpMeta;
  _meta?: AcpMeta | null;
}

/** An authentication method the agent handles itself through `authenticate` (`AuthMethodAgent`). */
export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
  _meta?: AcpMeta | null;
}

/** `initialize` params. */
export interface AcpInitializeRequest {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementation | null;
  _meta?: AcpMeta | null;
}

/** `initialize` result. */
export interface AcpInitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: AcpAuthMethod[];
  agentInfo?: AcpImplementation | null;
  _meta?: AcpMeta | null;
}

/** `authenticate` params. */
export interface AcpAuthenticateRequest {
  methodId: string;
  _meta?: AcpMeta | null;
}

/** An environment variable or HTTP header of an MCP server entry. */
export interface AcpNameValue {
  name: string;
  value: string;
}

/** An MCP server the client asks the agent to connect to (`McpServer`). */
export type AcpMcpServer =
  | {
      type?: 'stdio';
      name: string;
      command: string;
      args: string[];
      env: AcpNameValue[];
      _meta?: AcpMeta | null;
    }
  | {
      type: 'http' | 'sse';
      name: string;
      url: string;
      headers: AcpNameValue[];
      _meta?: AcpMeta | null;
    };

/** `session/new` params. */
export interface AcpNewSessionRequest {
  /** Absolute working directory of the session. */
  cwd: string;
  mcpServers: AcpMcpServer[];
  additionalDirectories?: string[];
  _meta?: AcpMeta | null;
}

/** `session/new` result. */
export interface AcpNewSessionResponse {
  sessionId: string;
  _meta?: AcpMeta | null;
}

/** `session/load` params. */
export interface AcpLoadSessionRequest {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServer[];
  additionalDirectories?: string[];
  _meta?: AcpMeta | null;
}

/** `session/load` result. */
export interface AcpLoadSessionResponse {
  _meta?: AcpMeta | null;
}

/** Display hints on a content block. */
export interface AcpAnnotations {
  audience?: ('user' | 'assistant')[] | null;
  priority?: number | null;
  lastModified?: string | null;
  _meta?: AcpMeta | null;
}

/** A text resource, or a binary one (`blob`, base64). */
export type AcpEmbeddedResourceResource =
  | { uri: string; text: string; mimeType?: string | null; _meta?: AcpMeta | null }
  | { uri: string; blob: string; mimeType?: string | null; _meta?: AcpMeta | null };

/** `ContentBlock`: what a prompt, a message chunk and a tool call's content are made of. */
export type AcpContentBlock =
  | { type: 'text'; text: string; annotations?: AcpAnnotations | null; _meta?: AcpMeta | null }
  | {
      type: 'image';
      /** Base64 data. */
      data: string;
      mimeType: string;
      uri?: string | null;
      annotations?: AcpAnnotations | null;
      _meta?: AcpMeta | null;
    }
  | {
      type: 'audio';
      data: string;
      mimeType: string;
      annotations?: AcpAnnotations | null;
      _meta?: AcpMeta | null;
    }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      title?: string | null;
      description?: string | null;
      mimeType?: string | null;
      size?: number | null;
      annotations?: AcpAnnotations | null;
      _meta?: AcpMeta | null;
    }
  | {
      type: 'resource';
      resource: AcpEmbeddedResourceResource;
      annotations?: AcpAnnotations | null;
      _meta?: AcpMeta | null;
    };

/** `session/prompt` params. */
export interface AcpPromptRequest {
  sessionId: string;
  prompt: AcpContentBlock[];
  _meta?: AcpMeta | null;
}

/** Why a prompt turn ended (`StopReason`). */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** `session/prompt` result. */
export interface AcpPromptResponse {
  stopReason: AcpStopReason;
  _meta?: AcpMeta | null;
}

/** `session/cancel` params (a notification). */
export interface AcpCancelNotification {
  sessionId: string;
  _meta?: AcpMeta | null;
}

/** Category of a tool call, for the client's icon (`ToolKind`). */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** `ToolCallStatus`. */
export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A file a tool call reads or changes (`ToolCallLocation`). */
export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
  _meta?: AcpMeta | null;
}

/** `ToolCallContent`: a content block, a diff, or an embedded terminal. */
export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock; _meta?: AcpMeta | null }
  | {
      type: 'diff';
      path: string;
      oldText?: string | null;
      newText: string;
      _meta?: AcpMeta | null;
    }
  | { type: 'terminal'; terminalId: string; _meta?: AcpMeta | null };

/** A new tool call (`ToolCall`). */
export interface AcpToolCall {
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: AcpMeta | null;
}

/** A change to a tool call: only the changed fields (`ToolCallUpdate`). */
export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolCallStatus | null;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: AcpMeta | null;
}

/** One entry of an agent plan (`PlanEntry`). */
export interface AcpPlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
  _meta?: AcpMeta | null;
}

/** Cumulative session cost (`Cost`). */
export interface AcpCost {
  amount: number;
  /** An ISO 4217 code such as `'USD'`, or another unit such as `'credits'`. */
  currency: string;
  _meta?: AcpMeta | null;
}

/** A streamed chunk of a message (`ContentChunk`). */
export interface AcpContentChunk {
  content: AcpContentBlock;
  messageId?: string | null;
  _meta?: AcpMeta | null;
}

/** `SessionUpdate`: the variants Deuz sends and reads. Others pass through untyped. */
export type AcpSessionUpdate =
  | ({ sessionUpdate: 'user_message_chunk' } & AcpContentChunk)
  | ({ sessionUpdate: 'agent_message_chunk' } & AcpContentChunk)
  | ({ sessionUpdate: 'agent_thought_chunk' } & AcpContentChunk)
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate)
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[]; _meta?: AcpMeta | null }
  | {
      sessionUpdate: 'usage_update';
      /** Tokens currently in context. */
      used: number;
      /** Context window size in tokens. */
      size: number;
      /** Cumulative session cost. */
      cost?: AcpCost | null;
      _meta?: AcpMeta | null;
    }
  | {
      sessionUpdate: 'session_info_update';
      title?: string | null;
      updatedAt?: string | null;
      _meta?: AcpMeta | null;
    };

/** `session/update` params (a notification from the agent). */
export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
  _meta?: AcpMeta | null;
}

/** `PermissionOptionKind`. */
export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/** One choice of a permission prompt (`PermissionOption`). */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
  _meta?: AcpMeta | null;
}

/** `session/request_permission` params. */
export interface AcpRequestPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
  _meta?: AcpMeta | null;
}

/** The user's answer to a permission prompt (`RequestPermissionOutcome`). */
export type AcpRequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string; _meta?: AcpMeta | null };

/** `session/request_permission` result. */
export interface AcpRequestPermissionResponse {
  outcome: AcpRequestPermissionOutcome;
  _meta?: AcpMeta | null;
}

/** `fs/read_text_file` params. */
export interface AcpReadTextFileRequest {
  sessionId: string;
  /** Absolute path. */
  path: string;
  /** 1-based line to start at. */
  line?: number | null;
  /** Maximum number of lines. */
  limit?: number | null;
  _meta?: AcpMeta | null;
}

/** `fs/read_text_file` result. */
export interface AcpReadTextFileResponse {
  content: string;
  _meta?: AcpMeta | null;
}

/** `fs/write_text_file` params. */
export interface AcpWriteTextFileRequest {
  sessionId: string;
  /** Absolute path. */
  path: string;
  content: string;
  _meta?: AcpMeta | null;
}

/** `fs/write_text_file` result. */
export interface AcpWriteTextFileResponse {
  _meta?: AcpMeta | null;
}

/** A JSON-RPC 2.0 error object. */
export interface AcpErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Any JSON-RPC 2.0 message on an ACP connection. */
export type AcpJsonRpcMessage =
  | { jsonrpc: '2.0'; id: AcpRequestId; method: string; params?: unknown }
  | { jsonrpc: '2.0'; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: AcpRequestId; result: unknown }
  | { jsonrpc: '2.0'; id: AcpRequestId; error: AcpErrorObject };

// --- Deuz extension payloads (`_meta` values under ACP_DEUZ_META keys) ------

/**
 * Budget state a Deuz agent attaches under `_meta[ACP_DEUZ_META.budget]` to its
 * `usage_update` notifications and `session/prompt` results. Amounts in USD.
 */
export interface AcpDeuzBudget {
  /** What the last turn cost. */
  turnUsd: number;
  /** What the session has cost so far, all turns. */
  sessionUsd: number;
  /**
   * What is left of the tightest persistent USD scope (`budget.scopes`), never
   * below zero. Absent when no scope bounds USD.
   */
  remainingUsd?: number;
  /** Each persistent scope with a USD limit: its limit, committed usage and remainder. */
  scopes?: { key: string; limitUsd: number; usedUsd: number; remainingUsd: number }[];
  /**
   * Model calls whose price is unknown in this turn: `turnUsd` is then a
   * lower bound. Absent when zero.
   */
  unpriced?: number;
  /** The turn stopped or failed on a budget (`'budget.usd'`, `'budget.tokens'`, `'budget_exceeded'`). */
  exhausted?: string;
}

/**
 * One effect receipt of a turn, under `_meta[ACP_DEUZ_META.receipts]` of a
 * `session/prompt` result: what the native run recorded for a tool call.
 */
export interface AcpDeuzReceipt {
  toolCallId: string;
  toolName: string;
  /**
   * The receipt stage (`'completed'`, `'failed'`, `'executing'` = outcome unknown, …), or
   * `'not-run'` for a call whose permission was rejected or cancelled: it never
   * ran, so the run recorded no receipt.
   */
  stage: string;
  /** How the permission prompt for this call was answered, when one was needed. */
  approval?: 'allowed' | 'rejected' | 'cancelled' | 'remembered-allow' | 'remembered-reject';
  /** The tool's error message, when it failed. */
  error?: string;
}
