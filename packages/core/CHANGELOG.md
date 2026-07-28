# @deuz-sdk/core

## 1.9.0

### Minor Changes

- Three surfaces that shipped as types with no producer now actually produce.

  `CallWarning`, `WarningPart`, the `warnings` result fields, `ToolStatePart.denied` and the `sub-agent` wire
  part were all declared, locked into the API contract, and documented as "declared but inert". This package's
  surface is append-only, so publishing them dead would have made them permanent dead API. They have producers now.

  ### `warnings` — the escape valve for "we quietly did something else"

  Deuz deliberately never throws on something it can degrade: an unknown model slug falls back to a
  conservative capability row, a sampling parameter a reasoning model rejects is stripped, a typo'd
  `activeTools` name is ignored fail-open. That policy is right — a new provider slug must not break a running
  app — but every one of those decisions went only to `deps.logger.warn`, and **the default logger is a no-op**,
  so by default they went nowhere at all.

  ```ts
  const res = await generateText({ model: openai('some-brand-new-slug'), prompt: 'hi' });
  res.warnings; // [{ type: 'unknown-model', message: "Unknown model 'some-brand-new-slug' — …" }]
  ```

  Emitting sites: the unknown-slug fallback, a sampling parameter dropped by `samplingRestrictions`, `effort`
  dropped on a model without reasoning, provider-executed tools the Chat Completions wire cannot carry, a
  document handed to a model without `nativePdf`, and an `activeTools` name that matches nothing.

  Verified populated on **all six call shapes** — `streamChat` single-turn and in the loop, `generateText`
  with and without tools, `generateObject`, `streamObject` — plus the `fallbackModels` / `withFallback` paths.
  `StreamChatResult.warnings` resolves alongside `usage`/`finishReason`, settles on every exit (success,
  mid-stream error, abort) and never rejects; live warnings also arrive as `warning` parts on `fullStream` and
  now cross the loop boundary and the UI wire instead of dying at a `default:` branch.

  Details that matter in practice: one sink per **run**, not per step, so a capability the loop re-derives every
  step is reported once rather than N times; sites that already log record without mirroring, so 1.9 adds a
  typed channel without turning one log line into two; and the list is capped with an explicit
  "N further warning(s) omitted" entry rather than truncating in silence.

  ### Approval denial is distinguishable from a tool that threw

  `ToolStatePart.denied` / `deniedReason` existed everywhere except in the code that should set them, so a
  human refusing a tool call still rendered as "getWeather failed" — the wrong last frame for this SDK's
  strongest feature. `settlePendingApprovals` now returns the full denial map (so a client-supplied _reason_
  survives) and the loop tags the terminal `tool-state` part:

  ```ts
  { type: 'tool-state', toolCallId: 'call_1', toolName: 'wire', state: 'error', denied: true }
  ```

  What the model is told is unchanged — it still receives an `is_error` tool_result, and denials still do not
  count toward the runaway-tool guard. Only the UI is better informed. Works in server mode
  (`approveToolCall`), in client mode (`approvalResponses`) and on a durable resume leg.

  ### `agentTool` runs are no longer invisible in `useChat`

  `applyUIPart` had no `sub-agent` case, so a whole delegated run — its text, reasoning, tool cards, citations,
  cost — reached the reducer and was dropped. A user watching a sub-agent work saw nothing.

  Sub-agent frames now land in their own `AssistantTurnState.subAgents` channel rather than being folded into
  the parent, and that separation is deliberate:
  - a sub-agent's words are **not** the parent's — folding them into `message.content` would misattribute
    prose, and folding its `tool_use` parts into the parent's would make `assistantMessageFromTurn` re-emit
    them as the parent's own, where each one needs a `tool_result` or the next request 400s;
  - `UIMessagePart` is a closed pinned union consumers switch on exhaustively, so a new member there would be
    breaking (the same reasoning that keeps `ToolRunState` at six members);
  - the interleave still stays truthful: each frame records `afterPart`, the count of the parent's ordered
    elements when it opened, so a renderer splices the block back in exactly where the parent handed off.

  Each frame holds a full `AssistantTurnState` folded by the same reducer, so a sub-agent's own ordered `parts`
  are as complete as the parent's. A second-level sub-agent is a **sibling** frame with a two-segment
  `agentPath`, not a nested one, so a renderer indents by `agentPath.length` and needs no recursion.

  The `false-finish` part also reaches the wire and the reducer now, the same gap `verify` had in Sprint 1.

  ### Two fixes found while wiring this up
  - **A step or tool timeout no longer triggers cross-provider fail-over.** `defaultShouldFallback` hopped on
    any `TimeoutError`; once `layer: 'step'` / `'tool'` existed that meant a step deadline would switch models
    and re-run the whole loop, **repeating the side effects of tools that already executed**. A caller-imposed
    budget is not a provider failure.
  - **A flaky React test is now pinned to the property it tests.** The `throttleMs` assertion pinned an exact
    React commit count; with real timers and 24 sequential flushes React can legitimately commit once for an
    unrelated state settle. The content invariant (nothing observable mid-window) is asserted exactly; the
    render count is bounded far below the token count instead.

- Finishing pass: two sandbox-escape fixes, the last silently-ignored options, a structural verifier, and a false-finish guard.

  ### `createFileWorkspace`'s sandbox had two escapes (both fixed)

  The Node workspace backend is the boundary an autonomous agent's file tools run inside. It was
  **lexical only** — `path.resolve` / `path.relative` and nothing else — and writing the first tests
  for it (there were none) found two ways out. Both are now closed with regression tests that assert
  the escape is refused _and_ that nothing appeared on the far side.
  1. **A symlink or NTFS junction inside the root walked straight out.** String math cannot follow a
     link, so `<root>/escape → /outside` passed every check: `write('escape/pwned.txt', …)` landed
     outside and `read('escape/secret.txt')` returned the outside file. A link can get there without
     anything unusual happening — a shell or CodeAct tool in the same run, a git checkout, an
     unpacked archive, any other process sharing the directory. `resolveInside` now re-verifies the
     deepest **existing** ancestor through `fs.realpath`, the only layer that resolves links.
     (Reproduced unprivileged on Windows via a junction and on POSIX via a directory symlink.)
  2. **On Windows, a foreign drive letter defeated both guard layers.** Nothing had to be planted —
     the model just had to emit `D:/x/y`. `path.relative` returns an _absolute_ path when the two
     sides live on different devices, so the `'..'` test never fired and the round-trip check passed.

  The primary fix for (2) is in `normalizeWorkspacePath`, which **every** backend shares (in-memory,
  your KV or object store, the file backend), so the hole is closed once rather than per-backend. It
  now rejects a `<letter>:` prefix and a NUL byte in addition to leading `/` and `..` segments:
  - **Drive-letter paths are rejected on every platform, not just Windows.** POSIX could read `C:/x`
    as a relative path whose first segment is literally named `C:`, but a path that is contained on
    Linux and escapes the sandbox on Windows is the worst possible split for a portable SDK.
  - **NUL bytes** used to pass every string check and were caught only by `node:fs`
    (`ERR_INVALID_ARG_VALUE`), so a backend that stores the key verbatim inherited the hole.

  If you relied on a path shaped like `C:name` or `C:/x` resolving _inside_ the workspace, it now
  throws `InvalidRequestError`. That shape was never meaningful as a workspace-relative path.

  Also newly covered by tests for the first time: `@deuz-sdk/core/mcp/stdio` and
  `@deuz-sdk/core/browser/node`.

  ### `doneWhen` — a guard against the model stopping early

  Long-horizon agent runs mostly fail for a dull reason: the model announces it is finished before the
  work is done. `verifyStep` (1.8) can catch that, but only if you write a verifier. `doneWhen` asks
  the narrower, cheaper question directly:

  ```ts
  const res = await generateText({
    model,
    prompt: 'Refactor both halves of the module, then say DONE.',
    doneWhen: ({ text }) => text.includes('DONE'),
    falseFinishGuard: { maxRetries: 3 }, // separate budget from maxSteps
  });
  ```

  Consulted at the natural-completion boundary — final text, no pending tool calls — **before**
  `verifyStep`, and a rejection that re-drives short-circuits verification for that round (there is
  nothing worth verifying in an answer you have just called incomplete). The two retry budgets never
  mix, and `stopWhen` / `budget` still win. When the guard's budget is spent the answer is accepted as
  final and the run records why: `providerMetadata.deuz.stoppedBy === 'false-finish'`. Streaming also
  emits one `false-finish` part per rejection, before the terminal `finish`.

  It works on both loops, and a call with no tools is routed through the loop so the option cannot be
  accepted and ignored.

  ### `createVerifier` — a structural verdict, not a yes/no

  `verifyStep` is a hook you implement; this is the implementation you would otherwise write.
  `createVerifier` decomposes a goal into sub-checks and returns
  `{ ok, confidence, checks, errorCategory, feedback }`. `asVerifyStep()` hands it straight to the
  loop, `score()` plugs into `bestOfN`, and the verifier's own token usage flows through `onUsage`
  like any other call. Reachable from `@deuz-sdk/core/autonomy`; built on `generateObject` with a raw
  JSON Schema, so it adds no dependency.

  ### `runGradedEval` — partial credit

  `runEval` grades pass/fail, which collapses the ranking on any multi-part task. `runGradedEval`
  takes weighted subtasks per case and returns a `0..1` score plus a per-case breakdown. A subtask
  whose check throws counts as failed and is reported, never crashing the run. On `@deuz-sdk/core/testing`.

  ### Options that were accepted and did nothing
  - **`timeout.stepMs` now applies to the buffered loop too.** It was wired into `streamChat` only, so
    `generateText` with tools took the option and ignored it. Both loops now fail an identical slow
    step with the same layer and message.
  - **`consume()` works on the fail-over paths.** `streamChat({ fallbackModels })` and the
    `withFallback` middleware built their own result and never attached it, so `res.consume?.()` was a
    silent no-op on exactly the serverless path it exists for — chat persistence, durable checkpoints,
    `onFinish` and memory extraction never ran. `observation` and `warnings` are forwarded there now too.
  - **`prompt` is reachable through the wrappers.** `client.streamChat({ prompt })` and
    `wrapModel(m).generateText({ prompt })` worked at runtime but did not typecheck.

  ### `TimeoutError.layer` gains `'step'` and `'tool'`

  A step deadline used to report `layer: 'total'`, indistinguishable from a real per-call timeout. This
  also fixes a consequence that only appeared once step deadlines existed: `defaultShouldFallback`
  hopped on _any_ `TimeoutError`, so a step expiry would fail over to the next model and re-run the
  whole loop, **repeating the side effects of tools that already executed**. A `step`/`tool` expiry is
  a caller-imposed budget, not a provider failure, so it no longer triggers fail-over.

  If you `switch` exhaustively on `err.layer` with a `never` check, or annotate it as the old
  three-member union, that code now needs the two new members. Runtime behaviour is unchanged.

  ### `onFinish` fired twice on a loop-routed call

  Pre-existing, and anyone using `onFinish` for billing or persistence was double-counting: a call
  that entered the agentic loop fired once for the step's inner model call and once for the loop. The
  loop's firing — whose meta covers the whole run — is the one that survives.

  ### Gate and contributor docs

  `npm run check` gained `verify:docs-refs`, a zero-dependency text linter over `docs/`, `skills/` and
  `README.md`: leaked tool-call debris (which broke two release passes and was caught only by a docs
  build minutes later), `@deuz-sdk` imports that name a symbol the package does not export — resolved
  against a symbol table built from `tsup.config.ts` and `package.json` `exports` — dead internal doc
  links and anchors, and `meta.json` drift.

  `CLAUDE.md` is current again, and now documents two traps that each cost real time: the
  `api-contract.json` regeneration one-liner truncates the file it is about to read (plus the
  PowerShell BOM variant), and `npm run check` typechecks `packages/react` against the _previous_
  `packages/core/dist`, so editing core and running the gate without rebuilding gives a false red.

  The bundle-size ratchet now covers `./chat`, `./ui`, `./otel` and `./observe`. Sprint 3 shipped
  ~10 KB of new surface completely unmeasured because a budget is opt-in per subpath.

- Parity hardening: four places where the SDK failed silently now report what happened.

  Every item below was a case where something went wrong and you were told nothing — an empty chat
  bubble, an option that did nothing, a tool call that hung forever, a dropped tool. Two of the fixes
  change existing behaviour on purpose and are called out separately at the end.

  ### A failed chat request no longer renders as an empty assistant bubble

  `readDeuzStream` only ever looked at the response body. A non-2xx response (a 500 from your route
  handler, a 401 from a bad key, a 429) carries no `data:` lines, so the generator ended immediately
  and the UI settled into a _successful_ empty assistant turn at status `idle`. The request had
  failed and nothing on screen said so.

  It now yields exactly one `error` part and returns:

  ```
  Deuz stream request failed (status 500 Internal Server Error).
  ```

  Every existing consumer inherits the fix without a code change: `useChat` goes to
  `status: 'error'` with `error` set and fires `onError`, `useObject` sets `error`, and the hooks in
  `@deuz-sdk/core/react` route it through the error path they already had for an error part.

  The response body is deliberately **not** read or echoed — an error page is unbounded markup you
  do not control. Only `statusText` is included, truncated and passed through the standard secret
  redaction. Opt out with `readDeuzStream(res, { onHttpError: 'ignore' })`, or in React with
  `useChat({ onHttpError: 'ignore' })`.
  - Added: `ReadDeuzStreamOptions` and an optional second argument on `readDeuzStream`.
  - Added: `UseChatOptions.onHttpError`.

  ### `verifyStep` verdicts now reach the UI

  `verifyStep` produced a canonical `verify` part, but `toDeuzStreamResponse` dropped it on the floor,
  so a verified run looked identical to an unverified one from the client's side — no way to render
  "checking…" or "retrying". `verify` is now serialized to the wire (v2 only), journaled to the
  `StreamStateStore`, and replayed on resume like any other part. A client that negotiated v1 still
  gets byte-identical output.
  - Added: `{ type: 'verify'; stepIndex; attempt; ok; willRetry; feedback? }` to `DeuzUIPart`.

  ### Token counts and finish reasons now survive the trip into chat state

  `applyUIPart` dropped `finish`, `step-finish` and `verify` into its `default` branch, so a UI built
  on the chat reducer could not display token usage and could not tell "stopped because the answer was
  complete" from "stopped because it hit the output limit" — a truncated answer was indistinguishable
  from a finished one. All three now fold into the turn.

  Wire payloads are normalized on the way in, so these fields are trustworthy even from an older or
  partial server: missing or non-finite counts read as `0`, `totalTokens` falls back to input+output,
  and a non-string `finishReason` is ignored rather than written. All four fields are optional and
  `createAssistantTurn` returns the same shape it did before.
  - Added: `AssistantTurnState.usage`, `.finishReason`, `.steps`, `.verifications`.
  - Added: `UseChatResult.usage`, `.finishReason`, `.verifications`.

  ### Dropping a hosted tool on Chat Completions is no longer silent

  Passing a provider-executed (hosted) tool to a `chat_completions`-surface model silently removed it
  from the request — the model simply never saw the tool, and you got a plain text answer with no
  indication why. The tool is still dropped (this wire has no hosted-tool support) but the SDK now
  emits one `logger.warn` naming the dropped tools, the provider and the model id. The request body is
  unchanged, byte for byte. If you use the default no-op logger you will see no difference.

  ## Intentional behaviour changes

  ### 1. `generateObject` / `streamObject` now fail loudly on tool-loop options

  Structured output is single-turn: it does not run the agentic loop. Passing loop options to it was
  accepted and then **ignored**, so `generateObject({ tools, maxSteps: 10 })` ran one plain turn and
  returned an object with no tools ever called, no error, and no warning.

  These calls now fail fast, before any network request, with an `InvalidRequestError` that names
  every offending option and tells you what to do instead. `generateObject` rejects; `streamObject`
  reports it through its existing never-throw shape (the stream and the `object`/`usage`/`finishReason`
  promises all reject).

  Detected: `tools`, `toolChoice`, `maxSteps`, `stopWhen`, `budget`, `maxToolConcurrency`,
  `onStepFinish`, `prepareStep`, `activeTools`, `verifyStep`, `maxVerifyAttempts`, `compaction`,
  `approveToolCall`, `approvalResponses`, `session`, `chat`, `memory`, `fallbackModels`,
  `approvalSigner`, `approvalMaxAgeMs`.

  If you were relying on the old silence, drop the options, or switch to `generateText`/`streamChat`.
  Options that are genuinely honoured are unaffected: `signal`, `maxRetries`, `headers`, `deps`,
  `onUsage`, `onFinish`, `temperature`, `maxOutputTokens`, `topP`, `stopSequences`, `effort`,
  `responseFormat`, `providerOptions`, `promptCaching`, `agentPath`.

  There are no false positives by construction: an option counts only when it carries a real value.
  Empty collections (`stopWhen: []`, `activeTools: []`, `tools: {}`) and `maxSteps: 1` — which _is_
  single-turn behaviour — pass the guard, so wrappers that always spread a full options bag keep
  working. No public type changed; this is a runtime check.

  ### 2. A hallucinated tool name now self-heals instead of ending the run

  A tool call naming a tool that is not in your `tools` was indistinguishable from a _client_ tool (a
  tool with no `execute`, which the caller is meant to run). So when a model invented a name, the loop
  treated it as a client hand-off and exited — returning a turn with a dangling `tool_use` and no
  error. A server waiting to send that `tool_result` back waited forever.

  An unregistered name is now recognized as unregistered and fed back to the model as an `is_error`
  `tool_result` in the same turn, and the loop **continues**:

  ```
  No such tool: "search_web". Available tools: getWeather, search.
  ```

  The model can correct itself, which is usually what happens. Both `generateText` and `streamChat`
  behave this way. Also fixed: a hallucinated name colliding with an `Object.prototype` member
  (`toString`, `constructor`) is now correctly classified as unknown, and `settlePendingApprovals`
  gives an unanswered unknown-name call this actionable result instead of a generic denial.

  Two guards on the new path: unknown-tool errors count toward the runaway limit, so a model looping
  on the same invented name hard-stops after 3 consecutive failures with
  `endReason: 'runaway-tool-errors'` (approval denials still do not count — a policy verdict is not
  something the model can fix). And in streaming, no `executing` tool-state is emitted, because
  nothing executes.

  Real client tools are unchanged: a tool present in `tools` with no `execute` still breaks the loop
  with no fabricated result, gated client tools still surface in `pendingApprovals`, and a
  `type: 'provider'` tool still never breaks the loop.

- Ergonomics: the first hour with the SDK no longer requires reading the source.

  Every item below removes a papercut that made a correct call look wrong — boilerplate for a
  one-line prompt, a `timeout` option that did not exist, a tool handler typed `unknown`, a PDF that
  400s on three of four wires. Behaviour changes are called out separately at the end.

  ### `prompt` and `instructions` — a one-line call

  `messages` was the only way in, so the smallest possible call was a nested array literal, and the
  system prompt had to be smuggled in as a history turn.

  ```ts
  const res = streamChat({
    model,
    instructions: 'You are terse.',
    prompt: 'Explain SSE in one sentence.',
  });
  ```

  `prompt` is shorthand for exactly one user turn and is **mutually exclusive** with `messages`;
  `instructions` is the system prompt and combines with either. Both are resolved at the call
  boundary into a canonical `Message[]`, so everything downstream — both loops, checkpoints, chat
  persistence, `response.messages`, observation — sees a plain `messages` array and nothing else had
  to learn about the shorthand.

  `instructions` is placed **first**, and a system message already in `messages` is **preserved**
  after it: the option arrives on its own structural field while history may be a replayed or
  user-supplied transcript, so history content cannot reorder or drop it. The fold is idempotent — a
  history whose first turn is already exactly `instructions` does not get a second copy, so
  persisting the folded history and passing the same `instructions` next turn cannot stack system
  prompts.

  Available on `streamChat`, `generateText`, `generateObject` and `streamObject`. `messages` stays
  required on the `CommonCallOptions` interface (making it optional would be a locked-surface
  change); the either/or lives in the call functions' overloads.

  ### `timeout` — four layers, one option

  There was no per-call timeout at all. The only knobs were module constants (60s to first byte, 300s
  total), which is a meaningless ceiling inside a serverless function with a 25-second budget.

  ```ts
  await generateText({
    model,
    prompt: '…',
    timeout: { ttftMs: 10_000, totalMs: 20_000, stepMs: 30_000, toolMs: 5_000 },
  });
  await generateText({ model, prompt: '…', timeout: 20_000 }); // shorthand for { totalMs }
  ```

  - `ttftMs` — per model call, time to the first content byte; cleared once content arrives.
  - `totalMs` — per model call, hard ceiling on that one whole response.
  - `stepMs` — one agentic step end-to-end: the model call **plus** the tool executions it triggered.
  - `toolMs` — one tool `execute`.

  Only the layers you set are overridden; `ttftMs`/`totalMs` fall back to the existing defaults and
  `stepMs`/`toolMs` are unbounded when unset. An explicit `0` **disables** that layer — that is how
  you opt out of the 300s total ceiling. Every timer is scheduled through `deps.clock`, so tests stay
  deterministic.

  An expiry is a **failure**, not a cancellation: you get a `TimeoutError`, never
  `finishReason: 'aborted'`. A user abort still resolves `'aborted'` with partial usage. All four
  layers apply to both loops — `streamChat` and `generateText` fail an identical slow step with the
  same `layer` and the same message.

  ### `Tool.timeoutMs` — cap one slow tool without loosening the budget

  ```ts
  tools: {
    runBuild: { description: '…', parameters: {…}, timeoutMs: 120_000, execute: runBuild },
  }
  ```

  Overrides the call's `timeout.toolMs` for that one tool. Expiry is **self-healing**: the execution
  is abandoned and the model gets an `is_error` `tool_result` — `Tool 'runBuild' timed out after
120000ms and was abandoned.` — so every `tool_use_id` still gets a result and the run continues.
  Nothing throws out of the call.

  ### `tool()` — a tool handler that knows its own argument type

  `ToolSet` is `Record<string, Tool>`, which erases `Tool<Args, Result>`. A hand-written tool literal
  therefore got `args: unknown` inside `execute`, and editing the schema produced no compile error in
  the handler — the mismatch showed up as a runtime failure instead.

  ```ts
  import { tool } from '@deuz-sdk/core';

  const getWeather = tool({
    description: 'Current weather for a city',
    parameters: z.object({ city: z.string() }),
    execute: async (args) => fetchWeather(args.city), // args: { city: string }
  });

  await generateText({ model, prompt: 'weather in Paris?', tools: { getWeather } });
  ```

  It is a **pure identity function** — `tool(def) === def` — that imports no validator and adds zero
  runtime behaviour; its entire job is inference. A raw JSON Schema has no type-level payload, so it
  degrades to `unknown` (never `any`): the handler must still narrow, exactly as today. Also added:
  `InferToolInput<T>` / `InferToolOutput<T>`, which work on `tool()` results and on plain
  `Tool<Args, Result>` values, with `InferToolOutput` awaited so sync and async tools report the same
  type.

  One sharp edge worth knowing: calling `myTool.execute(args, ctx)` **directly** checks `args` as
  `unknown`. `Tool` is invariant in `Args` (the argument sits in a contravariant position), so the
  return type is an intersection in order to stay assignable to plain `ToolSet` — which is where
  tools are actually used. Authoring inference and the loop are unaffected.

  ### `filePart()` / `imagePart()` — and PDFs that actually work on all four wires

  Attaching a PDF meant knowing an undocumented convention: the canonical `Part` union has no `file`
  kind (that is 2.0), so `ImagePart` is the carrier for all binary media. Nobody guesses "attach a
  PDF as an image".

  ```ts
  import { filePart } from '@deuz-sdk/core';

  const bytes = new Uint8Array(await file.arrayBuffer());
  await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          filePart({ data: bytes, mediaType: 'application/pdf' }),
          { type: 'text', text: 'Summarise this.' },
        ],
      },
    ],
  });
  ```

  More importantly, the convention now **works**. A media part whose `mediaType` is not `image/*` is
  mapped to each wire's document block — Anthropic `document`, OpenAI Responses `input_file`, Chat
  Completions `file`, Gemini `inlineData` — instead of an image block, which used to 400 on three of
  the four. `data` may be raw bytes, a base64 string, a `data:` URL, or an https URL on the wires that
  can fetch one.

  ### `createOpenAICompatible()` — a real provider id for OpenAI-shaped hosts

  The workaround for Ollama, vLLM, LM Studio, Perplexity or an internal gateway was to point a named
  factory somewhere else — `createGroq({ baseURL: 'http://localhost:11434/v1' })` — which then
  resolved keys, pricing, registry rows and every log line under the wrong provider id.

  ```ts
  import { createOpenAICompatible } from '@deuz-sdk/core/providers';

  const ollama = createOpenAICompatible({ id: 'ollama', baseURL: 'http://localhost:11434/v1' });
  const model = ollama('llama3.3');
  ```

  Optional `surface` (`'chat_completions'` default, or `'responses'`), `authHeader`
  (`'bearer'` default, or `'api-key'`), and `capabilities` for the host's slugs. Key and base-URL
  resolution use the same precedence chain as every named factory. Two eager errors instead of a
  confusing 401 later: an empty `id`, and `surface: 'responses'` with `authHeader: 'api-key'` (the
  Responses adapter always sends `Authorization: Bearer`). Note a custom `id` has no default base URL,
  so `baseURL` is effectively required.

  ### `capabilities` — override the registry row for a model it does not know yet

  An unknown model slug does not throw; it falls back to a conservative row whose `maxOutput` is 4096. So a brand-new Together / Groq / OpenRouter slug was **silently truncated** at 4096 output
  tokens, `reasoning: false` dropped `effort`, and `structuredOutput: false` pushed `generateObject`
  onto the tool strategy.

  ```ts
  await generateText({
    model,
    prompt: '…',
    capabilities: { maxOutput: 32_000, reasoning: true, structuredOutput: true },
  });
  ```

  Shallow-merged over the resolved row; set only what you know. Also settable per factory via
  `createOpenAICompatible({ capabilities })`, with the per-call value winning. This overrides what
  the SDK _believes_ about a model — it cannot change what the provider does. In particular
  `capabilities.tools` is read by no adapter, so it neither enables nor disables tool calling.

  New: `getModelCapabilities(model)` returns the effective matrix (a frozen copy; never throws) so a
  UI can gate on `caps.vision` or warn on `!caps.known` instead of hard-coding slug lists.

  ### `consume()` — make terminal effects run when nobody reads the stream

  `streamChat` starts its pump lazily on first output access. That is deliberate, but it means a
  caller who never iterates gets **nothing**: no chat persistence, no durable checkpoint, no
  `onFinish`, no memory extraction. Returning the response and walking away silently dropped all of
  it.

  ```ts
  const res = streamChat({ model, prompt, chat: { store, chatId } });
  const response = toDeuzStreamResponse(res);
  ctx.waitUntil(res.consume?.()); // drain so persistence/onFinish actually run
  return response;
  ```

  `consume()` takes its own subscription, so it and a normal `fullStream` iteration both see every
  part, and it awaits the post-terminal bookkeeping rather than resolving mid-write. It is memoized
  (safe to call twice; terminal effects fire once) and **never rejects** — failures go to
  `consume({ onError })` and remain on `fullStream` as an `error` part. Available on
  `StreamChatResult` and `StreamObjectResult`.

  It is optional on the type because two paths do not provide it yet: `streamChat({ fallbackModels })`
  and the `withFallback` middleware return `consume: undefined`, where `res.consume?.()` is a silent
  no-op.

  ### `toDeuzTextStreamResponse()` — plain-text streaming for non-Deuz clients

  ```ts
  import { toDeuzTextStreamResponse } from '@deuz-sdk/core/ui';
  return toDeuzTextStreamResponse(result); // text/plain, no SSE framing
  ```

  For a client that just wants text: any `streamProtocol: 'text'` consumer, `curl`, a shell pipe.
  Body bytes equal the concatenation of `result.textStream`. `includeReasoning: true` interleaves
  reasoning deltas (encrypted reasoning is always skipped — it is an opaque provider payload, not
  display text).

  A mid-stream failure writes **nothing** to the body; the response simply truncates. Injected error
  text would be indistinguishable from model output and would be persisted as if the model said it.
  Use `toDeuzStreamResponse` (or `result.finishReason`) when you need to tell "finished" from "died".
  Like the SSE serializer, it keeps draining through a client disconnect so terminal effects still
  complete.

  ### `abortSignal` — accepted as a deprecated alias for `signal`

  An AI SDK migration would copy `abortSignal` into an options object, and because excess-property
  checks only fire on literals it type-checked silently inside a spread — the user pressed stop and
  nothing happened. `abortSignal` is now honoured everywhere `signal` is. `signal` wins if both are
  set. Prefer `signal`; the alias is `@deprecated`.

  ### A warnings channel, declared but not yet emitting

  `CallWarning`, a `warning` `StreamPart`, and `warnings` on `GenerateTextResult` /
  `GenerateObjectResult` / `StreamChatResult` / `StreamObjectResult` are part of the public surface as
  of this release, **but no producer populates them yet** — the collector did not land in this sprint.
  `warnings` is `undefined` on every result today (a model wrapped with `wrapModel` resolves `[]`).
  Lossy mappings that will eventually report through it — a hosted tool dropped on Chat Completions, a
  document dropped on a model that cannot accept one — currently emit `logger.warn` only. The types
  are shipped and pinned so the shape cannot drift before the emitters arrive; do not build on the
  field until it does.

  ### `generateObject({ schema: z.object(...) })` now typechecks

  A real zod schema was never structurally assignable to core's inlined `StandardSchemaV1`, so the
  headline typed-structured-output path did not compile — despite being what the README and docs
  advertise. `StandardSchemaIssue.path` was typed `ReadonlyArray<PropertyKey>`, but Standard Schema
  (and zod >= 3.24, and valibot) also allow an object segment `{ key: PropertyKey }`. That made the
  failure branch of `StandardSchemaResult` incompatible, which rejected the whole schema.

  ```ts
  // Before: error TS2322 — ZodObject is not assignable to StandardSchemaV1<…>
  const { object } = await generateObject({
    model,
    prompt: 'Capital of France?',
    schema: z.object({ city: z.string() }),
  });
  ```

  It went unnoticed because core's tsconfig sets `types: []`, no test passed a real zod schema, and the
  docs build compiles the site rather than the mdx snippets. `path` is a type-only widening — nothing
  in core reads it — and `test/surface.test-d.ts` now pins a real zod schema against both
  `StandardSchemaV1` and `generateObject`, verified to fail without the fix.

  ## Intentional behaviour changes

  ### 1. `generateText` / `generateObject` reject an invalid input shape; `streamChat` / `streamObject` report it

  Passing both `prompt` and `messages`, or neither, is now an `InvalidRequestError` raised before any
  network request. Previously `prompt` was silently ignored (nothing read it) and a missing `messages`
  crashed inside the pump with `undefined.map`.

  The streaming entry points keep their never-throw contract: the error arrives as one `error` part on
  `fullStream`, with throwing `textStream` / rejecting `partialObjectStream` and rejected
  `usage`/`finishReason`, and `consume({ onError })` reports it.

  `messages: []` is deliberately asymmetric: combined with `prompt` it is _not_ "both given" (an
  empty collection asks for nothing, so `prompt` wins), and on its own it still reaches the transport
  exactly as it did in 1.8.

  ### 2. Non-image media is sent as a document block, and refused loudly when the model cannot take one

  An `ImagePart` whose `mediaType` is not `image/*` now maps to the wire's document block rather than
  an image block. Documents are gated on the model's capability row; a model that fails the gate no
  longer receives a bogus block — the part is **dropped** and `logger.warn` names the model and media
  type. Chat Completions also drops an https-URL document (that wire has no URL form on its `file`
  block, and the SDK does not fetch bytes on your behalf).

  Consequences worth knowing: a message may now carry fewer blocks than parts; an unknown slug gets
  the conservative row and so has its documents refused; and a URL ending `.pdf` now resolves to
  `application/pdf` instead of `image/jpeg`. Ordinary image parts are unchanged, byte for byte, on
  all four wires.

  ### 3. A timeout expiry that lost its reason is now reported as a timeout

  A ttft/total (or step) expiry whose abort reason was discarded by the transport used to be
  classified as a user abort and resolved `finishReason: 'aborted'`. It is now recovered to the
  `TimeoutError` that was armed, and fails. Transports that propagate the abort reason are
  unaffected.

  ### 4. Tool timeouts count toward the runaway-tool guard

  An expired tool execution returns an `is_error` result that counts toward the consecutive
  same-tool error limit, so a tool that hangs three times running hard-stops the loop rather than
  burning the full cap over and over. One success resets the counter. (Approval denials still do not
  count — a policy verdict is not something the model can fix.)

  ### 5. `wrapModel(...).streamChat()` stops dropping result fields

  The middleware wrapper built a partial result, so `runId`, `observation` and `memory` were lost on
  the way back through it — `result.runId` was `undefined` even for a durable session. All three are
  forwarded again, plus the new `warnings` and `consume`. A wrapped call with `session` set but no
  `runId` now generates the id up front, so `result.runId` is known synchronously and the inner loop
  checkpoints under it.

  ### 6. `getCapabilities()` returns a frozen object

  The resolved capability matrix is frozen, so mutating it throws in strict mode instead of silently
  poisoning later calls in the same process. Nothing in the SDK mutated it. Relatedly, a call that
  passes `capabilities` runs against a per-call clone of the model descriptor, so descriptor object
  _identity_ differs for that call; key and base-URL resolution are unchanged.

- Chat UI surface: ordered message parts, writable hook state, multimodal input, request validation

  This release makes a streamed turn **renderable in the order it actually happened**, makes
  `useChat`'s transcript **writable**, lets a chat turn carry **files**, and adds the
  **structural validator** every chat route needs in front of a client-supplied history.
  Everything is additive: no existing type gained a required field, no literal union gained a
  member, and every 1.8 call still compiles and behaves identically.

  ### Ordered part projection — `UIMessage.parts`

  `content` / `reasoning` / `toolCalls` are _buckets_. A multi-step run — think → search →
  "I found 3 papers" → fetch → "here is the summary" — flattens into one reasoning blob, one
  text blob, and a detached list of tool cards, so a UI cannot place a tool card between the
  two sentences it belongs between. `applyUIPart` and `uiFromMessages` now also record
  arrival order in a new optional `parts` array:

  ```tsx
  {
    message.parts?.map((part, i) => {
      switch (part.type) {
        case 'step-start':
          return <Divider key={i} step={part.step} />;
        case 'text':
          return <Prose key={i} text={part.text} streaming={part.state === 'streaming'} />;
        case 'reasoning':
          return part.encrypted ? null : <Thinking key={i} text={part.text} />;
        case 'tool':
          return <ToolCard key={i} call={byId(message.toolCalls, part.toolCallId)} />;
        case 'file':
          return <Attachment key={i} mediaType={part.mediaType} data={part.data} url={part.url} />;
        case 'citation':
          return <Source key={i} part={part} />;
        case 'data':
          return <Widget key={i} name={part.name} payload={part.payload} />;
      }
    });
  }
  ```

  No wire change was needed: the canonical `StreamPart` stream is already strictly ordered, so
  arrival order _is_ the interleave. The buckets keep their exact 1.8 semantics and are not
  deprecated — `content` is still the turn's full text, byte-identical.
  - `parts` is **optional and absent until the first element exists**, so
    `createAssistantTurn`'s shape is unchanged and a `UIMessage` restored from pre-1.9 storage
    stays valid. Render `parts` when present, the buckets otherwise.
  - A `tool` element carries **only** `{ type, toolCallId }` — a reference into `toolCalls`,
    not a copy, because a call's state mutates over the turn's life and two copies would drift.
  - `file` carries the canonical `ImagePart.image` value **verbatim** (bytes stay bytes) plus a
    resolved `mediaType`; `url` is set only when the data is already a renderable `data:` /
    `http(s):` src, because the reducer will not base64-encode a buffer on a render path.

  ### `sealAssistantTurn` — closing a truncated turn

  A tail text/reasoning part stays `state: 'streaming'` until something ends it. `applyUIPart`
  now seals on the wire's terminal parts (`finish`, `error`); `sealAssistantTurn(turn)` is for
  the boundaries only the binding knows about — a user abort, a dropped connection, a turn
  restored from storage. It is idempotent and returns the **same object** when there is nothing
  to seal, so a React binding can call it unconditionally without forcing a re-render.

  A stream that dies with neither `finish` nor `error` and is never sealed deliberately leaves
  the tail `'streaming'` — that is the truth about a truncated turn.

  ### `canonicalFromUI` — the inverse projection

  `uiFromMessages` had no inverse, so a binding could not let an app _replace_ history. It now
  does, and its lossiness is documented rather than hidden:

  **Survives** (when `parts` is present): interleave order, attachments with their media type,
  reasoning `signature`/`encrypted`/`redacted`, `tool_use.providerMetadata` (Gemini's
  `thoughtSignature`, without which the next request 400s), and executed tool calls re-emitted
  as the following `role: 'tool'` message — every `tool_use` must get a `tool_result`.

  **Does not survive**: `system` messages (`uiFromMessages` never renders one, so re-prepend
  your own), `Message.providerMetadata`, consecutive text parts (they merge into one block —
  that merge is what makes the text-only round-trip exact), UI-only state (`runState`, denial,
  pending approvals, `data-*`, citations, step boundaries), and a call still awaiting its
  result, which stays a bare `tool_use`. Without `parts` it is materially worse: bucket order,
  and attachments are gone entirely because `UIMessage.content` is a string.

  ### Multimodal input — `ChatInput`, `userMessageFromInput`, `filesToImageParts`

  ```tsx
  const parts = await partsFromFiles(e.target.files); // @deuz-sdk/react
  await sendMessage({ text: 'what is in these?', parts }); // media FIRST, then the question
  ```

  `ChatInput = string | { text?: string; parts?: Part[] }`. A bare string stays a **plain
  string** `content`, byte-identical to 1.8, so a prompt-cache prefix does not move when a
  caller upgrades. `filesToImageParts` uses Web APIs only (`await blob.arrayBuffer()`), no
  `FileReader` and no `Buffer`, so it behaves identically in a browser and on the edge.
  `partsFromFiles` is the React-side wrapper that also accepts a nullable `FileList`.

  `uiFromMessages` previously **dropped** `ImagePart`s; it now projects each one into a `file`
  element. `content` is unchanged (still text only).

  ### Addressable and transient data parts

  `writeData` takes an optional third argument:

  ```ts
  const { response, writeData } = createDeuzStream(result);
  writeData('status', 'searching…', { id: 'search' }); // one entry, reconciled
  writeData('status', 'found 12 results', { id: 'search' }); // replaces it, in place
  writeData('progress', 0.4, { transient: true }); // never journaled
  ```

  - **`id`** makes an entry addressable: a re-write of the same `(name, id)` replaces it _at its
    original position_ in `dataParts` and in `parts`, so a live status widget is one entry
    instead of three and does not jump to the bottom on every update. The **wire stays strictly
    append-only** — every write is its own frame carrying the id, and last-write-wins is the
    client's job. Collapsing server-side would have to mutate a record under a `seq` a client
    may already hold. Omit `id` for the exact 1.7/1.8 append-only behaviour.
  - **`transient`** emits on the wire but does not journal to the `store`, and is **off-seq**:
    no SSE `id:` line, so it can never move a resume cursor past an event that was never
    stored. Consequence to design for: a reconnecting client does not receive the transient
    frames it missed — only write state you are happy to lose.

  ### Approval denial is distinguishable from a thrown tool

  `ToolStatePart` and the wire's `tool-state` part gained optional `denied` / `deniedReason`,
  which `applyUIPart` folds onto `UIToolCall` and `useChat` surfaces. Without them a declined
  call renders as "getWeather failed" — the wrong last frame for the approval flow.

  Carried as **optional fields, not a new state**: `UIToolCall.state` is still exactly
  `'call' | 'result' | 'approval-requested'` and `ToolRunState` still has six members, because
  consumers switch on both exhaustively. `deniedReason` is redacted on the way out (it can be
  echoed from the client's own verdict string).

  > **Scope**: this ships the _plumbing_ (canonical type → wire → reducer → hook). The built-in
  > approval loop does not set `denied` yet, so today the fields populate only for an app that
  > emits its own `tool-state` part; a denial from `approveToolCall` / `approvalResponses` still
  > arrives as a plain tool error.

  ### Request validation — `validateChatRequest` / `parseDeuzChatRequest`

  New on `@deuz-sdk/core/chat` and `@deuz-sdk/core/edge`. A signed approval token proves a
  _verdict_ is genuine; it says nothing about the `messages` array around it. This closes the
  holes that leaves open, and **never repairs** — every failure is a rejection, so nothing is
  silently filtered:

  ```ts
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
  const { messages, chatId, approvalResponses } = parsed.request;
  ```

  Defaults: `rejectSystemRole: true` (an injected system turn is the live vector),
  `rejectToolResults: true` (forged `tool_result` parts _and_ `role: 'tool'` turns — smuggling
  one into a `role: 'user'` turn is caught at the part level too), `rejectAssistantTurns: false`
  (regenerate and edit-and-resend legitimately replay them), `maxMessages: 1000`,
  `maxTextBytes: 100_000` UTF-8 bytes per message with image/PDF payloads excluded.

  **Client tools need `rejectToolResults: false`** — `useChat`'s `onToolCall` round-trip POSTs a
  `role: 'tool'` message. Understand what that accepts: the validator cannot tell a real client
  tool result from a forged one, because the same client authored the assistant turn it pairs
  with. The only real fix is to persist history server-side and treat the client's copy as a
  rendering cache.

  Issue strings are bounded and secret-safe: only a bad `role` and a bad part `type` are ever
  echoed, each redacted _then_ truncated to 32 chars so truncation cannot split a secret
  pattern and leak its head. `chatId` and approval `token` values are reported by type only.
  `parseDeuzChatRequest` is the throwing variant (`InvalidRequestError`, status 400).
  `request.rest` is deliberately typed `Record<string, unknown>` — unvalidated passthrough; read
  the fields you know by name, never spread it into call options.

  ### `useChat` state is writable

  Four new methods over a **single state cell** holding the `{ ui, canonical }` pair, so the two
  views can no longer drift. Replacement is always wholesale into new arrays; nothing is spliced.

  ```tsx
  const { history, setHistory, setMessages, addToolResult, clearError, pendingToolCalls } = useChat(
    { api },
  );

  setMessages((prev) => prev.filter((m) => m.id !== id)); // delete a turn; the next POST reflects it
  setHistory({ ui: [], canonical: [{ role: 'system', content: SYS }] }); // switch chats
  ```

  - `history` exposes the pair the hook already holds exactly, so persisting a chat does not
    have to go through the lossy `canonicalFromUI`. Its identity is stable until a view changes.
  - `addToolResult({ toolCallId, output })` answers a **parked** client tool from outside the
    hook. A turn producing client tool calls with no `onToolCall` executor now parks —
    `pendingToolCalls` fills and `status` goes idle — instead of abandoning the round-trip and
    leaving a `tool_use` with no `tool_result`. An unknown `toolCallId` is a no-op, because an
    orphan `tool_result` 400s Anthropic.
  - `setHistory` / `setMessages` **drop pending approvals and parked tool calls**: they were
    anchored to the transcript that was just replaced. They do not reset the turn readouts
    (cost, citations, …) — the next turn does, exactly as `sendMessage` already did.
  - The streaming turn is now located in `ui` **by id** rather than by overwriting the trailing
    element, so a mid-stream `setMessages` can no longer have its result clobbered.
  - `initialMessages` is still read once at mount and deliberately not re-adopted when the prop
    changes (apps pass an inline array literal, so a new identity arrives every render).
    `setHistory` is the escape hatch — the same rule and remedy as React's own `useState`.

  ### One React commit per wire part, and optional coalescing

  `syncTurn` published up to **seven** `setState` calls per folded part; it now builds one
  snapshot and publishes it once. Values are unchanged, including the non-obvious one: `cost`
  stays cumulative across turns while `dataParts`/`citations`/`plan`/`activity`/`verifications`/
  `steps`/`usage`/`finishReason` stay turn-scoped.

  `throttleMs` (on both `useChat` and `useObject`, default `0` = 1.8 behaviour) coalesces
  commits on the trailing edge and **always flushes** at a terminal boundary — stream end,
  error, abort, or an external tool result — so the final text or the completed object can never
  be lost to a throttle window. `useObject.submit` also clears the previous object immediately,
  never coalesced.

  ### Automatic resume, and a caught-up endpoint is a no-op

  `resume.auto` fires **once per mounted hook** (a ref guard survives StrictMode's
  mount→unmount→mount) and `resume.cursor` is an injectable `{ load, save }` adapter — no
  `localStorage` is hardcoded, and a throwing adapter cannot kill a live stream.
  - A **failing auto attempt is silent**: no `error`, no `status: 'error'`, no `onError`. The
    user did not ask for it, and every cold load of an app whose resume endpoint answers 404
    would otherwise paint a permanent error. `reconnect()` called by hand keeps 1.8's exact
    error semantics.
  - A resume that folds **zero** parts (a caught-up endpoint answering `[DONE]` immediately) now
    changes nothing at all. 1.8 pre-pushed the assistant bubble before reading and left a
    permanently empty one on screen.

  ### Also in `useChat`

  `onData` fires once per `data-{name}` frame and receives the **raw** frame, so a caller
  observes every write even where `dataParts` reconciles them down to one entry (a throw from
  the callback is swallowed — a consumer callback is not a transport error).
  `steps`, `verifications` and each message's ordered `parts` are surfaced; `dataParts` is
  widened to `Array<{ name: string; id?: string; payload: unknown }>`. `stop()` and a stream
  that ends without `finish` now call `sealAssistantTurn`, so a truncated turn stops rendering
  as still-streaming. `useObject` gains `onHttpError`, forwarded verbatim to `readDeuzStream`.

  ### Other behaviour changes worth knowing
  - `applyUIPart` now handles `step-start`, which it previously ignored. Because the streaming
    loop pushes one at the top of every iteration, `parts[0]` of a real streamed turn is
    normally a `step-start` — a renderer over `parts` **must** have a case for it.
  - A `citation` element in `parts` is the _same object_ already pushed into `turn.citations`
    (one object, no drift).
  - `assistantMessageFromTurn` now builds its `tool_use` parts through the shared constructor
    that echoes `UIToolCall.providerMetadata`. No behaviour change today: the UI wire carries no
    provider metadata, so a streamed turn never has that field.
  - The wire's v1 output is unchanged in every byte. Both new `tool-state` fields and the
    data-part `id` ride carriers that v1 already drops wholesale.

- Enterprise gate-openers: a reusable agent value, an OpenTelemetry bridge, Vertex service-account auth, a run-report viewer, and the documentation 1.9 was missing.

  Everything here is additive. Three new subpaths (`./agent`, `./otel`, `./vertex/node`), one new optional
  peer, and no change to any existing behaviour.

  ### `createAgent` — define an agent once, as a value

  Every call site used to re-spread `{ model, instructions, tools, maxSteps, stopWhen, verifyStep, … }` by
  hand, and they drifted. What was missing was never a class — it was a reusable **value**.

  ```ts
  import { createAgent } from '@deuz-sdk/core/agent';

  const support = createAgent({
    name: 'support',
    model: anthropic('claude-opus-4-8'),
    instructions: 'Be terse. Cite the doc you used.',
    tools: { search },
    maxSteps: 6,
  });

  const { text } = await support.generateText({ prompt: 'How do I rotate a key?' });
  const stream = support.streamChat({ messages }); // synchronous, never throws (G2)
  const cheap = support.with({ model: haiku }); // a NEW frozen agent; the original is untouched
  const asSubAgent = support.asTool({ description: 'Ask the support agent.' });
  ```

  It is a frozen plain object of closures — `Object.getPrototypeOf(agent) === Object.prototype`, no `new`, no
  prototype chain, no new runtime. `createAgent` keeps a **copy** of your def, so mutating the object you
  passed in afterwards changes nothing.

  One merge rule, and it is worth knowing: per-call options **replace** the def's field rather than merging
  into it, and an explicitly-`undefined` per-call value **unsets** it. So
  `agent.generateText({ prompt, tools: { other } })` sends only `other`, and
  `agent.generateText({ prompt, tools: undefined, maxSteps: undefined })` is a tool-less single-turn call from
  an otherwise agentic agent.

  `asTool()` builds on the existing `agentTool`, whose behaviour is unchanged — its tests pass untouched.

  ### `@deuz-sdk/core/otel` — the OpenTelemetry last mile

  The `deps.tracer` seam and the versioned `ObserveEvent` protocol already existed; what was missing was the
  bridge to a real collector. "Send Deuz traces to our collector" was a task, not a config line.

  ```ts
  import { createOtelTracer, otelReady } from '@deuz-sdk/core/otel';

  const tracer = createOtelTracer(); // GenAI semconv names + gen_ai.* attributes
  export const ai = createClient({ deps: { tracer } });
  await otelReady(tracer); // surfaces a missing peer instead of silently emitting nothing
  ```

  - `createOtelTracer(options?)` implements the `Tracer` seam; the internal bridge stays the single span source.
  - `createOtelObserver(options?)` consumes the `ObserveEvent` protocol directly and emits exact per-request
    spans (`invoke_agent`, `chat {model}`, `execute_tool {name}`, `embeddings {model}`). Pick **one** of the
    two — attaching both double-spans a run.
  - `otelReady(target)` exists because `startSpan()` is synchronous while the peer import is not. Without it a
    missing peer is invisible.
  - `@opentelemetry/api` is an **optional peer**, imported lazily through a variable specifier: no runtime
    dependency, no bundled shim, and none of its types appear in a Deuz signature.

  Two deliberate differences from the ecosystem default: there is **no global registration** (deps are
  threaded through `createClient`, so nothing is ambient and tests stay deterministic), and **content capture
  is opt-in** (`captureContent: true`) and always passes the redaction barrier. Prompts do not start flowing
  to a collector because you attached a tracer.

  ### Vertex: service-account credentials, not a token that dies in an hour

  `VertexSettings.accessToken` was the only credential field — a `gcloud auth print-access-token` value that
  expires in ~1h with no refresh path. Getting past that meant writing RS256 JWT signing yourself.

  ```ts
  // Edge-safe: WebCrypto, and clock + fetch are REQUIRED so nothing is ambient.
  import { createServiceAccountKeyProvider } from '@deuz-sdk/core/vertex';
  // Node: Application Default Credentials — explicit keyFile, then
  // GOOGLE_APPLICATION_CREDENTIALS, then the GCE/Cloud Run metadata server.
  import { createAdcKeyProvider } from '@deuz-sdk/core/vertex/node';
  ```

  Both return a `KeyProvider`, which is the highest-precedence link in the existing key chain — no new
  resolution path. The token is cached until it nears expiry and keyed by `(client_email, scopes)`, so two
  service accounts in one process can never share one. A failed exchange raises `AuthenticationError`
  reporting the **status**, never the request body; the private key never reaches a log, error, span or event.

  `createAdcKeyProvider` is the one documented place Deuz reads environment variables, because ADC is defined
  in terms of them. The core still never does.

  ### `renderRunReport` — a viewer for the protocol that already shipped

  Debugging "why did step 4 call that tool" meant writing your own reducer over a JSONL file.

  ```ts
  import { renderRunReport } from '@deuz-sdk/core/observe';
  import { writeRunReport } from '@deuz-sdk/core/observe/node';

  const html = renderRunReport(memoryObserver.latestRun()!);
  await writeRunReport({ from: 'runs.jsonl', to: 'run.html' });
  ```

  One self-contained HTML document: inline CSS and JS, **no external fetch of any kind**, opens from a
  `file://` URL. It renders the nested run/step/tool/sub-agent timeline, `summarizeRun`'s stats, timings and
  errors. It is a pure string builder — no DOM, no clock, no randomness — so the same events produce the same
  bytes.

  Two properties it is built around, because a debugging tool that renders model output is a security surface:
  every payload is escaped for both HTML and inline-script contexts (no `<a>`, `href` or `src` is emitted at
  all, so a `javascript:` URL in a tool result can only ever be inert text), and everything passes
  `redactForObservation` first and is bounded second — so truncation can never leave a decodable secret prefix.

  Nothing records by default and nothing listens on a port. `writeRunReport` has no default output path and
  throws if given neither `events` nor `from`.

  ### Documentation

  The Vercel AI SDK migration page was mapping against names two majors old and closed with "everything else
  has a direct equivalent", which was not true. It is rewritten, with an honest
  "not implemented / deliberately different" section. New pages cover prompts and timeouts, file/PDF input,
  request validation and `createAgent`, plus a `whats-new-1-9` reference with a **"Declared but inert"**
  section. A second installable agent skill, `migrate-from-ai-sdk`, ports an app mechanically:

  ```sh
  npx skills add Deuz-AI/Deuz-SDK --skill migrate-from-ai-sdk
  ```

  Two corrections worth calling out because they were actively wrong: the tools docs defined a client tool as
  "any tool without `execute`" (since 1.9 an _unregistered_ name self-heals into an `is_error` tool_result — a
  client tool is a key **present** in `tools` with no `execute`), and every route example showed
  `const { messages } = await req.json()`, the exact pattern `validateChatRequest` exists to fix.

  ### Ratchet coverage

  `./chat`, `./ui`, `./otel` and `./observe` now have bundle-size budgets. Sprint 3 shipped ~10 KB with zero
  coverage because its surfaces were unmeasured; `renderRunReport` adds ~6.9 KB gzip of template, so it is
  measured now. It is deliberately **not** re-exported from `@deuz-sdk/core/edge` — it is legal there, but that
  barrel exists to keep worker bundles small, and `@deuz-sdk/core/observe` already works in every runtime.

## 1.8.0

### Minor Changes

- b10c71b: 1.8.0 — "Autonomous Agent Runtime": the primitives to build a Manus-style, fully autonomous system on an edge-safe, zero-runtime-dependency core. Every heavy capability is a seam with a Node-only reference adapter, so the core stays pure and the isolation/browser/host concerns are pluggable.
  - **Workspace (`./workspace`, `./workspace/node`)** — a path-addressed externalized-memory seam (`Workspace`) with an in-memory reference, a sandboxed-directory Node backend (`createFileWorkspace`), and a `ToolSet` (`createWorkspaceTools`). An autonomous run persists `plan.json`, notes, and artifacts here so progress survives compaction, a durable checkpoint, or a restart.
  - **Compute / CodeAct (`./compute`, `./compute/node`)** — a `ComputeSandbox` seam (`runCode`/`runShell`) with `codeActTool`/`shellTool` wrappers and a `node:child_process` reference sandbox (allow-lists, output caps, timeout + abort kill). The model acts by writing executable code; a thrown run self-heals into an is_error the loop feeds back — CodeAct with the self-correction loop. Docker/E2B/Daytona/Fly implement the same two methods.
  - **Planner → Executor → Verifier (`./autonomy`, `verifyStep`)** — `planTasks` decomposes a goal into an ordered `TaskList` (pure reducers included; persist as `plan.json`). A new `verifyStep` loop hook (both loops) runs at every natural completion: a rejection feeds feedback back as a user turn and re-drives the loop (bounded by `maxVerifyAttempts`), recording `providerMetadata.deuz.verified`; streaming emits a `verify` part. `bestOfN`, `selfConsistency`, and `parallelAgents` (Wide Research fan-out) round out verified/parallel generation.
  - **Background runs (`./runtime`, `./runtime/node`)** — a `RunStore` metadata seam over the durable `SessionStore` (`createRunManager`, in-memory + JSONL backends, `pollStaleRuns` for a worker to continue crashed runs). Live-view emitters `emitPlanUpdate`/`emitActivity` push new `plan-update`/`activity` stream parts (surfaced through the UI wire, the chat engine, and `useChat`) so a UI can render a to-do panel and a "Computer" activity feed. `createSteeringController` injects a mid-run user message at the next step boundary.
  - **Browser control (`./browser`, `./browser/node`)** — a `BrowserController` seam with `createBrowserTools` (navigate/click/type/readText/screenshot; screenshots save to a `Workspace`) and a Playwright reference adapter (optional peer, lazily imported).
  - **Providers + model router (`./providers`)** — the previously-internal OpenAI-compatible factories (Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras, Fireworks, Moonshot/Kimi, Qwen, GLM, MiniMax) are now published, plus `createProviderRegistry` for `'groq:llama-4-maverick'`-style string lookup (a unified model router with zero network).
  - **Testing (`./testing`)** — the deterministic `createMockModel` + `runEval` + golden-replay fixtures are now a published subpath, so consumers can test agents deterministically (the evals parity).

  All additive and edge-safe by construction: new heavy code lives only under `*/node` subpaths, the canonical stream/UI wire gains open-union parts (v1 clients unaffected), and `playwright` joins the optional peers.

- b10c71b: Add dedicated Azure OpenAI (`createAzure`) and Amazon Bedrock Mantle (`createBedrock`) provider factories, plus a `createKimi` alias for Moonshot. Document Mistral / DeepSeek / Qwen / Kimi on the compat providers page.

## 1.7.1

### Patch Changes

- Harden chat and memory correctness without changing the public API. Chat-scoped memories are now isolated consistently across in-memory and Markdown stores, suspended buffered runs settle their memory result, and resumed tool calls emit complete lifecycle state.

  Chat persistence now preserves the caller's unmodified conversation instead of compaction or `prepareStep` rewrites, while buffered `response.messages` includes the final text-only assistant turn exactly once.

## 1.7.0

### Minor Changes

- 749cc45: Built-in cross-session chat memory (D1) — `memory: { seams, scope }` on any call wires the existing mem0-style pipeline straight into the chat loop, with no third-party service:
  - **Recall** — before the first model step, relevant memories for the latest user message are retrieved and spliced into the system context (topK/header configurable, `recall: false` to disable). Best-effort: a failing store degrades to a bare call.
  - **Extract** — after the run completes, the extract→reconcile→apply pass runs WITHOUT blocking the response; `result.memory` resolves with the applied mutations (never rejects — await it on serverless). Suspended/errored turns skip extraction.
  - Scope is mandatory (`{ userId, chatId, … }`, mem0 rule) and consistent with `ChatStore` records. Absent option = zero extra work and byte-identical behavior.
  - AI SDK has no built-in memory (`@ai-sdk/memory` does not exist; their docs point to Mem0/Letta or "build your own") — Deuz ships the whole loop in-library.
  - Deliberate gzip budget raise for the 1.7 loop feature set (core 31 kB → 34 kB, edge 28 kB → 31 kB), with static named imports keeping the memory pull tree-shaken to the three pipeline functions.

- 566d7af: Chat persistence and the framework-agnostic chat engine (P2 + P6 core) — new `@deuz-sdk/core/chat` subpath:
  - **`ChatStore`** — a two-method (`saveChat`/`loadChat`) persistence seam with mandatory scope (aligned with the memory scope model; `MemoryScope` gains `chatId`). Set `chat: { store, chatId, scope }` on any call and the loop auto-persists the FULL immutable history at terminal boundaries (completion, approval suspension, even mid-stream errors) — best-effort, a failing store never kills a run. Tool-less calls route through the loop too, so every chat shape persists uniformly. `createInMemoryChatStore()` ships in core; a JSONL file store ships at `./chat/node` (binary parts survive via the `$deuzBytes` codec — `serializeChatRecord`/`deserializeChatRecord` exported for custom adapters).
  - **Pure chat engine** — the state logic `useChat` needs, extracted as pure functions: `applyUIPart` (the per-turn reducer folding wire parts into a render-friendly `UIMessage`, including 1.7's cost/budget/data/citation/tool-state parts), `assistantMessageFromTurn` + `clientToolResultMessage` (canonical reconstruction), and `uiFromMessages` (render a loaded chat).
  - **Branching** — `dropTrailingAssistant` (regenerate) and `branchBeforeUserMessage` (edit-and-resend) cut the UI and canonical views together by user-turn ordinal; immutable history makes a branch a plain prefix. `ChatRecord.parentId` records fork lineage.
  - Everything is edge-safe with zero runtime imports and re-exported from `./edge`.

- a0ab6f0: Mid-conversation cross-provider failover (D6) — possible in-library ONLY because the whole history is canonical; the next provider receives the identical request the failed one got:
  - **`fallbackModels: [model2, model3]`** on `streamChat`/`generateText` (or the composable **`withFallback`** middleware): when the primary fails BEFORE its first content byte — network error, timeout, 5xx/529 after retries, or an OPEN circuit breaker — the call hops to the next model. Streaming semantics stay strict: after the first content part, mid-stream errors remain final. The winner carries `providerMetadata.deuz.failedOver = { from, to, reason }`; `onFallback` gives telemetry per hop.
  - **The circuit breaker is now real** — the long-dormant `deps.breakerStore` seam is wired into the inference pump: `BREAKER_THRESHOLD` consecutive provider-health failures per `provider:model` open it for `BREAKER_COOLDOWN_MS`; open = instant `BreakerOpenError` (new, exported) with zero network — which failover treats as an immediate hop signal. First byte resets it. Per-client store (G11) preserved.
  - Deterministic acceptance goldens: provider-A 529 → provider-B completes with the same canonical history across DIFFERENT wires (Anthropic → OpenAI); breaker opens/fails fast/resets; post-first-content errors never hop. AI SDK tracks this as open feature request vercel/ai#9950 — automatic failover exists only in their hosted Gateway.
  - Final deliberate 1.7 bundle ceilings (core 120 kB raw / 37 kB gzip, edge 110/34) — durable×resumable pulled the wire serializer into the edge surface by design.

- 5ed160a: Durable × resumable together, vendor-free (D5) — `resumeDeuzChatResponse` on `./durable` is ONE endpoint for the whole "unbreakable chatbot" story:
  - Replays the stored wire log from the client's `Last-Event-ID` and keeps tailing while the original producer is still alive (a refreshed tab just re-attaches — the model is never re-driven).
  - If the process DIED mid-run (deploy, crash, serverless freeze — detected by a configurable silence probe over the wire log), it continues the run itself from the last durable checkpoint and pipes the new leg through the same wire log: seq numbering continues, the leg journals itself, and the client sees one gapless stream ending in `[DONE]`.
  - `connectDeuzStream` pointed at this endpoint makes refreshes, network drops and server crashes all look identical to the UI. E2E golden: F5 in the middle of a tool loop → checkpoint continuation completes the turn with monotonic gapless seq ids.
  - Vercel needs the hosted Workflow runtime for durability AND Redis (`resumable-stream`) for resume; Deuz does both in-library over two 2-method seams you can back with anything.

- d11d5e2: Live USD cost streaming (D2) and a conversation budget guardrail (D3) — both in-library, no gateway required:
  - **Live `cost` part** — with a `deps.priceProvider` injected, the streaming loop emits a cumulative `cost` part after every step (`costUsd`, per-step `deltaUsd`, `stepIndex`), and single-turn calls price the finish usage inline. Cumulative totals are cross-leg on durable resumes. Vercel closed this as wontfix (vercel/ai#3932) — Deuz ships it from a verified in-library price catalog.
  - **`cacheSavingsUsd`** — the new optional `PriceProvider.cacheSavings` seam (implemented by `createPriceProvider`, margin-aware, standalone `cacheSavings()` export in `./pricing`) reports the USD saved by prompt-cache reads as its own field.
  - **`budget: { usd?, tokens? }`** — a first-class call option that hard-stops the agentic loop at a spend or token ceiling: sugar over `costExceeds`/`totalTokensExceed` with dedicated `stoppedBy: 'budget.usd' | 'budget.tokens'` markers and a typed `budget-exceeded` stream part before `finish` (render a continue-confirmation directly from it). AI SDK has no built-in budget stop — its docs hardcode prices in a custom condition.
  - `durationExceeds` (written in 1.6, unexported until now) joins the root and edge surfaces.
  - Raw bundle budgets raised deliberately for the 1.7 feature set (core 100 kB → 110 kB, edge 90 kB → 100 kB); the gzip budgets — the delivery-relevant guard — are unchanged.

- 22fbb4d: Resumable UI wire v2 (P1): every SSE event now carries a monotonic `id: <seq>` line, making Deuz streams droppable and resumable with standard `Last-Event-ID` semantics — with no vendor, no Redis requirement, and zero new dependencies.
  - **`StreamStateStore`** — a two-method (`append`/`read`) persistence seam on `@deuz-sdk/core/ui`; pass `{ store, streamId }` to `toDeuzStreamResponse`/`toDeuzObjectStreamResponse` and every emitted event is journaled with its seq (ordered, best-effort — a failing store never kills the response). `createInMemoryStreamStateStore()` ships as the reference implementation; Redis/Supabase adapters are a few lines (see docs).
  - **`resumeDeuzStreamResponse(store, streamId, { lastEventId })`** — server helper that replays from the client's `Last-Event-ID` and keeps tailing a still-live stream, so a refreshed tab reconnects mid-generation and **any number of clients can follow the same stream live**.
  - **`connectDeuzStream(source)`** — fault-tolerant client reader: reconnects with `Last-Event-ID` after a drop, deduplicates replayed events by seq, and yields one gapless part sequence. Object streams (`useObject`) are covered too.
  - **Version negotiation** — wire v2 is additive; v1 clients keep working untouched. An explicit `x-deuz-stream: v1` request header (via `negotiateDeuzStreamVersion(request)`) produces byte-identical pre-1.7 output.
  - `parseSSE` now surfaces `id:` lines (sticky, spec-correct); `sseEvents` test helper accepts `id`.

- 316b338: Typed data parts, tool state machine, and built-in RAG citations on wire v2 (P3):
  - **`createDeuzStream(result)`** — returns `{ response, writeData(name, payload), close() }`: the server injects typed `data-{name}` parts (chart payloads, progress markers, citations) into the SAME SSE response the model streams over — ordered, seq-numbered, journaled to the `StreamStateStore`, replayable like every other part.
  - **Streaming validation (opt-in)** — declare `dataSchemas: { chart: mySchema }` (any Standard Schema: zod/valibot/arktype) and payloads are validated as they stream; invalid ones are dropped with a redacted `error` part while the stream keeps going. Vercel's `validateUIMessages` is a manual after-the-fact call — Deuz validates on the wire.
  - **Tool state machine** — the streaming loop now emits a `tool-state` part at every lifecycle transition (`input-streaming → input-complete → awaiting-approval | executing → complete | error`), so UIs render live tool status without re-deriving it from part ordering.
  - **Built-in citations** — `citationsFromHits(hits)` (`./rag`) maps retrieve/rerank results to canonical `citation` parts (`chunkIndex` stays aligned with `hybridRetrieve`'s stable `Chunk.index`).
  - All three part families are v2-only: a negotiated-v1 client never sees them (byte-compat preserved).

### Patch Changes

- b6fa072: Repository restructured as an npm-workspaces monorepo: the package now lives in `packages/core` (published content unchanged — the pack file list is identical to 1.6.1) alongside a new `packages/react` skeleton for the upcoming `@deuz-sdk/react`. Tooling resolves hoisted dev CLIs; release pipeline publishes via `changeset publish`.
- 057ecf2: New package: **`@deuz-sdk/react`** — the React home for Deuz chat UIs (the `@deuz-sdk/core/react` subpath keeps working but is frozen; new features land here). A THIN adapter by design: every chat-state transformation is a call into `@deuz-sdk/core/chat`'s pure engine; this package only binds it to React state.
  - **`useChat` v2** — everything the legacy hook did (client-tool auto round-trips with self-healing, approval pause/auto-resume, stop) plus 1.7: `chatId`, `initialMessages` actually rendered (`uiFromMessages`), live `cost` state (`costUsd` + `cacheSavingsUsd`), `budgetExceeded`, `dataParts`, `citations`, `regenerate()` / `editAndResend(messageId, text)` via the core branch helpers, signed-approval flow (`addToolApprovalResponse` auto-echoes the request's HMAC `token`), and `reconnect()` over `connectDeuzStream` against a resume endpoint.
  - **`useObject`** — ported from the legacy surface.
  - **Headless components (zero styling)** — `ToolApprovalCard` (render-prop; verdicts always carry the signed token) and `CostBadge` (USD + cache savings).
  - Core patch: `applyUIPart` now preserves `token`/`agentPath` on collected approvals.
  - 20 jsdom tests; publint/attw green in all four resolution modes.

## 1.6.1

### Patch Changes

- c4923e0: Observability hardening — two security fixes plus small additive controls.

  **Security fixes:**
  - **Redaction final barrier.** The built-in observation redaction profile now also runs AFTER a custom `redact` hook (and after structural truncation), so a buggy or malicious redactor can no longer reintroduce secrets into events, and truncation can never split a secret into a decodable prefix. Hardened the JWT pattern to catch tokens embedded mid-string.
  - **Composite observers: per-sink capture projection.** `composeObservers` children now each receive only what their OWN `capture` options allow — `captured*` fields are stripped, `error.message` is gated on that child's `capture.errorMessages`, and a child `redact` hook applies only to that child's view. _Behavior change:_ a composed observer with no options no longer receives captured content from its siblings' opt-ins (it now matches a standalone observer's privacy defaults).

  **Additive:**
  - `result.observation?.settled` on `generateText` / `streamChat` / `embed` / `embedMany` results — await it before `observer.close()` to drain async `cost.calculated` enrichments.
  - `createMemoryObserver({ maxBytes })` — total byte budget alongside `maxEvents`, evicting by the existing `overflow` strategy.
  - `deps.tracerMode: 'legacy'` — opt back into the 1.5 flat span topology (one parent-less `invoke` per model call); default stays `'hierarchical'`.

  **Notes:** `eventId` is now derived as `` `${executionId}:${sequence}` `` (one less id draw per event; the format was never part of the contract). Release workflow supports npm trusted publishing (OIDC) alongside `NPM_TOKEN`.

## 1.6.0

### Minor Changes

- 8cfb9f4: v1.6.0 — Observable Runtime

  Deuz-native versioned observation event protocol (`ObserveEvent`, `schemaVersion: 1`): model, agent-step, tool, approval, checkpoint, compaction and sub-agent lifecycle events, injected through the new `Dependencies.observer` seam. Local-first observers (`@deuz-sdk/core/observe`: memory / callback / composite / filter + `summarizeRun`), Node JSONL persistence (`@deuz-sdk/core/observe/node`), deterministic per-run sampling, privacy-first content capture (everything off by default; captured payloads always pass a `[REDACTED]` redaction profile), and async cost enrichment via the existing `priceProvider` seam. Zero runtime dependencies; no hosted service; no OpenTelemetry dependency.

  The legacy tracer seam is now driven by the same events through a bridge that COMPLETES the documented `invoke → step → execute_tool` span hierarchy (previously only flat per-model-call `invoke` spans fired). Span names and attribute keys are unchanged; agentic loops now produce one `invoke` with step/tool children instead of N flat invokes.

  Behavior fix: a tool-call-first response now clears the TTFT timer (previously only text/reasoning deltas did — a tool-first stream could falsely trip the 60s ttft timeout) and counts as first content in `model.first-content`.

  Observers can never affect a run (isolated, never awaited); with no observer the hot path pays a single boolean branch and draws no ids. Bundle budgets were raised once, with measurement: core 86000→100000 raw bytes (measured 97.7KB fully instrumented), edge 76000→90000.

## 1.5.1

### Patch Changes

- **Foundation release gates:** added Linux/Windows + Node 22/24 CI, tag-to-version verification, npm provenance publishing, documentation builds, and a single `release:verify` command shared by local and CI releases.
- **Package and API contracts:** every export target is checked inside the packed artifact and loaded through both ESM and CommonJS; publint/Are the Types Wrong remain mandatory; 26 subpaths and 141 root declarations are protected from accidental removal.
- **Runtime and size regressions:** representative root, `/edge`, and provider consumers must bundle for the browser; consumer bundles have checked raw/gzip budgets with narrow headroom.
- **Stream and provider conformance:** SSE parsing now covers LF, CRLF, bare CR, BOMs, arbitrary UTF-8 chunk boundaries, EOF tails, multiline data, and early cancellation. Anthropic, OpenAI Chat Completions, OpenAI Responses, and Google native share request/stream/usage/error contract tests.
- **Standard errors:** OpenAI-compatible errors retain the actual provider id; exhausted transport failures normalize to `NetworkError`; `isDeuzError` and secret-safe `toJSON()` make cross-realm detection and logging stable.
- **Documentation structure:** compatibility, stream protocol, provider conformance, and release guarantees now live in a dedicated Reference section.

## 1.5.0

### Minor Changes

- **Durable sessions — `session` option + `SessionStore` seam + `AgentCheckpoint`** (new `@deuz-sdk/core/durable` subpath, everything also re-exported from `/edge`; all additive): pass `session: { store, runId? }` on any agentic call and both loops (`generateText` and `streamChat`) save a serializable `AgentCheckpoint` at every **step boundary** — `{ version, runId, stepId: '${runId}#${stepIndex}', stepIndex, status: 'running' | 'suspended' | 'completed', messages, usage, pendingApprovals?, agentPath?, createdAt }`. `messages` is the full immutable history (the loop never mutates prior arrays, so snapshots stay true and prompt-cache prefixes stay byte-stable across legs); `usage` is CUMULATIVE across all resume legs while each leg's _result_ still reports that leg's own cost. The result carries `runId` — `GenerateTextResult.runId`, and **synchronously** on `StreamChatResult.runId`. Persistence is best-effort by contract: a throwing `store.save` logs `deps.logger.error` and the run continues. Single-turn calls (no `tools`) have no step boundaries — no checkpoint, no `runId`; an aborted call deliberately doesn't checkpoint the interrupted step (a checkpoint is only honest at a completed boundary). `SessionStore` is two required methods (`save`/`load`, plus `delete` and optional `list`) over any backend — **no vendor runtime**; `createInMemorySessionStore()` is the reference (latest save wins per runId). For persistent stores, `serializeCheckpoint`/`deserializeCheckpoint` are a binary-part-safe JSON codec: `Uint8Array` values anywhere in the message tree (raw image parts) round-trip as real `Uint8Array`s instead of decaying into index-keyed objects — including Node `Buffer`s, whose own `toJSON` would otherwise preempt the codec (the replacer reads the pre-`toJSON` holder value); `$deuzBytes` is the codec's reserved key, and a garbled lookalike in tool data passes through as plain data instead of throwing out of resume.
- **`resumeFromCheckpoint(store, runId, options)` / `resumeStreamFromCheckpoint`**: load a checkpoint and continue the run — the stored history becomes the messages, the existing settle-on-resume mechanism answers the trailing pending `tool_use` ids from `approvalResponses`, and step indices + cumulative usage continue across legs (budget stops `totalTokensExceed`/`costExceeds` and `prepareStep` see whole-run usage). Resuming a suspended run **without** a verdict for a pending gated call now **denies it by default** (safe side) instead of resending an unanswered `tool_use` to the provider — an explicitly-empty `approvalResponses: []` array activates the same default-deny settle (previously it was ignored). A mid-step crash resumes from the last completed boundary and re-runs that step (the honest recovery unit is one step — documented; keep tool side effects idempotent). `prepareStep` sees **continuing** cross-leg step indices on a resume leg in BOTH loops (loop-symmetry). Documented limits: a resume cannot hand a **client tool** its real output (`ToolApprovalResponse` carries a verdict, not a result — the escape hatch is loading the checkpoint, appending the `tool_result` message yourself, and re-calling with the same `session`), and a durable sub-agent suspending out of a _parallel_ tool batch discards that step's sibling executions (re-run on resume). Unknown `runId`: the buffered resume rejects with the new `CheckpointNotFoundError`; the streaming twin keeps the sync-return contract (G2) and surfaces it as an `error` part + rejected `usage`/`finishReason`, never a synchronous throw.
- **Client-mode approval inside sub-agents** (the 1.4 limitation, removed): when the parent call carries `session`, a gated tool call inside an `agentTool` (with no inherited server-mode approver) no longer returns an is_error — the **child** loop checkpoints itself as suspended under a per-call key (`${parentRunId}::${agentName}#${toolCallId}` — the model-issued tool_use id is stable across legs because it lives in the parent history, so parallel same-name sub-agents never collide), and the parent suspends too, carrying the pending approvals up tagged with the sub-agent path (`ToolApprovalRequest.agentPath` + `agentPath` on the `tool-approval-request` stream part, both additive). Resuming the **parent** with verdicts keyed by the same `approvalId`s re-executes the sub-agent call, which finds its suspended checkpoint, settles its own pending calls from the forwarded verdicts, and continues where it left off — at any nesting depth. A suspended sub-agent's usage still folds into the parent's checkpoint before suspension. Without `session`, the 1.4 contract is unchanged (clear is_error, parent model can react).
- **HMAC-signed approvals — `createApprovalSigner({ secret, clock? })`** (WebCrypto `crypto.subtle`, edge-safe): `sign(request, { runId? })` produces a `v1.<payload>.<mac>` token over the full `ToolApprovalRequest` + optional run binding + `issuedAt`; `verify(token, { maxAgeMs? })` returns the payload on a valid MAC — a forged, tampered, garbled, or expired token is a verdict of `null`, never a thrown exception (a token whose age is ≥ `maxAgeMs` is expired; omit for no expiry; strictly three token segments — trailing garbage is rejected). Signing is loop-based base64 (no spread), so approval payloads carrying large tool inputs (e.g. a write-file body) don't overflow the stack; an empty `secret` throws a `TypeError` at construction instead of surfacing as an unhandled `importKey` rejection. The clock is injectable for deterministic tests; `ToolApprovalRequest.approvalId` was kept distinct from `toolCallId` in 1.3 exactly so this scheme could land additively. Closes the `approvalResponses` trust-boundary gap documented in client-tools: sign pending approvals server-side, verify verdicts on resume, reject forgeries/replays.

## 1.4.0

### Minor Changes

- **Loop hooks — `prepareStep` + `activeTools`** (on `CommonCallOptions`; work in both `generateText` and `streamChat` whenever `tools` is present): `prepareStep(ctx)` runs before every model step, after automatic compaction, and may return `{ messages, activeTools, toolChoice, model }` — `messages` becomes the base history for this and all following steps (doubling as a user-controlled compaction/rewrite hook, including system-prompt edits via the `system`-role message), while `activeTools`/`toolChoice`/`model` apply to that step only. A thrown `prepareStep` fails the call like any caller code — it is never swallowed. Static `activeTools` restricts which tools are sent every step (unknown names warn and are dropped; matching nothing fails open to the full list); `prepareStep`'s `activeTools` overrides it. `prepareStep` is a plain call option on the free functions (no agent class to instantiate) and composes with the automatic compaction below — compaction runs first, `prepareStep` sees the result.
- **Budget stop conditions — `totalTokensExceed` / `costExceeds`** (`StopCondition` factories, exported from root + `/edge` alongside `stepCountIs` / `hasToolCall`, now also exported): stop the loop once cumulative REAL usage or cost — all steps and sub-agents included — crosses a bound, OR-ed into `stopWhen` like any condition and evaluated at the step boundary (never mid-tool-batch). A budget stop never changes `finishReason` (the locked union is untouched); instead it sets `providerMetadata.deuz.stoppedBy: 'totalTokensExceed' | 'costExceeds'` on the result / `finish` part (`GenerateTextResult.providerMetadata` is a new additive field). `costExceeds` needs `deps.priceProvider` — without one it warns once and never fires. Token- and cost-budget bounds are first-class `StopCondition` factories here (alongside `stepCountIs`/`hasToolCall`), and `stoppedBy` reports which bound ended the loop.
- **Automatic layered compaction** (`compaction?: 'auto' | CompactionPolicy` on `CommonCallOptions`; opt-in, off by default, active only inside the agentic loop): three cheapest-first layers — prune old tool results into `[pruned N chars]` stubs, prune old reasoning parts, summarize the oldest unprotected slice into one message — run before a step once estimated context fill crosses a threshold (default 92%), always leaving every system message, the first user message, the last message, and the last `keepRecentSteps` assistant turns untouched. History stays immutable and prefix-stable for prompt-cache hits; a failed summarize logs a warning and skips the layer instead of ending the call; token counts are a calibrated heuristic, not a real tokenizer. Streaming emits a new `compaction` `StreamPart`/UI part per layer that ran; buffered calls log it. Anthropic's native `providerOptions.anthropic.context_management` still works verbatim alongside this. This is automatic, layered, cache-aware context management from one opt-in flag — the alternative is to estimate tokens and prune inside a per-step hook yourself.
- **Sub-agents — `agentTool`** (exported from root + `/edge`; `AgentToolDef` exported type): wraps a `{ model, tools, system, maxSteps, maxDepth, ... }` definition into a `Tool` that runs a nested agentic loop and returns its final text — no new runtime. When the parent streams, the sub-agent's entire canonical stream forwards live as `agentPath`-tagged `sub-agent` parts, rather than surfacing only the final text. The parent's server-mode `approveToolCall` is inherited to every nesting depth as first-class behavior, so a sub-agent's own tool calls stay gated with no extra wiring. Usage folds into the parent total and is tagged with `meta.agentPath`; `maxDepth` (default 2) guards against runaway nesting; the parent `signal` propagates down. Client-mode approval inside a sub-agent isn't supported yet (needs durable suspend/resume — lands in 1.5); a gated sub-agent call with no inherited approver returns a clear is_error instead.

## 1.3.0

### Minor Changes

- **Tool approval flow** — `needsApproval` (locked since 1.0) is wired end-to-end. Server mode: `approveToolCall(call, { messages })` decides inline; denials become an is_error `'Tool call denied.'` result the model can react to (excluded from the runaway error guard). Client mode: without the callback, gated calls break the loop like client tools — `generateText` returns `pendingApprovals`, streaming emits `tool-approval-request` parts — and the next call's `approvalResponses` settles them (approved → execute, denied → is_error + reason, no verdict → denied by default; every `tool_use` id answered). New UI wire parts `tool-approval-request` / `tool-approval-response`.
- **`streamObject`** — streaming structured output with `partialObjectStream: AsyncIterable<DeepPartial<T>>` + validated `object` promise. Same options as `generateObject`; sync return (G2); zero-dep tolerant partial-JSON parser emits only on change. Tool-strategy models buffer a single final emission. NO repair retry (partials can't be un-streamed) — `usage`/`finishReason` still resolve on validation failure. New exports: `streamObject`, `DeepPartial`, `StreamObjectResult` (root + edge; `NoObjectGeneratedError` added to the edge entry).
- **React hooks** (`@deuz-sdk/core/react`; React becomes an OPTIONAL peer `^18 || ^19`): `useChat` — streaming messages over the Deuz wire with automatic client-tool round-trips (`onToolCall`) and tool-approval pauses (`pendingApprovals` + `addToolApprovalResponse` resume via `approvalResponses`) — and `useObject` — streaming `DeepPartial<T>` from the new `object-delta` part. Plain hooks, no JSX, SSR-safe. `createUseChat` (the 1.0 stub) now returns `useChat` instead of throwing.
- **`toDeuzObjectStreamResponse`** (`@deuz-sdk/core/ui`): serialize a `streamObject` result over the Deuz v1 wire as `object-delta` parts (additive union member); failures become redacted `error` parts.
- **MCP extensions** (peer `@modelcontextprotocol/sdk` floor raised to `^1.29.0`): `listResources`/`readResource`/`listPrompts`/`getPrompt` on `McpClient` (auto-paginated, 100-page cap); tool results with `structuredContent` now return that object verbatim (behavior change vs joined text); server `outputSchema` carried on the new additive `Tool.outputSchema` metadata field; `onElicitationRequest` callback handles form AND url elicitation (MCP 2025-11-25) — url mode is consent-only, the URL is never auto-opened.

## 1.2.0

### Minor Changes

- **`providerOptions` escape hatch** (additive): per-provider raw request-body fields on every call — `{ openai: { service_tier: 'flex' } }`, `{ anthropic: { fallbacks: […] } }`, `{ google: { cachedContent } }`. Canonical fields always win; shallow, top-level only.
- **`promptCaching: 'auto' | 'auto-1h'`**: one flag turns on Anthropic's automatic prompt caching (top-level `cache_control`; the API manages the breakpoint). No-op on providers that cache implicitly.
- **Provider-executed web search on 3 wires**: `anthropicWebSearch()` (`web_search_20260318`), `openaiWebSearch()` (Responses hosted tool), `googleSearch()` (grounding). Results/citations stream as canonical `source` parts; `usage.serverToolUses` counts billed invocations; provider tools never break the loop as client tools. Chat Completions has no hosted tools — entries are dropped there.
- **Responses stateless round-trips fixed**: with tools + reasoning the wire now sends `include: ["reasoning.encrypted_content"]` + `store: false`, replays encrypted reasoning items verbatim ahead of their `function_call` on later steps, and preserves the `phase` field on replayed assistant messages via `Message.providerMetadata` (additive field).
- `ReasoningDeltaPart.encrypted` (additive) marks opaque encrypted reasoning payloads on `fullStream`.

## 1.1.1

### Minor Changes

- **Anthropic effort wire fix:** on Claude Opus 4.7+, Sonnet 5 and Fable 5, `effort` now rides `output_config.effort` — the previous `thinking.budget_tokens` path returns HTTP 400 on those models. Legacy models keep the budget mapping (plus new `xhigh`/`max` → 48k).
- **`effort` union widened** (additive input change): `'xhigh'` and `'max'` levels. OpenAI clamps `max` → `xhigh`; Gemini clamps both to `high` (level wire) or 32,768 budget (2.5 wire); the Responses wire now sends `'none'` verbatim (a real OpenAI value).
- **`samplingRestrictions` on Anthropic rows:** Opus 4.7/4.8, Sonnet 5 and Fable 5 reject non-default `temperature`/`top_p` — the adapter no longer sends them there.
- **Catalog refresh (2026-07, price-page verified):** new registry rows `claude-fable-5`, `claude-sonnet-5`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gemini-3.1-pro-preview` (both wires), `gemini-3.1-flash-lite`, `gemini-embedding-2`; `gpt-5.5`/`gpt-5.5-pro` gain reasoning + 1.05M context. Pricing corrections: `gpt-5.5` $5/$30, `gpt-5.5-pro` $30/$180, `grok-4.3` $1.25/$2.50, `gemini-3.5-flash` $1.50/$9; new GPT-5.4-family and Claude 5 rows; retired `text-embedding-004` and `gemini-3-pro-preview` removed.
- **Long-context pricing tiers:** `ModelPrice.over200k` — `priceUsage` switches rates when prompt tokens exceed 200k (Gemini 3.1 Pro: $4/$18).
- **Gemini thinking levels fixed:** `medium` no longer collapses to `low` on Gemini 3.x flash-tier models; pro tier stays low/high-only.
- **Anthropic usage extensions:** `usage.reasoningTokens` now populated from `output_tokens_details.thinking_tokens`; server-side fallback/compaction `usage.iterations[]` are summed so billing covers every attempt.
- **`FinishStreamPart.providerMetadata`** (additive): Anthropic refusal `stop_details` surfaces as `providerMetadata.anthropic.stop_details` (finish reason stays `content_filter`).

## 0.1.0

### Minor Changes

- Initial public release. Pure, web-first, multi-provider AI SDK (Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex, Yunwu) with zero runtime dependencies and an ESM+CJS dual build. Ships a canonical streaming + tool-loop core, structured output, memory, RAG, skills, MCP, media generation, middleware, and a versioned Deuz UI wire.

## 0.0.0

- Scaffolding (Faz 0): tooling (tsup dual ESM/CJS + dts, vitest, ESLint edge-safety, Prettier, changesets), publish hygiene (subpath exports, publint/attw gate, MIT), and the locked 1.0 public surface (`streamChat`/`generateText`/`generateObject` free functions, `createClient`, provider factories, `Message`/`Part`/`Usage`/`StreamPart`/`CommonCallOptions` types, `DeuzError` base). Methods throw `NotImplementedError` until Faz 1.
