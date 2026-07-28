/**
 * chat-request.ts — validate the body a chat route actually receives (1.9).
 *
 * Every documented Deuz route does `const { messages } = await req.json()` and
 * hands the result straight to `streamChat`. That body is ATTACKER-CONTROLLED,
 * and canonical `Message[]` is expressive enough to be dangerous:
 *
 *   1. `Role` includes `'system'` (`types/message.ts`) — a client can append a
 *      system turn and overwrite the instructions the route thought it owned.
 *      This is the live vector, and it is the one most deployments miss.
 *   2. A forged `tool_result` part can claim any outcome ("payment captured").
 *      On the wire a client-authored tool result is INDISTINGUISHABLE from one
 *      the server produced, and the model believes it.
 *   3. Forged assistant turns rewrite what the model thinks it already said.
 *   4. 50 000 messages, or one 40 MB message, is a billing attack.
 *
 * The HMAC approval token (`durable.ts` `createApprovalSigner`) closes #2 for
 * APPROVAL VERDICTS specifically — this module does not duplicate it; it is the
 * structural gate in front of it, covering the other four cases.
 *
 * Deliberately PURE: no clock (so no rate limiting — that belongs at the edge),
 * no randomness, no `console`. It returns a discriminated result and lets the
 * route map `issues` to a 400 and log them through `deps.logger`.
 *
 * It NEVER repairs. A silently "cleaned" message array hides the attack and
 * leaves the operator with no signal — every failure is a rejection.
 *
 * ```ts
 * export async function POST(req: Request) {
 *   const parsed = validateChatRequest(await req.json());
 *   if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
 *   const result = streamChat({ model, system: MY_PROMPT, messages: parsed.request.messages });
 *   return toDeuzStreamResponse(result);
 * }
 * ```
 */
import { InvalidRequestError } from './errors';
import { redactString } from './internal/redact';
import type { Message, Part, Role } from './types/message';
import type { ToolApprovalResponse } from './types/tool';

// ===================================================================
// Public surface
// ===================================================================

/** A validated chat request body, in the shape `useChat` POSTs it. */
export interface DeuzChatRequest {
  /**
   * The validated canonical history. A NEW array (immutable-history invariant);
   * the message objects themselves are the parsed JSON, aliased not cloned —
   * nothing downstream mutates them, and deep-cloning a megabyte of base64
   * image would be pure waste.
   */
  messages: Message[];
  /** Present only when the client sent a non-empty, length-bounded string. */
  chatId?: string;
  /** Present only when the client sent a well-formed verdict array. */
  approvalResponses?: ToolApprovalResponse[];
  /**
   * Everything else the client sent, unvalidated and clearly labelled as such
   * (`useChat`'s `options.body` lands here). A NEW object, but the values are
   * the raw parsed JSON — do NOT spread it into call options; read the fields
   * you know by name and validate them yourself.
   */
  rest: Record<string, unknown>;
}

export interface ValidateChatOptions {
  /** History length cap. Default 1000 — far past a real conversation, far below a billing attack. */
  maxMessages?: number;
  /**
   * Per-message text budget in UTF-8 bytes. Default 100_000 (~25k tokens).
   * Counts `content` when it is a string plus every `text`/`reasoning` part and
   * every string inside a `tool_use.input` / `tool_result.result`. Image/PDF
   * payloads are EXCLUDED — see `messageTextBytes`.
   */
  maxTextBytes?: number;
  /**
   * Reject `role: 'system'` inside the client's messages. Default TRUE — this
   * is the live vector. Opt out only if the client legitimately owns the system
   * prompt (a local playground, never a multi-tenant deployment).
   */
  rejectSystemRole?: boolean;
  /**
   * Reject client-authored `tool_result` parts (and `role: 'tool'` messages,
   * where the role itself is the claim). Default TRUE.
   *
   * CLIENT TOOLS NEED THIS OFF. `useChat`'s `onToolCall` round-trip POSTs
   * `clientToolResultMessage(...)` output, so set `rejectToolResults: false`
   * there — and understand what you are accepting: this validator cannot tell a
   * real client tool result from a forged one, because the same client authored
   * the assistant turn it pairs with. The only real fix is to stop trusting the
   * history: persist it server-side (`ChatStore` + `chatId`) and treat the
   * client's copy as a rendering cache.
   */
  rejectToolResults?: boolean;
  /** Reject client-authored assistant turns. Default false (regenerate/branch flows need them). */
  rejectAssistantTurns?: boolean;
}

/**
 * A discriminated result, never a throw — the SDK idiom (`schema/bridge.ts`
 * `ValidationResult`), and it lets a route map `issues` to a 400 itself.
 * `issues` is non-empty whenever `ok` is false.
 */
export type ValidateChatResult =
  | { ok: true; request: DeuzChatRequest }
  | { ok: false; issues: string[] };

// ===================================================================
// Bounds. Every one of these exists to keep a hostile body cheap to reject.
// ===================================================================

/** Default history cap (`maxMessages`). */
const DEFAULT_MAX_MESSAGES = 1000;

/** Default per-message text cap (`maxTextBytes`): 100 KB ≈ 25k tokens. */
const DEFAULT_MAX_TEXT_BYTES = 100_000;

/**
 * Issue budget. A 1000-message hostile body must not amplify into 1000 strings
 * the route then ships to a log aggregator; the overflow count is reported.
 */
const MAX_ISSUES = 20;

/** Chars of client text an issue may echo (redacted first — see `preview`). */
const PREVIEW_CHARS = 32;

/** Chars of a client string the redaction sweep looks at before truncating. */
const PREVIEW_WINDOW = 1024;

/** A `chatId` becomes a store key and a log field; it is never legitimately long. */
const MAX_CHAT_ID_CHARS = 200;

/** One verdict per gated call in one turn — 100 is far past any real fan-out. */
const MAX_APPROVAL_RESPONSES = 100;

/**
 * Depth cap for the text-byte walk over `tool_use.input` / `tool_result.result`.
 * Two forces set this: the walk is recursive and must never throw, so it cannot
 * follow arbitrarily deep client input; but a real nested API payload inside a
 * tool result is easily 10 levels, so the cap must not trip on honest data.
 * Hitting it is FAIL-CLOSED (see `countTextBytes`) — silently not counting a
 * deep payload was a straight bypass of `maxTextBytes`.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Every canonical role, as an own-property lookup. Typed `Record<Role, true>`
 * on purpose: a new member in `types/message.ts` breaks THIS line and forces a
 * decision about whether a client may send it.
 */
const KNOWN_ROLES: Record<Role, true> = { system: true, user: true, assistant: true, tool: true };

/** Same exhaustiveness trick for the LOCKED `Part` union (a 2.0 `file` kind lands here). */
const KNOWN_PART_TYPES: Record<Part['type'], true> = {
  text: true,
  image: true,
  tool_use: true,
  tool_result: true,
  reasoning: true,
};

const ROLE_LIST = Object.keys(KNOWN_ROLES)
  .map((r) => `'${r}'`)
  .join(', ');
const PART_LIST = Object.keys(KNOWN_PART_TYPES)
  .map((t) => `'${t}'`)
  .join(', ');

/** Web-safe byte counting — `TextEncoder`, never `Buffer` (edge-safe purity). */
const encoder = new TextEncoder();

// ===================================================================
// Describing hostile input without echoing it
// ===================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Coarse type name — safe to put in an issue, carries no client content. */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Bound a client string before it lands in an issue message.
 *
 * Order matters. Redact BEFORE the final truncation — a hostile client can put a
 * key-shaped value in `role` hoping the route logs the issue verbatim (P0: a
 * credential must never reach a log), and truncating first could split the
 * pattern so `redactString` no longer matches and its head leaks.
 *
 * The `PREVIEW_WINDOW` pre-slice keeps a 50 MB `role` value from being swept by
 * four regexes; it is orders of magnitude wider than `PREVIEW_CHARS`, and every
 * secret pattern in `redact.ts` matches within ~20 chars, so any credential that
 * could still reach the 32-char preview is fully inside the window.
 */
function preview(value: string): string {
  const window = value.length > PREVIEW_WINDOW ? value.slice(0, PREVIEW_WINDOW) : value;
  const safe = redactString(window);
  return JSON.stringify(safe.length <= PREVIEW_CHARS ? safe : `${safe.slice(0, PREVIEW_CHARS)}…`);
}

/** `"wizard"` for strings, `number`/`null`/`array` otherwise. */
function describe(value: unknown): string {
  return typeof value === 'string' ? preview(value) : typeOf(value);
}

// ===================================================================
// Text-byte accounting
// ===================================================================

/** Walk state shared across one message's parts. */
interface Walk {
  /** Revisited objects count once — cycle-safe, since the input may be hand-built. */
  seen: WeakSet<object>;
  /** The depth cap stopped the walk: this payload could not be fully accounted for. */
  tooDeep: boolean;
}

/**
 * UTF-8 bytes of every string reachable from `value`, abandoning the walk once
 * the running total passes `budget` (the caller only needs "over or not", so the
 * returned number is exact only below the budget).
 *
 * The `value.length > budget` fast path is EXACT, not a heuristic: UTF-8 byte
 * length is always >= UTF-16 code-unit length, so a longer string cannot fit —
 * and we avoid encoding a 40 MB string just to learn it is too big.
 *
 * At `MAX_WALK_DEPTH` the walk gives up and reports OVER budget, not zero: a
 * `tool_use.input` with 40 levels of nesting around a 50 MB string is an obvious
 * attempt to hide volume from the cap, and "I could not measure this" must never
 * read as "this is small". Typed-array payloads count as 0 rather than walking a
 * megabyte of numbers one element at a time.
 */
function countTextBytes(value: unknown, budget: number, depth: number, walk: Walk): number {
  if (typeof value === 'string') {
    if (value.length > budget) return budget + 1;
    return encoder.encode(value).byteLength;
  }
  if (typeof value !== 'object' || value === null) return 0;
  if (ArrayBuffer.isView(value) || walk.seen.has(value)) return 0;
  if (depth >= MAX_WALK_DEPTH) {
    walk.tooDeep = true;
    return budget + 1;
  }
  walk.seen.add(value);
  let total = 0;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    total += countTextBytes(entry, Math.max(0, budget - total), depth + 1, walk);
    if (total > budget) return total;
  }
  return total;
}

/**
 * Text bytes ONE message carries: `content` when it is a string, plus every
 * `text`/`reasoning` part and every string inside a `tool_use.input` /
 * `tool_result.result`.
 *
 * `image.image` is deliberately EXCLUDED — a legitimate photo or PDF is
 * megabytes of base64 and would trip a cap sized for prose. Binary volume is a
 * raw-body-size concern: cap that at the edge (or before calling this), which
 * this pure validator cannot do for you.
 */
function messageTextBytes(
  message: Record<string, unknown>,
  budget: number,
): { bytes: number; tooDeep: boolean } {
  const walk: Walk = { seen: new WeakSet<object>(), tooDeep: false };
  const content = message.content;
  if (typeof content === 'string') {
    return { bytes: countTextBytes(content, budget, 0, walk), tooDeep: walk.tooDeep };
  }
  if (!Array.isArray(content)) return { bytes: 0, tooDeep: false };
  let total = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const payload =
      part.type === 'text' || part.type === 'reasoning'
        ? part.text
        : part.type === 'tool_use'
          ? part.input
          : part.type === 'tool_result'
            ? part.result
            : undefined;
    if (payload === undefined) continue;
    total += countTextBytes(payload, Math.max(0, budget - total), 0, walk);
    if (total > budget) break;
  }
  return { bytes: total, tooDeep: walk.tooDeep };
}

// ===================================================================
// Structural validation
// ===================================================================

/** Resolved gates, threaded down so the part walker sees the same policy. */
interface Gates {
  rejectSystemRole: boolean;
  rejectToolResults: boolean;
  rejectAssistantTurns: boolean;
  maxTextBytes: number;
}

type Fail = (issue: string) => void;

/**
 * One content part. `Object.hasOwn`, never `in`: `{ type: 'constructor' }` is a
 * hostile payload that `in` would happily accept off `Object.prototype`.
 */
function validatePart(value: unknown, path: string, gates: Gates, fail: Fail): void {
  if (!isRecord(value)) {
    fail(`${path} must be an object; got ${typeOf(value)}.`);
    return;
  }
  const type = value.type;
  if (typeof type !== 'string' || !Object.hasOwn(KNOWN_PART_TYPES, type)) {
    fail(`${path}.type must be one of ${PART_LIST}; got ${describe(type)}.`);
    return;
  }
  switch (type as Part['type']) {
    case 'text':
    case 'reasoning':
      if (typeof value.text !== 'string') {
        fail(`${path}.text must be a string; got ${typeOf(value.text)}.`);
      }
      return;
    case 'image':
      // Over JSON only a string survives; bytes are accepted for callers that
      // validate an already-constructed object rather than a parsed body.
      if (typeof value.image !== 'string' && !(value.image instanceof Uint8Array)) {
        fail(`${path}.image must be a string or Uint8Array; got ${typeOf(value.image)}.`);
      }
      if (value.mediaType !== undefined && typeof value.mediaType !== 'string') {
        fail(`${path}.mediaType must be a string when present; got ${typeOf(value.mediaType)}.`);
      }
      return;
    case 'tool_use':
      if (!isNonEmptyString(value.id)) {
        fail(`${path}.id must be a non-empty string; got ${describe(value.id)}.`);
      }
      if (!isNonEmptyString(value.name)) {
        fail(`${path}.name must be a non-empty string; got ${describe(value.name)}.`);
      }
      return;
    case 'tool_result':
      // Checked at the PART level as well as the role level: a `tool_result`
      // smuggled inside a `role: 'user'` message is the obvious way around a
      // role-only gate, and adapters serialize it just the same.
      if (gates.rejectToolResults) {
        fail(
          `${path} is a client-authored tool_result — the server cannot tell it from a real one (set rejectToolResults: false to allow it).`,
        );
        return;
      }
      if (!isNonEmptyString(value.toolUseId)) {
        fail(`${path}.toolUseId must be a non-empty string; got ${describe(value.toolUseId)}.`);
      }
      if (value.isError !== undefined && typeof value.isError !== 'boolean') {
        fail(`${path}.isError must be a boolean when present; got ${typeOf(value.isError)}.`);
      }
      return;
  }
}

/** One message. A gate rejection stops here — the turn is refused, its content is moot. */
function validateMessage(value: unknown, path: string, gates: Gates, fail: Fail): void {
  if (!isRecord(value)) {
    fail(`${path} must be an object; got ${typeOf(value)}.`);
    return;
  }
  const role = value.role;
  if (typeof role !== 'string' || !Object.hasOwn(KNOWN_ROLES, role)) {
    fail(`${path}.role must be one of ${ROLE_LIST}; got ${describe(role)}.`);
    return;
  }
  if (role === 'system' && gates.rejectSystemRole) {
    fail(
      `${path}.role is 'system' — a client may not inject a system turn (set rejectSystemRole: false to allow it).`,
    );
    return;
  }
  if (role === 'assistant' && gates.rejectAssistantTurns) {
    fail(
      `${path}.role is 'assistant' — client-authored assistant turns are not allowed (set rejectAssistantTurns: false to allow them).`,
    );
    return;
  }
  if (role === 'tool' && gates.rejectToolResults) {
    // The ROLE is the claim here, whatever the content shape: a `role: 'tool'`
    // message asserts "a tool ran and produced this".
    fail(
      `${path}.role is 'tool' — a client may not author tool results (set rejectToolResults: false to allow it).`,
    );
    return;
  }

  const content = value.content;
  if (typeof content !== 'string' && !Array.isArray(content)) {
    fail(`${path}.content must be a string or an array of parts; got ${typeOf(content)}.`);
    return;
  }
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      validatePart(content[i], `${path}.content[${i}]`, gates, fail);
    }
  }
  if (value.providerMetadata !== undefined && !isRecord(value.providerMetadata)) {
    fail(
      `${path}.providerMetadata must be an object when present; got ${typeOf(value.providerMetadata)}.`,
    );
  }
  const size = messageTextBytes(value, gates.maxTextBytes);
  if (size.tooDeep) {
    fail(
      `${path} has a content payload nested deeper than ${MAX_WALK_DEPTH} levels — its size cannot be accounted for, so it is refused.`,
    );
  } else if (size.bytes > gates.maxTextBytes) {
    // "more than" is the honest wording: the walk abandons early, so the exact
    // size is unknown (and printing it would be a second amplification vector).
    fail(`${path} carries more than ${gates.maxTextBytes} text bytes (image payloads excluded).`);
  }
}

/**
 * Validate the JSON body a chat route received. Structural only — it proves the
 * body has the shape `streamChat` expects and that the client did not claim
 * privileges it does not have. It cannot prove the history is the one the server
 * previously produced; only server-side persistence (`ChatStore`) can.
 */
export function validateChatRequest(
  body: unknown,
  options: ValidateChatOptions = {},
): ValidateChatResult {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const gates: Gates = {
    rejectSystemRole: options.rejectSystemRole ?? true,
    rejectToolResults: options.rejectToolResults ?? true,
    rejectAssistantTurns: options.rejectAssistantTurns ?? false,
    maxTextBytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
  };

  const issues: string[] = [];
  let suppressed = 0;
  const fail: Fail = (issue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
    else suppressed += 1;
  };
  const rejected = (): ValidateChatResult => {
    if (suppressed > 0) issues.push(`${suppressed} further issue(s) suppressed.`);
    // Belt and braces: `ok: false` with an empty list would be unusable. Every
    // rejection path above pushes at least one issue, so this never fires.
    if (issues.length === 0) issues.push('body is not a valid chat request.');
    return { ok: false, issues };
  };

  if (!isRecord(body)) {
    return { ok: false, issues: [`body must be a JSON object; got ${typeOf(body)}.`] };
  }
  // `JSON.parse` turns `{"__proto__": …}` into an OWN enumerable property, and
  // copying that key onto a plain object with `=` hits `Object.prototype`'s
  // setter instead of defining data. No real client sends it — reject rather
  // than carry it into `rest`.
  if (Object.hasOwn(body, '__proto__')) {
    return { ok: false, issues: ['body carries a forbidden "__proto__" key.'] };
  }

  const rawMessages: unknown = body.messages;
  let checked: readonly unknown[] | undefined;
  if (!Array.isArray(rawMessages)) {
    fail(`messages must be an array; got ${typeOf(rawMessages)}.`);
  } else if (rawMessages.length === 0) {
    fail('messages must not be empty.');
  } else if (rawMessages.length > maxMessages) {
    // Reported WITHOUT walking the entries: a 50k-message body must not cost
    // 50k validations to reject, which would be its own denial of service.
    fail(`messages has ${rawMessages.length} entries; the limit is ${maxMessages}.`);
  } else {
    checked = rawMessages as readonly unknown[];
    for (let i = 0; i < checked.length; i++) {
      validateMessage(checked[i], `messages[${i}]`, gates, fail);
    }
  }

  const rawChatId: unknown = body.chatId;
  let chatId: string | undefined;
  if (rawChatId !== undefined) {
    // Never echoed: a chatId is a store key and can encode tenant identity.
    if (typeof rawChatId !== 'string') {
      fail(`chatId must be a string when present; got ${typeOf(rawChatId)}.`);
    } else if (rawChatId.length === 0) {
      fail('chatId must not be empty.');
    } else if (rawChatId.length > MAX_CHAT_ID_CHARS) {
      fail(`chatId must be at most ${MAX_CHAT_ID_CHARS} characters.`);
    } else {
      chatId = rawChatId;
    }
  }

  const rawApprovals: unknown = body.approvalResponses;
  let approvalResponses: ToolApprovalResponse[] | undefined;
  if (rawApprovals !== undefined) {
    if (!Array.isArray(rawApprovals)) {
      fail(`approvalResponses must be an array when present; got ${typeOf(rawApprovals)}.`);
    } else if (rawApprovals.length > MAX_APPROVAL_RESPONSES) {
      fail(
        `approvalResponses has ${rawApprovals.length} entries; the limit is ${MAX_APPROVAL_RESPONSES}.`,
      );
    } else {
      for (let i = 0; i < rawApprovals.length; i++) {
        const entry: unknown = rawApprovals[i];
        const path = `approvalResponses[${i}]`;
        if (!isRecord(entry)) {
          fail(`${path} must be an object; got ${typeOf(entry)}.`);
          continue;
        }
        if (!isNonEmptyString(entry.approvalId)) {
          fail(`${path}.approvalId must be a non-empty string; got ${describe(entry.approvalId)}.`);
        }
        if (typeof entry.approved !== 'boolean') {
          fail(`${path}.approved must be a boolean; got ${typeOf(entry.approved)}.`);
        }
        if (entry.reason !== undefined && typeof entry.reason !== 'string') {
          fail(`${path}.reason must be a string when present; got ${typeOf(entry.reason)}.`);
        }
        // `token` is a credential (`createApprovalSigner`): report its TYPE
        // only, never its value — not even bounded and redacted.
        if (entry.token !== undefined && typeof entry.token !== 'string') {
          fail(`${path}.token must be a string when present; got ${typeOf(entry.token)}.`);
        }
      }
      // A NEW array carrying the entries VERBATIM. Malformed verdicts are
      // rejected below, never filtered out here: a silently dropped verdict
      // resumes the loop with an unsettled approval that then gets denied — a
      // bad request masquerading as a product bug.
      approvalResponses = [...rawApprovals] as ToolApprovalResponse[];
    }
  }

  if (issues.length > 0 || suppressed > 0 || checked === undefined) return rejected();

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'messages' || key === 'chatId' || key === 'approvalResponses') continue;
    rest[key] = value;
  }

  return {
    ok: true,
    request: {
      messages: [...checked] as Message[],
      ...(chatId !== undefined ? { chatId } : {}),
      ...(approvalResponses !== undefined ? { approvalResponses } : {}),
      rest,
    },
  };
}

/**
 * Throwing sibling, for routes that already funnel every failure through one
 * `catch`. `InvalidRequestError` is the right carrier and not a new concept: it
 * already reports `statusCode: 400` / `isRetryable: false`, and its `toJSON()`
 * is secret-safe — so an existing route error handler maps it with no new
 * branch. Prefer `validateChatRequest` when you want to hand the individual
 * issues back to the client or log them structurally.
 */
export function parseDeuzChatRequest(
  body: unknown,
  options?: ValidateChatOptions,
): DeuzChatRequest {
  const result = validateChatRequest(body, options);
  if (result.ok) return result.request;
  throw new InvalidRequestError({ message: `Invalid chat request: ${result.issues.join(' ')}` });
}
