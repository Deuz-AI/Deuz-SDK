/**
 * a2a/protocol.ts — A2A v1.0.0 constants and wire helpers shared by the
 * client and the handler (2.3). Values come from `@a2a-js/sdk` 1.3.0.
 */
import type {
  A2AMessage,
  A2AMessageInput,
  A2APart,
  A2ARole,
  A2AStreamResponse,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
} from './types';

/** The protocol version this module speaks, as sent in `A2A-Version`. */
export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_VERSION_HEADER = 'A2A-Version';
export const A2A_EXTENSIONS_HEADER = 'A2A-Extensions';
/** Response content type of the HTTP+JSON binding. */
export const A2A_CONTENT_TYPE = 'application/a2a+json';
export const JSON_CONTENT_TYPE = 'application/json';
export const SSE_CONTENT_TYPE = 'text/event-stream';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** `google.rpc.ErrorInfo` as A2A errors carry it. */
export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';

/**
 * The reasons an A2A error can carry. The first ten are A2A's own
 * (`google.rpc.ErrorInfo.reason`); the JSON-RPC ones name the binding's
 * generic codes.
 */
export type A2AErrorReason =
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_CANCELABLE'
  | 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  | 'UNSUPPORTED_OPERATION'
  | 'CONTENT_TYPE_NOT_SUPPORTED'
  | 'INVALID_AGENT_RESPONSE'
  | 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'
  | 'EXTENSION_SUPPORT_REQUIRED'
  | 'VERSION_NOT_SUPPORTED'
  | 'INVALID_PARAMS'
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'INTERNAL_ERROR';

interface ReasonWire {
  /** JSON-RPC error code. */
  rpc: number;
  /** HTTP status on the HTTP+JSON binding. */
  http: number;
  /** `google.rpc.Status` name on the HTTP+JSON binding. */
  status: string;
  /** Carried as an `ErrorInfo` detail. */
  info: boolean;
}

export const REASON_WIRE: Readonly<Record<A2AErrorReason, ReasonWire>> = {
  TASK_NOT_FOUND: { rpc: -32001, http: 404, status: 'NOT_FOUND', info: true },
  TASK_NOT_CANCELABLE: { rpc: -32002, http: 400, status: 'FAILED_PRECONDITION', info: true },
  PUSH_NOTIFICATION_NOT_SUPPORTED: {
    rpc: -32003,
    http: 400,
    status: 'FAILED_PRECONDITION',
    info: true,
  },
  UNSUPPORTED_OPERATION: { rpc: -32004, http: 400, status: 'FAILED_PRECONDITION', info: true },
  CONTENT_TYPE_NOT_SUPPORTED: { rpc: -32005, http: 400, status: 'INVALID_ARGUMENT', info: true },
  INVALID_AGENT_RESPONSE: { rpc: -32006, http: 500, status: 'INTERNAL', info: true },
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: {
    rpc: -32007,
    http: 400,
    status: 'FAILED_PRECONDITION',
    info: true,
  },
  EXTENSION_SUPPORT_REQUIRED: { rpc: -32008, http: 400, status: 'FAILED_PRECONDITION', info: true },
  VERSION_NOT_SUPPORTED: { rpc: -32009, http: 400, status: 'FAILED_PRECONDITION', info: true },
  INVALID_PARAMS: { rpc: -32602, http: 400, status: 'INVALID_ARGUMENT', info: true },
  PARSE_ERROR: { rpc: -32700, http: 400, status: 'INVALID_ARGUMENT', info: false },
  INVALID_REQUEST: { rpc: -32600, http: 400, status: 'INVALID_ARGUMENT', info: false },
  METHOD_NOT_FOUND: { rpc: -32601, http: 404, status: 'NOT_FOUND', info: false },
  INTERNAL_ERROR: { rpc: -32603, http: 500, status: 'INTERNAL', info: false },
};

/** JSON-RPC code → reason. */
export function reasonForRpcCode(code: number): A2AErrorReason | undefined {
  for (const [reason, wire] of Object.entries(REASON_WIRE)) {
    if (wire.rpc === code) return reason as A2AErrorReason;
  }
  return undefined;
}

// --- enum normalization ----------------------------------------------------------

// ProtoJSON parsers accept an enum's number as well as its name.
const STATE_NAMES: readonly A2ATaskState[] = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
];
const ROLE_NAMES: readonly A2ARole[] = ['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT'];

export function stateName(value: unknown): A2ATaskState {
  if (typeof value === 'number') return STATE_NAMES[value] ?? 'TASK_STATE_UNSPECIFIED';
  return typeof value === 'string' ? (value as A2ATaskState) : 'TASK_STATE_UNSPECIFIED';
}

export function roleName(value: unknown): A2ARole {
  if (typeof value === 'number') return ROLE_NAMES[value] ?? 'ROLE_UNSPECIFIED';
  return typeof value === 'string' ? (value as A2ARole) : 'ROLE_UNSPECIFIED';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A received message with its role named. `parts` defaults to `[]` (ProtoJSON omits empty lists). */
export function normalizeMessage(value: unknown): A2AMessage {
  const message = isRecord(value) ? value : {};
  return {
    ...(message as unknown as A2AMessage),
    role: roleName(message.role),
    parts: Array.isArray(message.parts) ? (message.parts as A2APart[]) : [],
  };
}

function normalizeStatus(value: unknown): A2ATaskStatus {
  const status = isRecord(value) ? value : {};
  return {
    ...(status as unknown as A2ATaskStatus),
    state: stateName(status.state),
    ...(status.message !== undefined ? { message: normalizeMessage(status.message) } : {}),
  };
}

export function normalizeTask(value: Record<string, unknown>): A2ATask {
  return {
    ...(value as unknown as A2ATask),
    status: normalizeStatus(value.status),
    ...(Array.isArray(value.history) ? { history: value.history.map(normalizeMessage) } : {}),
  };
}

/** A received stream event with its enums named, or `undefined` when it is none of the four. */
export function normalizeStreamResponse(value: unknown): A2AStreamResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.task)) return { task: normalizeTask(value.task) };
  if (isRecord(value.message)) return { message: normalizeMessage(value.message) };
  if (isRecord(value.statusUpdate)) {
    return {
      statusUpdate: {
        ...(value.statusUpdate as unknown as A2AStreamResponse['statusUpdate'] & object),
        status: normalizeStatus(value.statusUpdate.status),
      },
    };
  }
  if (isRecord(value.artifactUpdate)) {
    return {
      artifactUpdate: value.artifactUpdate as unknown as NonNullable<
        A2AStreamResponse['artifactUpdate']
      >,
    };
  }
  return undefined;
}

// --- inputs ----------------------------------------------------------------------

/** A message from caller input: ids generated, role defaulted, empty fields left out. */
export function toMessage(
  input: A2AMessageInput,
  defaults: { role: A2ARole; generateId: () => string },
): A2AMessage {
  if (typeof input === 'string') {
    return { messageId: defaults.generateId(), role: defaults.role, parts: [{ text: input }] };
  }
  if (Array.isArray(input)) {
    return { messageId: defaults.generateId(), role: defaults.role, parts: input };
  }
  return {
    ...input,
    messageId: input.messageId ?? defaults.generateId(),
    role: input.role ?? defaults.role,
  };
}
