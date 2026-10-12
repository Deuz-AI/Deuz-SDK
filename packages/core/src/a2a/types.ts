/**
 * a2a/types.ts — the A2A v1.0.0 wire model and the public option types (2.3).
 *
 * Wire types are the ProtoJSON form of the `lf.a2a.v1` messages exactly as
 * they travel over the JSON-RPC and HTTP+JSON bindings: lowerCamelCase field
 * names, enums as their names (`'TASK_STATE_WORKING'`, `'ROLE_USER'`), oneofs
 * flattened (`{ text }` / `{ raw }` / `{ url }` / `{ data }` parts, `{ task }`
 * / `{ message }` responses). ProtoJSON omits default values, so a field a
 * server may leave out (an empty list, an empty string) is optional here.
 * Derived from the types and codecs of `@a2a-js/sdk` 1.3.0, which implements
 * A2A v1.0.0.
 */
import type { Dependencies } from '../types/deps';

// --- enums ---------------------------------------------------------------------

/** Who sent a message: the client (`ROLE_USER`) or the agent (`ROLE_AGENT`). */
export type A2ARole = 'ROLE_USER' | 'ROLE_AGENT' | 'ROLE_UNSPECIFIED';

/**
 * A task's lifecycle state. Terminal: `COMPLETED`, `FAILED`, `CANCELED`,
 * `REJECTED`. Interrupted (the agent waits for the client): `INPUT_REQUIRED`,
 * `AUTH_REQUIRED`.
 */
export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_UNSPECIFIED';

// --- content -------------------------------------------------------------------

interface A2APartCommon {
  /** Metadata attached to this part. */
  metadata?: Record<string, unknown>;
  /** A file name for file content (`'report.pdf'`). */
  filename?: string;
  /** The content's media type (`'text/plain'`, `'image/png'`, `'application/json'`). */
  mediaType?: string;
}

/** Text content. */
export interface A2ATextPart extends A2APartCommon {
  text: string;
  raw?: never;
  url?: never;
  data?: never;
}

/** Inline bytes, base64-encoded in JSON. */
export interface A2ARawPart extends A2APartCommon {
  raw: string;
  text?: never;
  url?: never;
  data?: never;
}

/** A file by reference. */
export interface A2AUrlPart extends A2APartCommon {
  url: string;
  text?: never;
  raw?: never;
  data?: never;
}

/** Structured content: any JSON value. */
export interface A2ADataPart extends A2APartCommon {
  data: unknown;
  text?: never;
  raw?: never;
  url?: never;
}

/** One piece of message or artifact content: exactly one of `text`, `raw`, `url`, `data`. */
export type A2APart = A2ATextPart | A2ARawPart | A2AUrlPart | A2ADataPart;

/** One unit of communication between a client and an agent. */
export interface A2AMessage {
  /** Unique id, chosen by the message's creator. */
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: A2ARole;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  /** URIs of the extensions present in or contributing to this message. */
  extensions?: string[];
  /** Tasks this message refers to for additional context. */
  referenceTaskIds?: string[];
}

/** A task output. */
export interface A2AArtifact {
  /** Unique within its task. */
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

// --- tasks ---------------------------------------------------------------------

export interface A2ATaskStatus {
  state: A2ATaskState;
  /** A message that goes with the status (a question for `INPUT_REQUIRED`, a reason for `FAILED`). */
  message?: A2AMessage;
  /** ISO 8601, when the status was recorded. */
  timestamp?: string;
}

/** The unit of work: a status, the outputs produced so far and the conversation. */
export interface A2ATask {
  /** Server-generated. */
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  /** The task's messages, oldest first. */
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

/** A task's status changed. */
export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  metadata?: Record<string, unknown>;
}

/** An artifact was produced or extended. */
export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  /** The parts extend the artifact with the same id sent earlier. */
  append?: boolean;
  /** This is the artifact's final chunk. */
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * One event of a stream (`SendStreamingMessage`, `SubscribeToTask`). A stream
 * is either a single `message`, or a task lifecycle: a `task` snapshot first,
 * then `statusUpdate` and `artifactUpdate` events.
 */
export type A2AStreamResponse =
  | { task: A2ATask; message?: never; statusUpdate?: never; artifactUpdate?: never }
  | { message: A2AMessage; task?: never; statusUpdate?: never; artifactUpdate?: never }
  | {
      statusUpdate: A2ATaskStatusUpdateEvent;
      task?: never;
      message?: never;
      artifactUpdate?: never;
    }
  | {
      artifactUpdate: A2ATaskArtifactUpdateEvent;
      task?: never;
      message?: never;
      statusUpdate?: never;
    };

/** What `SendMessage` answers: the task it created or continued, or a direct message. */
export type A2ASendMessageResponse =
  | { task: A2ATask; message?: never }
  | { message: A2AMessage; task?: never };

// --- requests ------------------------------------------------------------------

/** Push-notification settings. Carried on the wire; not acted on by this module. */
export interface A2ATaskPushNotificationConfig {
  tenant?: string;
  id?: string;
  taskId?: string;
  url: string;
  token?: string;
  authentication?: { scheme: string; credentials?: string };
}

export interface A2ASendMessageConfiguration {
  /** Media types the client accepts in the answer's parts. */
  acceptedOutputModes?: string[];
  taskPushNotificationConfig?: A2ATaskPushNotificationConfig;
  /** At most this many of the most recent history messages in the returned task; 0 for none. */
  historyLength?: number;
  /**
   * Answer at the agent's first update instead of waiting for a terminal or
   * interrupted state: a new task as soon as it exists, a task the message
   * continues once the agent has taken the message up. A message the agent
   * refuses is answered with the error either way.
   */
  returnImmediately?: boolean;
}

/** The params of `SendMessage` and `SendStreamingMessage`. */
export interface A2ASendMessageRequest {
  tenant?: string;
  message: A2AMessage;
  configuration?: A2ASendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

/** The params of `GetTask`. */
export interface A2AGetTaskRequest {
  tenant?: string;
  id: string;
  historyLength?: number;
}

/** The params of `CancelTask`. */
export interface A2ACancelTaskRequest {
  tenant?: string;
  id: string;
  metadata?: Record<string, unknown>;
}

/** The params of `SubscribeToTask`. */
export interface A2ASubscribeToTaskRequest {
  tenant?: string;
  id: string;
}

// --- agent card ----------------------------------------------------------------

/** `'JSONRPC'` and `'HTTP+JSON'` are the bindings this module speaks; `'GRPC'` is not supported. */
export type A2AProtocolBinding = 'JSONRPC' | 'HTTP+JSON' | 'GRPC' | (string & {});

/** One endpoint an agent serves. */
export interface A2AAgentInterface {
  /** Absolute URL of the endpoint. */
  url: string;
  protocolBinding: A2AProtocolBinding;
  /** A tenant id the client sends with every request. */
  tenant?: string;
  /** The A2A version served there, `'1.0'` for this module. */
  protocolVersion: string;
}

export interface A2AAgentProvider {
  url: string;
  organization: string;
}

export interface A2AAgentExtension {
  uri: string;
  description?: string;
  /** Clients must request the extension (`A2A-Extensions`) to be served. */
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface A2AAgentCapabilities {
  /** `SendStreamingMessage` and `SubscribeToTask` are served. */
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: A2AAgentExtension[];
  extendedAgentCard?: boolean;
}

/** Security schemes per scheme name, required scopes per scheme (`{ list }`). */
export interface A2ASecurityRequirement {
  schemes: Record<string, { list?: string[] }>;
}

export type A2AOAuthFlows =
  | {
      authorizationCode: {
        authorizationUrl: string;
        tokenUrl: string;
        refreshUrl?: string;
        scopes?: Record<string, string>;
        pkceRequired?: boolean;
      };
    }
  | {
      clientCredentials: { tokenUrl: string; refreshUrl?: string; scopes?: Record<string, string> };
    }
  | {
      deviceCode: {
        deviceAuthorizationUrl: string;
        tokenUrl: string;
        refreshUrl?: string;
        scopes?: Record<string, string>;
      };
    }
  | {
      implicit: { authorizationUrl: string; refreshUrl?: string; scopes?: Record<string, string> };
    }
  | { password: { tokenUrl: string; refreshUrl?: string; scopes?: Record<string, string> } };

/** How a client authenticates, after the OpenAPI 3.2 security scheme object. */
export type A2ASecurityScheme =
  | { apiKeySecurityScheme: { description?: string; location: string; name: string } }
  | { httpAuthSecurityScheme: { description?: string; scheme: string; bearerFormat?: string } }
  | {
      oauth2SecurityScheme: {
        description?: string;
        flows: A2AOAuthFlows;
        oauth2MetadataUrl?: string;
      };
    }
  | { openIdConnectSecurityScheme: { description?: string; openIdConnectUrl: string } }
  | { mtlsSecurityScheme: { description?: string } };

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: A2ASecurityRequirement[];
}

/** A JWS signature over the card. */
export interface A2AAgentCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

/**
 * The agent's self-description, served at `/.well-known/agent-card.json`.
 * `supportedInterfaces` lists the endpoints, preferred first.
 */
export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: A2AAgentInterface[];
  provider?: A2AAgentProvider;
  /** The agent's own version (not the protocol's). */
  version: string;
  documentationUrl?: string;
  capabilities?: A2AAgentCapabilities;
  securitySchemes?: Record<string, A2ASecurityScheme>;
  securityRequirements?: A2ASecurityRequirement[];
  /** Media types the agent accepts. */
  defaultInputModes: string[];
  /** Media types the agent produces. */
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  signatures?: A2AAgentCardSignature[];
  iconUrl?: string;
}

// --- inputs --------------------------------------------------------------------

/** A message without the fields a sender fills in: `messageId` is generated and `role` defaulted. */
export type A2AMessageDraft = Omit<A2AMessage, 'messageId' | 'role'> & {
  messageId?: string;
  role?: A2ARole;
};

/**
 * Message content as callers write it: a string (one text part), a list of
 * parts, or a message draft. The client defaults `role` to `'ROLE_USER'`, an
 * executor's messages to `'ROLE_AGENT'`.
 */
export type A2AMessageInput = string | A2APart[] | A2AMessageDraft;

// --- client --------------------------------------------------------------------

/** The bindings the client and handler speak. */
export type A2ABinding = 'JSONRPC' | 'HTTP+JSON';

/** Static headers, or a function called for every request (rotating credentials). */
export type A2AHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface A2AClientOptions {
  /**
   * The agent's card (see `fetchAgentCard`). The client uses the first
   * `JSONRPC` or `HTTP+JSON` interface the card declares for A2A 1.x, or the
   * first of the `binding` you name.
   */
  card?: A2AAgentCard;
  /** An endpoint URL to use without a card. */
  url?: string;
  /** With `url`: the endpoint's binding (default `'JSONRPC'`). With `card`: the binding to use. */
  binding?: A2ABinding;
  /** Sent with every request. Default: the chosen card interface's `tenant`. */
  tenant?: string;
  /** Extra headers on every request, such as credentials. */
  headers?: A2AHeaders;
  /** Extension URIs requested with every call (`A2A-Extensions`). */
  extensions?: string[];
  /** `fetch` and `generateId` (message ids) are used. */
  deps?: Dependencies;
}

export interface A2ACallOptions {
  signal?: AbortSignal;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

export interface A2ASendMessageOptions extends A2ACallOptions {
  /** Continue this task (an `INPUT_REQUIRED` one, say). Sets `message.taskId`. */
  taskId?: string;
  /** Join this context. Sets `message.contextId`. */
  contextId?: string;
  configuration?: A2ASendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export interface A2AGetTaskOptions extends A2ACallOptions {
  /** At most this many of the most recent history messages; 0 for none. */
  historyLength?: number;
}

export interface A2ACancelTaskOptions extends A2ACallOptions {
  metadata?: Record<string, unknown>;
}

/** Options of `fetchAgentCard`. */
export interface A2AFetchAgentCardOptions extends A2ACallOptions {
  /** Where the card lives, resolved against the URL. Default `/.well-known/agent-card.json`. */
  path?: string;
  /** `fetch` is used. */
  deps?: Dependencies;
}

/** A connection to one A2A agent endpoint. */
export interface A2AClient {
  /** The endpoint in use. */
  readonly url: string;
  readonly binding: A2ABinding;
  /** The card the client was created from, if any. */
  readonly card: A2AAgentCard | undefined;
  /**
   * `SendMessage`: send a message and wait for the answer — a direct
   * message, or the task once it is terminal or interrupted (or at the
   * agent's first update with `configuration.returnImmediately`).
   */
  sendMessage(
    message: A2AMessageInput,
    options?: A2ASendMessageOptions,
  ): Promise<A2ASendMessageResponse>;
  /** `SendStreamingMessage`: the answer as it happens. Ends when the agent's turn does. */
  sendStreamingMessage(
    message: A2AMessageInput,
    options?: A2ASendMessageOptions,
  ): AsyncGenerator<A2AStreamResponse, void, undefined>;
  /** `GetTask`. */
  getTask(taskId: string, options?: A2AGetTaskOptions): Promise<A2ATask>;
  /** `CancelTask`: the task as it is after the request. */
  cancelTask(taskId: string, options?: A2ACancelTaskOptions): Promise<A2ATask>;
  /**
   * `SubscribeToTask`: re-attach to a task that is still running — a `task`
   * snapshot, then its updates until the agent's turn ends.
   */
  subscribeToTask(
    taskId: string,
    options?: A2ACallOptions,
  ): AsyncGenerator<A2AStreamResponse, void, undefined>;
}

// --- handler -------------------------------------------------------------------

/**
 * Where a task lives. The task store keys tasks by it, so tasks of different
 * tenants or owners never see each other.
 */
export interface A2ATaskScope {
  tenant?: string;
  /** The caller `options.owner` named. */
  owner?: string;
}

/**
 * Persistence for tasks. The handler loads a task before every change and
 * saves the whole task after it. Tasks are plain JSON.
 *
 * A store must keep tasks apart by scope: key each task by `scope.tenant`,
 * `scope.owner` and the task id, so `load` returns `undefined` for an unknown
 * id and for a task saved under another scope, and a save never replaces
 * another scope's task. The handler does no ownership check of its own;
 * tenant and `owner` isolation rest on the store (`createInMemoryA2ATaskStore`
 * keys tasks this way).
 */
export interface A2ATaskStore {
  load(taskId: string, scope: A2ATaskScope): A2ATask | undefined | Promise<A2ATask | undefined>;
  save(task: A2ATask, scope: A2ATaskScope): void | Promise<void>;
}

/** Options of the status helpers on an execution context. */
export interface A2AStatusOptions {
  /** Merged into the task's `metadata` (and sent with the status update). */
  metadata?: Record<string, unknown>;
}

/** An artifact as an executor writes it; `artifactId` is generated when absent. */
export type A2AArtifactInput = Omit<A2AArtifact, 'artifactId'> & { artifactId?: string };

export interface A2AArtifactOptions {
  /** Add the parts to the artifact with the same `artifactId` instead of replacing it. */
  append?: boolean;
  /** This is the artifact's final chunk. */
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * One turn of an agent: the work an incoming message starts. A new
 * interaction has no `task` yet; the task is created by the first status or
 * artifact update (or never, when the executor answers with `reply`). A
 * message to an `INPUT_REQUIRED` or `AUTH_REQUIRED` task starts a new turn of
 * that task, with `task` set and the message added to its history.
 *
 * The turn ends at `reply`, at a terminal state, at `INPUT_REQUIRED`, or when
 * `execute` settles; updates after that are rejected. If `execute` resolves
 * while the task is `SUBMITTED` or `WORKING` the task is completed; if it
 * resolves without a reply or an update, a new interaction answers
 * `INVALID_AGENT_RESPONSE` and a follow-up turn answers with the task as it
 * waits. If `execute` throws, the task fails with the error's message —
 * unless it throws an `A2AError` of its own before changing the task, which
 * answers the request with that error instead and leaves the task as it was
 * (a follow-up message comes back out of its history). An `A2AError` a
 * `createA2AClient` call threw is another agent's answer: it fails the task
 * like any other error.
 */
export interface A2AExecutionContext {
  /** The message that started this turn, with `taskId` and `contextId` filled in. */
  readonly message: A2AMessage;
  /** The task this turn continues, its `history` ending with `message`; `undefined` for a new interaction. */
  readonly task: A2ATask | undefined;
  /** The task's id: the existing task's, or the one a new task gets. */
  readonly taskId: string;
  readonly contextId: string;
  readonly tenant: string | undefined;
  /** The caller, as `options.owner` named it. */
  readonly owner: string | undefined;
  /** The full `SendMessage` params: `configuration` (accepted output modes, …) and `metadata`. */
  readonly request: A2ASendMessageRequest;
  /** Extension URIs the client requested (`A2A-Extensions`). */
  readonly extensions: readonly string[];
  /** Aborted when the task is canceled. */
  readonly signal: AbortSignal;
  /** The HTTP request that carried the message. */
  readonly httpRequest: Request;
  /** Answer with a single message and no task. New interactions only, before any update. */
  reply(message: A2AMessageInput): Promise<void>;
  /** `TASK_STATE_WORKING`, optionally with a progress message. */
  working(message?: A2AMessageInput, options?: A2AStatusOptions): Promise<void>;
  /** Add an artifact, or extend one (`append`). Resolves with the artifact's id. */
  artifact(artifact: A2AArtifactInput, options?: A2AArtifactOptions): Promise<string>;
  /**
   * Stream an artifact update to the clients following this turn without
   * storing it (2.3): a preview, such as text while a model writes it, sent as
   * an `artifactUpdate` (with `append`, it extends the previewed artifact).
   * `GetTask`, a blocking `SendMessage` and a later `SubscribeToTask` never
   * see it, and it does not answer a `returnImmediately` request. Store the
   * finished content with `artifact` under the same `artifactId` to replace
   * the preview. Needs the task, so make an update first. Resolves with the
   * artifact's id.
   */
  draft(artifact: A2AArtifactInput, options?: { append?: boolean }): Promise<string>;
  /** `TASK_STATE_INPUT_REQUIRED`: ask the client; its next message starts a new turn. Ends the turn. */
  requireInput(message?: A2AMessageInput, options?: A2AStatusOptions): Promise<void>;
  /** `TASK_STATE_AUTH_REQUIRED`. The turn stays open, so the executor may continue once authorized. */
  requireAuth(message?: A2AMessageInput, options?: A2AStatusOptions): Promise<void>;
  /** `TASK_STATE_COMPLETED`. Ends the turn. */
  complete(message?: A2AMessageInput, options?: A2AStatusOptions): Promise<void>;
  /** `TASK_STATE_FAILED`. Ends the turn. */
  fail(message?: A2AMessageInput, options?: A2AStatusOptions): Promise<void>;
  /** `TASK_STATE_REJECTED`: the agent will not do this task. Ends the turn. */
  reject(message?: A2AMessageInput, options?: A2AStatusOptions): Promise<void>;
  /** Any state; the helpers above are shorthands for it. */
  setStatus(
    state: A2ATaskState,
    message?: A2AMessageInput,
    options?: A2AStatusOptions,
  ): Promise<void>;
}

/** What `executor.cancel` is told about a `CancelTask` request. */
export interface A2ACancelContext {
  /** The task, not yet canceled. */
  readonly task: A2ATask;
  readonly tenant: string | undefined;
  readonly owner: string | undefined;
  readonly request: A2ACancelTaskRequest;
  /** A turn of this task is running in this handler; its `signal` is aborted next. */
  readonly running: boolean;
  readonly httpRequest: Request;
}

/** Runs one turn. */
export type A2AExecuteFunction = (context: A2AExecutionContext) => void | Promise<void>;

/** The agent behind a handler. */
export interface A2AExecutor {
  execute: A2AExecuteFunction;
  /**
   * Called before a task is canceled, whether or not a turn of it is running
   * here (an `INPUT_REQUIRED` task has none). Throw an `A2AError` with reason
   * `'TASK_NOT_CANCELABLE'` to refuse. Whatever it throws leaves the task
   * uncanceled; anything but an `A2AError` of its own (one a
   * `createA2AClient` call threw included) answers `INTERNAL_ERROR`. Do not
   * wait for `execute` in here.
   */
  cancel?(context: A2ACancelContext): void | Promise<void>;
}

export interface A2AHandlerOptions {
  /**
   * The agent card, served at `cardPath`. Its `JSONRPC` and `HTTP+JSON`
   * interfaces with `protocolVersion: '1.0'` are the endpoints the handler
   * serves, matched by URL path.
   */
  card: A2AAgentCard;
  executor: A2AExecutor | A2AExecuteFunction;
  /** Default: an in-memory store (`createInMemoryA2ATaskStore`). */
  taskStore?: A2ATaskStore;
  /**
   * Who is calling. Tasks are kept per owner (within a tenant), so a caller
   * only ever sees, continues, cancels or subscribes to its own tasks —
   * provided the task store keys tasks by scope, as `A2ATaskStore` requires
   * and the default store does. The executor gets it as `owner`. Return an
   * identity you verified — a session, a checked token — never a header you
   * did not check. Default: no owner, every caller shares the tasks (their
   * random ids are the only key).
   */
  owner?: (request: Request) => string | undefined | Promise<string | undefined>;
  /** Default `/.well-known/agent-card.json`. */
  cardPath?: string;
  /** The largest request body read, in bytes. Default 4 MiB. */
  maxRequestBodyBytes?: number;
  /** Failures nobody else hears about (an executor that throws after its turn ended). Reporting only. */
  onError?: (error: unknown) => void;
  /** `generateId` (task, context, message and artifact ids), `clock` (timestamps), `logger`. */
  deps?: Dependencies;
}

/** A fetch-style handler: `Request` in, `Response` out. */
export type A2AHandler = (request: Request) => Promise<Response>;
