# @deuz-sdk/core

## 2.4.0

### Minor Changes

- 7f5654b: **A V3 run can now charge the RAG context source's query embedding to its own ledger.** Before this, the embedding that a `createRagContextSource` query made inside a V3 run was never charged to the run. The compiler now gives every source query `accounting` when a V3 run compiles the step. It carries the run's execution context and a request id unique to the query. `ContextSourceRequest` gains `accounting` and `onWarning`. The RAG source passes them to `retrieve` as a new fourth argument, `charge`. Spread it into the options of `retrieve` or `hybridRetrieve`, for example `retrieve: (query, topK, signal, charge) => hybridRetrieve(query, deps, { topK, ...charge })`. The embedding is then reserved on the run's ledger before the call. An accounted embedder (`defineAccountedEmbedder`) settles its reported usage. An embedder that reports no usage stays held as unaccounted, never free, with one `unaccounted-usage` warning per run. The supervisor reads these charges through its watermark like any other ledger entry. Outside a run, and with a `retrieve` that ignores `charge`, nothing changes: `retrieve` is still called with three arguments and nothing is charged.

  **`ChatSnapshotV1` and `ChatSnapshotGateV1` are now exported from `@deuz-sdk/core/chat` and `@deuz-sdk/core/ui`.** Both are type only. A server can now store, check or build the snapshot that `useChat` restores with `initialSnapshot` without importing the React package. `@deuz-sdk/react` still keeps its own copy, because its core peer range is `^2.0.0`. A type test checks that the two copies stay identical.

  **`pruneOccurrences` now accepts `olderThan`, the name the 2.4 spec uses.** `GoalRuntimeStore.pruneOccurrences({ olderThan })` deletes the same occurrence records as `pruneOccurrences({ before })`. The cut is exclusive in both cases, and `scope` works the same way. The in-memory, SQLite and PostgreSQL stores all accept it. Pass exactly one of the two: both, or neither, throws a `TypeError`, as other malformed retention options already do. The new option type is `GoalRuntimeOccurrencePruneOptions`. The other retention calls still take `before`.

  **Trusted tools for memory extraction are named in `extraction.trustedTools`. A tool definition has no trust flag.** Spec §2.1 describes the host marking a tool with `memorySource: 'trusted'`. 2.4 does not add that field to tool definitions. Instead, the host lists the tool names in the extraction policy's `trustedTools`, and each tool result is matched by its tool name. This is a recorded deviation from the spec, and the behaviour is unchanged. By default, extraction reads user messages, host input and the results of the listed tools. It reads the results of every other tool (MCP, browser, web) only with `allowExternal`, and stores them with source kind `'external'`. The `MemoryExtractionPolicy` JSDoc used to name a `memorySource: 'trusted'` mark that nothing reads. It now describes `trustedTools`.

- b898948: A versioned-memory `forget` now reaches the stored copies of the forgotten record in the V3 runs that point to a redacted package, not only the compiled context packages. When `redactForgotten(event)` redacts a package, the store also rewrites the runs that point to it: each copy of that package's retrieval block (the exact `<deuz_context pass="P" step="S">` message the compiler appended) that holds a forgotten record, in the run's history, in every checkpoint and in the stored result's messages, a terminal run's `result.messages` included, becomes a stand-in that keeps the block's opening marker and holds no record. The message count, roles and order stay the same. A user's own message that only opens with such a marker is not a block and stays as it is, and so does an overflow retry's block, which carries its first attempt's marker but no longer holds the forgotten record. The rewrite happens in place: the run's revision and its last-save time do not change, so it does not move the run's retention, and a repeated forget changes nothing. A run saved after the forget is stored the same way, so a leg that was running during the forget cannot write the block back with its terminal save. A resumed run still finds the marker, drops the block and compiles that step again with refresh `'redacted'`, as before. The Postgres store reads the package state inside its SERIALIZABLE transaction, so a save that races the forget is retried. This applies to `createInMemoryAgentRunStoreV3`, `createSqliteAgentRunStoreV3` and `createPostgresAgentRunStoreV3`.

  Known limits of the redaction: a leg that is running when the forget lands keeps the block in memory and can still send it until the leg ends or the run is resumed. A retrieval block that a run received in its input messages, for example a previous run's `result.messages` passed on to `runAgent({ messages })`, is not that run's copy: the forget does not redact it in that run's record. Continue a conversation from the chat projection or the transcript, which carry no retrieval blocks, instead. Text the model wrote from a block (its answers, `result.text`, a compaction summary) and the results of the versioned memory tools (`memory_recall` output in tool messages, the transcript and a chat store) are not retrieval blocks and are left as they are. `forget` never touches chats, the transcript index or host files.

  Retention stays explicit for every 2.4 store: no store deletes anything in the background, and every cutoff is exclusive, so a record stamped exactly at the cutoff stays. `ProcessOperationStore.prune` now refuses a malformed `terminalBefore` with a `TypeError`, and `ConditionalChatStore.pruneTombstones` refuses a malformed `before` with `InvalidRequestError`, both before deleting anything. Before, a missing or `NaN` cutoff pruned nothing or failed inside the database driver. The in-memory, SQLite and Postgres versioned memory stores now log the same `pruneOperations` warning, with `{ count, olderThan }`.

  `DEFAULT_DURABLE_STREAM_RETAIN_MS` from `@deuz-sdk/core/ui` (24 hours) is the default retention for terminal durable streams. Prune with `store.prune({ terminalBefore: Date.now() - DEFAULT_DURABLE_STREAM_RETAIN_MS })`, for example from a durable schedule; the cutoff is compared on the store's clock.

- ec58811: Versioned memory and durable scheduler fixes.
  - Automatic extraction (`MemorySession.extract`) never reads the SDK's own turns in a transcript, under any policy: a stable-prefix memory recall block, a compaction summary and a tool-set change notice are neither host nor user input, and a recall block or summary can carry external content.
  - A forget is an operation in every versioned memory store: it leaves a content-free receipt (`entries: []`) for its operation id and moves the scope revision even when it deleted nothing, a repeated forget id replays, and a forget or commit that reuses another operation's id throws `OperationConflictError`. The SQLite and PostgreSQL stores now do what the in-memory store did.
  - `MemoryForgetEvent` gains the optional `alreadyForgotten: true`: the record had been forgotten in this scope before (a retried forget, or a replayed operation id), and `revisions: []` then stands for every revision. `session.forget` calls the `onForget` listeners for it too, so a retry completes a context-package redaction that a crash between the forget and its listeners, or a failed listener, cut short. An unknown id, or one forgotten in another scope, still triggers nothing.
  - The SQLite versioned memory store runs its FTS5 index with `secure-delete` (SQLite 3.42 and later), so the tokens of a forgotten or pruned revision leave the index pages at once instead of staying behind a delete marker until a merge. Forget is still a logical delete for the file as a whole: pages SQLite frees keep their bytes unless the host sets `PRAGMA secure_delete` or runs `VACUUM`.
  - `DurableScheduler.put` with the stored goal, spec and event (a host ensuring its schedules at every boot) changes nothing: no new revision and no new boundary, so occurrences missed while the host was down are still caught up under `catchUp: 'latest'` and `'all'`.
  - `GoalRuntimeStore.schedules.put` takes only the definition from its input (`scheduleId`, `scope`, `goalId`, `spec`, `event`). A whole stored schedule passed as the input no longer sets its status, cursor, `scanTo` or times, so a put cannot rewind the cursor, resume a paused schedule or cancel one without disposing its pending deliveries.

- 9418f72: `createContextCompiler` (preview) keeps placed context through compaction. When a compaction removes an earlier `<deuz_context>` block, the compiler places its entries again in the next package, and an overflow retry does the same for blocks its own compaction removed. If mandatory content, such as a loaded skill body, no longer fits on the retry, the retry throws `ContextBudgetExceededError` instead of leaving that content out. Only a record's latest placement comes back, so an older revision is never appended after a newer one. Each placed entry in the compiler state records its block's step (`ContextPlacedEntry.step`), and the compiler counts an entry as placed only while that exact block is still in the messages. A block that places entries again keeps the current pass number, so the pass alone cannot identify it. A compiler restored from a checkpoint does not have the candidates the earlier process retrieved. If a compaction removes a mandatory entry's block (`ContextPlacedEntry.mandatory`), the restored compiler asks that entry's source for it again, even past `refresh.maxPasses` and without spending a pass. Optional entries still wait for the next refresh.
- c05a9c7: Docker sandbox and process runner refinements (`@deuz-sdk/core/compute/docker`, preview):
  - An abort that fires while a sandbox run is still preparing (reading the workspace, resolving the image, creating or staging the container) keeps the command from starting: the run reports `Aborted before start.` with `timedOut: true`, and the container is removed without being started.
  - `reconcile()` reports a sandbox run's container, or a read-only staging helper, as an orphan only once no run can still be using it. That is 30 minutes after its create (if it never ran) or after its exit. A running one is reported only past its run timeout, now written to a `deuz.run-timeout-ms` label, plus the same 30 minutes. `removeOrphans` therefore never kills a live sandbox run or staging copy, on this host or another. With a `scope`, `removeOrphans` removes only that scope's dangling volumes. A record whose container was created after the `docker ps` snapshot is matched instead of being marked `lost`.
  - Process containers carry a `deuz.request-digest` label. A new operation adopts a container found under its name only when that container never ran and carries the same request digest, which is the case after a crash cut a create short. A container left by an earlier operation under the same id (its record pruned before `dispose`) fails the new operation with error code `container_conflict` and is left alone; `dispose` removes it.
  - If the deadline has already passed before the start, `start`, `poll` or `reconcile` cancels the operation without ever starting its container. Cancelling an operation whose container never started removes the container, so a start another host had already dispatched finds nothing to run.
  - The output tail is read with `docker logs --tail <maxOutputBytes>`. If the log is too long to read within 120 s, the read fails with `docker_failed`, and the exit, the cancel and `dispose` go ahead without the output. When the line window is full, both streams are marked `truncated`.
  - An inline program too long for the operating system's command line fails with `docker_failed`, and the message says the command line is too long. It used to be reported as `docker_unavailable`.

  `createNodeSandbox` (`@deuz-sdk/core/compute/node`):
  - A timed-out or aborted run reports `exitCode: null` on Windows again, as in 2.3. With the 2.4 tree kill it reported 1 when the killed child closed within the grace period.
  - Once the direct child has exited, a timeout no longer runs `taskkill` on its pid, which Windows may already have given to another process.
  - `runShell` starts the command in the working directory as given, and uses the real path only to check that it is inside the root. A root on a mapped network drive no longer sends `cmd.exe` to `C:\Windows`.

- bf2fbc4: **Durable continuation legs in `resumeDeuzChatResponse`.** `ResumeDeuzChatOptions` takes an optional `durable` (`DurableStreamOptions`, its `store` the `streamStateStore`). The continuation leg then runs in durable mode: it takes the producer lease and commits before it sends. A durable producer that only went quiet past `liveProbeMs` (a long tool call) keeps its stream: the leg is refused with 'another producer holds this stream' and writes nothing, where a legacy leg could write seqs that producer had committed or went on to commit. Once a crashed producer's lease lapsed, the leg continues the log gapless. Without `durable` the leg is a legacy one, as before.

  **Durable streams across legs.** A lease provider's `prune` deletes released keys and the next holder starts again at token 1, below the stream's fence: every later leg of such a stream used to fail closed with 'a newer producer took over this stream'. When the stream holds a higher token, the producer now renews its lease: a producer whose lease changed hands is still refused, and the lease's current holder fences the stream one past the stored token, so a producer from before the prune is refused. A durable response whose producer throws (for example a `writeData` payload JSON cannot encode) now ends its journal, so its lease is released and no longer renewed for the life of the process. A durable leg now gives its lease back before its last frames, `[DONE]` among them, reach the client, so a client that starts the next leg as soon as it reads `[DONE]` is no longer refused.

  **Transcript search.** Every `TranscriptIndex` backend can index any message: U+0000 counts as a separator (the PostgreSQL store used to fail the whole chat write on it, and SQLite's LIKE fallback stopped matching there), and of a message larger than 256 KiB (UTF-8) only the terms of its first 256 KiB are indexed, where a large tool result used to fail the PostgreSQL write with 'string is too long for tsvector'. PostgreSQL search now finds the terms inside hosts, emails, paths and versions (`example` in `api.example.com`, `srv` in `/srv/app`), as the in-memory and SQLite indexes do.

- 9bba757: A V3 run nested under another native run may only narrow its parent's memory scopes, by the same rule as the legacy `memory` scope. Its versioned memory session's scope, the compiler's `scope` and the scope each built-in memory or transcript context source was pinned to must each lie within one of the parent run's scopes; a wider one fails the nested run with a `TypeError` ("widens its parent run's …") before it writes anything or calls a model. A V3 parent's scopes bound its children in turn, legacy `memory` children included.

  A V3 step reopened after a crash during its overflow retry sends the same context as before the crash. The overflow retry's package used to replace the step's package and the messages it was compiled for, so the restarted step, which starts again from the uncompacted checkpoint, compiled a new step whose retrieval was lost until the next refresh. The step's first package is now kept with it (`AgentRunContextStepV3.firstAttempt`, retained and redaction-checked like the step's own): the reopened attempt sends it again byte for byte, and its retry sends the recorded retry package when the compaction gives the same messages.

  A V3 run's versioned extraction now cites each message by the id the chat projection gives it (`<runId>:<index>`, or a stored chat's own id for an input message the run continues) instead of `<runId>#<index>`, so `TranscriptIndex.resolveSource` resolves the memory sources it writes to the chat messages. The claim of the extraction intent saves the ids it cites (`AgentRunMemoryIntentV3.messageIds`), so `reconcileAgentRun` replays the same operation.

- e24408b: Goal supervisor fixes in `@deuz-sdk/core/goal/runtime`:
  - **Takeover.** When the new holder's native leg meets the earlier executor's run lease (`lease_held`), loses the run's lease, or meets another executor of the run in the same process, the goal no longer parks with `run-failed:lease_held` and no longer drops its run. The native launcher reports such a leg as `RunLaunchResult.heldElsewhere`; the supervisor keeps the intent and the active run, goes back to `dispatching` without spending a retry, and a later claim resumes the same run.
  - **Native lease by default.** A `createNativeRunLauncher` created without `lease` takes the goal-lease provider and TTL of the first supervisor it is given to, so `drain()`, a cancel during a leg and the drain on goal-lease loss reach its runs, and a takeover in another process cannot drive the same V3 run twice. A launcher with a lease of its own keeps it; one used on its own behaves as before.
  - **Maintenance.** With the native executor, a verified goal now completes while its memory extraction is still running: the launcher returns the leg once the run's outcome is committed, with `maintenance: 'pending'`, and the supervisor follows the extraction. Every run whose maintenance is pending is followed until it settles (listed in the new `runtime.maintenanceRuns`), also when its goal stayed active and a later run completed it, so its late charges are added; `runtime.maintenance` shows the oldest pending run until none is.
  - **Inbox.** An entry queued for a goal that has already ended (a webhook delivery, a schedule occurrence) is settled with the `'terminal'` disposition, so its payload is tombstoned by `prunePayloads` like any other.
  - **Working memory.** A run's snapshot is named after the `specGeneration` the run first launched under (the new `GoalActiveRun.specGeneration`), also after a resume or a retry that follows a `revise`, so a run of a later generation never inherits it.
  - **Ended goals.** A host command that ends a goal whose run is suspended, or waiting for its retry, now settles the runtime at once: phase `done`, no active run.
  - **Lease provider restarts.** An intent claimed before the lease provider started its tokens again (an in-memory provider after a restart, a pruned key) is taken over on the first tick: the drive renews its own lease to make sure no later holder exists, then applies a recorded cancel, or resumes the run under a fresh intent.

  Additive contract changes: `RunLaunchResult.heldElsewhere`, `GoalActiveRun.specGeneration` and `GoalRuntimeState.maintenanceRuns`.

- ef96804: **Skill proposals read only what the source run itself did.** `proposeSkillFromRun` counts a tool as used, and so as a possible `allowedTools` entry, only for a call the run made itself, with a receipt of the run that records the call completed. A tool call that only appears in the run's input history (for example a chat history the client sent) is projected but never counts as used, and gets no model step. For a run without a transcript, every user turn after the caller's input is left out of the projection, including custom verifier feedback, and a multi-turn input stays the task. A source reference's `messageId` is the id the message keeps in the run's chat projection, so an input message carried over from the stored chat keeps that chat's id. Without a chat projection it is `<runId>:<index>`, as before.

  **Durable streams.** A refused durable response never reads a lazy source (a `streamChat` result behind `toDeuzStreamResponse` or `createDeuzStream`, a `resumeDeuzChatResponse` continuation leg). An agent stream starts as soon as it is passed to `toDeuzAgentStreamResponse`, so for a native run the run's own lease, not the stream lease, keeps a second executor out. A `resumeDeuzChatResponse` continuation leg that finds another producer holding the stream therefore never starts the run: it makes no model call, runs no tool and saves no checkpoint. After a lease prune, a producer that fences the stream one past the stored token must still hold its lease once that open has landed, or it is refused before it commits anything. A producer whose lease lapsed during the open can no longer share its fence with the next holder.

  The `unaccounted-usage` warning for a memory LLM now says to pass the `defineAccountedMemoryLLM` callback as the seams' `accountedLlm`, because `MemorySeams.llm` is typed as a plain `MemoryLLM`.

- 3d9df74: **Embedding generations work the same way on every versioned memory store.** The store prepares one generation at a time. `embeddings.begin` with another model or size retires the pending generation and deletes its vectors in the same transaction, so an abandoned `reembed` leaves no vectors behind. A job that is still filling the retired generation ends quietly with `activated: false`. A retired or unknown generation stays retired: `pending` lists nothing for it, `put` stores nothing and returns `0`, and `activate` returns `false`. A generation that an activation replaced never becomes active again. Before this, the SQLite and PostgreSQL stores kept every pending generation, threw `InvalidRequestError` from `put` and `activate`, and could make a retired generation active again. The in-memory store already behaved as described.

  **`ConditionalChatStore.pruneTombstones` on PostgreSQL accepts a fractional cutoff.** Before, a cutoff such as `1000.5` failed inside the driver. The store now compares the cutoff as its whole-millisecond ceiling, so it removes the same tombstones as the in-memory and SQLite stores.

- e802512: Native run and goal supervisor fixes:
  - **A run's lease never strands its result.** A native run with `lease` whose `LeaseProvider` throws synchronously while the run gives its lease back (a provider over a closed client, a host shutting down) no longer leaves `runAgent` / `resumeAgent` / `streamAgent` and `reconcileAgentRun` waiting forever. Giving the lease back (release, an acknowledged cancel, a cancel put back for the next executor) is best effort, and a synchronous throw is now treated like a rejection. Under the goal supervisor, whose native launcher takes the goal-lease provider by default, such a leg could stall `supervisor.tick()` for good.
  - **Versioned extraction is maintenance too.** With the native executor, a verified goal now also completes while the 2.4 `versionedMemory.extract` extraction is still running, as it already did for the 2.3 `memory` extraction. The launcher returns the leg once the run's outcome is committed, with `maintenance: 'pending'`, and the supervisor follows the extraction until its intent is acknowledged (`'complete'`) or the run's own pass failed (`'failed'`). A model tool's memory write is never maintenance.
  - **A failed versioned extraction is recorded.** When `session.extract` throws after a V3 run's outcome, the run saves why on its extraction intent (the new optional `AgentRunMemoryIntentV3.error`) and keeps the intent's status, so `reconcileAgentRun` may still settle it. The acknowledgment clears `error`.

- cc33bf6: **Nested V3 runs and context sources.** A nested V3 run claims the scope each built-in context source actually reads. A store-backed `createMemoryContextSource` or a `createTranscriptContextSource` pinned to a wide scope (for example one source per user) and narrowed by the compiler's `scope` is claimed at that narrowed scope, so a child whose compiler scope lies within its parent run's memory scope is no longer refused. A `ContextCompiler` instance passed as `context` now has its `scope` claimed too, as the compiler options' `scope` already was. A memory session source still claims its session's scope.

  **Refused durable responses.** A durable `toDeuzAgentStreamResponse` refused at open because another producer holds the stream returns its subscription to the run's events at once. Before, the run, which the subscription had started, kept queueing every event (text deltas and raw tool results included) for a response that would never read them. A refused durable `createDeuzStream` drops what was queued and every later `writeData`, as it does after the stream ended.

  **Context compiler reads current memory.** `createContextCompiler` no longer sends `recordedAsOf` with its source queries. It sent its own clock (a V3 run's clock), which is not the memory store's: when the store's clock ran ahead, or the run used a fixed clock, every record written in that gap was silently left out of the pass. A restarted step still sends the same context, because the V3 run reuses the step's stored package. `ContextSourceRequest.recordedAsOf` stays for a host that queries a source itself. The legacy-store memory source now reads TTL expiry against its own `clock` option.

- 50a7094: New `@deuz-sdk/core/memory/versioned` entry: versioned, provenance-tracked memory. It is opt-in and edge-safe, and the legacy `@deuz-sdk/core/memory` API is unchanged.
  - `createMemorySession({ store, scope, llm?, embedder?, extraction?, onForget?, execution? })` gives one memory scope `remember`, `extract`, `recall`, `revise`, `retract`, `forget`, `history` and `reembed`. Every record keeps a stable id and increasing revisions. It carries an `asserted | inferred` origin and cites its sources: the kind (`user`, `assistant`, `tool`, `external` or `host`), the run, the message or tool call id, and a `sha256:` digest of the content. Only an explicit host `remember` asserts; everything a model extracts or writes is inferred. The model can never change a record's scope, origin or source kinds.
  - Every write is one operation with a receipt. The active record, its immutable revision, the search index and the receipt commit together or not at all. An empty operation and a retract-only one still leave a receipt. Repeating an `operationId` with the same request returns the stored receipt (`replayed: true`); reusing it with a different request throws `OperationConflictError`.
  - When a concurrent writer changes the scope, `remember` and `extract` read the current records again and reconcile again, up to `maxConflictRetries` attempts in all (default 3), then throw `RevisionConflictError`. `revise` and `retract` take the caller's `expectedRevision` and throw at once when it no longer holds. Memory LLM and embedding calls never run inside a store transaction. The vector is computed from the final reconciled text and is bound to the record revision, the text digest and the embedding generation. A revised text never keeps the old vector. A vector from another model or of another size throws `EmbeddingMismatchError`; it is never scored as zero.
  - `extract` takes the same options as `remember`: `ttlMs`, `kind`, `links`, `topK`, `supersede` and custom `instructions`. Under the default untrusted-source policy it reads only user messages, host (system) input and the results of tools listed in `extraction.trustedTools`. It reads external or unmarked tool content only with `extraction.allowExternal`, and stores what it finds there with source kind `external`. It reads assistant turns only with `extraction.allowAssistant`.
  - `retract` removes a record from normal retrieval and keeps its history. `forget` deletes the record's content, every revision and every vector. Its receipts stay, without content and marked `redacted`, so a redelivered operation can never bring the record back. Then every `onForget` listener receives `{ scope, recordId, revisions, operationId }`. A listener that fails leaves `redaction: 'failed'` and never undoes the forget. `recall({ recordedAsOf })` returns what the store knew at that time.
  - `reembed({ embedder, modelId, dims })` is a resumable job: batches of 64, one at a time by default. It fills a new embedding generation while search keeps using the active one, embeds records that changed meanwhile again, and switches to the new generation atomically once every current record has a vector.
  - `createVersionedMemoryTools(session)` gives the model `memory_remember`, `memory_recall`, `memory_revise` and `memory_retract`, bound to the session's scope. There is no forget tool. These tools write inferred records only, never change an asserted record, and take an operation id from the model step and tool call id, so a replayed call applies once.
  - `createInMemoryVersionedMemoryStore()` is the reference store: compare-and-set, receipts, replay, generations, `pruneHistory` and `pruneOperations`. `pruneOperations` warns that the operation ids it removes lose their dedupe protection. `importLegacyMemory({ from, to, scope })` imports any legacy `MemoryStore`, the SQLite and PostgreSQL `deuz_memory` tables included, into initial revisions. Running it again replays and does not duplicate anything. It invents no history and carries no vectors over.
  - With an `execution` context, the session reserves each memory LLM and embedding call on the ledger before the call runs, then settles it. A callback marked accounted settles the usage it reports. An unmarked callback is held as unaccounted at its estimate, never treated as free, and reports one `unaccounted-usage` warning. Each operation reports a `deuz.memory.op` span with counts only: operation, record count, conflict retries and embedding generation.

- 86b3c4d: Versioned memory gets its SQLite and PostgreSQL stores. `createSqliteVersionedMemoryStore` (`@deuz-sdk/core/memory/versioned/sqlite`) and `createPostgresVersionedMemoryStore` (`@deuz-sdk/core/memory/versioned/postgres`) keep records, their immutable revisions, operation receipts, embedding generations and vectors in new tables with their own `deuz_vmem_schema` version table, beside the existing memory tables, which they never touch. Each operation is committed in one transaction (record, revision, search index, vector and receipt together, or nothing), a repeated operation id replays its receipt, and search fuses full-text and vector ranking: FTS5 with a LIKE fallback on SQLite, a `simple` tsvector with a GIN index on PostgreSQL, and cosine over the active embedding generation (computed in the database when pgvector is installed, over the freshest `candidateLimit` rows, default 1000, otherwise). The PostgreSQL store needs a pool (`pg.Pool` or compatible); a client that only offers `query()` is refused. Both stores take a `clock`, a `logger` (`pruneOperations` warns through it) and an `observer` (`pruneHistory` and `pruneOperations` report `deuz.memory.op` spans).

  Behaviour change in the existing memory stores (in-memory, Markdown, SQLite, PostgreSQL and Redis): a vector query no longer fills its results with records that have no vector at score 0, and a record whose stored vector has another length or another `embeddingModelId` than the query's no longer enters the vector ranking. Both are still found by their text. `recall` names the embedder's model on the query and reports such records once per run as an `embedding-mismatch` warning (through the new `onWarning` option, or one logger line per seams and mismatch). A store that implements its own `search` can do the same with the new `MemoryQuery.embeddingModelId` and `MemoryQuery.onEmbeddingMismatch`. The PostgreSQL store no longer tops up a short pgvector result with records that have no vector.

  Behaviour change: `memory_update` now drops the record's stored vector, because it was computed from the old text, and every built-in store's `update` drops it when the text changes without a new embedding. The record is found by text until it is embedded again; no embedding call is added.

  The new optional `MemorySeams.accountedLlm` takes an accounted memory LLM (`defineAccountedMemoryLLM`, now exported from `@deuz-sdk/core/memory` together with `isAccounted`); when set, memory LLM calls go to it instead of `llm`, whose type stays the 2.3 `MemoryLLM`. `MemorySeams.embedder` also accepts an accounted memory embedder. With the new `MemorySeams.execution`, every memory LLM and embedder call is reserved on that execution context's ledger first: an accounted callback settles the usage it reports, an unmarked one is counted as unaccounted (never as free) with one `unaccounted-usage` warning. Without `execution` nothing is charged, as before.

- e2a1470: `@deuz-sdk/core/context` compiles memory, RAG, past conversations and the skill catalog into one token budget. Nothing changes until you configure it.

  `compileContext(input)` is pure and deterministic: the same input gives the same package, byte for byte. The added context gets 20% of what the request leaves free (`inputTokens − usedTokens`), at most 8192 tokens. The working memory is placed first, up to 1024 tokens; its goal, constraints and active task are always placed. The rest is shared by source kind, memory 2 : RAG 2 : skills 1, plus transcript 1 when a transcript source is present, and a share a source leaves unused goes to the others. Each source offers at most 20 candidates, taken by score. Mandatory content (the working memory's critical fields, and skill bodies the model already loaded) is never cut: when it does not fit, the call throws `ContextBudgetExceededError` (`context_budget_exceeded`) instead. Retrieval enters the conversation as one append-only `user` message that adds only what is new: an entry placed earlier at the same revision is not written again. The working memory is a separate tail message that is never written to history. The system message and tool schemas are never touched, so the provider's prompt cache and preserved thinking survive a refresh. Retrieved content is escaped and labelled with its source, origin and source kinds, so it reads as data and cannot pass for an instruction. Every package comes with a `ContextManifest` that records each candidate's source, record id, revision, digest, query, tokens and why it was selected or left out. It never carries the content.

  `createContextCompiler(options)` (preview) queries the sources for the native loop. It refreshes on the first call, when the active task changes (at least `refresh.minSteps`, default 2, model steps after the last retrieval) and when the host asks (`requestRefresh()`). It runs at most `refresh.maxPasses` retrievals per run (default 4). After that it reuses the last package, and the manifest says so with `fallback: 'pass-limit'`. The query is the active task's title plus the latest user text, and no model rewrites it unless you pass `refresh.rewriteQuery`. An optional source that fails produces a `context-source-failed` warning (`onWarning`, or `contextWarnings(manifest)`) and the step goes on without it. A required source (`required: true`) that fails stops the call with its own error. `state()` returns plain JSON for a checkpoint, and a compiler restored from it compiles the same context. `onOverflow` recompiles a step's package under a smaller budget without retrieving again. Each compile reports a `deuz.context.compile` span whose attributes are counts, ids, digests and token numbers only. `contextPackageBlob(pkg)` gives a package's content-addressed blob for the V3 run store.

  The built-in sources:
  - `createMemoryContextSource` reads a versioned `MemorySession` (with revisions, origin labels and `recordedAsOf`) or a legacy `MemoryStore`.
  - `createRagContextSource` wraps your `retrieve` or `hybridRetrieve`. It is the first link between `/rag` and the agent loop.
  - `createTranscriptContextSource` searches a `TranscriptIndex` and resolves the chat messages that memory records cite (`refs`).
  - `createSkillsContextSource` offers only catalog lines (name and description). A skill's body is budgeted only after the model loads it with `load_skill`; a body is never injected because retrieval matched it.

  Every source reads only within the scope you pin: a request may narrow that scope but never widen it.

  The token estimator is public as `createTokenEstimator` (about 3.6 characters per token, corrected by real usage, or your own tokenizer). `estimateRequestTokens` and `estimateRequestOverhead` count a whole request through it: messages, tool schemas, the output schema and provider framing. `estimateTextTokens` counts a single text.

  `/rag` accepts an optional `estimator` (`ChunkOptions.estimator`, `estimateTokens(text, estimator)`, `countTokensWith`) to count through that same estimator. Without one it keeps counting 4 characters per token, so 2.3 chunk boundaries do not move. `retrieve`, `hybridRetrieve` and `indexChunks` accept an accounted embedder (`defineAccountedEmbedder`) and an optional `accounting` (`CallAccounting`) that charges each embedding call to a budget ledger: the call is reserved before it runs and settled with the usage an accounted embedder reports. An embedder that reports no usage is recorded as unknown, never as free, and reports an `unaccounted-usage` warning through `onWarning`. Without `accounting`, these functions behave as in 2.3.

- a959997: Native runs get a V3 record (`checkpointVersion: 3`) that can hold compiled context, working memory and versioned-memory intents. V3 runs are stored in an `AgentRunStoreV3`: `createInMemoryAgentRunStoreV3` from `@deuz-sdk/core/agent`, `createSqliteAgentRunStoreV3` from `@deuz-sdk/core/ops/sqlite` and `createPostgresAgentRunStoreV3` from `@deuz-sdk/core/ops/postgres`. These stores keep V3 runs in tables of their own (`deuz_runs_v3*`) and track their version in their own `deuz_runs_v3_schema` table. The 2.3 tables and `deuz_ops_schema` are never touched, so a 2.3 process can still open the same database: its run listing and pruning never see a V3 run, and its `resumeAgent` and `reconcileAgentRun` refuse a V3 record before calling a model or a tool. Nothing changes for existing runs: version 1 and 2 records are never converted, and every 2.4 feature stays off until you choose `checkpointVersion: 3`.

  An `AgentRunStoreV3` accepts only version 3 records, so a V3 run is never written back as version 1 or 2, not even by a terminal or maintenance save. Each save must carry the stored revision plus one, and any other save fails with `RevisionConflictError` (code `revision_conflict`, subsystem `'run'`), which carries the revision the writer expected and the one stored. `list` pages through V3 runs the way the 2.3 `AgentRunStore.list` does. `prune({ terminalBefore })` deletes terminal runs last saved before that time, along with the context packages that only those runs used. A package that was put again after the last save of the runs that used it is kept: another run is writing it, so a prune that comes between that run's `putBlob` and its save does not take the package away. Times come from the store's clock: the injected `clock` (or `deps.clock`) for the in-memory and SQLite stores, and the database clock for Postgres.

  Each compiled context package is stored once as a content-addressed blob (`putBlob` and `getBlob`), keyed by the `sha256:` digest of its blocks' canonical JSON. A package that stays the same across steps is written only once, and content that does not match its digest is rejected. `redactForgotten(event)` handles a versioned-memory forget: call it from the memory session's `onForget` listener (for example `onForget: async (event) => { await runs.redactForgotten(event); }`). It redacts every package that holds one of the forgotten record revisions, including a package written after the forget, and returns how many packages it redacted. When the run loads again, the manifests that point to a redacted package are marked `redacted: true` and `getBlob` reports `{ status: 'redacted' }`. That step's context is then compiled again, which is the only case where a reopened step does not reuse its stored context. The forget records it keeps hold only record ids and revisions, never text.

  The Postgres store needs a pool with `connect()` (such as `pg.Pool`) or a `connectionString`. It runs every write as one SERIALIZABLE transaction, so a package written at the same moment as a forget is retried and still redacted. `migrate()` creates the tables, and `close()` ends only a pool the store opened itself. The SQLite store opens `{ path }` itself and closes it on `close()`, but it only borrows a `{ database }` handle you pass in and leaves it open. Redis has no V3 store in 2.4: running a Redis `AgentRunStore` with `checkpointVersion: 3` fails at configuration time with `UnsupportedStoreError` (code `unsupported_store`).

  `@deuz-sdk/core/context` adds structured working memory, which keeps what a long task must not lose: the goal and the host's constraints, a copy of the task list and the active task, observations, hypotheses, decisions, open questions and the approaches already tried, each with its source references. `createWorkingMemory({ scope, goal, constraints, tasks, goalRef, now })` starts a plain-JSON snapshot at revision 0. It holds a copy of the `TaskList`, not a reference to it, so a V3 checkpoint keeps the active task across a restart. `applyWorkingMemoryPatch(snapshot, patch, { now })` is the only way to change a snapshot. It is pure and never mutates its input. A patch is a list of named, schema-checked operations, and there is no free-form JSON Patch. It carries an `expectedRevision` and an `operationId`, and the result is one of four:
  - `'applied'`: the revision goes up by one;
  - `'duplicate'`: this operation id was applied before, and the last 64 ids are remembered;
  - `'conflict'`: the expected revision is stale;
  - `'rejected'`: the patch is refused with the index of the refused operation and a reason (`forbidden`, `unknown-id`, `duplicate-id` or `invalid`), and nothing is applied.

  Only the host can set the goal, the constraints and the task list, or confirm a hypothesis or accept a decision. A hypothesis or decision that a model adds stays `'proposed'` and is never treated as a verified fact. A model can change only items it wrote, and it can never cite the host as a source. The goal, the constraints and the active task are the critical fields that the context compiler always keeps.

  `workingMemoryTools({ memory, prefix, agentPath })` gives the model three tools: `working_memory_read`, `working_memory_add` and `working_memory_update`. Every write becomes one model patch whose operation id is built from the model step and the tool call id, so a call replayed on resume is applied once (the tools are `replay: 'idempotent'`). A refused write comes back to the model as a tool error. A model can cite earlier tool results as evidence by their tool call ids. The tools persist nothing themselves: a V3 run checkpoints the snapshot together with the tool's receipt. A sub-agent that is handed these tools can read the working memory but not write to it, because sub-agents never share writable working memory automatically.

- e6ccfcb: `runAgent`, `streamAgent`, `resumeAgent`, `resumeStreamAgent` and `reconcileAgentRun` take a V3 path: pass `checkpointVersion: 3` with a session on an `AgentRunStoreV3` (`createInMemoryAgentRunStoreV3`, `createSqliteAgentRunStoreV3`, `createPostgresAgentRunStoreV3`). The same executor runs both paths. A V3 run saves every record as version 3, terminal and bookkeeping saves included, and `streamAgent` returns an `AgentStreamV3` whose `eventsV3` carries every 2.3 event plus the V3 ones: `context` (a step's manifest), `working-memory` (a new revision) and `memory-intent` (a versioned-memory write moving on). The stream is still an `AgentStream`, so `toDeuzAgentStreamResponse` serializes it as before and none of the compiled context reaches the wire. A V3 run refuses a missing session or a 2.3 store with a `TypeError`, and a Redis store with `UnsupportedStoreError` (code `unsupported_store`), before anything is read or written. Without `checkpointVersion: 3` nothing changes. A 2.3 run that passes `context`, `workingMemory` or `versionedMemory`, or a V3 store, is now refused with a `TypeError` instead of having those options silently ignored.

  `context` puts the context compiler into the native loop. It takes a `ContextCompiler` or the options of `createContextCompiler`, and a resumed run restores the compiler's state from the run record. Each model step runs in the spec order: compaction, then your `prepareStep`, then the step's real model and active tools, then a source refresh when one is due, then the compile with the final budget check (the tool schemas, the output schema of a final answer call and the provider framing are counted). The package is then written as a content-addressed blob (an unchanged package is written once) and its manifest is saved with the run, all before the model call. Retrieval enters the history append-only, right after the messages it was compiled for and only once the call succeeded, and it never reaches the chat transcript. The working memory ends each request as an ephemeral tail and is never written to history, except on a model that binds preserved thinking to the transcript prefix (Claude 5.x): there each step's copy joins the history once the call succeeded, right after that step's retrieval, so the bytes before every replayed thinking block stay the same. Every copy says the latest copy replaces every earlier one, the next request ends with the current one, and the manifest records `placement.tailKept`. The system message and the tool schemas never change, so a refresh keeps the prompt-cache prefix, and the manifest records whether it changed (it does at a compaction boundary). A native final answer call carries its context the same way, so a structured-output run without tools is compiled too. `deuz.context.compile` now nests under the step's span. A host estimator given as `context.estimator` is calibrated with each call's real prompt size.

  On a provider overflow, the loop compacts again as before (it does not re-run `prepareStep`), and the compiler places the step's context again for just under the size of the request that overflowed: optional context shrinks, the step's package is replaced (refresh `'overflow-retry'`), and mandatory content that cannot fit fails the run with `ContextBudgetExceededError` (code `context_budget_exceeded`). A step whose package placed nothing, with nothing compacted, keeps the provider's overflow error as in 2.3. A step that is reopened after a restart (same messages, answer never saved) uses its stored package again without asking the sources. A package that a `forget` redacted is compiled again (refresh `'redacted'`, `redacted: true` in its manifest), and when a run resumes, the retrieval blocks of redacted packages are removed from its history and checkpoints before the next request.

  Memory placed by the compiler and the legacy automatic recall would inject the same memories twice. A V3 run whose compiler has a memory source and whose `memory.recall` is on is refused at configuration time. Set `memory.recall: false` to keep only the legacy extraction. Without a memory source, the legacy recall works as in 2.3.

  `workingMemory: { snapshot?, create?, tools? }` keeps the working memory, with the task list and the active task, in the V3 record. A resumed run keeps the stored snapshot, so the active task survives a restart. Working memory without a compiler still gets its tail placed. With `tools: true` the model gets `working_memory_read`, `working_memory_add` and `working_memory_update`; a model's patch becomes durable in the same save as its tool receipt, and a call replayed after a crash is applied once. A host tool with one of these names is refused, and so is a snapshot or a `create` for another scope than the session's.

  `versionedMemory: { session, tools?, extract? }` connects a versioned memory session. Its writes follow durable intent, prepared plan, atomic memory commit with its receipt, then native acknowledgment, and they are recorded in `memoryIntents`. With `tools: true` the model gets the session's memory tools. Each write's intent moves with its tool receipt (`intended`, `committed`, `acknowledged`) under the session's operation id. `extract` (off by default) extracts the completed run's turns into the session: its intent is saved in the terminal commit, the run saves its claim on it (`planned`, with the ids of the messages it cites, but no plan) before the session runs, the session prepares the plan and commits it with its receipt in one call, and the acknowledgment copies the receipt into the intent (its mutation count as `planned`, and `requestDigest`, the digest of the request rather than of the plan). A lost acknowledgment is settled from the receipt (a resume replays the tool call; `reconcileAgentRun` with `versionedMemory: { session }` replays the extraction and returns the settled operation ids in `memoryIntents`), and a memory change is never applied twice, even when a model call repeats after a crash. In a V3 run, a legacy extraction that wrote only part of its plan is recorded as `'partial'` and reported with a `memory-extraction-partial` warning; `reconcileAgentRun` reports it as `'failed'` in its 2.3 answer shape.

  Behaviour change: the built-in memory of native runs (`memory`) reports its 2.4 warnings on the run's stream (`embedding-mismatch` from the recall, `unaccounted-usage` for a memory LLM or embedder that reports no usage). It also charges the memory LLM and embedder calls to the run's execution context, unless you set `seams.execution` yourself, so they count against the run's budget and execution policy. The legacy loops (`generateText`, `streamChat`) report the same warnings in `warnings` and charge `execution` when the call has one.

- 52f7466: **Goal runtime stores.** `createInMemoryGoalRuntimeStore` (`@deuz-sdk/core/goal/runtime`), `createSqliteGoalRuntimeStore` (`@deuz-sdk/core/goal/runtime/sqlite`) and `createPostgresGoalRuntimeStore` (`@deuz-sdk/core/goal/runtime/postgres`) keep a goal, its inbox, the supervisor's runtime state, durable schedules with their cursors and occurrence records, run intents and ledger watermarks under one transaction boundary. They are `GoalStore`s, so goals become durable for the first time, and every multi-part write commits whole or not at all: an inbox `apply` writes the entry's disposition, the goal, the runtime state and a run intent together; a schedule `advance` moves the cursor, records the occurrences and queues their deliveries together; an intent `complete` and a watermark `advance` save the runtime state and the charged goal with them. Writes are fenced by revision compare-and-set (the stored revision plus one), never by a lease token alone. The SQLite and PostgreSQL stores use new `deuz_goal_runtime_*` tables with their own `deuz_goal_runtime_schema` version table and change no existing table or schema version; the SQLite store runs each write in one `BEGIN IMMEDIATE` transaction, so several processes can share the file, and the PostgreSQL store needs a pool (`pg.Pool` or compatible), pins one connection per write and refuses a client that only offers `query()`. Both take a `clock` (the PostgreSQL options gain it too); a store closes only a connection it opened itself.

  **Scopes and deliveries.** `load(goalId, { scope })` reads a goal of another scope as undefined, a goal never changes scope, and every runtime state, inbox entry, schedule, intent and watermark must name a goal of its own scope. An inbox entry is keyed by scope, namespace and delivery id: the same delivery with the same digest answers `duplicate`, another payload digest or target goal answers `conflict` and writes nothing. A recorded cancel request (and the time it took effect) can never be withdrawn by a later runtime save. A run intent is claimed by token: a higher token takes a claimed or launched intent over (a launched one stays launched, to be resumed), and only the current holder can mark it launched or complete it. `intents.record` takes an optional `{ runtime, goal }` saved with it, so a supervisor with a stale view cannot record a retry. Schedule cursors move only with `advance`, which leaves the schedule's revision alone; `put`, `pause`, `resume` and `cancel` make a new revision, and `cancel` disposes the schedule's still-pending deliveries as `cancelled`. The stores also offer `schedules.occurrences({ scope, scheduleId? })` to list occurrence records (optional in the `GoalRuntimeStore` interface).

  **Retention is explicit.** Nothing is deleted in the background. `prunePayloads({ before })` replaces the payloads of settled entries with content-free tombstones (`payloadPruned`; ids stay, so dedupe holds), `pruneInbox` deletes settled entries ids included, `pruneOccurrences` deletes occurrence records and `pruneIntents` deletes finished intents, each optionally within one `scope`.

  `createInMemoryGoalStore` (`@deuz-sdk/core/goal`) gains the same scope-checked `load(goalId, { scope })`; called without a scope it behaves as in 2.3.

- 8cfe4cc: Goal supervisor in `@deuz-sdk/core/goal/runtime`. `createGoalSupervisor({ store, launcher, lease })` drives durable goals to completion with the existing native executor; it is a library loop in your process, not a service, and adds no agent loop of its own. Nothing runs until you create one.
  - **Surface.** `submit` creates a supervised goal (it opts into spec generations, `specGeneration` 1 by default) together with its runtime state and a start intent, in one write; goal ids stay globally unique. `get` and `list` read one scope only. `dispatch` queues an event in the goal's inbox, digested like the durable scheduler and the webhook handler: the same delivery is a duplicate, the same id with other content throws `GoalError('delivery_conflict')`. `command` applies a host command at an expected revision, fenced by the runtime state. `resume` answers a suspended run with `approvalResponses` and `clientToolResults`, which are stored with the run intent first. `updatePolicy` changes the limits at an expected runtime revision, and is the only way to raise them. `events` streams what the supervisor does, `tick` runs one pass, `start` ticks every `pollMs` on the injected clock, and `drain` stops taking work.
  - **Defaults.** One goal is driven at a time (`concurrency: 1`), one executor per goal, a 30 s goal lease, a 1 s poll, at most 10 automatic runs per goal, and at most 3 retries 1, 5 and 30 s apart, only for failures the native layer marks retryable. A limit that runs out parks the goal and reports `policy-limit` once.
  - **Leases and fencing.** Each goal is claimed through your `LeaseProvider` under `goalLeaseKey(scope, goalId)` (`goal:["scope","goalId"]`). A run intent is recorded before every launch and claimed with the lease token, so a later holder takes it over and fences the earlier one out. Every write is a `GoalRuntimeStore` revision compare-and-set: the lease alone authorizes nothing. A supervisor that loses a goal lease drains the run it started, writes nothing more, and starts nothing new. The next holder resumes the same run and never starts it twice.
  - **Cancel.** A cancel request and its application are separate states. `command(scope, goalId, { type: 'cancel' })` records the request durably and returns the goal unchanged (`changed: false`, outcome `'applied'`), asks the working run to stop, and signals the goal lease. The cancel takes effect, and the goal turns `cancelled`, at the next claim or when the working run stops. A cancel for an idle run, which nobody holds and so cannot be signalled, or one that arrives before the run's first checkpoint, is never lost. `drain()` stops new work and brings each running run to its next safe checkpoint. The run stays resumable.
  - **Runs.** Only an active goal runs: a goal that waits, for you, an event or more budget, starts nothing and is not retried until it is active again. A run that completes goes through your `verify` hook, usually returning the `evaluate` command from `verifyGoalAcceptance`. The hook is asked once per run leg and each command it returns is applied once; then the supervisor tries `complete`. A hook that throws, or returns a malformed command, parks the goal in a `user` wait (`note: 'verify-failed'`). A goal that stays active gets another automatic run. A suspended run parks the goal in a `user` wait (`note: 'approval'` or `'client-tools'`) until you call `resume`. A run that stops for another reason, or fails for good, parks the goal in a `user` wait too (`note: 'run-stopped:<reason>'` or `'run-failed:<code>'`), and no new run is started on its own, because a new run could repeat an outside effect. A retry resumes the same run and passes the stored approval verdicts again as `approvalResponses`, so a call that waited for an approval is not gated a second time.
  - **Inbox.** Due inbox entries are settled with `settleGoalEvent` and `store.inbox.apply`. The goal change, the runtime state and the run intent an applied event starts are written in one transaction. Early events stay pending. Dependency waits are reconciled with `goalDependencyEvents`; pass `runFinished` for run dependencies. Wakeups and deadlines are applied on time.
  - **Accounting.** After every leg the supervisor charges the run's durable ledger above its watermark exactly once (`watermarks.advance`), through `launcher.accounting`, or the leg's own totals when a launcher reads no ledger. Uncertain amounts are recorded as reservations and never charged. A verified goal completes even while its optional memory extraction is pending. That maintenance shows separately in `runtime.maintenance`, and a charge that lands later raises `spent` without reopening the goal.
  - **Working memory.** A goal's next run inherits the last `WorkingMemorySnapshot` only when its scope and `specGeneration` match the goal's, as it is, so hypotheses keep their status.
  - **Telemetry.** The supervisor reports the `deuz.goal.claim`, `deuz.goal.dispatch`, `deuz.goal.retry`, `deuz.goal.cancel_requested`, `deuz.goal.cancel_applied`, `deuz.goal.drain` and `deuz.goal.generation` spans. Their attributes carry only ids, revisions, spec generations and attempt numbers.

  `createNativeRunLauncher({ store, options, lease })` runs a goal's V3 runs (`checkpointVersion: 3`) with the native executor, loaded with a lazy `import()`. It starts a run its V3 store does not hold and resumes a stored one, so a repeated launch never starts a run twice. Only a retry of a transient failure resumes with `retryFailed`. The inherited working memory goes to new runs only. Cancel and drain are signals to the native run's lease. `accounting` reads the ledger of the run's last checkpoint, and `maintenance` reads its memory extraction.

  Additive contract changes: `RunLaunchRequest.kind`, `RunLaunchResult.maintenance`, the optional `RunLauncher.maintenance`, `GoalSupervisorOptions.verify` and `runFinished`, and `GoalRunIntentInput.clientToolResults`.

- 1152ef5: **Goal evidence is bound to its source.** `GoalEvidence` gains five optional fields: `criterionId` (the criterion it was produced for), `verifier: { id, version }` (the host verifier and the version of its checks), `specGeneration`, `artifactDigest` and `workspaceDigest` (`sha256:<hex>`). They are validated, kept through `parseGoal`/`serializeGoal` and every transition, and take part in the `evidence-conflict` check: evidence recorded again under its id with another binding is refused. Evidence that names a criterion now supports a `passed` verdict on that criterion only; a pass that rests on evidence for other criteria is recorded `inconclusive` with a note, as a pass that rests on the model already is. 2.3 records carry none of the fields and read as before.

  **Spec generations (opt-in).** `GoalRecord` and `createGoal` gain an optional `specGeneration`, and `revise` an optional `nextSpecGeneration`. On a goal that carries `specGeneration`, a new objective, any change to the criteria, or a `revise` with `nextSpecGeneration: true` (a relevant host constraint or verifier changed) starts the next generation and rewrites every earlier verdict to `inconclusive` in the record itself, so the goal cannot complete until it is verified again; verdicts of removed criteria are dropped. Only evidence of the current generation supports a pass, and evidence recorded without a generation is stamped with the current one. Charges, run links, waits, events and budget, deadline or metadata revisions never touch the generation or the evidence. `nextSpecGeneration: true` on a goal without the field opts it in at generation 1. A goal without `specGeneration` keeps the 2.3 rules exactly: a `revise` drops only the verdict of a criterion whose text changed, and a new objective keeps the verdicts.

  **`verifyGoalAcceptance`** (`@deuz-sdk/core/goal/runtime`) runs the host's `GoalVerifier`s against the artifacts or workspace a run left, resolved through a `GoalArtifactResolver` before and after each check, and returns the `evaluate` command to apply with `transitionGoal` (it writes nothing itself). Each verdict's evidence binds the scope, goal, criterion, producing run (`runId`, else the goal's), digest, verifier id and version and spec generation, under an id derived from them, so verifying the same state again adds nothing. A missing verifier, artifact, resolver or run, a digest that differs from `expectedDigest` or from the digest the run recorded for that ref, an artifact that changes while it is verified, or a verifier that throws gives `inconclusive` with a note and no evidence, never `passed`. Remembered facts and model claims are never used as evidence.

  **`digestWorkspace(workspace, { include, exclude })`** (`@deuz-sdk/core/workspace`) returns the `deuz-workspace-v1` digest of a workspace's files: SHA-256 of the canonical JSON of `{ path, size, digest }` entries sorted by UTF-8 path, computed with WebCrypto (edge-safe). The Docker runner's artifacts use the same format. `include` and `exclude` take anchored globs (`*`, `?`, `**`; a glob naming a directory covers everything below it); exclusion wins.

  **Helper calls reach the budget ledger.** `embed` and `embedMany` take `accounting: { execution, requestId, kind?, tokens?, usd? }`: the call is reserved on the execution context before its first request (under its policy and budgets; the estimate comes from the shared token estimator, priced like usage) and settled with the provider's usage, and a request id is charged once. When the provider reports no tokens, or a request may have been billed before it failed, the estimate stays held as unknown; a refusal before billing (400, 401, 403, 404, 422, 429) releases it. `createVerifier({ execution })` charges each judge call to that context the same way, and a call the budget or policy refuses degrades the verdict like any other verifier outage. Without these options nothing changes and requests are byte-identical to 2.3.

  **Callbacks that report no usage are unaccounted, never free.** A reservation marked `unaccounted` (a plain memory LLM or embedder callback) holds its estimates, is counted in `BudgetTotals.unaccounted` while its usage is unknown (also after `compact`, through the new optional `BudgetAggregate.unaccounted`) and keeps its marker in snapshots. A budget, scope budget or persistent `BudgetStore` scope with `unknownPrice: 'reject'` refuses it with the new `BudgetLedgerError` code `'unaccounted_call'`: a strict budget needs the accounted variant of the callback (for example one built with `defineAccountedMemoryLLM`). `BudgetLedgerErrorCode` is widened by that member; code that switches over it should keep a default branch.

- 680edf0: **Durable scheduler.** `createDurableScheduler({ store })` from `@deuz-sdk/core/goal/runtime` turns cron schedules into goal inbox deliveries that survive restarts. A schedule (`put`) targets one existing goal in its scope and never creates goals; `pause`, `resume`, `cancel`, `get` and `list` manage it, and every change is a new revision whose `effectiveFrom` is an explicit UTC boundary: nothing of either revision before it is delivered. `tick()` runs one pass and `start()` loops every `pollMs` (default 1 s) on the injected clock; it is a library loop in your process, not a service. Each step is one `store.schedules.advance`, so the schedule cursor never moves without its deliveries, and a crash mid-backlog resumes from the persistent cursor without losing or repeating an occurrence. Catch-up after downtime is `'latest'` by default (only the newest missed occurrence, once its whole window was scanned), `'all'` (every one, oldest first) or `'none'` (missed ones skipped); an occurrence found within `graceMs` (60 s) is on time. A tick delivers at most `maxDeliveriesPerTick` (100) occurrences in total and scans at most `maxScanMinutes` (10 000) UTC minutes per schedule; schedules take turns, so one backlog never starves the others. Skipped occurrences are recorded with their reason, `pause` stops scanning, `cancel` also ends the deliveries not yet applied, and every occurrence reports a `deuz.schedule.delivery` span. The 2.2 `createScheduler` stays as it is (in-process, UTC only).

  **Time zones and DST.** Schedules take an IANA `timezone` (default `'UTC'`), evaluated with `Intl`, with no dependency and the same results on any host time zone. A local time the clock skips runs once at the first valid instant after the gap (`dstGap: 'shift'`, the default) or not at all (`'skip'`); a repeated local time runs once (`dstOverlap: 'first'`, the default) or at both instants with distinct occurrence ids (`'both'`). The same reading is available on its own from `@deuz-sdk/core/schedule` as `zonedOccurrencesBetween`, `nextZonedOccurrence`, `timeZoneOffset` and `assertTimeZone`.

  **Webhooks.** `createWebhookHandler({ store, verify, target, namespace })` is a Fetch API handler (`(request: Request) => Promise<Response>`) that runs on the edge as it is. It verifies with `verifyHmacSignature`, `verifyGitHubWebhook`, `verifySlackRequest` or your own check, takes the scope and the target goal from your configuration only, and dedupes by scope, namespace and delivery id (the `X-GitHub-Delivery` header for GitHub, a header or function you choose, else the body's SHA-256). It answers `202` only after the delivery is durably in the goal's inbox, `200` for a recorded duplicate with the same payload and target, and `409` (`delivery_conflict`) for the same delivery id with another payload or target, recording nothing; `401`, `404`, `405` and `413` (bodies over `maxBodyBytes`, default 1 MiB) cover the rest, and a store failure answers `500`, never `202`. `toNodeHandler(handler)` serves it from Node's `http` server or Express without importing `node:http`.

  **Inbox semantics.** `goalDeliveryDigest`, `settleGoalEvent` and `goalDependencyEvents` (also from `/goal/runtime`) give the inbox's event rules to anyone settling entries: an event early for its `notBefore` stays pending, unmatched, stale, expired and terminal outcomes are explicit dispositions, an event is never re-dated onto a wait that began after it, and a dependency wait catches up with dependencies that had already finished.

- 343847b: New `@deuz-sdk/core/compute/docker` (preview, Node only): a local Docker sandbox and a process runner that survives a host restart. Both drive the Docker CLI with `shell: false` (`dockerPath`, default `docker`; `dockerArgs` for global flags such as `--context`) and target Linux containers.

  `createDockerSandbox({ image, ... })` implements the `ComputeSandbox` seam. Every `runCode` / `runShell` runs in a fresh container with the defaults of the 2.4 spec: the image is given explicitly, resolved once to its immutable id and never pulled; UID/GID 10001; `--network none`; 1 CPU; 512 MiB of memory with no swap; 128 PIDs; every capability dropped; `no-new-privileges`; `restart=no`; no host directory and no Docker socket mounted; the labels `deuz.operation-id`, `deuz.scope`, `deuz.sdk-version` (and `deuz.kind`) on every container. The `workspace` is copied in through a tar archive limited to `maxStagingBytes` (256 MiB) and owned by the run user. `cwd` stays inside the workspace. Env values are passed through a private env file, never on the command line. The output is a tail of `maxOutputBytes` (1 MiB) per stream with `truncated`. A run without `timeoutMs` stops after 30 s, and the container is always removed afterwards. Nothing the run writes is copied back to the host workspace. `readOnlyRootFilesystem: true` (default off) adds `--read-only`, a tmpfs `/tmp` of `tmpfsBytes` (64 MiB) and a writable workspace volume. Failures of the infrastructure reject with the new `DockerSandboxError` (`code`: `docker_unavailable`, `image_not_found`, `staging_too_large`, ...).

  `createDockerProcessRunner({ image, store, ... })` runs a process that outlives its host process: `start`, `poll`, `readOutput`, `readArtifact`, `cancel`, `dispose` and `reconcile`. Each step is recorded with a compare-and-set in a `ProcessOperationStore`, in a fixed order: operation record, container create, staging, a durable `start-dispatched` record, one start command, then inspection. A restarted host calls `start` with the same operation id and request and carries on where it stopped. A running or exited container is never started again. A start whose outcome is unknown becomes `needs-reconcile`. `reconcile` marks it `failed` (`start_unconfirmed`) and never starts it. A container that vanished makes the operation `lost`, and it is never recreated under the same id. The same id with another request throws `OperationConflictError` (subsystem `'process'`). `cancel` is recorded first, then `docker stop` with a 2 s grace, a kill if needed, and a check of the state. While the daemon cannot be reached, the operation stays `cancel-requested`, and the next `poll`, `cancel` or `reconcile` finishes the cancel. The output tail is stored at exit and outlives `dispose`. `readArtifact` reads only from a stopped container, and only a regular file under the workspace up to `maxArtifactBytes` (64 MiB). It refuses links, directories, a linked parent directory and paths that leave the workspace. Its digest is the shared workspace-entry digest (`sha256:<hex>`). `durableTimeout` is `false`: the runner enforces `deadlineAt` while it runs, and a deadline that passed while the host was down cancels the process when the host reconnects. `reconcile()` matches labelled containers with the store and reports orphans. It removes them only with `removeOrphans: true`. The SDK deletes nothing in the background. The runner reports the `deuz.process.start`, `poll`, `cancel`, `exit` and `reconcile` spans, with ids, states, exit codes and counts only.

  `createInMemoryProcessOperationStore()` and `createSqliteProcessOperationStore({ path | database })` record the operations. The SQLite store adds its own tables with their own `deuz_process_ops_schema` version table and changes no existing schema version, and `prune({ terminalBefore })` removes old finished records.

  **`createNodeSandbox` fixes (`@deuz-sdk/core/compute/node`):**
  - **Behaviour change:** `runShell`'s `cwd` is now confined to the sandbox root (`options.cwd`, else the host's working directory), as the shell tool's description always said. A relative path resolves against the root. A path that leaves it (`..`, an absolute path elsewhere, a symlink or junction pointing out) or that does not exist is refused without running the command (`exitCode: null`, the reason in `stderr`). Before, the command ran wherever the path pointed. Pass an absolute `cwd` only for a directory inside the root.
  - Output cut at `maxOutputBytes` is no longer silent: the result carries `truncated: { stdout, stderr }` when a stream was cut (the new optional `CodeExecutionResult.truncated`). It is absent otherwise, as in 2.3.
  - A timeout or abort now kills the whole process tree, not just the direct child: the process group on POSIX, where each child now leads its own group, and `taskkill /T /F` on Windows. Children start with `windowsHide`. Because a POSIX child leads its own process group, a Ctrl-C at the host's terminal no longer reaches it directly.

- 49e6db0: Conditional chat persistence. `createInMemoryConditionalChatStore` (`@deuz-sdk/core/chat`), `createSqliteConditionalChatStore` (`@deuz-sdk/core/stores/sqlite`) and `createPostgresConditionalChatStore` (`@deuz-sdk/core/stores/postgres`) return a `ConditionalChatStore`: still a `ChatStore`, so it goes wherever one goes, with `conditional: true` and a revision on every chat (1 for a new chat, plus one per committed write). `readChat` returns the chat with its revision, or says it is missing or deleted. `writeChat(record, { expectedRevision })` writes only when the stored revision is the expected one (0 for a chat that must not exist yet) and otherwise answers `conflict` with what is stored, writing nothing. `tombstoneChat` and `deleteChat` replace a chat by a tombstone that no later write goes over, conditional or legacy (`saveChat` throws `RevisionConflictError` then), so a late write can never bring a deleted chat back; deleting a chat that was never written leaves a tombstone too. `pruneTombstones(before)` removes tombstones older than a time, after which the id can be used again. `updateConditionalChat(store, chatId, merge)` reads, merges and writes, re-reading and merging again on a conflict, three attempts by default (`attempts`), then throws `RevisionConflictError`. `isConditionalChatStore` tells a conditional store from a legacy one. The SQLite and PostgreSQL stores keep their data in new tables with their own `deuz_chat_conditional_schema` version table and never touch `deuz_chats`, `PRAGMA user_version` or the legacy migrate versions. The PostgreSQL store needs a pool (`pg.Pool` or compatible), or opens its own from `connectionString`. The legacy chat stores are unchanged.

  Transcript search. A `TranscriptIndex` searches past messages lexically within a memory scope and never across one: `search(scope, query, { limit, around, chatIds, before, after })` returns the matching messages with their stable message id, position and a score (the best hit scores 1), best first, and with `around` the messages on each side. Any query term matching is a hit, case and diacritics folded; system messages are not indexed. `resolveSource(scope, ref)` resolves a memory source reference (`chatId` and `messageId`) to its message under the same scope check. `createInMemoryTranscriptIndex` is the in-memory index; the SQLite and PostgreSQL conditional stores carry their own as `store.transcript` (FTS5 with a LIKE fallback on SQLite builds without FTS5; a `simple` tsvector with a GIN index on PostgreSQL) and update it in the same transaction as every chat write, and a tombstoned chat leaves it at once. `indexChat(index, record)` backfills a chat saved through a legacy `ChatStore`; a message without a stable id is indexed as `<chatId>:<index>`.

  Behaviour change for native runs whose `chat.store` is a conditional store: the chat projection is written with `writeChat` at the revision it read instead of a load followed by a save. When another writer got in between, the run reads the chat again and decides again (three attempts; then the projection is recorded as `failed` and a later save or `reconcileAgentRun` repairs it). A deletion tombstone stops the projection, from a late repair and from a run still in progress alike: nothing is written, the run's chat state is `superseded` and a `chat` warning says so. Runs with any other chat store keep the 2.3 behaviour.

  The message ids a native run gives its chat (`ChatRecord.messageIds`) survive every conditional store; pass them to `uiFromMessages(messages, generateId, { messageIds })` to render a stored chat under the same ids that a transcript hit or a memory source reference names.

- ec0e45d: **Durable streams (preview): persist before publish.** `toDeuzStreamResponse`, `toDeuzObjectStreamResponse`, `toDeuzAgentStreamResponse` and `createDeuzStream` take a new `durable` option (`DurableStreamOptions`). Every frame is committed to a `DurableStreamStateStore` before it is sent, so a client that reconnects to the resume endpoint (`resumeDeuzStreamResponse` over the same store) gets every frame once, in order, and never a frame the store lacks. Frames are committed in batches, 20 ms or 16 KiB, whichever comes first (`durable.batch.maxDelayMs` / `maxBytes`), so a token is not a database round trip. One producer writes a stream at a time: it holds the lease `stream:<streamId>` from `durable.lease.provider` (renewed every `ttlMs / 3`, 30 s by default, and released at the end), and its lease token fences the store, so a stale producer's batch is refused. A durable response fails closed instead of degrading: when another producer holds the lease or took over, when its lease is lost, when the stored log moved past it, or when the store fails, it sends nothing it did not commit, ends with an `error` frame (no event id, no `[DONE]`), stops reading its source and hands a thrown store error to `onStoreError`. `durable.deps` supplies the clock, the observer for the `deuz.stream.batch` and `deuz.stream.fenced` spans (counts, bytes, milliseconds and tokens, never content) and the default lease owner. Durable mode is off unless you set it, and the code behind it is only loaded when you do.

  **`DurableStreamStateStore` adapters.** `createInMemoryDurableStreamStateStore` (`@deuz-sdk/core/ui`), `createSqliteDurableStreamStateStore` (`/stores/sqlite`), `createPostgresDurableStreamStateStore` (`/stores/postgres`, needs a pool such as `pg.Pool`) and `createRedisDurableStreamStateStore` (`/stores/redis`, Redis 7+, the only 2.4 store on Redis). Each is also a `StreamStateStore`, so replay reads it unchanged. `open(streamId, token)` and `commit({ streamId, token, records })` refuse a token lower than the stream's highest; a batch commits whole or not at all and must continue the stored last seq. Parts are stored as their JSON text, so a replay sends the bytes the live response sent. The SQL stores create their own tables with their own `deuz_stream_state_schema` version table and change no existing schema. Redis keeps each stream under a hash tag of its own. `prune({ terminalBefore })` deletes finished streams (their last record is the `done` sentinel) whose last open, commit or append is older than the cutoff, on the store's clock; nothing is deleted in the background. A retention of 24 hours is a good default.

  **Capability handshake (server side).** Pass the request as `capabilities: { request, announce }` to a stream response or to `resumeDeuzStreamResponse`. Only when the request lists what the client understands in an `x-deuz-capabilities` header does the response announce what it supports, in the same response header and in a first `capabilities` part (no event id, never journaled, not on wire v1): `durable-stream` for a durable response or store, plus what `announce` adds. A request without the header, which is every 2.3 client, gets the same stream as before, byte for byte. `DeuzUIPart` gains the `capabilities` member; `applyUIPart` ignores it.

  **Behaviour change: a failing legacy stream store is no longer silent or destructive.** When a `StreamStateStore` cannot tell the last stored seq, a response used to number its frames from 0 again and journal them over the frames already stored. It now leaves the journal alone for that response (no records and no `id:` lines), calls `onStoreError`, and sends the client a `warning` part of type `'stream-store-error'`. When an append fails, the frames still reach the client without waiting for the store, as before, but the response now stops journaling at the first failure (so the log never holds a gap a replay would skip without a word), calls `onStoreError` once and sends the same warning. Wire v1 clients get no warning part. A response whose store fails cannot be resumed; use durable mode when it must be.

- a165c14: **Chat snapshots: `ChatSnapshotV1`, `useChat({ initialSnapshot })` and `exportSnapshot()`.** `exportSnapshot()` captures a chat as plain data you can persist with `JSON.stringify`: the canonical history (`messages`) with one id per message (`messageIds`, aligned like `ChatRecord.messageIds`), the resume cursor, the assistant turn that was still streaming, the approvals the chat is paused on (with the verdicts already given) and the client tool calls it is parked on (with the results already given; a native run's id included). `useChat({ initialSnapshot })` restores all of it, read once at mount: a verdict or a tool result after a page reload resumes the chat exactly as it would have before, and `reconnect()` or `resume.auto` continues the restored turn from the snapshot's cursor, every frame once. `setHistory` still drops pending gates. A stored chat restores as `{ version: 1, messages: record.messages, messageIds: record.messageIds }`. `initialMessages` works as before; `initialSnapshot` takes precedence when both are set, and a snapshot whose `version` is not 1 throws a `TypeError`.

  **Message ids reach the UI (H7).** Restoring renders every message under its stored id, through `uiFromMessages(messages, generateId, { messageIds })`, and the hook applies the ids itself too, so they survive next to a 2.3 core. A missing, empty or repeated id gets a fresh one from `generateId`. Messages are told apart by id, never by text: two messages with the same text stay two messages.

  **Capability handshake (client side).** `useChat` now sends an `x-deuz-capabilities: chat-snapshot-v1, durable-stream, message-ids` request header on every POST and resume read (a function `resume.endpoint` receives the value as `ctx.capabilities`). A 2.4 route that passes `capabilities: { request, announce }` answers in the same response header and in a first stream frame; the hook reads either, exposes the result as `capabilities` and records it in the snapshot. It uses a feature only once the server announced it: with `message-ids`, a resume read that re-delivers a message the history already holds (a replay that starts over) skips it instead of rendering, appending and running it twice; with `chat-snapshot-v1`, request bodies also carry `messageIds` aligned with `messages`, so the server can store the ids the UI renders; with `durable-stream`, a POST read that drops before it ends continues from `resume.endpoint` instead of ending in `status: 'error'`. A 2.3 route announces nothing, and the hook behaves exactly as in 2.3, with the same request bodies.

  **Behaviour change: one more request header.** Cross-origin chat APIs that answer preflights with an explicit `Access-Control-Allow-Headers` list must add `x-deuz-capabilities` to it, or pass `capabilityHandshake: false`, which sends no header and ignores announcements (exactly the 2.3 requests and behaviour). To read the response header cross-origin, expose it with `Access-Control-Expose-Headers`; otherwise the hook reads the announcement from the stream's first frame.

  **Deprecated: `@deuz-sdk/core/react`.** The frozen `useChat` and `useObject` hooks of the core package are deprecated in favour of `@deuz-sdk/react` and will be removed in 3.0. Their behaviour is unchanged; a development build logs one console warning per page, a production build stays silent.

- 80e229b: `@deuz-sdk/core/skills/learning` (experimental) adds `proposeSkillFromRun(options)`. It drafts an Agent Skill from one run that finished its task and passed its host's verification. The draft is a proposal only: its `status` is always `'proposed'` and its `evaluation` always `'not-evaluated'`. The source condition describes the task, not the skill, so verification of the run says nothing about whether the skill works. The helper writes no file, changes no skill registry, and never evaluates or activates the skill. Storing, reviewing and testing the draft is up to you.

  The source run must be terminal, completed and verified (`verification: 'verified'`, on a 2.3 or a V3 envelope). Any other run is refused with `SkillLearningError` code `source_not_eligible` before a model is called. The model never sees the raw transcript. It reads a numbered projection (`S1`, `S2`, …) of the run's user-facing turns: the transcript without the turns the SDK wrote (recall, finalization, output repair, verifier feedback), or, for a run without a transcript, its history without the SDK's own fixed turns. System messages, reasoning (plain, encrypted or redacted), provider metadata, images, compiled context blocks and compaction summaries are left out. Raw tool results are left out too: a result is shown as `omitted` unless you pass a summary for its tool call in `toolSummaries`. A projection longer than `maxSourceChars` (default 32 000 characters) is refused with `source_too_large`; it is never cut.

  The helper makes one model call with no transport retry and no tools, capped at `maxOutputTokens` (default 2048), plus optional `instructions`. `budget` is required and needs a `tokens` or `usd` bound. The call is charged to a ledger of its own, separate from the source run's closed accounting, and a budget that cannot hold the call rejects with the ledger's `budget_exceeded` error before any request. `cost` reports the model id, the usage and, when `deps.priceProvider` prices the model, `costUsd`. Calling again makes a new call and may cost again: there is no exactly-once or single-draft guarantee.

  The model's answer is checked, never repaired. Every method step must cite at least one item of the projection and no item the projection lacks. Each step's `sources` carry the run id, the message id (the id the message keeps in the run's chat projection, otherwise `<runId>:<index>`), the tool call id and model step when known, and the `sha256:` digest of the cited item. The suggested `allowedTools` must be a subset of the tools the run used, meaning calls the run made itself that a completed receipt backs (a call only in the input history never counts); the model can never add a tool permission. The `skillMd` text must pass `parseSkill`: a name matching `^[a-z0-9-]{1,64}$` without "anthropic" or "claude", and a description of at most 1024 characters. A draft that fails any of these checks, or that was cut off or refused, is rejected with `invalid_proposal`. The `SKILL.md` frontmatter holds `name`, `description`, `allowed-tools`, `deuz-status: proposed`, `deuz-evaluation: not-evaluated` and `deuz-source-digest`, and the body has Method, Limitations and Sources sections. `source` records the run id, scope and revision, and the digest of the projection.

  The module is edge-safe. Its model call loads the core pipeline only when you make a proposal.

- b8e5d5f: When SQLite has already rolled back a failed transaction, the SQLite ops store (`createSqliteOpsStore`) used to throw the error of its own `ROLLBACK` ("cannot rollback - no transaction is active") instead of the error that failed the transaction. It now rethrows the original error, as the SQLite store pack (`createSqliteStores`) already did. A second `close()` made while the store is still waiting for its calls to finish now resolves only once the database is closed, instead of at once. Both stores now open, configure and close their database through one shared module. Their schemas, schema versions and other behaviour are unchanged, so 2.3 still opens every file they write.
- a636ade: **`ObservedSubsystem` is widened** with five members for the 2.4 subsystems: `'context'`, `'goal'`, `'schedule'`, `'process'` and `'stream'`. Their operations arrive as the existing `operation.started` / `operation.completed` / `operation.failed` events, named by their span (`deuz.context.compile`, `deuz.memory.op`, `deuz.goal.*`, `deuz.schedule.delivery`, `deuz.process.*`, `deuz.stream.*`). The three `operation.*` events gain an optional `attributes` field: scalar counts, ids, digests, token values and small enums under `deuz.<subsystem>.*` keys, never content. `createOtelObserver` copies them onto the operation's span. Code that switches over `ObservedSubsystem` should keep a default branch.

  `createOtelObserver` no longer loses track of a run when an operation happens inside it. Before, the end of any `operation.*` span dropped the state of its whole execution leg, so a run with built-in `memory` (whose recall reports a `memory.recall` operation) never ended its `invoke_agent` span, and the run's later model and tool spans lost their parent. Now only a standalone operation, one that runs outside any run, is forgotten when it ends.

  **`GoalErrorCode` is widened** with four members: `'delivery_conflict'` (a webhook delivery id seen before with another payload or target, thrown by the webhook handler and `supervisor.dispatch`), and `'lease_lost'`, `'stale'` and `'policy_limit'`, which are reserved: nothing throws them in 2.4. The goal supervisor reports a lost lease and a spent run or retry limit as its `lease-lost` and `policy-limit` events, and a write from an outdated view as `revision_conflict`. Code that switches over the union should keep a default branch.

  The budget ledger types gain optional `unaccounted` fields: `BudgetReservationInput.unaccounted` and `BudgetReservation.unaccounted` mark an attempt that runs through a callback reporting no usage (a plain memory LLM or embedder callback), and `BudgetTotals.unaccounted` counts such attempts. Such a call is never counted as free: its estimates stay held as unknown amounts.

  `@deuz-sdk/core/ui` exports the capability handshake a 2.4 server uses to announce its chat and stream features: the `x-deuz-capabilities` header name (`DEUZ_CAPABILITIES_HEADER`), the capability strings (`DEUZ_CAPABILITY`: `'message-ids'`, `'chat-snapshot-v1'`, `'durable-stream'`, `'conditional-chat'`), `formatDeuzCapabilities` for the header value and `parseDeuzCapabilities` for reading it off a `Request`, `Response` or `Headers`. A response without the header comes from an older server, and a client keeps its 2.3 behaviour with it.

- ff37b44: A native memory extraction that wrote only part of its memories is no longer reported completed. `reconcileAgentRun` used to settle an interrupted extraction as `'completed'` as soon as one record of its operation was in the memory store, so the facts the pass never wrote were lost without notice. A native run now saves how many store mutations its extraction planned on the extraction record (the new optional `AgentRunMemoryExtraction.planned`) before it writes any memory, and writes nothing when that save fails (the extraction is then `'failed'` and a later `reconcileAgentRun` runs it again). Deletions, which leave no record to find, are applied first and counted in `mutations`. `reconcileAgentRun` records the extraction `'completed'` only when every planned mutation is confirmed. When only some are, the extraction is recorded `'failed'`, keeps the confirmed count in `mutations` and an error with code `'memory-extraction-partial'`, is never run again, and the call reports a `memory-extraction-partial` warning on the new optional `AgentRunReconciliation.warnings` (and to `deps.logger.warn`). The extraction status union is unchanged. An extraction record a 2.3 process left without a planned count is settled as before. **Behaviour changes:** a record that a native extraction updates now carries that extraction's `metadata.deuz` run and operation ids instead of the ids of the operation that wrote it before; a native run saves its record once more per extraction (twice more when it both deletes and writes records); and a completed reconciliation no longer keeps the error of an earlier failed attempt.

  `applyMutations(store, mutations)` is exported from `@deuz-sdk/core/memory`. It applies a plan from `remember(..., { apply: false })` or `planMemory` exactly as `remember` applies it: every upsert in one `upsert` call, then every delete in one `delete` call, then each invalidation.

  `uiFromMessages(messages, generateId, { messageIds })` keeps the ids a stored chat gave its messages. Pass `ChatRecord.messageIds` (ids aligned with the canonical messages, as a native run's chat projection writes them) and each UI message keeps the id stored for its canonical message. `generateId` covers a message without an id (a missing or empty entry) and an id an earlier message already kept. The two-argument call is unchanged.

  **`CallWarning['type']` is widened** with five members that 2.4 reports: `'embedding-mismatch'`, `'unaccounted-usage'`, `'context-source-failed'`, `'stream-store-error'` and `'memory-extraction-partial'`. Code that switches over the union should keep a default branch, as the `'other'` member already asks.

## 2.3.0

### Minor Changes

- d6e42f8: Native runs (`runAgent`, `streamAgent`, `resumeAgent`) put MCP tools behind the same effect receipts as local tools. An MCP call records `executing` before the server is called, so a resume after an interrupted call stops with `tool-reconciliation-required` instead of calling the server again and repeating the paid model turn. Each call emits a native `tool-output` event, and tools that arrive through a `tools/list_changed` hot refresh are covered too. The servers' tool catalog is pinned in the resume binding as `AgentRunEnvelope.binding.mcp` (the `fingerprintTools` JSON). A resume whose catalog gained, lost or changed a tool fails with `MCP tool catalog changed across resume (...)` and leaves the stored run untouched. A hot refresh mid-run records the new catalog before the model is offered it and reports the change as a `warning` part with `setting: 'mcp'`. A run checkpointed before 2.3 records the catalog it is resumed with. An `mcp` entry may declare `replay: 'idempotent'` for the whole server, or per tool by the server's own tool name, so an interrupted call of that tool runs again on resume (`AgentMcpEntry`, `AgentMcpReplay`; `AgentRunOptions.mcp` widens to accept them). The declaration never enters the connection pool key. An MCP tool's raw JSON Schema `outputSchema` stays metadata, because the MCP client validates structured results, instead of failing native preparation. The servers are connected after a terminal run has returned and before anything is persisted: a terminal run never reconnects, and an unreachable server fails a fresh run before its first checkpoint or model call. `ResolvedMcpRuntime` gains an optional `origins` map (entry index and server tool name per merged tool).

  Native tool receipts gain an additive `'failed'` stage (the `AgentToolReceipt['stage']` union widens). A tool whose `execute` threw has already answered the model with that error, so a resume replays the recorded error instead of stopping for reconciliation; `'executing'` still means an unknown outcome. Receipts also gain an optional `idempotent` flag, the replay policy of the tool that ran the call, and a resume judges an interrupted call by it rather than by tool name: a handoff target's own tool that shares its name with an idempotent root tool stops for reconciliation instead of failing the run, and a target tool declared `replay: 'idempotent'` runs again. Receipts written before 2.3 are still judged by name. Handoff transfers now work in native runs: native tool preparation dropped the transfer marker, so the transfer tool's throwing body ran instead of handing the run over. A target agent's own tools carry the same receipts. The resume binding records each reachable target's name, model, instructions and tool schemas as the new optional `AgentRunEnvelope.binding.handoffs`, so a resume rejects a changed target with `Native agent binding changed across resume.` as it rejects a changed root tool, and an approval granted for the old target tool never runs the new one; an envelope written before records its targets on its next resume. After a transfer, the target's model also answers the finalization request and any verifier re-drive, and a finalization resumed on its own offers the target's tools.

  A turn the provider refused (`content_filter`, Anthropic `stop_reason: 'refusal'`) or cut off (`length`, `max_tokens`) no longer dispatches its tool calls in `generateText`, `streamChat` or native runs, because their arguments can be truncated JSON. A tool call whose arguments are not a JSON object is never executed and self-heals into an `is_error` result. An empty assistant turn is never stored or sent back, and `doneWhen` and `verifyStep` do not re-drive such a turn. A provider's stop explanation is surfaced as `StopDetails` on `GenerateTextResult.stopDetails`, `StepFinishPart.providerMetadata`, the streaming loop's `finish` part and `AgentResult.stopDetails`. A native run that ends on a refusal stops with the new reason `'refusal'` instead of the raw `'content_filter'`.

  The finalization request of a native run with tools and `output` ends with a user turn instead of the loop's last assistant answer, a prefill that Claude 5.x models reject with HTTP 400 (inferred from Anthropic's documented rules; not live-verified). That turn is persisted once, so the transcript stays append-only. Finalization asks for the loop's own tools with `tool_choice: 'none'`: a text re-drive after a rejected verdict sends them today, and a structured request will once the provider adapters send tools alongside the output format. The stored answer is the full assistant message, reasoning included.

  Native runs re-check cancellation and the execution deadline after async output validation, guardrails and the verifier. An abort during verification stops the run with reason `'aborted'`, also when the verifier throws because of it, instead of completing or reporting `verification-inconclusive`. A deadline that elapsed during verification fails the run with the same `ExecutionPolicyError` that model and tool dispatch raise. A completed result that was already committed is never rewritten.

  Envelopes written by 2.2 still resume. A run that 2.3 saved with an MCP catalog or handoff targets in its resume binding needs 2.3 to resume: 2.2 compares the whole binding and refuses `binding.mcp` and `binding.handoffs` with `Native agent binding changed across resume.`, also in a version 1 envelope. A run whose stored turn leaves a call open with a `'failed'` receipt (its process stopped before the step that answers the call was saved) is saved as version 2, which 2.2 refuses, because 2.2 does not know the stage and would answer the call with no result; once a checkpoint answers the call, the envelope is version 1 again. `resumeAgent` refuses an envelope holding a loop or sub-agent checkpoint whose `version` is not 1 with `CheckpointVersionError` before it writes anything, so the stored run stays resumable by the SDK that wrote it.

- 953d71e: Every tool call now takes one path, in one order: the finish-reason gate, the policy, the approval gate, admission, the effect receipt, execution, `onToolResult` and the step checkpoint. The buffered loop, the streaming loop and the resume settle share a single implementation of everything before execution, and the same path serves local tools, MCP tools (at connect, after a hot refresh, with an `outputSchema`), handoff transfers, swarm blackboard tools, the calls of spawned swarm tasks and of sub-agents, and the model calls of evolve mutations and MCP sampling requests. A tool that `prepareStep` puts on the wire, or that an MCP refresh brings in, is gated like any other.

  **Behaviour change:** the execution policy is decided for the whole batch before the guardrails and the approval gate. A call it forbids still fails the run with `ExecutionPolicyError`, but no human is asked first to approve it under `requireApproval`, no sibling call starts and no receipt is written. The error names the call (`ExecutionPolicyError.toolCallId`; `ExecutionPolicyCheck` gains `toolCallId`), and `streamChat` and native runs report it as a `tool-state` part before the `error` part. A native tool is admitted (policy, deadline, cancellation) before its `executing` receipt is written, and again after the write as before, so a call refused up front never reads as an effect of unknown outcome.

  **Behaviour change:** an approval is bound to the call it was issued for. `approvalId` is now the tool call id followed by a digest of the durable run, the step the run suspended at, the sub-agent path, the call id, the tool name and the arguments (a call without a `session` binds the call, the tool and the arguments, because a chat UI folds a request's steps into one assistant turn). A verdict answers a call only under that id, and a signed token must name it, so a verdict kept from an earlier gate never approves another tool, other arguments, or the same call again at a later step, also with providers that number their calls `tool_0`, `tool_1`, … in every response. Answer with the `approvalId` you were given, as the docs always showed. A verdict that names only the tool call id (the 2.2 form) still counts when the run used that id once, so runs suspended before 2.3 and clients that build verdicts from `toolCallId` keep working there. "Once" means the id occurs once in the history and the run issued one approval request under it: the new optional `AgentCheckpoint.approvalRequestCounts` keeps that count over every leg, so compaction or a `prepareStep` window that drops the earlier call from the history cannot make a reused id look unique. A checkpoint written without the count still resumes, and its history decides. A native resume whose verdicts do not answer every pending approval stays suspended, as before.

  **Behaviour change:** a plain call that continues a stored durable run (its `session.runId`, without `resumeFromCheckpoint`) continues the run's step counter instead of starting again at 1. `AgentCheckpoint.stepIndex` is then monotonic over every leg, as documented, and an approval bound to a step is never issued again by a later leg, so a verdict kept from an earlier turn cannot approve the identical call of a later one. The call reads the run's checkpoint once before its first step: a failed read is logged and the leg counts from 0, and under `durability: 'strict'` the call fails instead.

  **Behaviour change:** handoff transfers take the policy and the approval gate like any call. The `onToolCall` guardrails see them, and `requireApproval` or a `needsApproval` on a transfer tool gates them; a refused transfer is answered with its denial and the run stays with the current agent, and a transfer waiting for a verdict suspends the run. A transfer tool must be in an `allowedTools` allowlist to be used.

  **Behaviour change:** a sub-agent (`agentTool`) inherits the parent run's `onToolCall` and `onToolResult` guardrails, through the new `ToolExecuteContext.guardrails`, so its own calls cannot step outside the parent's tool policy. It already ran under a child of the parent's execution context and inherited its approver; tests now pin that a sub-agent, a handoff target and a spawned swarm task only narrow the run's tool and model allowlists, deadline, cancellation and budget.

  Each way a tool call can end is distinguishable. The new `ToolCallOutcome` (`'success'`, `'tool-error'`, `'permission-denied'`, `'approval-denied'`, `'approval-pending'`, `'unknown-effect'`) is set as `outcome` on error results (`ToolResult.outcome`, `ToolResultStreamPart.outcome`) and on `ToolStatePart` (a terminal `'error'`, and `'awaiting-approval'`); a successful result carries none, as before. A native resume that stops with `'tool-reconciliation-required'` lists the receipts of the unknown effects in the new `AgentResult.unknownEffects` and streams a `tool-state` part for each. Model errors and refusals keep ending the run (`error` part and `failed`; `content_filter` finish and stop reason `'refusal'`).

  MCP name collisions are no longer silent: a local tool that shadows an MCP tool, and two servers that expose the same name, are reported as `CallWarning { type: 'unsupported-tool', setting: 'mcp' }` on the call's `warnings` and as `warning` parts, in native runs and in the tool loop. `McpResolveDeps` gains an optional `warn`; without it `resolveMcpForLoop` logs the line as before.

  A server that changes its tool catalog mid-run is governed by `onCatalogChange`. **Behaviour change:** a native run (`AgentRunOptions.onCatalogChange`, type `AgentMcpCatalogChange`) defaults to `'stop'`: it ends with reason `'mcp-catalog-changed'` before the model is offered the new catalog, and keeps the catalog it is bound to. `'accept'` records the new catalog in the resume binding and carries on. `generateText` and `streamChat` default to `'accept'` and now report the change as a `warning` (`setting: 'mcp'`); `onCatalogChange: 'stop'` ends them with `stoppedBy: 'mcp-catalog-changed'`. An announcement that changed nothing does neither, and the refresh now runs before a step starts, so a stop never counts a step that did not happen.

  `McpSamplingOptions` gains `execution` and `deps`: a server's sampling request checks the run's execution policy before `approve` asks anyone, and is reserved on the context's ledger like the run's own model calls.

  The retry, idempotency and reconciliation options of a native run are documented and tested together: a store failure between a call's `executing` and `completed` receipts stops the resume for reconciliation without repeating the call or the model turn; `retryToolCallIds` runs exactly the listed calls once more; a `replay: 'idempotent'` tool runs again by itself under the same `[modelStep, toolCallId]` identity; a receipt that could not be written means the effect never ran.

  All type changes are additive: `ToolCallOutcome`, `AgentMcpCatalogChange`, and optional fields on `ToolResult`, `ToolResultStreamPart`, `ToolStatePart`, `ToolExecuteContext`, `AgentResult` (stopped), `AgentRunOptions`, `AgentCheckpoint`, `ExecutionPolicyError`, `ExecutionPolicyCheck`, `McpSamplingOptions` and `McpResolveDeps`. No public union is widened. The checkpoint keeps `version: 1`: a 2.2 process reads a checkpoint that carries `approvalRequestCounts` and ignores the field.

- 02e37e0: A structured-output request keeps the conversation's tools. When a json-strategy request carries tools, the Anthropic, OpenAI Chat Completions and OpenAI Responses wires now send them with the requested `tool_choice` beside the output format (`output_config.format`, `response_format`, `text.format`); every adapter used to drop them. The finalization of a native run with tools and `output` asks with the loop's own tools and `tool_choice: 'none'`, so its request prefix stays the loop's for the prompt cache and preserved thinking. The tool strategy still sends only its own forced output tool. Gemini's native wire keeps sending the JSON schema alone, because `@google/genai` documents no request that combines function declarations with a response schema; with `'none'` the model could not call them anyway, and any other drop of callable tools is reported as an `unsupported-tool` warning. Request shapes follow the official SDK types (`@anthropic-ai/sdk` 0.133.0, `openai` 7.32.0, `@google/genai` 2.28.0). Not live-verified, and an OpenAI-compatible host may not accept a format and tools in one request.

  The provider's explanation of a stop (`StopDetails`, such as a refusal's category) is now reported on every result, with the same normalization as `GenerateTextResult.stopDetails`. `StreamChatResult` and `StreamObjectResult` gain an optional `stopDetails` promise that settles with `finishReason`: `undefined` when the provider explained nothing or you aborted, rejected when the call failed. `streamObject` resolves it before the final validation, so a refused structured request is explained even though `object` rejects with `NoObjectGeneratedError`. `GenerateObjectResult` and `StepResult` gain an optional `stopDetails` value, and each entry of `generateText`'s `steps` carries its own. A `streamChat` run with tools reports its last step's explanation, and `fallbackModels` and `wrapModel` middleware chains forward it.

  `streamObject`'s `warnings` no longer hangs when the call fails. It resolves with the notices collected before the failure, as declared.

  Anthropic usage that reports `usage.iterations` (server-side fallback, compaction, server tool loops) keeps `serverToolUses` and the `reasoningTokens` share. The iteration entries carry token counters only, so summing them lost both; they now come from the top-level usage, and the reasoning share never exceeds the summed output. A `priceProvider` that bills server tool calls per call is charged for them again.

- c8a6a7b: A2A. The new edge-safe, dependency-free `@deuz-sdk/core/a2a` speaks the Agent2Agent protocol, version 1.0.0, over its JSON-RPC and HTTP+JSON bindings, in both directions.

  `fetchAgentCard(url)` reads an agent's card from `/.well-known/agent-card.json`, and `createA2AClient({ card })` talks to the first JSON-RPC or HTTP+JSON interface the card declares for A2A 1.x (or `createA2AClient({ url, binding })` without a card): `sendMessage`, `sendStreamingMessage` (SSE), `getTask`, `cancelTask` and `subscribeToTask`, with `A2A-Version: 1.0` on every request, the interface's tenant, static or per-request `headers` and requested `extensions`. Messages are a string, a list of parts or a draft; answers and stream events are the wire's own shapes, with numeric enum values named. Every failure is an `A2AError` with a `kind` (`protocol` with the A2A `reason` and JSON-RPC code, `http`, `network`, `invalid-response`); an aborted `signal` rejects with `AbortError` at once, even through a `fetch` that ignores it.

  `createA2AHandler({ card, executor })` serves an agent as a fetch-style handler (`Request` in, `Response` out): the card at `/.well-known/agent-card.json`, and every JSON-RPC or HTTP+JSON interface the card declares for A2A 1.0 at its URL's path. It answers `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask` and `SubscribeToTask`, checks `A2A-Version` (a missing header is read as 0.3 and refused, as the official SDK's server does), and maps every refusal onto the A2A error codes with a `google.rpc.ErrorInfo` detail (JSON-RPC) or a `google.rpc.Status` body (HTTP+JSON). `ListTasks`, push-notification configs and the extended card answer as unsupported. Each incoming message is one turn of the executor, which drives the task through its context: `working`, `artifact` (with `append`/`lastChunk`), `requireInput`, `requireAuth`, `complete`, `fail`, `reject`, or a task-less `reply`. A new interaction gets its task at the first update; a message to an `INPUT_REQUIRED` task starts the next turn with `ctx.task` set; an executor that returns mid-task completes it and one that throws fails it, unless it throws an `A2AError` of its own before changing the task, which answers the request with that error and leaves the task as it was (a refused follow-up message is not kept in its history). An `A2AError` from a `createA2AClient` call inside the executor is another agent's answer, never sent on as this agent's own: it fails the task like any other error (and answers `INTERNAL_ERROR` from `executor.cancel`). `CancelTask` asks an optional `executor.cancel` (which may refuse with `TASK_NOT_CANCELABLE`), then cancels the task, ends its streams and aborts `ctx.signal`. Tasks live in an `A2ATaskStore` (`createInMemoryA2ATaskStore` by default), kept apart per A2A tenant and per caller with `owner(request)`: the handler does no ownership check of its own, so a store keys every task by that scope and its id, as the default one does and a custom one must. `a2aText` reads the text out of a message or an artifact.

  Not live-verified against third-party agents: the wire was derived from `@a2a-js/sdk` 1.3.0, and both halves are tested offline against that SDK in both directions — its client against the handler in-process, and the client against its server over JSON-RPC in-process and over HTTP+JSON through its express handlers on 127.0.0.1. The gRPC binding, A2A 0.3, push notifications, `ListTasks` and signed cards are not included; a native agent is served through `createA2AAgentExecutor`.

- 2092d45: A native agent run can be served over A2A. `createA2AAgentExecutor({ agent: { streamAgent, resumeStreamAgent }, store, run })` in `@deuz-sdk/core/a2a` is an executor for `createA2AHandler` that runs each task as one native run: the task id is the run id, and the task's tenant and owner name the run's scope (`scope` maps them; the default is the JSON of `['a2a', tenant, owner]`), so a run is resumed only in the scope that created its task. The engine is passed in, so `@deuz-sdk/core/a2a` stays edge-safe and does not bundle it for an app that only calls agents.
  - **A new message** starts the run, with the message as its one user message: text parts as text, data parts as JSON text, `image/*` files as images. Any other file is refused with `CONTENT_TYPE_NOT_SUPPORTED` before a task exists, unless `run` builds the input itself (`prompt` or `messages`). `run` is the run's options, or a function of the turn that returns them; options the executor sets on every leg itself (`session`, `lease`, `signal`, `abortSignal` and the resume answers) are refused: an object's when the executor is created, a function's on its turn.
  - **A suspended run** is an `INPUT_REQUIRED` task. Its status message carries a text part and a data part `{ type: 'pending-actions', actions }` listing each pending approval (`approvalId`, `toolCallId`, `toolName`, `input`, `token?`, `agentPath?`) and each pending client-tool call (`toolCallId`, `toolName`, `input`). The client answers every action in one message, in data parts `{ approvalResponses, clientToolResults }` with the shapes `resumeAgent` takes, and the run resumes. The answers are checked against the run before anything is written: an unknown id, the wrong kind of answer, a duplicate, an action left open, an approval of a signed action (`approvalSigner`) that does not echo its own `token`, a malformed part or a file is refused with `INVALID_PARAMS`, and the task and the run stay as they were. A message without answers is refused the same way while the task's status lists the actions; when it does not (a person resumed the run outside A2A and it suspended again), the task lists them again and no leg runs.
  - **A completed run** stores its validated output, and only that, as the `output` artifact: a text part for a string output, a data part (`application/json`) for a typed one. Then the task completes.
  - **A stopped run** puts the task in `INPUT_REQUIRED` with a data part `{ type: 'stopped', reason, stopDetails?, unknownEffects? }`. A drained run (`'drained'`: a `'drain'` signal on the run's lease, as in a rolling deploy) has not ended, and the client's next message resumes it; a drain that stopped a resume before it took the answers up leaves the run waiting for them, and the task lists them again as `pending-actions`. After `tool-reconciliation-required`, once a person has settled the unknown effects with `resumeAgent`, the client's next message picks the run up: it resumes the run, or lists what the run waits for when that resume left it suspended again. At any other stop a person must look at the run, and a message is refused with `UNSUPPORTED_OPERATION`. A stop a cancellation caused cancels the task.
  - **A failed run** fails the task with a text that names the run's error by its code, or its name (`The agent run failed (rate_limit).`), or with what `failureMessage` returns from the whole error, and a data part `{ type: 'failed', error: { name, code? } }`. A resume that fails before it begins, having written nothing, refuses the message instead, and the task keeps waiting: `UNSUPPORTED_OPERATION` while another executor holds the run's lease, `INTERNAL_ERROR` otherwise (a changed run definition, a store that could not be read). By default the client never reads an error's message, which can name a provider account, a database host or a user: a task store that fails an update fails the task with `The agent could not update the task.`
  - **Streams** carry `WORKING` once a leg runs, the text of a string output as unstored drafts of the output artifact, then the stored artifact and the final status. A typed output is never sent in part. A draft is the model's text before `guardrails.onOutput` rewrites or blocks it, so a run with output guardrails sends none; the executor's `drafts` option sends them anyway (`true`) or never (`false`).
  - **Cancellation:** `CancelTask` aborts a run whose turn runs on this instance. With `lease`, every leg claims the run's lease, canceling a task whose turn runs on another instance signals that lease, and a lease cancel from outside A2A cancels the task. Canceling a task that waits for input leaves its run as it is, suspended or drained; `findStaleAgentRuns` lists a drained run, so a sweeper that resumes stale runs must skip the runs of canceled tasks.

  Tested in-process with the `@a2a-js/sdk` 1.3.0 client over JSON-RPC and HTTP+JSON (an approval answered in a data part, the typed output as a data artifact, a streamed turn, a cancel); not live-verified against third-party agents. A keyless example is `examples/20-a2a-agent`.

  The A2A handler, new in 2.3, also gains:
  - **`ctx.draft(artifact, { append? })`**, which streams an artifact update to the clients following the turn without storing it: a preview, such as text while a model writes it. `GetTask`, a blocking `SendMessage` and a later `SubscribeToTask` never see it, and the finished content stored with `ctx.artifact` under the same `artifactId` replaces it.
  - **A non-blocking follow-up that reaches its client's refusal.** A follow-up `SendMessage` with `configuration.returnImmediately` is answered at the executor's first update, at the end of a turn that changes nothing, or with the executor's refusal, never with the task as it stood before the executor ran. An `A2AError` the executor raises first reaches the client over both bindings, and no client is handed a task holding a message the agent then refused.
  - **Only a status update ends or interrupts a turn**, as in the official SDK. A follow-up turn's task keeps the previous turn's `INPUT_REQUIRED` (or `AUTH_REQUIRED`) until the executor changes its status, so an artifact added first ends nothing, and a blocking follow-up on an `AUTH_REQUIRED` task is answered at a status update, not at an artifact.

- ee36c2f: Usage and pricing bill every token once. All four model wires now report `outputTokens` with reasoning included and `reasoningTokens` as its share, so `priceUsage` no longer adds reasoning on top: an OpenAI Responses turn with 100 input and 1,000 output tokens (800 of them reasoning) at $2/$10 now costs $0.0102 instead of $0.0182, and Anthropic turns that carry a `thinking_tokens` detail are no longer overcharged. Gemini native reports `outputTokens` as candidates plus thoughts, and its fallback total counts thoughts. `audioTokens` is a share of the input and output buckets and is no longer billed a second time; a row's `audio` rate re-prices that share from the input rate. The Chat Completions wire reads DeepSeek's `prompt_cache_hit_tokens` and Moonshot's top-level `cached_tokens` as cached reads, and both OpenAI-shaped wires fold reasoning into `outputTokens` when a host counts it beside the output. Usage built in the 2.2 shape, with `reasoningTokens` above `outputTokens`, still prices both counters.

  Price lookup is explicit: an exact row, then the new `PRICE_ALIASES`, then both again after dropping one vendor prefix (in any case, so `Qwen/…` works) and a trailing snapshot date. It no longer falls back to the longest matching prefix or strips `-latest`, `-preview`, `-fast`, `-exp` or `-all`, so `claude-opus-5-5` stops pricing as Opus 5 and new or invented ids such as `kimi-k2.7-code`, `sonar-reasoning-pro` or `grok-4.1-fast` return `undefined`; map your own with `createPriceProvider({ aliases })`. Inherited keys such as `constructor` no longer price as `NaN`. `ModelPrice.tiers` takes any number of long-context cards (`{ above, input, output, … }`) beside `over200k` and `over272k`. New rows, checked against Anthropic's Claude API reference on 2026-10-06: `claude-opus-5-5` ($4/$20), `claude-sonnet-5-5` ($2/$10) and `claude-haiku-5-5` ($0.10/$0.50 up to 100K prompt tokens, $0.50/$2.50 above). `claude-sonnet-5` is corrected from $3/$15 to $2/$10, and `gpt-6.1-sol` ($2/$10) is added with research-dated rates. The OpenAI rows drop their explicit cache-write rates, since OpenAI usage reports no cache-write counter; their prices are unchanged.

  A call whose usage the provider did not report now has an unknown cost on every path, as the native ledger already treated it: no usage counters, or a stream that ended before its usage arrived. `UsageMeta` gains the optional `usageAvailable`, `false` for such a call, so `onUsage` can tell its zeros from a free call. **Behaviour change:** the agentic loop without an execution context no longer counts such a call as $0, so it emits no further `cost` parts and its `budget.usd` and `costExceeds` stops wait instead of counting on, as after a failed price lookup; a single `streamChat` call emits no `cost` part for it.

- f126361: Native budget reservations now cover what the provider can actually bill. A call used to reserve `maxOutputTokens ?? 4096` output tokens while the request asked for `maxOutputTokens` or the model's full `maxOutput`, and Anthropic raises even an explicit cap to the thinking budget plus 1 024. Parallel calls could therefore spend far past a USD budget (a $0.50 budget admitted $10). The reservation now prices the output cap the wire sends, reasoning included, and prices a prompt the call caches at the cache-write rate on Anthropic, the only wire that writes a cache; elsewhere it stays input, long-context tiers included. A row that documents no output limit (an unknown model, and rows such as `gpt-6-astra`, `gpt-5.6` and `gpt-5-pro`) sends no cap on OpenAI Chat Completions, OpenAI Responses and Gemini native; under a token or USD bound, in the context's budget or a persistent scope, such a call now sends the row's 4 096-token placeholder as `maxOutputTokens`, reserves exactly that and reports a `clamped-setting` warning on `maxOutputTokens`, so its reservation stays a bound. A call without a bound still leaves the cap off. Because reservations are larger, a call without `maxOutputTokens` on a large-output model can now be refused with `budget_exceeded` under a small USD budget; set `maxOutputTokens` to fit the budget. Admission remains an estimate, not a provider-enforced cap.

  A model with no price no longer breaks USD budgets. A model is unpriced when no `deps.priceProvider` is configured or the provider returns `undefined` for it. **Behaviour change:** under a USD budget, native runs (`runAgent`, `generateText`/`streamChat` with an execution context, swarms, `evolve` and `BudgetStore` admission) used to refuse such a call with `missing_reservation` before any model call. They now run it: its tokens are still reserved, bounded and settled, its cost is left out of the USD totals (`totals().unpriced` counts these calls, which stay in `unknownUsd`), and each leg of a run reports the new `unpriced-model` warning once per model (a resumed leg reports it again; runs that share one execution context each report it; a swarm or `evolve` run reports it once for all its tasks in each leg). **`CallWarning['type']` is widened with `'unpriced-model'`.** Set `budget.unknownPrice: 'reject'` to keep the old fail-closed behaviour: the call is then refused before it is sent, with `BudgetLedgerError` code `unpriced_model` (`BudgetLedgerErrorCode` is widened with `'unpriced_model'`). The policy lives on `BudgetLimits` (`unknownPrice?: 'warn' | 'reject'`, type `UnknownPricePolicy`), so it applies to every budget: contexts and their children, swarm, task and reducer budgets, `evolve`, and persistent scope limits; `'reject'` always wins when budgets intersect. A price lookup that throws still fails a USD bound closed. In the agentic loop without an execution context, one unpriced call used to switch `budget.usd` and `costExceeds` off for the rest of the run; unpriced calls now add nothing to the cost and the priced calls keep counting. The loop's `budget` covers every model it calls, a compaction `summarizeModel` and an `agentTool` sub-agent's model included; under `'reject'` the run fails with the new `UnpricedModelError` (code `unpriced_model`, fatal to the run like `BudgetLedgerError`) before the first unpriced call.

  Unpriced holds close. In a `BudgetStore`, an unpriced call settles its token hold to the actual usage and holds no USD; a call reserved with a caller `executionEstimate.usd` for a model that turns out to have no price settles that estimate as its charge instead of keeping the hold forever.

  Settlements survive a failing store. The native request forgot an attempt's request ID before settling it, so a failed settlement left the hold at its estimate with no way to find it. The ledger now tries a failing settlement or release three times, the native request keeps the request ID until the ledger accepts the write and gives a failed settlement one more round of three, completing the call normally when that round closes the hold, and the final `admission_failed` error carries `requestId` and, for a settlement, `settlement`, which `ledger.settle(error.settlement)` replays once the store is back. A settlement or release that the store refuses with `reservation_conflict` found its hold already closed, for example by a `sweep` that got there first: it is neither retried nor reported, the local entry closes, and the store keeps the sweep's amounts.

  Each warning is reported once. A warning a call records through a logger-backed sink (`generateObject`, `streamObject`, the agentic loops, native finalization) was logged twice, and one recorded after the sink's 50-entry list cap was not logged at all; both now log one line. A streaming loop no longer streams a warning its step's own stream already carried, and the `unpriced-model` warning reaches the stream ahead of the model's output, also when the run's only model call meets the model.

  Additive types: `BudgetLimits.unknownPrice`, `UnknownPricePolicy`, `BudgetAmounts` (the `{ tokens, usd }` shape that `BudgetTotals` and `BudgetAggregate` used to type as `Required<BudgetLimits>`), `BudgetReservationInput.unpriced`, `BudgetReservation.unpriced`, `BudgetTotals.unpriced`, `BudgetAggregate.unpricedUsd`, and `BudgetLedgerError.requestId` and `.settlement`. Snapshots gain only optional fields; a 2.2 reader that restores one keeps failing a USD bound closed on unpriced entries.

- 812511c: New `@deuz-sdk/core/batch`: provider batch APIs for single-turn requests. `createBatchClient({ model })` sends a batch to OpenAI (the requests go up as a JSONL file through the Files API, then a 24-hour batch on `/v1/responses` or `/v1/chat/completions`), Anthropic Message Batches or Gemini batch mode (`batchGenerateContent` on the Developer API), and `submit`, `status`, `wait`, `cancel`, `results`, `collect` and `pending` follow it. A lifecycle call that fails before or while its answer arrives throws the retryable `NetworkError`, as a model call does, and `wait` polls again after it as after a 429 or a 5xx. Every request body is built by the model's own wire adapter with streaming off, so a batch request follows the same request rules as `generateText` / `generateObject` (effort mapping, sampling restrictions, output caps, structured output, OpenAI `store: false`). Requests take `prompt` or `messages`, `instructions`, the sampling options, `effort`, `providerOptions`, `promptCaching` and a structured-output `schema`; tools and other agentic-loop options are refused. `results` yields one normalized `BatchResult` per request as the provider's result file is read: `status` (`succeeded`, `errored`, `cancelled`, `expired`), text, reasoning, the parsed and validated `object`, finish reason, usage per the 2.3 usage contract, `costUsd` on the batch tier, and a typed per-request `error`. A `BatchJob` is plain JSON without credentials; `createMemoryBatchJobStore` (or your own `BatchJobStore`) records jobs so a new process can resume them. Vertex AI, Bedrock, Azure and the other OpenAI-compatible hosts are refused with `BatchError` kind `unsupported`. The wire shapes come from the providers' SDK types (`openai` 7.32, `@anthropic-ai/sdk` 0.133, `@google/genai` 2.28) and are tested against in-memory stand-ins; they are not live-verified.

  With an execution context, every request reserves one budget hold when the batch is submitted, all or none, in one ledger step (one revision and one persisted snapshot however large the batch) and before anything is sent, estimated as a native call is and priced on the batch tier. Each result settles its hold before it is handed out: with the reported usage, released when the request was cancelled, expired, never run or refused (400, 401, 403, 404, 422, 429), kept as unknown when it may have been billed or reported no usage. Settlement is idempotent in the ledger and in a persistent `BudgetStore`, so results can be read again; a fresh context of the same scope records a hold its ledger does not know again with the amounts the job recorded, without refusing it under its own budgets (the provider already ran the request; the hold counts against them from then on), and the store treats it as the same hold. A model without a batch price runs under a USD budget with one `unpriced-model` warning, or is refused before sending under `unknownPrice: 'reject'`. `holdMs` (default 25 hours) sets `job.holdUntil`, so a `BudgetStore.sweep` can leave batch holds open for the batch window.

  Price lookups take a service tier. `PriceProvider.priceUsage(model, usage, options?)` and `cacheSavings(model, usage, options?)` gain the optional `PriceUsageOptions` (`{ tier?: ServiceTier }`, `'standard' | 'batch'`; standard by default), and the `priceUsage` / `cacheSavings` functions take it as a fourth argument. `createPriceProvider` prices `{ tier: 'batch' }` from the new `ModelPrice.batch` card, a complete rate card of its own; a row without one has no batch price, so its batch requests are unpriced rather than billed at a guessed discount. The bundled table cards only rates a primary source states: the Claude rows listed in Anthropic's Claude API reference (cached 2026-10-06), which prices Message Batches at 50% of standard prices, cache reads and writes included (Fable 5.1 and 5, Opus 5.5, 5, 4.8, 4.7 and 4.6, Sonnet 5.5, 5 and 4.6, Haiku 5.5 and 4.5). OpenAI and Gemini rows have no batch card; add your own through `createPriceProvider({ table })`. A `PriceProvider` written before 2.3 ignores the tier and prices batch usage at its standard rates.

- 6b22840: Requests follow each model's documented rules, and no value changes in silence.

  Claude 5.x: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-opus-5` are registry rows. Effort rides `output_config.effort`, `temperature` and `top_p` are never sent, structured output uses `output_config.format`, prompt caching and vision are on, with a 1,000,000-token context window and 128,000 output tokens. A forced `toolChoice` is sent as `auto` on Fable 5.1, Opus 5.5 and Sonnet 5.5, and `generateObject` / `streamObject` never take the forced-tool strategy there. `effort: 'none'` maps per model: `thinking.type` `between_tools` on Sonnet 5.5, `disabled` on Haiku 5.5 and Opus 5, and `low` with a warning on Fable 5.1 and Opus 5.5, which cannot turn thinking off. Thinking turns off only at effort high or below and Opus 5 documents no default effort, so its request also sends `output_config.effort` `low`, with a warning. An unknown `claude-{fable,opus,sonnet,haiku}-N` with N ≥ 5 gets these rules instead of the generic fallback, and a `capabilities` override can no longer put `budget_tokens` or sampling parameters on the wire for that family. Verified against Anthropic's API reference (cached 2026-10-06), not live-verified.

  New rows, research-dated 2026-10-09 and not live-verified: `gpt-6.1-sol` (1,050,000 context, 128,000 output, effort low to max with `max` sent as `max`; a tool request on Chat Completions throws `InvalidRequestError`, because Sol calls tools only on the Responses API), `gpt-6-astra`, `gpt-6-luna`, `gemini-3.8-flash`, `deepseek-flash`, `kimi-k3`, `kimi-k2.7-code`, `glm-5.3` and `Qwen/Qwen3-Coder-Next`, one open-weight row for any host. `gpt-5.5` and `gpt-5.5-pro` on Chat Completions are now reasoning rows: they send `max_completion_tokens` and drop `temperature` / `topP` (not live-verified).

  Priced models the registry did not know get rows of their own (not live-verified): the GPT-5.6 family, `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.1`, `gpt-5.2`, `gpt-5-pro`, `gpt-5.2-pro`, `gpt-5.2-codex`, `gpt-5.4-pro`, `claude-opus-4-5` and `claude-sonnet-4-5`. The conservative fallback they ran on dropped their `effort`, kept Claude's prompt caching off and sent `temperature` to GPT-5 reasoning models. `gemini-3.1-pro` also gets a row on the Gemini native wire, the same as its preview's, so it sends its 64,000-token output cap there. The GPT-5 snapshots take the effort levels OpenAI publishes, research-dated 2026-10-10: low to high on `gpt-5`, `gpt-5-mini` and `gpt-5-nano`, which have no `'none'`, so it is sent as `low`; low to high on `gpt-5.1` and low to xhigh on `gpt-5.2`, both sending `'none'`; high only on `gpt-5-pro`. Any other value is changed with a warning. The GPT-5.6 rows and the other pro and codex snapshots keep the default OpenAI mapping.

  An unknown model, or a row whose output limit is undocumented, no longer gets a 4,096-token cap on OpenAI Chat Completions, OpenAI Responses or Gemini native, where it silently truncated long answers: the cap is left off and the provider's own default applies. Anthropic requires `max_tokens`, so an unknown Claude id still sends 4,096, and the `unknown-model` warning names `maxOutputTokens` and `capabilities: { maxOutput }` as the ways to raise it.

  OpenAI Responses requests are stateless by default: every request sends `store: false`, and a reasoning model always asks for `reasoning.encrypted_content`, with or without tools, so its reasoning round-trips on the next turn. Pass `providerOptions.openai.store: true` to opt back in to server-side storage; a caller-supplied `include` list is merged.

  Every value a request changes is now reported as a `clamped-setting` or `unsupported-setting` warning: OpenAI `max` → `xhigh`, Gemini 3 `xhigh` / `max` → `high` and Gemini 3 Pro `medium` → `low`, the shared `xhigh` / `max` thinking budget on Anthropic and Gemini 2.5, `temperature` / `topP` dropped while extended thinking is on, a raised `maxOutputTokens`, a forced `toolChoice` sent as `auto`, an explicit `generateObject` / `streamObject` `mode: 'tool'` that runs as the json strategy, and a dropped `promptCaching`. DeepSeek V4 always reasons, so `effort: 'none'` is dropped with a warning instead of being sent. It also rejects a forced tool choice in thinking mode, so a forced `toolChoice` is sent as `auto` with a warning and `generateObject` takes the json strategy.

  New `resolveModelProfile(model)` returns a `ModelProfile`: capabilities as supported, unsupported or unknown, lifecycle status, the documented alias target, limits (context window, provider maximum and default request cap kept apart), effort levels and what `'none'` becomes, thinking mode and how reasoning state is replayed, sampling rules, forced tool choice, prefill, usage, cache and refusal semantics, every clamp with the warning it reports, and the source URL and check date. A value no source states is reported as unknown, never as a row's conservative default: the GPT-5.6 rows, for example, report no context window. `liveVerified` is always `false`. It is pure: no network call, no logging, never the API key. `ModelCapabilities` gains the optional fields `forcedToolChoice`, `effortLevels`, `effortDefault`, `effortNone` and `toolSurfaces`, and the new types `EffortLevel` and `EffortNoneMapping` describe them.

- d72d8a4: A stable transcript prefix for Claude 5.x's preserved thinking. Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind every thinking block to the conversation before it: the top-level `system`, the `tools` array and every earlier message have to reach the API byte-identical on every later request, or the replayed block is invalid (a 400 on accounts opened from 2026-08-31). The agentic loops now keep that prefix stable for these models, and for an unknown `claude-*-5…` id on the family fallback, so the `block_binding: drop_block` default that 2.3 sends with replayed thinking is the safety net rather than the normal path. Every other model keeps its 2.2 requests, apart from the two wire changes noted below. Request shapes follow `@anthropic-ai/sdk` 0.133.0; not live-verified. New guide: Agents → Preserved thinking.

  The top-level system slot is the leading run of `system` messages. A system message after the first non-system message is a mid-conversation system message: Claude 5.x receives it in place as a `role: 'system'` message, OpenAI Responses as a `system` input item in place, Chat Completions in place as before, and Gemini and the older Claude models keep the 2.2 fold into the top-level instruction. **Behaviour change:** on OpenAI Responses (every model) a system message from the middle of the history no longer moves into `instructions`; it stays where it is, as a `system` input item. A system message without text is sent by no wire.

  Memory recall in a run that starts on Claude 5.x is one appended system message instead of a block spliced into the system prompt at every call. The model the run starts with decides this on every leg: a leg that resumes as a handoff target on another model reads the recall where the first leg put it, so the target's system prompt does not change between legs and no leg carries both forms. It is recalled once per user turn, appended right after the question it was recalled for (after the `onInput` guardrails, before the first model call), and it is part of the conversation: it rides in the run's history (so checkpoints keep it), in `response.messages` and in the chat record, carrying `providerMetadata: { deuz: { memoryRecall: true } }`, so the next turn sends it back where the model saw it. A history whose last user message is already followed by its recall message recalls nothing: a durable resume leg (also once a compaction inside the tool loop folded the turn's recall into its summary), an approval continuation built from `response.messages`, a replayed transcript. A compaction summary is never the recall query, on any model: the query is the last user message before it. The extraction pass ignores system messages, so recalled memories are never written back. **Behaviour change** (Claude 5.x only): `response.messages` and the chat record now hold that system message; other models keep the recall-free transcript. `uiFromMessages` does not render system messages, and `useChat` does not post them, so a route that wants the prefix to hold across turns loads its history from its chat store.

  Handoffs to a Claude 5.x target append the target's `instructions` as a system message after the transfer's tool result instead of rewriting the run's leading system turn; a target without `instructions` appends nothing, so the run's own system prompt stays in force. The message lives in the run's history and checkpoints, not in `response.messages` or the chat record, as the rewritten turn did. When the transfer's step breaks (an approval, a client tool, a suspended sub-agent), the resume leg answers the step's pending calls ahead of that message, right after the transfer's tool result. **Behaviour change** for those targets: the run's system prompt is no longer replaced or removed. Other targets keep the 2.2 rewrite.

  `promptInjectionGuard()` adds its notice once: a history whose leading system run already carries the policy text (a chat record saved by an earlier guarded call) is left as it is, where it used to gain one more copy per turn. The `promptInjectionGuardrail()` input guardrail does the same: a durable leg resumed from its checkpoint (a native run's too) finds the policy there and passes, where it used to prepend one more copy per leg, so a resumed leg no longer reports a `guardrail` part for it. `instructions` folds once over the whole leading system run, not only when it is the first message, so a guard notice saved ahead of it no longer produces a second copy either. All three apply to every model.

  On Claude 5.x the `tools` array stays the same on every request of a run leg: the root agent's tools (MCP tools merged in) filtered by the call's static `activeTools`. A step that offers another set — `prepareStep.activeTools`, a handoff target's tools, an MCP `tools/list_changed` — appends one system message carrying the change (`providerMetadata: { deuz: { toolChanges: { remove, add } } }`), which the Anthropic wire sends as `tool_removal` / `tool_addition` blocks under the beta `mid-conversation-tool-changes-2026-07-01`, with `inline-tools-2026-09-15` added when a definition rides inline. Like the recall message it is conversation content (`response.messages`, the chat record), and a replayed removal that names a tool the request no longer declares is left out. The step's tool calls resolve against the set it offered, so a call to a withdrawn tool is answered like an unknown tool and never runs, also when the step stopped for an approval and the resume settles its calls. Other models keep a per-step `tools` array.

  Compaction for Claude 5.x is simple: one summary replaces the whole conversation, so no thinking from before it is replayed behind a rewritten prefix. The leading system messages, the later system messages that carry run state (handoff instructions, tool-set changes, your own) and the pending user turn with its recall message stay; an older recall block is summarized with its turns. The prune layers never run on their own for these models: with `'auto'` or any policy that lists `summarize` they fold into the summary, and a prune-only policy compacts nothing and reports each skipped layer. Overflow recovery runs the same simple pass. `compactMessages` takes the model the history goes to next (`CompactMessagesDeps.model`) and compacts simple for these models. Anthropic's server-side compaction is not used: its signed `compaction` blocks would need a new canonical part kind, which 2.x does not add.

  Known limit: handoff instructions stay out of the transcript, so the first request of the call after a handoff drops the thinking of the turns that followed the transfer (the `drop_block` safety net, no error).

  Additive types, no new export: `CompactMessagesDeps.model`. No union gains a member and no persisted format changes: the recall and tool-set change messages are ordinary `system` messages with message-level `providerMetadata`.

- 1d39cce: Reasoning blocks round-trip intact. Every block a provider sends is now its own `reasoning` part, kept where it arrived and replayed unchanged on the next request, in `generateText`, `streamChat`, the steps of native runs, checkpoints, native envelopes and `useChat`. The Anthropic parser keeps block boundaries and reads `redacted_thinking.data` (a part with `redacted: true`). A thinking block whose text is empty but which carries a signature, which is what Claude 5.x streams under its default `display: 'omitted'`, is kept instead of dropped. Two consecutive thinking blocks stay two parts, each with its own signature: both loops used to merge them into one part carrying the last signature, a modified block that Anthropic rejects with 400. The Anthropic request no longer moves thinking to the front of a message, so thinking between two tool calls stays there. A turn that carries neither text nor a tool call (cut off by `max_tokens` while thinking, for example) is still not stored. The sequence `[thinking ''/S0, thinking 'a'/S1, redacted_thinking, text, tool_use]` now reaches the next request byte-identically in both loops, native runs and `useChat`.

  Reasoning stays with the provider family that produced it. `ReasoningPart` gains an optional `source` (`'anthropic'`, `'openai'`, `'google'`, or the Chat Completions host's provider id), and each wire replays only its own family's reasoning: an OpenAI encrypted item no longer reaches Claude as a `thinking` block or Gemini as a `thoughtSignature`, which a fallback to another provider used to do. Between Claude models the blocks are forwarded unchanged. A thinking block without a signature is never sent to Claude, since the API always rejects it. Parts written before 2.3 carry no `source` and replay as before, except `encrypted` parts (only OpenAI produced them) and `redacted` parts (only Anthropic did).

  DeepSeek and Kimi (`createDeepSeek`, `createKimi`) get their own reasoning back as `reasoning_content` on the assistant message that carries the turn's tool calls; other Chat Completions hosts send none (not live-verified). On Gemini native a thought signature on a plain text part, including one streamed in an empty final chunk, is kept on that text as `providerMetadata.google.thoughtSignature` and sent back with it (not live-verified).

  Claude block binding controls. Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking block's signature to the conversation before it, and on newer accounts a replayed block whose prefix changed fails the request with 400. A request that replays thinking to one of these models, or to an unknown `claude-*-5…` id, now sends `thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }` with the header `anthropic-beta: thinking-binding-controls-2026-08-01` (merged into an `anthropic-beta` header you pass), so a mismatched block is dropped instead of failing the request. `providerOptions.anthropic.thinking.block_binding` overrides it: an object is sent as given, `null` sends none. Thinking turned off with `effort: 'none'` carries no binding. The response's `input_transformations` report rides the finish part as `providerMetadata.anthropic.input_transformations` and surfaces as one warning (`type: 'other'`, `setting: 'thinking.block_binding'`), streamed and, in the loops, on `warnings`. Shapes follow `@anthropic-ai/sdk` 0.133.0's beta types; not live-verified.

  `validateChatRequest` gives opaque reasoning a budget of its own. Since `useChat` now posts every block back, the payload of an `encrypted` reasoning part (OpenAI) or a `redacted` one (Anthropic) counts against the new `maxOpaqueReasoningBytes` option (default 1 000 000 UTF-8 bytes per message) instead of `maxTextBytes`. The flags come from the client, so a part counts as opaque only when its flag matches the family that produces it (`encrypted` with `source` absent or `'openai'`, `redacted` with `source` absent or `'anthropic'`); any other flagged part counts as text. The Gemini native wire never sends an encrypted or redacted part: Gemini produces neither, and it would have read the payload as thought text.

  The chat projections keep every block. The Deuz UI wire's `reasoning-delta` frame carries the optional `id`, `encrypted`, `redacted` and `source` fields on every wire version, and `applyUIPart` keeps one UI part per block. An encrypted or redacted block's payload rides the frame's new `data` field and its `text` is empty, so a client that predates these fields (a 2.2 `@deuz-sdk/react`, the frozen `@deuz-sdk/core/react` hook, a reader of your own) shows nothing for the block instead of the payload; such a client never sent reasoning back. `applyUIPart` reads the payload from `data`. A response negotiated to wire v1 carries these fields too, so its reasoning frames are no longer byte-identical to pre-1.7 output. A streamed turn's `parts` now hold flagged `encrypted` and `redacted` blocks: a renderer that draws `parts` must skip both, as it already skipped `encrypted` parts from history. **Behaviour change:** `assistantMessageFromTurn`, which `useChat` uses to build the history it POSTs, now follows the ordered parts and includes every reasoning block in place, where it used to drop all reasoning and put the turn's text ahead of its tool calls; a plain text answer is still a string. The `reasoning` text of a UI message no longer includes encrypted or redacted payloads, `canonicalFromUI` keeps a signed block whose text is empty, and `toDeuzTextStreamResponse` with `includeReasoning` never writes redacted data.

  A tool call's provider metadata rides the UI wire too. The streaming loop's `tool-call` part carries the `providerMetadata` of its `tool_use` part (`ToolCallPart.providerMetadata`), the `tool-call` frame forwards it on every wire version, and `applyUIPart` keeps it on the UI call, so the history `useChat` posts sends a Gemini function call's `thoughtSignature` back. Before, a Gemini 3 client-tool loop through `useChat` lost it, and the next request could fail with 400 (not live-verified).

  Additive types, no new export: `ReasoningPart.source`, `TextPart.providerMetadata`, `ReasoningDeltaPart.id` / `redacted` / `source`, `TextDeltaPart.providerMetadata`, `ToolCallPart.providerMetadata`, the `reasoning-delta` member of `DeuzUIPart` (`id`, `encrypted`, `redacted`, `source`, `data`) and its `tool-call` member (`providerMetadata`), the `reasoning` member of `UIMessagePart` (`id`, `source`) and `ValidateChatOptions.maxOpaqueReasoningBytes`. No union gains a member and no persisted format changes: checkpoints, native envelopes and chat stores already stored parts as given.

- c852d93: Native runs support `memory`, `chat` and `fallbackModels`. `runAgent`, `streamAgent`, `resumeAgent` and `resumeStreamAgent` used to reject all three. Each is now bound to the run's checkpoint instead of running as a best-effort side effect, and each is part of the resume binding: a resume with another memory scope, another chat or other fallback models fails before anything is written.
  - **Memory.** A new run recalls once, before its first model call, and the memories enter its history as one appended `role: 'system'` message (`providerMetadata.deuz.memoryRecall`, the shape the legacy loops use for preserved thinking). Every step and every resume therefore sends the same prefix, and a resume never recalls again. Extraction runs only for a run that completed. The terminal commit records it as pending under an operation id before anything is written to memory, and its outcome follows in a later save (`AgentRunEnvelope.memory`). Every record it writes carries `metadata.deuz = { runId, operationId }`. A terminal resume never extracts again or calls a model. `extract: false`, `recall: false`, `writePolicy: 'manual' | 'session-end'` and `sweep: 'on-extract'` behave as in the legacy loops. A run under another native run's execution may only narrow that run's memory scope, also when it shares that run's own execution context; a wider scope fails it before any call.
  - **Chat projection.** The run keeps an append-only transcript of its turns, raw (before compaction or a `prepareStep` history, with reasoning blocks byte for byte). It writes the transcript to `chat.store` after its own checkpoint at every suspension and at the end, as a whole record with the new `ChatRecord.messageIds`. `AgentRunEnvelope.chat` records the projection cursor and which assistant turn and tool invocation is which message. A chat store failure never fails the run: it is reported as a `warning` part and repaired by the next save, a terminal resume or `reconcileAgentRun`, and a repeat never appends a message twice. A stored chat of another scope is never overwritten. A late repair (a terminal or still-waiting resume, `reconcileAgentRun`) writes only over the record the run's failed write found or one its transcript continues: a chat that another run or writer saved or deleted since is left as it is, and the run records the new status `'superseded'` (with `AgentRunChatState.found`, what the failed write found).
  - **Model fail-over.** A model call that fails with a retryable error before its first content (network, transport timeout, 5xx, 429/529 after its own retries, an open breaker) is repeated on the next candidate of `[that model, ...fallbackModels]` inside the same run, budget and checkpoint. A tool-loop step runs again from the run's last checkpoint, so completed tool effects never run again. A refusal, a policy, budget or validation rejection, a cancel, an elapsed deadline or an error after content never fails over. The failed model is skipped for the rest of the run, also after a resume, whether it was the root model, a handoff target's or a `prepareStep` model. `AgentRunEnvelope.models` records each fail-over (attempt, model and next model with provider and protocol, model step, phase, error), the selected model and the rules' version. A failed attempt's budget hold stays counted against the shared execution. Each candidate gets the call's `capabilities` override and its own request profile and object strategy. Claude thinking blocks reach another Claude model unchanged and never another provider.
  - **`reconcileAgentRun({ session, chat?, memory?, lease? })`** settles what a run that ended or is suspended left behind. It rewrites a chat projection that is behind or failed. It also settles a pending or failed extraction: one whose records are already in the memory store is recorded completed without another memory LLM call, and any other runs now. Call it only when no executor drives the run: an extraction stays pending while the executor that completed the run is still extracting. With `lease` (the shape of the `runAgent` option) it claims the run's lease first, rejects with `'lease_held'` while an executor holds it, and gives the lease back at the end.
  - **Envelope version.** `AgentRunEnvelope.version` widens from `1` to `1 | 2`. An envelope that records memory, a transcript, a chat projection or fail-over state is written as version 2, so a 2.2 reader refuses it (`Native checkpoint version, identity, or scope mismatch.`, before it writes anything) instead of resuming without that state. So is an envelope whose stored turn has an open call a 2.2 resume would answer wrongly, until a checkpoint answers the call: a run that waits on an approval, or one stopped mid-step with an open call whose ID the run's approval gate issued a request under, such as an approved call a resume took up (2.2 looks a verdict up by the bare tool call ID and would deny a call answered with its 2.3 `approvalId`), a call whose receipt records `failed` (2.2 would answer it with no result) or `suspended` (2.2 would start the sub-agent over), and a client call that a resume took up and still waits on (2.2 would deny it). Every other envelope stays version 1, and resume reads both. A 2.2 reader also refuses, at either version, an envelope whose resume binding records a key 2.3 added (`binding.memory | chat | fallback`, and `mcp` and `handoffs`), because it compares the whole binding: it fails with `Native agent binding changed across resume.` and writes nothing. Once 2.3 saved a run that uses `memory`, `chat`, `fallbackModels`, `mcp` or handoffs, only 2.3 resumes it. The new optional fields are `memory`, `transcript`, `chat`, `models` and `binding.memory | chat | fallback`, with their types (`AgentRunMemoryState`, `AgentRunTranscript`, `AgentRunChatState`, `AgentRunModelState` and related types).

  The caller's `capabilities` override now follows a model switch (F26): a `prepareStep` model, a handoff target in the legacy loops and in native runs (finalization included), and a fail-over candidate, in a native run and with the `fallbackModels` option of `generateText` and `streamChat`. Before, the switched-to model fell back to its registry row, such as Anthropic's 4096-token placeholder for an unknown slug.

  `NoObjectGeneratedError` gains optional `finishReason` and `stopDetails` from the last attempt, so a refused or cut-off structured request says why no object came back. `toJSON` adds `finishReason` to the logged details.

  `agentTool` child sessions no longer collide when a provider reuses a tool-call id (`tool_0`) at a later parent step; the second delegation used to find the first one's child. A native run keys the child by call id and root model step, and still resumes a child that 2.2 left under the plain key. A legacy loop keeps the 2.2 key for an id's first use and adds `~<n>` for each reuse.

  `remember()` takes optional base `metadata` for every record it writes.

  Provider behavior here follows the documented wire shapes and is tested offline; none of it is live-verified.

- c6fb3f4: `createNodeSandbox` (`@deuz-sdk/core/compute/node`) no longer takes the host process down when a child stops reading its stdin. A child that exited, crashed or closed stdin before reading an input larger than 64 KiB raised an uncaught `write EOF` (Windows) or `EPIPE` (Linux) that killed the caller, and its `try`/`catch` never ran. stdin is now written with backpressure, and a child that stops reading ends the write quietly; the run settles once with the child's exit code and output and releases its timer and abort listener. Without `stdin` the child now gets the null device instead of a pipe that was never closed, so a program that reads to EOF (`sort`, `cat`, `node` reading a script) finishes at once instead of waiting out the timeout; `stdin: ''` is still an empty pipe. `runShell` takes `stdin` the same way `runCode` does, and `ShellExecutionRequest` (`@deuz-sdk/core/compute`) gains the matching optional `stdin` field. A timeout or abort settles within half a second of the kill even when a program the shell started (any command under `cmd.exe /c`, or `a` in `bash -c 'a && b'`) still holds the output pipes; that program is not killed. `createFileWorkspace` (`@deuz-sdk/core/workspace/node`) accepts names that merely start with two dots, such as `..notes`, `...` and `..notes/x.txt`, which its own containment checks used to refuse as traversal; a real `..` segment is still refused. Its `write()` and `writeBytes()` also refuse to go through a link that does not resolve (a dangling symlink, or an NTFS junction whose target is missing): the link check took it for a path that did not exist yet, and the write followed it and created the target outside the root, a file with the content on POSIX and a directory on Windows. Behaviour change: its `exists()` and `delete()` now reject an illegal or escaping path the way `read()` and `write()` do, and the way `createInMemoryWorkspace` always has, instead of answering `false` or reporting success while doing nothing. `delete()` rejects when it cannot remove what is there (a directory, for example) and `exists()` surfaces filesystem errors other than a missing path; a missing path is still `false` for `exists()` and a no-op for `delete()`. `list(prefix)` rejects an illegal prefix even when the workspace is empty.
- 4d51793: `@deuz-sdk/core/testing` gains versioned eval suites. `runEvalSuite(tasks, options)` runs `EvalTaskManifest`s: each task has a stable `id` and a `version`, a start snapshot (`messages`, workspace `files`, JSON `store` state) that every attempt gets its own copy of, acceptance criteria (graded as `runGradedEval` grades a case) and an optional `grade` for partial credit, the tools it may call and the file `scope` it may change, the model, protocol and effort it is meant for, a budget, a timeout, repeats, required artifacts, the tools whose approval is part of the task, and, for a fault scenario, the fault boundary and the recovery its documentation promises. A task's `run` gets an `EvalTaskContext` (an in-memory observer to pass as `deps.observer`, an abort signal for the timeout, and `effect`, `approve`, `rescue`, `interrupt` and `artifact` recorders) and returns an `EvalTaskOutcome`, which a native `AgentResult` already is. Every attempt reports success, score, false completion (the run claimed `completed` and failed acceptance), cost and tokens from the run's accounting across every leg, duration on an injectable clock, human rescues counted apart from required approvals, repeated effects, the tools it called, and how it came back from an interruption (`EvalRecovery`: `not-needed`, `recovered`, `rescued`, `contained` or `failed`; an attempt that executed an effect twice is `failed`). Beyond its acceptance, an attempt fails when it executed an effect twice, called a tool outside the allowed set, changed a file outside its scope, went over budget, missed a declared artifact, or for a fault scenario never hit its fault or recovered another way than documented. Metrics add up per task and per tier: `'offline'` and `'real-model'` tasks are separate experiments and never aggregated together, and `skip` lists a task (a missing key, say) without running it. A thrown or timed-out run is a failed attempt, never a crash; a malformed suite throws a `TypeError` before any task runs. The JSON report (`EvalSuiteReport`, `format: 'deuz-eval-suite'`, version 1) is returned and written only on request, to a file path (through `node:fs`, loaded only then, so the subpath stays edge-safe) or to a callback. The 2.3 baseline lives in the repository: offline tasks and fault-injection scenarios (before dispatch, after approval, between effect and receipt, between receipt and checkpoint, mid model stream, verifier abort and deadline, child initialization, swarm cancel commit, lease loss and renew failure, admission store failure, settle failure, spawn commit failure, MCP hot refresh, a refused or cut-off turn that carried a tool call, and the opt-in recovery of four of them) run on every `npm test`, and real-model tasks are defined but not run (not live-verified); the Evals page lists them. It is a baseline, not a ranking. See the new Evals page.
- 6a9664a: The eval baseline in the repository now covers what 2.3 added: native memory, chat and model fail-over, the UI bridge, goals, batches and the MCP server. No API changes; see the Evals page.
  - **Nine fault-injection scenarios** at the boundaries that depend on them. A nested run whose memory scope leaves the scope of the run it serves, on a child execution context and on the parent's own context, fails before any memory read or write; nothing crosses scopes (contained). A model call that fails with a 529 after a tool effect fails over, and a crash between the failed attempt and the fallback's resumes on the recorded attempt: the failed model is not called again and the effect runs once (recovered). The same fail-over under a USD budget with persistent admission, to a fallback without a price, and a resume: the fallback warns with `unpriced-model` once in each leg and runs, every answered call is settled once, the failed attempt stays held at its estimate, and the budget store agrees with the ledger (recovered). A Claude Opus 5.5 run with memory compacts inside its tool loop and is interrupted: the resume replays the compacted history byte for byte, with no second summary and one recall with the user's question (recovered). A chat projection that fails after the run completed is written once by `reconcileAgentRun` (recovered); a late repair after the chat moved on without the run reports `superseded` and overwrites nothing (contained). A memory write whose recording save fails is settled by `reconcileAgentRun` without a memory LLM call or a second write (recovered). The client of a journaled native UI stream drops mid-leg and reconnects with its cursor: it gets every frame once, in order, and a refused second resume writes nothing into the journal (recovered).
  - **A fault-injection scenario for a native resume's settle** (`fault/after-receipt-approved`): an approved charge runs in the resume's settle, and the process dies during the next model call, after that call's budget reservation was saved. The next resume passes no verdict and goes on from the answers the settle saved: the charge runs once, the model gets its recorded result, and nothing is denied (recovered).
  - **Six offline tasks**: a native run that continues a stored chat and acts on a preference it recalls from memory, a fail-over from an overloaded primary, an approval given through the UI bridge, a goal woken by its schedule and completed on a tool's evidence, a batch submitted and collected on an in-memory stand-in of a batch API, and a tool that `createMcpServer` serves to an in-process client.
  - **Their real-model twins** are defined and skipped offline. The batch twin is defined apart, because a provider can take up to 24 hours to end a batch. None of them was run: not live-verified.

  The baseline is now 22 offline tasks, all accepted (four required approvals; the interrupted run and the fail-over recover by themselves), and 33 fault scenarios, 22 recovered and 11 contained, with no false completion and no repeated effect. It is a baseline, not a ranking.

- 07f86f4: A swarm executor gives everything back when a start-up commit fails. `run` and `resume` took the run's in-process ownership, its lease and a heartbeat, then committed; when the commit that records a cancellation (an aborted `signal`, or a recorded `requestCancel`) failed, the ownership, the lease and a heartbeat renewing it forever stayed behind, so the process never exited, a later `resume` reported an executor already running and `recover()` could not take the run over. Every step after ownership now shares one cleanup, which rethrows the store's error.

  Lease cancels are acknowledged. A renewal used to remove a queued `'cancel'` in the same step that delivered it, before the holder had recorded it, so a holder that died in between lost it, and the re-queue after a failed cancel commit needed the holder to still hold the key. `LeaseProvider.renew` takes `{ acknowledge: true }` (`LeaseRenewOptions`): the delivered cancel stays queued, reported again by every renewal (`LeaseRenewal.queued`) and handed to the next holder, until the new optional `LeaseProvider.ack(lease, 'cancel')` removes it. The memory, SQLite and Postgres providers implement both, and swarm and evolve executors acknowledge a cancel only once the run has durably recorded it, or ended without needing it. Without the option a renewal behaves as in 2.2, and the stored signals keep their 2.2 format, so 2.2 processes sharing the database read the same queue.

  The Postgres stores retry contended writes. Under a `REPEATABLE READ` or `SERIALIZABLE` session default, every single-statement write now runs again on a serialization failure (40001) or a deadlock (40P01), up to five attempts: lease acquire, renew, release, signal and ack, agent run saves, claims, swarm create and commit, budget reserve, settle and release, the 2.0 store pack's writes, and every new prune. A swarm write whose attempts run out rejects with `SwarmConflictError` (which now takes `ErrorOptions` and keeps the driver error as its `cause`), so resume, recover and requestCancel handle it as any other conflict.

  Durable stores can be pruned. `BudgetStore.prune({ before })` deletes settled, released and denied request records created before `before`, and folds each scope's closed history, per model, into one row, so no usage total and no admission changes; an open hold keeps its record and its bucket. `LeaseProvider.prune(before)` deletes keys nobody holds that queue no cancel; a lease that has not expired is kept even when `before` is later than the store's clock. The SQLite and Postgres ops stores add `agentRuns.prune(before)` for terminal native runs and `claims.prune(before)` for old claim keys, which can then be claimed again. `SwarmStore.prune({ before, scope?, limit? })` deletes settled swarm runs with their tasks, events and blackboard notes. The memory, SQLite and Postgres implementations have them all. A lifetime budget scope no longer sums its whole history on every admission: the memory store keeps a running total, and the SQLite store reads `deuz_budget_totals`, kept by triggers that a 2.2 process sharing the file fires too.

  Stale budget holds can be found and closed. `BudgetStore.holds({ before, limit?, after? })` lists the holds still open, oldest first, and `BudgetStore.sweep({ before, resolve?, limit? })` closes them through the store's own settle and release: by default it bills each held estimate (fail closed), `'release'` frees them, and a resolver may return the actual usage from your own records or keep a hold open. This is the recovery path for a lifetime budget charged by a hold its crashed caller never settled. `BudgetStoreMaintenance` names `prune`, `holds` and `sweep`; `createInMemoryBudgetStore` and `createPostgresBudgetStore` return `BudgetStore & BudgetStoreMaintenance`, and `SqliteBudgetStore` declares the three.

  Schemas and checkpoints are versioned forward. The Postgres stores' schema statement now upgrades a schema stored at an older version in place, under its advisory lock and in one statement, and its refusal of a newer version names both versions. No store changes its schema version in 2.3; on first use they add indexes (`deuz_claims_claimed_at`, `deuz_agent_runs_updated_at`, `deuz_budget_requests_state`, and on SQLite `deuz_swarm_runs_settled`) that 2.2 ignores, so 2.2 and 2.3 processes can share a database. On a large Postgres table, create them beforehand with `CREATE INDEX CONCURRENTLY` under the same names. `deserializeCheckpoint`, `resumeFromCheckpoint` and `resumeStreamFromCheckpoint` refuse a legacy checkpoint whose `version` is not 1 with the new `CheckpointVersionError` (code `checkpoint_version_unsupported`, from `@deuz-sdk/core/durable`) instead of resuming a format this build cannot read; a checkpoint without a version still reads as version 1.

  Widened public types: `LeaseProvider` gains the optional `ack` and `prune`, `LeaseRenewal` the optional `queued`; `BudgetStore` gains the optional `prune`, `holds` and `sweep`; `SwarmStore` gains the optional `prune`. The ops stores' `leases` declare `ack` and `prune`, their `agentRuns` and `claims` declare `prune`, and `SqliteSwarmStore`, `createInMemorySwarmStore` and `createPostgresSwarmStore` declare `prune`. New types: `LeaseRenewOptions`, `BudgetPruneOptions`, `BudgetPruneResult`, `BudgetHold`, `BudgetHoldQuery`, `BudgetHoldResolution`, `BudgetSweepOptions`, `BudgetSweepResult`, `BudgetStoreMaintenance` and `SwarmPruneOptions`.

- bf1cc94: Goals, wakeups and events get a data contract: the new `@deuz-sdk/core/goal` subpath (edge-safe, pure; nothing in it runs a model, a timer or a service). A `GoalRecord` (version 1) holds a goal's identity, scope, parent goal and current native run, an objective, acceptance criteria, evidence references, the latest verdict per criterion, a budget with what was spent, a deadline and a lifecycle: `active`, `waiting` with an explicit reason (`user`, `event`, `dependency`, `wakeup`, or `budget` once a charge reached a limit), `completed`, `failed` or `cancelled`. `createGoal` makes one and `transitionGoal(record, command, { now, expectedRevision? })` is the only way it changes, one revision at a time, never touching the record it is given: `wait`, `resume`, `event`, `evidence`, `evaluate`, `complete`, `fail`, `cancel`, `charge`, `revise`, `link-run` and `tick`. It reports what it did as `applied`, `ignored` or `rejected`, with a reason; a malformed record or command, an event for another goal and an `expectedRevision` the record is not at throw `GoalError` (`invalid_goal`, `invalid_command`, `invalid_event`, `scope_mismatch`, `revision_conflict`). A goal is done only on evidence: `assessGoal` gives each criterion and the goal `passed`, `failed` or `inconclusive`, a `passed` verdict counts only when something other than the working model reached it on evidence from outside the model, and `complete` is rejected until every required criterion passed that way. A passed deadline fails the goal at the next transition, and a spent budget holds it until a revision raises the budget, keeping the wait it interrupted (events that answer that wait still apply) and putting it back then.

  A `GoalEvent` (version 1) is the wakeup and event envelope: identity, source, scope, goal and run, a dedupe `key`, the time it happened with `notBefore` and `expiresAt`, a payload reference and a `correlationId` naming the wait it answers. Its key shares one space with the schedule's occurrence keys (`<id>@<at>`) and `handleSignal`'s keys (a delivery ID or `sha256:<hex>` of the body), so one durable claim dedupes them all: `goalEventFromOccurrence`, `goalEventFromSignal` and `goalWakeupEvent` (keyed `goal:<goalId>@<at>`, see `goalWakeupKey`) build them, `createGoalEvent` takes your own. A goal applies an event that answers its wait and remembers its key, and remembers a charge's key in a window of its own, so a run's charge and its completion event may both be keyed by the run ID; it drops a duplicate, an expired or early event, one answering an earlier wait or older than the wait (a dependency's completion is never too old), and one it does not wait for, each with its reason. `parseGoal`, `serializeGoal`, `parseGoalEvent` and `serializeGoalEvent` read every version up to their own, keep fields a later 2.x release adds, and refuse a newer version with `unsupported_version`. `GoalStore` is the host's persistence boundary (copies, a save only at the next revision, an optional `list`), and `createInMemoryGoalStore` is its reference implementation. A running supervisor, a durable inbox and timezone-aware wakeups remain 2.4 work.

  Native runs can be listed. `AgentRunStore` gains an optional `list({ phases?, updatedBefore?, scope?, limit?, cursor? })` that resolves a page of run summaries (`runId`, `scope`, `phase`, `revision`, `updatedAt`, and the stored result's `status`, so a suspended run is told apart from one in progress), newest save first, with a `cursor` while more follow. `createInMemoryAgentRunStore` (which now takes an optional `clock`) and the SQLite and Postgres `agentRuns` implement it; the SQL stores page by the `deuz_agent_runs_updated_at` index added on first use, with no schema version change. `findStaleAgentRuns(store, { staleMs?, scope?, includeSuspended?, limit?, clock? })` from `@deuz-sdk/core/ops` finds the runs still running or finalizing whose last save is older than `staleMs`, for a worker to resume.

  `runAgent`, `streamAgent`, `resumeAgent` and `resumeStreamAgent` take a `lease` option, `{ provider, owner?, ttlMs? }` as `createSwarm` does, so two processes never drive one native run. The executor holds the run's key (`agentRunLeaseKey({ scope, runId })`) from before it reads the run until it returns, renewing it at once and then every `ttlMs / 3`. While another executor holds it the run fails with code `'lease_held'` before anything is read or written; an executor that loses it aborts and writes nothing more, failing with `'lease_lost'`. A `'cancel'` signalled to the key stops the run with the new stop reason `'cancelled'`; with a provider that acknowledges cancels, it stays queued until the stopped run is saved, so an executor that dies in between cannot lose it, and the next executor to claim the run applies a cancel still queued before any model call. A new run starts clean of a cancel queued before it claimed the key, and is stopped by one signalled after that. Without the option nothing changes.

  Widened public types: `AgentRunStore` gains the optional `list`, `AgentRunOptions` the optional `lease`, and the SQLite and Postgres ops stores' `agentRuns` declare `list`. New types: `AgentRunPhase`, `AgentRunListQuery`, `AgentRunSummary`, `AgentRunListPage`, `AgentRunLeaseOptions`, `FindStaleAgentRunsOptions`, and the goal module's types.

- acca78b: Native agent runs reach the UI. `toDeuzAgentStreamResponse(stream, options)` in `@deuz-sdk/core/ui` serializes a `streamAgent` or `resumeStreamAgent` run to the Deuz UI wire. The run's parts go out exactly as `toDeuzStreamResponse` frames them, and `data-agent` parts add what only a native run has: a `run` frame opening every leg (carrying the `runId` option), the phases, the `partial` drafts and validated array `element`s of a structured output, and a terminal `result` frame with the run id, the status, the validated output (only when `completed`), the pending approvals and client calls of a suspension, the stop reason with its `stopDetails`, or the failure. Every frame's `seq` is its own SSE event id. With `store` and `streamId` (one per run, such as the run id) the sequence grows across every leg, and a client resumes after its cursor through `resumeDeuzStreamResponse`; a response without a store cannot be replayed. A stream has one writer at a time: a leg the run refuses before it begins (a second resume while the run executes, a run id stored under another scope, an unknown run, invalid options) goes out on its own response only, with its failed result and error part but no event ids, and writes nothing to the journal, where its frames would take the seqs of the leg that does run. With a store, the first frames of a leg go out once the run has emitted its first event. The serializer subscribes to the run's events before it returns. It never sends the transcript, the raw result of a `tool-output` event, receipts or the accounting ledger, it redacts a failure's message, and it ends a failed run with an `error` part as well. The frames are wire v2 parts on the existing `data-${string}` member of `DeuzUIPart`, so a client that negotiated v1 gets the plain chat stream and no union is widened.

  `agentStateFromParts(parts, initial?)` folds the frames into a `DeuzAgentState`: `idle`, `running` (with the latest unvalidated `partial` draft), `completed` (with `output: T`), `suspended`, `stopped` or `failed`. A frame applies only when its `seq` is above the state's, so a duplicate, a replay that overlaps the live stream or an out-of-order frame never applies twice, and the state never moves backwards. `applyUIPart` folds the same frames into the new optional `AssistantTurnState.agent`. An app's own `data-agent` part whose payload is no agent frame stays an ordinary data part.

  The UI wire shows more of a turn. The `finish` and `step-finish` frames carry the provider's `stopDetails` (a refusal's category and explanation, secret-redacted), and `applyUIPart` keeps the `finish` frame's on the new optional `AssistantTurnState.stopDetails`. The `tool-state` and `tool-result` frames carry the dispatch contract's `outcome` (`ToolCallOutcome`), kept on the new optional `UIToolCall.outcome`; the latest frame wins, so a call that was `'approval-pending'` and then ran carries none. These optional fields ride every wire version, except the `outcome` of `tool-state`, a v2-only part (a client that negotiated v1 reads a call's `outcome` from its `tool-result` only), and an older client ignores them. Claude's thinking display modes need no new shape. Under `display: 'omitted'` a block stays an empty, signed reasoning part that adds nothing to the readable text and is sent back unchanged. Under `'updates'` (beta `thinking-display-updates-2026-08-18`, per `@anthropic-ai/sdk` 0.133.0's types) the progress notes are the block's text. Not live-verified. `readDeuzStream` gains `onEventId`, which receives each part's SSE event id right before the part is yielded.

  A Gemini thought signature on a plain text part now rides the UI wire. The `text-delta` frame carries the text's `providerMetadata` (the signature often arrives on a final chunk whose text is empty), the UI text part keeps it, and `assistantMessageFromTurn` and `canonicalFromUI` send it back on that text, so the history `useChat` posts keeps it. Such a text stays a text part instead of collapsing to a plain string; text without round-trip data is a string as before. Gemini does not enforce text signatures (not live-verified).

  `useChat` drives a native agent route with no new option. When a turn's agent state is suspended, the run's terminal frame is the authority on what it waits for: its approvals pause the chat, and its client calls run through `onToolCall` or park in `pendingToolCalls`. The hook then resumes the run in one request with `runId`, `approvalResponses` and `clientToolResults`, because `resumeStreamAgent` proceeds only with every verdict and every client result. The client calls run inside that round, so `status` is `'streaming'` while they run and `stop()` cancels it. Verdict matching and replay-safe client tools work on this path as on a chat route. New readouts: `agent` (the run's state, with `output` only once it completed) and `stopDetails`; tool calls carry `outcome`. Agent frames stay out of `onData` and `dataParts`. A chat route never sends a frame, so its requests are unchanged. The hook imports no new core export: with a core older than 2.3 it behaves as before, and `UseChatAgent` and `UseChatStopDetails` are derived from the installed core's types.

  **Behaviour change:** a POST response that carries the journal's `id:` lines (a route that passes `store` and `streamId`) now moves `useChat`'s in-memory resume cursor. A `reconnect()` after a settled turn, or after a leg the hook continued with a POST, resumes after it; before, it appended the replayed turn to the history a second time. A reconnect after a dropped POST continues that turn from the last part it showed. The persisted cursor (`resume.cursor`) still moves on resume reads only, so a reload mid-turn replays the turn from its start. `setHistory` and `setMessages` drop the in-memory cursor along with the pending gates, so after a chat switch the next reconnect reads the new chat from its persisted cursor or its start, as before 2.3, never from the old chat's position. After a reload, a replay of a journal that also holds legs the restored history already has (a lost or old cursor) can still append them again.

  **Behaviour change:** after an approval, the history a chat client keeps now answers the approved call. The leg that resumes a paused run executes the approved call and streams its state and result, but not the call itself. `assistantMessageFromTurn` used to put that call into the leg's turn again as a second `tool_use` without its input, which no provider accepts, and the call's result never reached the history, so the next request carried an open `tool_use`. Now `assistantMessageFromTurn` leaves out a call the turn knows only from a `tool-state` or `tool-result` frame (its UI card has no `input`), and `useChat` adds the result to `history.canonical` as a `role: 'tool'` message before the turn, on a chat route and a native route alike. `canonicalFromUI` (behind `setMessages`) re-derives the same history: it leaves such a card out of the turn and puts its result right after the call it answers, or leaves the result out when no earlier turn holds that call. The result is the one the wire carried, which is what the model saw. A call without `input` is also never handed to `onToolCall`. And when two responses name their message the same (a route that passes no `messageId` starts every response with `'deuz-msg'`), each leg now fills its own bubble; before, the continuation's text overwrote the bubble of the leg before it. Likewise, a client result for a turn the chat waits on (an open approval gate or a parked call) fills that turn's bubble after a caught-up `reconnect()`; before, it added a copy of the turn.

  **Behaviour change:** the history `useChat` keeps now answers a call the server ran within a turn. The hook adds the call's result (the one the wire carried, which the model saw) as a `role: 'tool'` message right after the assistant turn, as `canonicalFromUI` already did. Before, the next request carried that `tool_use` open, which providers reject, and on a chat route an approval continuation in the same turn ran the call a second time, because `streamChat` settles every call the history leaves open. This holds on a chat route and a native route alike.

  **Behaviour change:** `validateChatRequest` accepts by default the tool results `useChat` posts. A `role: 'tool'` message, or a run of them, right after an assistant turn, holding only `tool_result` parts that each answer a different call of that turn, now passes with the default `rejectToolResults: true`. That is the history after a client tool, an approval and a server tool the leg ran, so a route on the defaults no longer answers the follow-up of an approval with a 400, and a client-tool route no longer needs `rejectToolResults: false`. Every other tool result is still rejected (no assistant turn before it, a call that turn did not make, a call answered twice, a tool message that also carries text, a `tool_result` in a `user` turn), and `false` still accepts them all. The validator cannot tell a forged result in that shape from a real one: a route that must not trust the client's history keeps it server-side.

  `validateChatRequest` bounds provider round-trip data with a new optional `ValidateChatOptions.maxProviderMetadataBytes` (per message, default 1 000 000 UTF-8 bytes): the `providerMetadata` of a message and of its parts (such as the Gemini thought signatures `useChat` now posts back on text) and every reasoning `signature`. Before, none of it counted against any budget.

  **Behaviour change:** `validateChatRequest`'s byte walks now count an object's keys as well as its values, so a `tool_use.input`, a `tool_result.result` or a `providerMetadata` cannot hide its volume in key names; a body that did is now rejected.

  **Behaviour change:** an `onToolCall` result that lands after the chat moved on (a new message, `regenerate`, `editAndResend`, `setHistory` or `setMessages` while the call ran) is dropped. Before, `useChat` appended it after the new exchange, a history no provider accepts, and POSTed the old turn's continuation next to the new one.

  The frozen `@deuz-sdk/core/react` hook is unchanged and gets none of this; fixes and features ship in `@deuz-sdk/react`.

  All type changes are additive. Core `./ui`: `toDeuzAgentStreamResponse`, `agentStateFromParts`, `ToDeuzAgentStreamOptions`, `DeuzAgentFrame`, `DeuzAgentResultFrame`, `DeuzAgentState`, `DeuzAgentStatus`, `DeuzAgentClientCall`, `DeuzAgentUnknownEffect`, and the optional fields `stopDetails` (the `finish` and `step-finish` members of `DeuzUIPart`), `outcome` (its `tool-state` and `tool-result` members), `providerMetadata` (its `text-delta` member) and `ReadDeuzStreamOptions.onEventId`. Core `./chat`: the optional `AssistantTurnState.agent`, `AssistantTurnState.stopDetails`, `UIToolCall.outcome`, the `providerMetadata` of the `text` member of `UIMessagePart`, and `ValidateChatOptions.maxProviderMetadataBytes`. React: `UseChatResult.agent` and `UseChatResult.stopDetails`, and the types `UseChatAgent` and `UseChatStopDetails`. No union gains a member, and no persisted format changes.

- d0289cf: Headless preview: `@deuz-sdk/core/headless` runs, resumes and inspects native agent runs from a script, a CI job or a cron entry, and checks a model and its configuration before running it. It is a preview, not a stable API: report fields, finding codes and exit codes can still change in a 2.x minor. It is Node-only and never reaches the edge-safe entries. There is no binary, CLI package, TUI or daemon; `examples/13-headless` is a small command line built on it, with `run`, `resume`, `inspect` and `doctor` commands that run without an API key.

  `runHeadless(options)` takes `runAgent`'s options plus a durable `AgentRunStore` (the SQLite ops store's `agentRuns` is the default choice on one machine), a `runId` and a `scope`, and returns a plain-JSON `HeadlessReport`: the run ID, its status and outcome, where the stored run stands, the stop reason and provider stop details, the error, the actions a pending run waits for (each with the resume option that answers it: `approvalResponses`, `clientToolResults`, or for a call whose effect is unknown `retryToolCallIds` or `reconciledToolResults`), usage, model steps, the cost from the run's budget ledger, the leg's warnings, and a completed run's output. Calls are priced with the bundled table unless `deps.priceProvider` is given; `cost.complete` is `false` when a call had no price. `resumeHeadless` continues a stored run with those answers, and `inspectRun(store, runId)` reports a stored run with no model call. `exitCodeFor(report)` maps each outcome to its own exit code (`HEADLESS_EXIT_CODES`): 0 completed, 1 failed, 2 usage, 3 pending (approvals, client results, unknown effects or a resume), 4 refused, 5 cancelled, 6 a budget, step, deadline or timeout limit, 7 stopped for another reason, and 8 when the doctor found an error. A refused or pending run never exits 0.

  Project instructions: `loadProjectInstructions(dir, options?)` reads `AGENTS.md` and then `CLAUDE.md` in each directory from the git root down to `dir` (only `dir` outside a repository, or from an explicit `root`), outermost first so the text nearest `dir` wins a conflict, repeated text once, under a 32 KiB cap that keeps the files nearest `dir` whole. A symlink or junction is followed only while it stays inside the root: a file whose real path is outside it is not read, and `skipped` lists it. `runHeadless({ projectDir })` puts them into the run's system message after your `instructions`, and reports a skipped file as a warning. They get the trust of the system message, so whoever can change them (a pull request from a fork) can steer the run: review the files of a checkout you do not trust, or leave `projectDir` out. `projectInstructions: { role: 'user' }` delivers them as a user message ahead of the prompt instead, as Claude Code and Codex do; the model weighs that below your `instructions`, but it does not make the files safe. `skills` takes folders of Agent Skills: the first leg lists them, and every leg gets `load_skill` and `read_skill_resource` tools that read only listed skills, and only files whose real path is inside the skill's folder.

  `doctor(options)` reports why a configuration will not work, with no network call: the model's profile and support level (a pinned registry row, the Claude 5.x family rules, or the conservative fallback), how effort, sampling, forced tool choice and structured output reach the wire, whether the model has a price (an unpriced model under a USD budget warns, and is an error with `unknownPrice: 'reject'`), where the API key comes from (core never reads the environment, so a key left there is reported too, never its value), tools the model cannot take or takes only on another protocol, and the Node version. Every profile fact is labelled as not live-verified.

  New exports from `@deuz-sdk/core/headless`: `runHeadless`, `resumeHeadless`, `inspectRun`, `doctor`, `loadProjectInstructions`, `exitCodeFor`, `HEADLESS_EXIT_CODES` and the types `HeadlessReport`, `HeadlessOutcome`, `HeadlessPendingAction`, `HeadlessCost`, `HeadlessRetry`, `HeadlessRunOptions`, `HeadlessResumeOptions`, `HeadlessSessionOptions`, `DoctorOptions`, `DoctorReport`, `DoctorFinding`, `DoctorSeverity`, `ProjectInstructions`, `ProjectInstructionFile` and `ProjectInstructionsOptions`.

- 6bd8c0a: Headless preview: reports and `resumeHeadless` take the native durability options of 2.3. A pending action for a call whose effect is unknown names both answers, `resumeWith: ['retryToolCallIds', 'reconciledToolResults']`: check the effect, then run the call again or record the result that landed, so it never runs again. A failed run whose stored envelope records a transient cause (a model call that failed in transit: a network or provider error, a transport timeout, an open circuit breaker or a stream that broke off; or a budget admission refused with a serialization conflict) carries a new report field, `retry` (`cause`, `phase`, `resumeWith: 'retryFailed'`), on the leg's report and in `inspectRun`: resume it with `retryFailed: true` to go on from its last checkpoint. The outcome and exit code do not change: `failed` (exit 1), or `limit` (exit 6) for a transport timeout. A retried resume that stops again before its first write, on an unknown effect for example, keeps `retry`, so the next resume passes `retryFailed: true` with its answers. A run that a lease drain stopped (stop reason `'drained'`) has not ended: its report is `pending` (exit 3) with a pending `resume` in the phase it stopped in, as `inspectRun` reports the stored run; when the drain reached a resume before it took the run up, the report lists what the run still waits for (its approvals, client results or unknown effects, and `retry` for a run that failed in transit). A resume refused before it wrote anything (a changed binding, `retryFailed` for a failure that was not transient, or, on a run that has not ended, a client or recorded result for a call the run does not wait on or a call both run again and recorded) reports its own error without `retry`, and the stored run stays as it was. A verdict or a `retryToolCallIds` entry that matches no pending call is ignored, and a resume of a run that ended (completed, stopped, or failed and not retried) returns its stored result and ignores client results, recorded results and retry IDs. New type `HeadlessRetry`.

  `runHeadless` rejects, and stores nothing, when a `projectInstructions` option is invalid, as it does when `projectDir` is not a directory. A skill folder that does not exist adds no skills.

  `examples/13-headless`: `resume` takes `--retry-call <call-id>`, `--reconcile <file.json>` (the results that landed) and `--retry-failed`, and two keyless scenarios show them: `--mock crash` makes the run store go down while a tool runs, leaving an unknown effect, and `--mock outage` opens the circuit breaker so the model call fails in transit. `--approve` and `--deny` answer the approval the stored run waits on, also one that the report of a leg that failed before its next checkpoint does not list, so `resume <run-id> --deny --retry-failed` finishes a run whose denying leg failed in transit. Relative paths and the project instructions are taken from the directory the command was started in. A `--reconcile` file that cannot be read as JSON is a usage error (exit 2); one that holds no list of answers goes to the resume, which refuses it (exit 1) without writing.

- ea7c658: **Behaviour change:** every Gemini finish reason is mapped on purpose. On the native wire (`createGoogleNative`) and in batch results, the filters `SPII`, `IMAGE_PROHIBITED_CONTENT` and `IMAGE_RECITATION` now end a turn with `'content_filter'`, like `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` and `IMAGE_SAFETY`; they ended it with `'stop'`. `CONTINUATION` ends it with `'length'` instead of `'stop'`, since Deuz sends no continuation token. Because Gemini finishes a turn that called a function with `STOP`, a turn that carried a call ends with `'tool_calls'`; that rule no longer hides a filter or a limit. A turn that streamed a call and was then filtered or cut off ends with `'content_filter'` or `'length'` instead of `'tool_calls'`, so the finish-reason gate holds the call back in both loops and in native runs. Every other value ends a turn as before: `STOP`, `FINISH_REASON_UNSPECIFIED`, any value `@google/genai` 2.28 does not list, and the stops that leave no usable answer (`LANGUAGE`, `OTHER`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `NO_IMAGE`, `IMAGE_OTHER`) end it with `'stop'`, or `'tool_calls'` when it carried a call, so after one of those a native run with `output` still reaches finalization and re-asks through output repair when the answer is empty or invalid. New and additive: the `finish` part, and so the streaming loop's `step-finish` part, keeps Gemini's own value as `providerMetadata.google.finishReason`, which tells those stops from `STOP`; a batch result carries the same key.

  **Behaviour change:** a streamed OpenAI Responses turn that its content filter cut off (`response.incomplete` with `incomplete_details.reason: 'content_filter'`) ends with `'content_filter'` instead of `'stop'`, or `'tool_calls'` when it streamed a call, so the finish-reason gate holds that call back. `max_messages` and `steered` still end a turn as a complete response does.

  **Behaviour change:** an OpenAI refusal is kept. Both OpenAI wires dropped the model's refusal text (Chat Completions `delta.refusal`, Responses `response.refusal.delta` and `response.refusal.done`), so a refused answer looked like an empty one that ended with `'stop'`. A refused turn now ends with `'content_filter'`, as an Anthropic refusal does, unless the provider reported `'length'` or `'content_filter'` itself, also when its stream closes before the last event (no Chat Completions `finish_reason`, no Responses `response.completed` or `response.incomplete`). The refusal text is its stop explanation, `stopDetails: { type: 'refusal', explanation }`, on `generateText`, `streamChat`, `generateObject`, `streamObject`, `NoObjectGeneratedError`, native runs (which stop with reason `'refusal'`), the UI wire and batch results, and the `finish` part keeps it as `providerMetadata.openai.refusal`, the key the batch parsers use. The refusal never becomes answer text, and a refused turn dispatches none of its tool calls. The batch parsers share each streaming adapter's finish mapping, so a batch result ends as the same reply does when streamed.

  No public type changes: `FinishReason` and `StopDetails` keep their shapes. Wire shapes follow the types of `openai` 7.32.0 and `@google/genai` 2.28.0; not live-verified.

- 7a3b533: The MCP client speaks MCP 2026-07-28. That revision ships only in the v2 TypeScript SDK, so the client is now dual-stack over two optional peers: `@modelcontextprotocol/client` (v2, 2026-07-28, ^2.3.1) and `@modelcontextprotocol/sdk` (v1, 2025-11-25, unchanged). `createMcpClient` and `createStdioMcpClient` take `sdk: 'auto' | 'v1' | 'v2'` (default `'auto'`: the v2 line when its package can be imported, else v1) and, on the v2 line, `versionNegotiation: 'auto' | 'legacy' | { pin }` (default `'auto'`: a `server/discover` probe selects 2026-07-28 when the server offers it, else the 2025-era `initialize` handshake; a pin fails loudly against anything else and is rejected on the v1 line). Nothing changes until you install the v2 package; with it installed, pass `sdk: 'v1'` to keep the 2.2 handshake. A zero-config `mcp` entry forwards the same two fields to the connection it opens. `McpClient` gains optional `protocolVersion()` and `sdk()`, and `McpHttpTransport` gains an optional `fetch` that every request goes through on both lines (a proxy, a service binding, an in-process server). With neither SDK installed, connecting rejects with an `InvalidRequestError` naming both packages.

  Every existing client feature works on both lines: HTTP, SSE and stdio transports, OAuth (a pre-registered client is stamped with the issuer the v2 SDK requires), sampling, roots, elicitation, reconnect, keepalive, `tools/list_changed` hot refresh and tool fingerprints. On a 2026-07-28 connection, elicitation, sampling and roots arrive as `input_required` results and are answered by the same handlers; the keepalive and the dead-session probe ask `server/discover` because the revision removed `ping`; `tools/list_changed` is received over a `subscriptions/listen` stream the client opens and re-opens every time it is cut (only a stream that keeps ending within seconds of opening is given up, and reported); `setRoots()` sends no notification because the server re-reads the roots per request; and a URL-mode elicitation carries no `elicitationId` (it is `''`). Over stdio the v2 line's `'auto'` probe runs on a short-lived sibling process, so the server starts twice per connect; use `versionNegotiation: 'legacy'` for a server with side effects at startup. Not exposed yet: the v2 response-cache controls, cached-discovery reuse, resource subscriptions, and prompt/resource list-change notifications.

  OAuth against an authorization server that implements RFC 9207 (it advertises `authorization_response_iss_parameter_supported` and names itself with `iss` on the redirect): the v2 SDK refuses to redeem the code without that `iss`, so it can now be forwarded with the new `authorizationIss` option next to `authorizationCode`, as `provider.completeAuth(code, iss)`, and through the loopback listener's new `waitForCallback()`, which resolves `{ code, iss? }`. All three are additive. `completeAuth` runs the exchange on the SDK line its provider was bound through, so a provider handed to an `sdk: 'v1'` client keeps the 2.2 exchange; a fresh provider uses the v2 SDK when it is installed.

  New: an MCP server. `createMcpServer` (`@deuz-sdk/core/mcp/server`, edge-safe) publishes a `ToolSet`, a native `AgentToolSet` (`agentTools`, with `toolsContext`) and whole agents (`agents`: `runAgent` behind a `{ prompt }` tool) on the v2 SDK's server (`@modelcontextprotocol/server` ^2.3.1, an optional peer). `server.fetch` is a fetch-native Streamable HTTP handler for Workers, Deno, Bun and route handlers; `serveMcpStdio` (`@deuz-sdk/core/mcp/server/stdio`, Node-only) serves the same handle over stdin/stdout. One definition answers 2026-07-28 clients and, by default, 2025-era clients through a stateless fallback (`legacy: 'reject'` makes a 2026-07-28-only endpoint). A served call runs the loop's pipeline in the loop's order: the arguments are checked against the advertised schema (a raw JSON Schema is listed verbatim; a Standard Schema is listed as its JSON Schema and still transforms once), then `guardrails.onToolCall`, the approval gate, `execute` (a throw or a `Tool.timeoutMs` expiry becomes an error result carrying the message), and `guardrails.onToolResult`. A plain-object result travels as `structuredContent`, so a Deuz client gets the object back. `needsApproval` is decided by a server-side `approve` callback or, by default, by a yes/no elicitation the client's user answers; a call nobody can approve (a client without form elicitation, a 2025-era client over stateless HTTP) is denied and never runs. A served agent answers with its output; a suspended, stopped or failed run is an error result naming why. Pass the verified caller identity as `server.fetch(request, { authInfo })`; it reaches `runtimeContext`, `toolsContext` and `approve` and is never read from headers. `ready()` loads the peer and prepares every tool up front, so a missing package or a schema that cannot be listed fails at startup. Client tools and provider-executed tools are rejected at construction because the server has nothing to run.

  `listTools()` now reads every page of a paginated `tools/list`; it used to keep only the first page and silently drop the rest of the catalog. A tool on any page keeps the SDK's check of its structured results against its `outputSchema`, on both lines.

  All of this is additive: no existing export, event union or persisted format changes. The 2026-07-28 client and the server are verified offline against the official v1 and v2 SDK clients and servers, in-process and over a real stdio child process; they are not live-verified against third-party hosted MCP servers or clients.

- d8a0d76: Redis backends for operations, budgets and swarms, promised for 2.3 in the 2.2 notes. `@deuz-sdk/core/ops/redis` adds `createRedisOpsStore({ client | url, prefix? })`, which returns `leases`, `agentRuns`, `claims` and `close()` with the 2.3 semantics of the SQLite and Postgres ops stores (acknowledged cancels, a revision compare-and-set on every agent run save, retention on all three), and `createRedisBudgetStore`, a `BudgetStore` with `holds`, `sweep` and `prune` that admits, settles and refuses exactly like the others. `@deuz-sdk/core/swarm/redis` adds `createRedisSwarmStore`, a `SwarmStore` with the `'spawn'`, `'channels'` and `'list'` capabilities, `head` and `prune`. Every operation is one Lua script, so it is atomic on the server, with no `WATCH`/`MULTI`; lease, claim and budget-window time is the server's `TIME`, never a host clock; and every key of a store carries one hash tag (`{<prefix>:ops}`, `{<prefix>:budget}`, `{<prefix>:swarm}`), so a Redis Cluster keeps each store in one slot. A swarm commit validates at the run's revision and writes only while the run is still at that revision and generation, so a concurrent writer gets `SwarmConflictError` and a run pruned and created again under its key never takes a write meant for the old one. Retention removes at most 1 000 entries per script and loops, and the budget store folds each scope's history a page of about 1 000 rows per script, so a large backlog never holds the server in one long script. Each store stamps its key layout version (`<tag>:schema`, 1) on first use and refuses another, as the SQL stores refuse a newer schema. The stores need Redis 7 or later, on a server that never evicts their keys (`maxmemory-policy noeviction` or a `volatile-*` policy; the stores set no TTL), since an evicted budget scope admits its whole limit again and an evicted lease, claim or run key loses what it held. Their conformance suites run offline on ioredis-mock, which executes the same scripts, and on a real Redis when `DEUZ_TEST_REDIS_URL` names one, as in the repository's CI.

  The Redis store pack serves `runs`. `createRedisStores` now returns the `RunStore` the SQLite and Postgres packs already had, which the 2.0 notes listed for Redis before it existed: a record string plus one sorted set per status, written in the pack's crash-tolerant order, so `list({ status })` is an index read. It needs only the pack's existing commands. **`RedisStores` is widened with `runs`.**

  The client seam runs scripts and takes ioredis. `RedisClientLike` gains an optional `eval(script, { keys, arguments })`, node-redis's `EVAL` signature; the new stores need nothing else (`RedisScriptClient`), so a connected node-redis client, standalone or cluster, fits as it is. `wrapIoredisClient(client)` fits an ioredis client to the whole seam, `eval` included, and answers an empty batch locally; `IoredisClientLike` is the structural shape it accepts. A `keyPrefix` set on the ioredis client applies to every key the stores touch, because each script builds its keys only from the keys it declares. node-redis 6 fits the seam as v4 and v5 do, and the message for a missing optional `redis` peer now names v4, v5 or v6.

  New exports: from `@deuz-sdk/core/ops/redis`, `createRedisOpsStore`, `createRedisBudgetStore`, `wrapIoredisClient` and the types `RedisOpsStore`, `RedisOpsStoreOptions`, `RedisBudgetStore`, `RedisBudgetStoreOptions`, `RedisScriptClient` and `IoredisClientLike`; from `@deuz-sdk/core/swarm/redis`, `createRedisSwarmStore`, `wrapIoredisClient` and the types `RedisSwarmStore`, `RedisSwarmStoreOptions`, `RedisScriptClient` and `IoredisClientLike`; from `@deuz-sdk/core/stores/redis`, `wrapIoredisClient` and the types `RedisScriptClient` and `IoredisClientLike`.

- 899074f: Native runs can be listed on Redis. The `agentRuns` of `createRedisOpsStore` (`@deuz-sdk/core/ops/redis`) now implements `AgentRunStore.list` with the contract the memory, SQLite and Postgres stores share: newest save first, then run ID descending, an opaque `cursor` while more runs follow, the `phases`, `scope` and `updatedBefore` filters, and the stored result's `status`. So `findStaleAgentRuns` from `@deuz-sdk/core/ops` works on Redis as well. A run's `updatedAt` is the server's `TIME` at its last save. The Lua script that checks and writes the run's revision also keeps sorted-set indexes of the runs under the store's hash tag: every run, by phase, by scope, and by both. The prune script removes pruned runs from them. A listing reads only the indexes it needs (one per phase it names) and loads no run, and runs saved in the same millisecond are ordered by run ID exactly as JavaScript compares strings. The key layout version stays 1. Widened public type: `RedisOpsStore['agentRuns']` declares `list`.
- d17bf6c: **A native resume answers a call from its receipt when the receipt records the call's outcome.** A native run saves a call's receipt before the checkpoint that answers the call, so a run can stop in between: its process dies while other calls of the step still run, a store write fails, or a sub-agent called in the same step suspends on its own approval. The next resume found the call unanswered and ran the approval gate again. A call that had waited for an approval (`needsApproval`, or the execution policy's `requireApproval`) was then answered `Tool call denied. Reason: No approval response.` unless the resume passed its verdict again, so the model was told the call had been denied although its effect had landed and its result was recorded.

  This is a behaviour change. Such a call is now answered from its receipt exactly like a call that needs no approval: the policy and the `onToolCall` guardrails still apply, the receipt answers the call through the normal tool path (`onToolResult` included), and the tool never runs again. A receipt records an outcome in stage `executed`, `completed`, `failed`, `validation-failed` or `projection-failed`, including one recorded with `reconciledToolResults`. The resume needs no verdict for such a call. A verdict passed for it anyway, an approval or a denial, decides nothing: the resume ignores it and streams a `warning` part (`type: 'other'`, `setting: 'approvalResponses'`) that names the call. A call without a recorded outcome is gated as before: one that never started, one in `executing` that `retryToolCallIds` runs again, and a sub-agent call in `suspended`; without its verdict it is answered as denied. This holds for `resumeAgent` and `resumeStreamAgent`, for a run's own tools, a handoff target's tools and MCP tools, which share the run's receipts. A client call is answered the same way from the result a resume supplied, which the resume records in the call's receipt as it applies it.

  **An interrupted native resume no longer loses the client results it was given.** The resume that took a run up cleared its pending client calls at once, so a resume that died before the step that answers them was saved lost their results: the next resume answered each call `Tool call denied. Reason: No result provided for this client tool.`, and a result passed again failed it with `Client tool results must match unique pending call IDs on resume.` The same denial followed, without any crash, when a sub-agent called in the same step suspended on its own approval. The calls now stay pending until the resume has saved its answers: a resume that died before it recorded a result accepts the same result again, and a resume without it stays suspended on the call, also when a call beside it moved the stored step on. A result the resume did record answers the call on the next resume without being supplied again; one passed for it anyway is ignored with a `warning` part (`type: 'other'`, `setting: 'clientToolResults'`) that names the call. A later call of the same client tool still suspends the run.

  **A native resume saves what its settle answered before its first model call.** The answers to the pending calls (each call's result or error, a denial, a client result) are saved as the run's checkpoint before the resume's first model call. Before, nothing recorded them until the step after that call was checkpointed, so a process that died during the call left them unanswered: the next resume denied an approved call that had run, or ran it again when its verdict was passed again, and ran a call that needs no approval again, as in 2.2. The next resume, a `retryFailed` one included, now goes on from the saved answers and needs no verdict or client result again.

  **A leased native run can be drained.** A `'drain'` signalled to the key of a native run that holds a `lease` (`leases.signal(agentRunLeaseKey({ scope, runId }), 'drain')`) stops the run at its next model-step boundary, for example to move the run to another process during a deploy. The executor picks it up at its next renewal, as it does a `'cancel'`. Nothing in progress is interrupted: the step's model call and tool calls finish, a model call that fails over goes to the next model first, and no further model call starts. The result is `stopped` with the new stop reason `'drained'`; on a stream, the `finish` part of a run that stopped after a step also names it (`providerMetadata.deuz.stoppedBy: 'drained'`). The run has not ended. No outcome is committed: it stays as its last save left it, a run stopped after a step exactly as after any other step (a run with `chat` still saves its chat projection, as after any leg), so a resume on any executor goes on from there and nothing that ran runs again. A new run stops before its first model call, once it is saved; a run with `output` stops before its final answer call, or before a new one after an invalid answer or a rejected verdict. A resume that the drain reaches before it takes the run up writes nothing; one that already took the run up goes on to its first step boundary, so the verdicts and client results it was given are applied and saved first. Any other stop at the same point comes first (`maxSteps`, a budget), and a cancel or an abort of the run's `signal` outranks a drain. As for a swarm, the signal concerns the executor that holds the run: it is dropped when the run changes hands or the lease is released. Unlike a drained swarm, which settles as `'suspended'`, a drained native run keeps its phase, so `findStaleAgentRuns` finds it as it finds a run whose executor died.

- 5ef0412: Realtime voice. `createRealtimeSession` in the new edge-safe `@deuz-sdk/core/realtime` opens a live speech-to-speech session with OpenAI Realtime (`createOpenAIRealtime`) or Gemini Live (`createGeminiLive`) over WebSocket, behind one event model: session lifecycle, input audio append and commit, output audio deltas, input and output transcripts, text, tool calls, interruption, turn end, errors and usage. `deps.webSocket` is the socket seam: the default is the runtime's global `WebSocket`, which sends a server-side API key as a handshake header in Node.js 22+ (or pass a `ws` socket), while a browser connects with an ephemeral token minted on your server by `createOpenAIClientSecret` or `createGeminiAuthToken`. Gemini tokens lock the session configuration by default. Tools are ordinary Deuz tools: they are validated, approval-gated (`approveToolCall`), timed out on `deps.clock`, and their errors go back to the model; a tool without `execute` waits for `session.sendToolResult`. OpenAI tool calls run only from a completed response, and a Gemini cancellation aborts the call. Usage is split by modality (text, audio, image) and priced per modality through `deps.priceProvider`; `realtimePriceTable` builds the rows, and a model without a price warns once (`unpriced-model`) while the session continues. No realtime prices ship. OpenAI's `interrupt({ playedMs })` cancels the running answer and truncates the audio to what the user heard. `sendRaw`, `rawEvents` and `providerOptions` cover anything the normalized API does not map. Sessions are single-use, `RealtimeError` carries a `kind` for every failure, and messages never contain the key or token. Not live-verified: both wires were derived from the official SDK types (`openai` 7.32, `@google/genai` 2.28) and are tested offline against a scripted socket and a local WebSocket server. WebRTC, Vertex AI Live and OpenAI transcription-only sessions are not covered; WebRTC is planned for 2.4.
- 3e33b40: Native runs get three opt-in ways to go on after a persistence, catalog or transport failure. No default changes, and a 2.2 process reads what they write as before, except that a call recorded with `isError` while it is still open is saved as version 2, like any open call whose receipt records `failed`.
  - **A catalog change the run missed.** A native run with `onCatalogChange: 'accept'` could die between an MCP hot refresh and the save that records the refreshed catalog; while the server kept its new catalog, every resume failed with `MCP tool catalog changed across resume`. A resume with `onCatalogChange: 'accept'` now treats the change like the hot refresh it missed: its first write records the servers' catalog as a new binding revision, before its first model call, and it reports the same `warning` part (`setting: 'mcp'`). It still fails, and leaves the run untouched, while a call the model made against the recorded catalog is in flight (an MCP receipt in stage `'executing'`, or a call of the last turn that waits for its verdict or never started) and when the resume dropped the `mcp` entries. Under `'stop'`, the native default, the resume fails exactly as before. A resume that writes nothing records nothing.
  - **Recording an effect that landed.** After a `tool-reconciliation-required` stop, an effect that did land could not be recorded: the run stayed stopped, or `retryToolCallIds` ran it again. The new resume option `reconciledToolResults: [{ toolCallId, output, isError? }]` (the shape of `clientToolResults`) records the outcome you found in the system the effect touched. The receipt takes `output` as the call's raw result, marked with the new `AgentToolReceipt.reconciled`, and the step goes on from it exactly as from a result the tool recorded (through `outputSchema`, `validateResult` and `toModelOutput`); the call never runs again. With `isError` the call is answered with `output` as its error. Only the run's interrupted calls are accepted: its unknown effects, and a call of a `replay: 'idempotent'` tool whose receipt was written before 2.3 and so records no replay policy (it would run again by itself, and a headless report lists it as unknown). Each is accepted once and never also in `retryToolCallIds`; anything else fails the resume with a `TypeError` before anything is written. A call that waited for an approval needs no verdict: the recorded outcome answers it, and a verdict passed for it is ignored with a `warning` part. A stop for reconciliation now lists every call the store still holds as unknown in `unknownEffects`, also one the stopped resume tried to retry or reconcile, since that stop records nothing.
  - **Retrying a run that failed in transit.** A native run that fails stays failed, and a resume returns its stored result. That held for a transient failure too, such as a model stream that broke off or a budget admission refused with a serialization conflict, so a durable run could not go on after a short outage. The failed envelope now records, additively, whether its cause was transient (`AgentRunEnvelope.retry: { cause: 'model-call' | 'admission', phase }`, new type `AgentRunRetry`): a model call that failed with a retryable transport or provider error (network, transport timeout, 5xx, 429/529 after its own retries, an open breaker), a model call whose stream broke off, or a budget admission the persistent store refused with 40001 or 40P01 after its own retries; never for a run that was cancelled, lost its lease or ran out of time. The envelope stays version 1: a 2.2 reader returns the failed result as before. The new resume option `retryFailed: true` re-enters such a run from its last checkpoint, in the phase it failed in, after every check of a resume: completed calls answer from their receipts, and an unknown effect still stops it for reconciliation. The failed call stays counted, as a model step (a final answer also as one of `maxOutputAttempts`, as after a crash) and, while its outcome is unknown, in the accounting at its estimate; the retried call is reserved on its own. For any other failure a resume with `retryFailed` fails with a `TypeError` and writes nothing; for a run that did not fail the option is ignored.

  Four fault-injection scenarios show these recoveries: `fault/mcp-refresh-record-failure-accepted`, `fault/after-effect-before-receipt-reconciled`, `fault/mid-model-stream-retried` and `fault/admission-store-failure-retried`. The scenarios they vary still pin the default outcome (`fault/mcp-refresh-record-failure` now resumes under the default `'stop'`, version 2).

### Patch Changes

- 92dd649: The `deuz-sdk` Agent Skill's maintenance tooling is now in the repository, under `packages/core/tooling/skills/`. Its index and its docs page named generator and verifier scripts in a git-ignored directory, so nobody could regenerate or check the skill. No runtime code changed, and nothing in the published package changed.
  - `generate-api-index.mjs` rebuilds `references/api-index.md` in both skill copies from `package.json` `exports`, tsup's entry map and a walk of the source that follows `export *`. The index lists every subpath with its values, its type-only names and a reverse lookup. The stamp date comes from `--date` or `SOURCE_DATE_EPOCH`, never from the clock, and names are sorted in a pinned locale, so the same sources give the same file on any machine. Run against the v2.2.0 sources with the subpath descriptions 2.2.0 shipped, it reproduces the shipped 2.2 index byte for byte, apart from its "regenerate" line and one pair of names. The 2.2 file was sorted in a Turkish locale, where `I` sorts before `i`; `--locale tr` restores that order.
  - `verify-skill.mjs` resolves every `@deuz-sdk` import, every quoted or backticked `@deuz-sdk/…` specifier (one of a package that does not exist, such as `@deuz-sdk/cli`, fails too) and every "`name` from `@deuz-sdk/…`" claim in `SKILL.md` and `references/*.md` against the real export table. It skips fences tagged `no-verify`. It fails when any stamp's package version or API-contract hash is not the current one, when the index differs from the generator's output, and when the two skill copies differ (`TESTING.md` aside). Given a directory, it grades agent answers by name alone.
  - `sync-skill-copy.mjs` makes `skills/deuz-sdk/` the single source and mirrors it into `.claude/skills/deuz-sdk/` with `--write`. It refuses a source without a `SKILL.md`, so a mistyped `--skill` cannot empty the mirror. `extract-examples.mjs` writes each `ts`/`tsx` example as its own module, for the compile check `TESTING.md` describes.

  Documentation fixes: the 2.0 notes said the Redis store pack had a run store, which it gained only in 2.3, and both changelogs now carry a correction. The docs deployment guide now gives the commands that drive `deploy/redeploy.sh`, in place of a script the repository never had, and deploys from `main`.

## 2.2.0

### Minor Changes

- 17ef301: Swarm accounting now grows with live work instead of history. A finished task's reservations fold into one ancestor aggregate (`BudgetLedger.compact`, ledger snapshot version 2), and a native run under a shared child context checkpoints only its own ledger slice. Event readers poll the optional `SwarmStore.head()` instead of reloading every task. Native tools can declare `replay: 'idempotent'` and read a stable `ctx.modelStep`. `timeout.chunkMs` fails a stream that stalls between parts with `TimeoutError` layer `'chunk'`.
- 023541f: Swarms can grow at runtime. With `dynamic` limits, a finished task spawns more tasks — reducers through `context.spawn`, agent bindings from their validated output through `spawn(output)` — and the children commit atomically with the parent's terminal state, so a crash never duplicates or loses them. `onFailure` hooks commit compensation tasks with a failure, and `timeoutMs` fails an attempt that runs long as `SwarmTaskTimeout`. Dynamic runs are version 2 and need a store with the `'spawn'` capability; the memory and SQLite stores have it. The SQLite swarm store moves to schema 2 and upgrades a 2.1 file in place on first open.
- 075e624: Swarm agents can work together. Tasks take a `group`, and agent bindings with `blackboard` get idempotent `blackboard_post` / `blackboard_read` tools over durable, ordered group channels (stores need the new `'channels'` capability; memory and SQLite have it); reducers page channels through `context.readChannel`. Soft dependencies (`after`) wait for tasks to settle in any state and pass only completed results, with statuses in `context.settled`. `createRounds` builds rounds of group-parallel agents with a consolidator that reallocates agents and prompts between rounds.
- 27668ca: Durable runs can move between processes. A new `@deuz-sdk/core/ops` entry adds leases (`createInMemoryLeaseProvider`), and `@deuz-sdk/core/ops/sqlite` / `@deuz-sdk/core/ops/postgres` add durable lease providers and native agent run stores. Swarms take a `lease` option: the executor renews its run's lease on a heartbeat, a second executor gets `SwarmLeaseError` `'held'`, and one that loses its lease stops writing (`'lost'`). New operations: `handle.drain()` (settles `suspended` with a `run.drained` event), `swarm.recover()` (takes over running runs without a live executor, using the new `listRuns` store capability `'list'`), `swarm.requestCancel(key)` (`'signalled'`, `'recorded'` or `'settled'`), and `expectedRevision` / `expectedStatus` on resume. `@deuz-sdk/core/swarm/postgres` adds a Postgres swarm store whose every write is one revision-gated statement. `AgentRunEnvelope.revision` increases on every save and stores reject a stale one; `createInMemoryAgentRunStore` now enforces it too. A queued lease `'cancel'` stays queued across a change of hands and a release until a holder receives it, so a signalled cancel survives a holder that crashes or settles first, and the next executor applies it before dispatching anything. `recover()` resolves to `{ handles, failed }`, reports a run it cannot resume instead of rejecting, pages through up to 10 000 running runs with the new `listRuns` `after` cursor, and a zombie executor whose write meets the revision check rejects with `SwarmLeaseError` `'lost'`. `createPostgresStores` now takes an advisory lock for its migration batch, so several processes migrating a new schema at once queue instead of failing with 23505, a first migration that a concurrent one failed runs again, and a failed batch is rolled back, so a single-connection client such as a `pg.Client` stays usable.
- 750c48c: Evolutionary program search. `evolve` in the new edge-safe `@deuz-sdk/core/evolve` evolves the code between `EVOLVE-BLOCK-START` / `EVOLVE-BLOCK-END` markers with model-written SEARCH/REPLACE diffs, full rewrites and crossovers (0.6 / 0.3 / 0.1). It scores candidates through an evaluation cascade with thresholds, timeouts and an artifact side channel fed back into prompts. Parents are selected with seeded weighted, power-law, beam or Boltzmann sampling over islands, which migrate in a ring and reset the weakest island to the global best, and a MAP-Elites archive keeps the elites. A UCB1 bandit picks from a model ensemble. Novelty rejection works on embedding cosine similarity with an optional judge. A budget is mandatory, and every mutation is charged to a compacted child scope. Stops: target score, plateau, budget, `drain()` and `cancel()`. Candidates get deterministic IDs and idempotent writes, and generations commit with a compare-and-set, so `resumeEvolve` replays stored slots with zero model calls. `parseEvolveBlocks`, `applySearchReplace` and `buildMutationPrompt` are exported as pure helpers. `PopulationStore` has a memory backend and a SQLite backend in `@deuz-sdk/core/evolve/sqlite`. A `lease` option takes the run's lease from a shared `LeaseProvider` while a process drives it: a second executor fails with `EvolveLeaseError`, and one that loses its lease stops before its next write. A full rewrite or crossover takes its parent's final newline, so a program that ends without one no longer loses every rewrite to `frozen_changed`. Policy refusals, authentication errors and unknown models fail the run instead of rejecting every candidate, `modelCalls` leaves out calls refused before any request was sent, and a seed or resumed run that already meets `stopWhen` finishes without a model call.
- fc579a4: Budgets can outlive a run. Execution contexts and ledgers take `admission: { store, scopes, warnAtPercent, onWarning }`: after local admission, every model call is admitted all-or-nothing by a shared `BudgetStore` against persistent scopes such as `user:42` or `org:acme`, with optional rolling windows. Swarms take the same `admission` option for every task's model calls. Settlement and release are mirrored, unknown usage keeps the hold, and requests are idempotent by request ID. Stores: `createInMemoryBudgetStore`, `createSqliteBudgetStore` (`BEGIN IMMEDIATE`) and `createPostgresBudgetStore` (one locking statement per change, database time for windows). Snapshots that record persistent scopes are version 2 and cannot be restored without the store.
- 4fb5b98: New edge-safe `@deuz-sdk/core/schedule` subpath for starting work from time and webhooks. `parseCron` reads five-field UTC cron (lists, ranges, steps, names, macros, the day-of-month/day-of-week OR rule) with `nextOccurrence`, `previousOccurrence` and `occurrencesBetween`. `createScheduler` runs due occurrences from a host cron trigger (`tick`) or an injected clock (`start`), dedupes each `${id}@${at}` key through a pluggable `claim`, follows a `catchUp` policy (`'latest'`, `'all'`, `'none'`) after downtime, and reports run errors per occurrence instead of throwing. `verifyGitHubWebhook`, `verifySlackRequest` (with a replay window) and `verifyHmacSignature` check signatures with WebCrypto and a constant-time comparison, and `handleSignal` turns a verified request into one dispatch, answering 401, 200 for duplicates or 202. A claim may carry `release(key)` (`createInMemoryClaim()` does), and `handleSignal` releases the key when `dispatch` throws, so the sender's retry after the 500 dispatches instead of being dropped as a duplicate. `createSqliteOpsStore` and `createPostgresOpsStore` return `claims`, a durable claim for `createScheduler` and `handleSignal` across processes: one unique insert per key, and `release` deletes it.
- 8cdbbcc: Real rerankers behind the `Reranker` seam: `createCohereReranker` (`./rag`, default `rerank-v4.0-pro`) and `createVoyageReranker` (`./voyage`, default `rerank-2.5`). They map provider indices back to the original chunks with the relevance score, follow the `deps.keyProvider` > `apiKey` and factory `fetch` > `deps.fetch` precedence, and raise the usual `DeuzError` classes. A fourth guardrail hook, `onToolResult`, runs after a tool returns and before the model sees its result (`pass`, `block` into an `is_error` result, or `rewrite`) in `generateText`, `streamChat` and native `runAgent`, where it guards the model-facing projection and leaves the receipt's raw result alone. Its verdicts report as `hook: 'tool-result'`, and `maxToolResultLength` ships on `./guardrails`. `fingerprintTools` and `detectToolDrift` on `./mcp` hash each tool's name, description and input schema (SHA-256) so a server that rewrites its tools after approval is caught.
- 2a8e705: `PRICES_2026` gains rows for `gpt-6-astra`, `gpt-5.6` (`-sol`, `-terra`, `-luna`), `claude-fable-5-1` and `claude-opus-5`, verified 2026-09-20. `ModelPrice.over272k` prices a whole request above 272,000 prompt tokens, as OpenAI bills its GPT-6 and GPT-5.6 models.

### Patch Changes

- 329f51d: SQLite stores that open a file path load `node:sqlite` again. The build no longer strips `node:` prefixes, which turned the lazy import into a lookup for a package named `sqlite`, and `verify:package` now fails any built file that loads a prefix-only built-in without it. Every SQLite store (memory and chat, swarm, ops, evolve, budget) now sets a busy handler before it switches a file to WAL, so it waits for another process's lock while opening instead of failing at once, and a failed open is retried on the next call instead of being cached. An injected handle that already has a busy timeout keeps it. The Postgres store pack (`createPostgresStores`) serializes its first migration with an advisory lock, retries a lost race and rolls back a failed batch, so processes starting together against an empty schema no longer fail.

## 2.1.0

### Minor Changes

- Add native typed agent runs with strict recovery, scoped tool context, validated output streams, and explicit verification verdicts. Add bounded swarm task graphs with reducers, durable event journals, and memory and SQLite stores.

  Share mandatory execution policies and request reservations across nested agents and auxiliary model calls. Preserve signed child approvals, stop on strict persistence failures, and price each model invocation independently across handoffs and resume.

## 2.0.0

### Major Changes

- Memory, compaction, and MCP become first-class; 8 more providers; speech, transcription, and video.

  **Memory that survives the session.** Facts are deduplicated by hash at write time, scored for importance by the model that extracted them, swept when they expire, and reachable through `[[wikilink]]` graph expansion. `recall` finally honors `scorer`, `maxChars`, and `expandLinks` — `maxChars` was never passed before, so the recall block was unbounded and uncounted against the context budget. `writePolicy` decides when the loop writes; `memoryEmbedderFromRag` bridges the two embedder seams.

  **Compaction that folds instead of stacking.** Repeated summaries merge into one running block. `compactMessages()` exposes the layers to callers who own their history. `countTokens` accepts a real tokenizer. And a provider that rejects a request as too long now triggers one forced pass and a retry, instead of failing the run.

  **Production stores.** SQLite (`node:sqlite`, or any better-sqlite3-compatible handle you inject), Redis, and Postgres — each implementing the memory, chat, session, and run stores against one shared conformance suite, so a divergence between backends is a test failure rather than a surprise in production.

  _Correction (2.3): the Redis pack implemented the memory, chat, and session stores only. It had no run store until 2.3, where `createRedisStores` returns `runs`._

  **MCP you can rely on.** OAuth 2.0 with PKCE, discovery, dynamic registration, and refresh, behind a `TokenStore` seam with file and loopback helpers for Node. Connections reconnect with backoff, report status, and invalidate their tool cache on `tools/list_changed`. Servers can drive sampling through your own model behind an approval gate, and read roots. `options.mcp` connects servers for a call, namespaces their tools, and closes only what it opened.

  **Agent controls.** `handoff()` transfers the conversation to another agent — system prompt, tools, and model swap for the rest of the run, and a checkpoint replays it. `guardrails` can pass, block, or rewrite on input, tool calls, and output; a blocked tool call self-heals through the existing denial path instead of ending the run. `runtimeContext` threads a typed value to tools, hooks, and sub-agents.

  **Providers and modalities.** Ollama, LM Studio, Perplexity, Cohere, DeepInfra, Nvidia NIM, SambaNova, and Hyperbolic. The two local hosts need no API key, without weakening the key-precedence chain. `generateSpeech`, `transcribe`, and `generateVideo` are new, the last giving the Yunwu video model list a producer at last.

  ### Breaking changes
  - **`NotImplementedError` is removed.** It was never thrown — a leftover from the pre-1.0 scaffolding. Delete the import; nothing else changes.
  - **`ObservedSubsystem` and the compaction `trigger` union gained members** (`speech`/`transcription`/`video`, and `manual`/`overflow`). An exhaustive `switch` over either needs a new case.
  - **The streaming `compaction` part always carries `trigger`**, where it used to be absent.
  - **`generateObject` / `streamObject` now reject `mcp`, `guardrails`, and `doneWhen`** instead of silently ignoring them, the same way 1.9 made the other loop options loud.

  The `Part` union stays at five members: audio and documents ride `filePart()` with a media type, and a sixth kind would break every exhaustive switch for a wire none of the providers offer.

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
