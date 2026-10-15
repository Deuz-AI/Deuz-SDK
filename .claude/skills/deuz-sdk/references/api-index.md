<!-- GENERATED FILE — do not hand-edit.
     regenerate: node packages/core/tooling/skills/generate-api-index.mjs --date YYYY-MM-DD
     source: packages/core/{package.json exports, tsup.config.ts} + src walk (export * followed)
     verified: 2026-10-16 against @deuz-sdk/core@2.4.0 · api-contract sha256:e126e881213b -->

# API index — every subpath, every export

**Load when:** checking whether a name exists, finding which subpath exports it, or exploring an unfamiliar module.

`@deuz-sdk/core@2.4.0` ships **80 subpaths**; `@deuz-sdk/react` ships one. Names marked under **Types** are type-only — import them with `import type`, or a bundler-free runtime will crash looking for a value that was erased at compile time.

If anything here disagrees with `packages/core/package.json` `exports` or `tooling/api-contract.json`, those win — and this file is stale; regenerate it.

## `@deuz-sdk/core`

The six call functions, tool authoring, stop conditions, errors, model profiles, and every canonical type.

**Values** (55): AbortError, agentTool, anthropicWebSearch, APICallError, AuthenticationError, BreakerOpenError, compactMessages, ContextOverflowError, costExceeds, createClient, createPriceProvider, DeuzError, durationExceeds, embed, embedMany, filePart, generateObject, generateText, getModelCapabilities, googleSearch, handoff, hasToolCall, imagePart, InvalidRequestError, isDeuzError, logging, maxOutputLength, maxToolResultLength, McpAuthorizationRequiredError, ModelNotFoundError, NetworkError, NoObjectGeneratedError, openaiWebSearch, OverloadedError, PRICE_ALIASES, PRICES_2026, priceUsage, promptInjectionGuard, promptInjectionGuardrail, RateLimitError, redactPII, resolveDependencies, resolveModelProfile, simpleCache, stepCountIs, streamChat, streamObject, TimeoutError, tool, ToolExecutionError, totalTokensExceed, UnpricedModelError, UnsupportedCapabilityError, withFallback, wrapModel

**Types** (215): ActivityPart, AgentCheckpoint, AgentToolDef, AnthropicThinkingType, AnthropicWebSearchConfig, APICallErrorOptions, ApprovalRequestedEvent, ApprovalResolvedEvent, BreakerState, BreakerStore, BudgetExceededPart, CallWarning, CheckpointFailedEvent, CheckpointLoadedEvent, CheckpointSavedEvent, CheckpointStatus, CitationPart, ClientConfig, Clock, CommonCallOptions, CompactionEvent, CompactionLayer, CompactionObserveEvent, CompactionOption, CompactionPart, CompactionPolicy, CompactionSkippedEvent, CompactMessagesDeps, CompactMessagesResult, CostCalculatedEvent, CostPart, CreatePriceProviderOptions, DataPart, DeepPartial, Dependencies, DeuzClient, DeuzErrorJSON, DeuzOAuthProvider, DoneWhen, DoneWhenContext, DurableSessionOptions, EffortField, EffortLevel, EffortNoneMapping, Embed, EmbeddingModel, EmbeddingModelSurface, EmbeddingProvider, EmbeddingTaskType, EmbedMany, EmbedManyOptions, EmbedManyResult, EmbedOptions, EmbedResult, ErrorStreamPart, FallbackHooks, FalseFinishPart, FinishMeta, FinishReason, FinishStreamPart, GenerateObject, GenerateObjectOptions, GenerateObjectResult, GenerateText, GenerateTextOptions, GenerateTextResult, GuardrailBaseContext, GuardrailPart, Guardrails, HandoffAgentDef, HandoffOptions, HandoffPart, ImagePart, InferSchemaOutput, InferToolInput, InferToolOutput, InputGuardrail, InputGuardrailContext, InputGuardrailResult, JSONSchema, KeyProvider, LanguageModel, LanguageModelMiddleware, Logger, McpClientLoopEntry, McpHttpLoopConfig, McpLoopEntry, McpOAuthOptions, McpStdioLoopConfig, Message, MiddlewareContext, ModelCapabilities, ModelCompletedEvent, ModelFailedEvent, ModelFirstContentEvent, ModelId, ModelPrice, ModelProfile, ModelProfileCache, ModelProfileClamp, ModelProfileEffort, ModelProfileLimits, ModelProfileSampling, ModelProfileThinking, ModelProfileUsage, ModelRetryEvent, ModelStartedEvent, ModelStatus, ModelSurface, ObservationCaptureOptions, ObservationLimits, ObservationOptions, ObservationRedactor, ObserveAttributes, ObserveAttributeValue, ObservedError, ObservedSubsystem, ObserveEvent, ObserveEventBase, ObservePrimitive, Observer, OpenAIWebSearchConfig, OperationCompletedEvent, OperationFailedEvent, OperationStartedEvent, OutputGuardrail, OutputGuardrailContext, OutputGuardrailResult, Part, PlanTaskSnapshot, PlanUpdatePart, PrepareStepResult, PriceProvider, PriceTable, PriceTier, PriceUsageOptions, ProfileCapability, ProfileSupport, Provider, ReasoningDeltaPart, ReasoningPart, RegistryMatch, ResolvedDependencies, Role, RunAbortedEvent, RunCompletedEvent, RunFailedEvent, RunStartedEvent, RunSuspendedEvent, ServiceTier, SessionStore, SourcePart, Span, SpanOptions, StandardSchemaIssue, StandardSchemaProps, StandardSchemaResult, StandardSchemaV1, StepCompletedEvent, StepFinishPart, StepResult, StepStartedEvent, StepStartPart, StopCondition, StopDetails, StreamChat, StreamChatOptions, StreamChatResult, StreamObject, StreamObjectResult, StreamPart, SubAgentCompletedEvent, SubAgentFailedEvent, SubAgentPart, SubAgentStartedEvent, SubAgentSuspendedEvent, TextDeltaPart, TextPart, TokenStore, Tool, ToolApprovalRequest, ToolApprovalRequestPart, ToolApprovalResponse, ToolCall, ToolCallDeltaPart, ToolCallGuardrail, ToolCallGuardrailContext, ToolCallGuardrailResult, ToolCallOutcome, ToolCallPart, ToolChoice, ToolCompletedEvent, ToolDeniedEvent, ToolExecuteContext, ToolFailedEvent, ToolResult, ToolResultGuardrail, ToolResultGuardrailContext, ToolResultGuardrailResult, ToolResultPart, ToolResultStreamPart, ToolRunState, ToolSet, ToolStartedEvent, ToolStatePart, ToolUsePart, Tracer, Usage, UsageMeta, VerifyPart, VerifyStep, VerifyStepContext, VerifyStepResult, WarningPart, WrappedModel

## `@deuz-sdk/core/anthropic`

Anthropic Messages wire (Claude).

**Values** (2): anthropic, createAnthropic

**Types** (1): AnthropicSettings

## `@deuz-sdk/core/openai`

OpenAI Chat Completions + Responses wires, and OpenAI embeddings.

**Values** (6): createOpenAI, createOpenAIEmbedding, createOpenAIResponses, openai, openaiEmbedding, openaiResponses

**Types** (1): OpenAISettings

## `@deuz-sdk/core/xai`

xAI Grok over the Chat Completions wire.

**Values** (2): createXai, xai

**Types** (1): XaiSettings

## `@deuz-sdk/core/google`

Gemini on either wire: native generateContent or OpenAI-compatible.

**Values** (6): createGoogle, createGoogleEmbedding, createGoogleNative, google, googleEmbedding, googleNative

**Types** (1): GoogleSettings

## `@deuz-sdk/core/google/extras`

Gemini explicit context caching and the Files API.

**Values** (6): createGeminiCache, deleteGeminiCache, getGeminiCache, listGeminiCaches, uploadFile, waitForFileActive

**Types** (6): CachedContent, CreateCacheOptions, GeminiCachePart, GoogleExtrasConfig, UploadedFile, UploadFileOptions

## `@deuz-sdk/core/voyage`

Voyage embeddings (retrieval-tuned, embedding-only provider).

**Values** (4): createVoyage, createVoyageReranker, voyage, VOYAGE_RERANK_DEFAULT_MODEL

**Types** (2): VoyageRerankerSettings, VoyageSettings

## `@deuz-sdk/core/azure`

Azure OpenAI / Azure AI Foundry, api-key or Entra auth.

**Values** (2): azure, createAzure

**Types** (1): AzureSettings

## `@deuz-sdk/core/bedrock`

AWS Bedrock over its OpenAI-compatible endpoint with Bearer keys (no SigV4 SDK).

**Values** (2): bedrock, createBedrock

**Types** (1): BedrockSettings

## `@deuz-sdk/core/providers`

Every provider factory re-exported, plus the OpenAI-compatible host presets and the registry.

**Values** (46): azure, bedrock, cerebras, cohere, createAzure, createBedrock, createCerebras, createCohere, createDeepInfra, createDeepSeek, createFireworks, createGLM, createGroq, createHyperbolic, createKimi, createLMStudio, createMiniMax, createMistral, createMoonshot, createNvidia, createOllama, createOpenAICompatible, createOpenRouter, createPerplexity, createProviderRegistry, createQwen, createSambaNova, createTogether, deepinfra, deepseek, fireworks, glm, groq, hyperbolic, kimi, lmstudio, minimax, mistral, moonshot, nvidia, ollama, openrouter, perplexity, qwen, sambanova, together

**Types** (6): AzureSettings, BedrockSettings, CompatSettings, CreateProviderRegistryOptions, OpenAICompatibleSettings, ProviderRegistry

## `@deuz-sdk/core/testing`

Deterministic mock models, SSE fixtures, fetch mocks, eval runners and versioned eval suites for YOUR tests.

**Values** (8): createMockModel, mockFetch, mockFetchSequence, runEval, runEvalSuite, runGradedEval, sseEvents, sseResponse

**Types** (23): CreateMockModelOptions, EvalAcceptance, EvalAggregate, EvalAttemptReport, EvalCase, EvalCaseResult, EvalRecovery, EvalReport, EvalSuiteReport, EvalTaskContext, EvalTaskManifest, EvalTaskModel, EvalTaskOutcome, EvalTaskReport, EvalTaskSnapshot, EvalTier, GradedCase, GradedCaseResult, GradedEvalReport, GradedSubtask, MockResponse, MockToolCall, RunEvalSuiteOptions

## `@deuz-sdk/core/workspace`

A file-tree seam agents use as externalized memory, plus the tools that drive it and digestWorkspace (2.4).

**Values** (4): createInMemoryWorkspace, createWorkspaceTools, digestWorkspace, normalizeWorkspacePath

**Types** (4): DigestWorkspaceOptions, Workspace, WorkspaceEntry, WorkspaceToolsOptions

## `@deuz-sdk/core/workspace/node`

Real-filesystem workspace (Node only).

**Values** (1): createFileWorkspace

**Types** (1): FileWorkspaceOptions

## `@deuz-sdk/core/compute`

CodeAct: let the model act by writing code; sandbox seam and shell tool.

**Values** (3): codeActSystemPrompt, codeActTool, shellTool

**Types** (8): CodeActToolOptions, CodeExecutionRequest, CodeExecutionResult, ComputeArtifact, ComputeSandbox, ShellExecutionRequest, ShellExecutionResult, ShellToolOptions

## `@deuz-sdk/core/compute/node`

Node child-process sandbox for the compute tools.

**Values** (1): createNodeSandbox

**Types** (2): Interpreter, NodeSandboxOptions

## `@deuz-sdk/core/compute/docker`

Preview (Node only): local Docker sandbox for the compute tools and a reconnectable process runner with its operation store.

**Values** (7): createDockerProcessRunner, createDockerSandbox, createInMemoryProcessOperationStore, createSqliteProcessOperationStore, DEFAULT_DOCKER_SANDBOX, DockerSandboxError, OperationConflictError

**Types** (14): DockerErrorCode, DockerLimits, DockerSandboxOptions, ProcessArtifact, ProcessOperationQuery, ProcessOperationRecord, ProcessOperationStore, ProcessOutput, ProcessReconcileReport, ProcessRunner, ProcessSession, ProcessStartRequest, ProcessState, SqliteProcessOperationStoreOptions

## `@deuz-sdk/core/agent`

Native run/stream/resume/reconcile, validated outputs, execution policies, shared and persistent budgets, V3 runs (checkpointVersion 3, 2.4); also createAgent templates and handoff.

**Values** (18): BudgetLedgerError, BudgetStoreError, createAgent, createBudgetLedger, createExecutionContext, createInMemoryAgentRunStore, createInMemoryAgentRunStoreV3, createInMemoryBudgetStore, ExecutionPersistenceError, ExecutionPolicyError, handoff, intersectExecutionPolicies, reconcileAgentRun, resumeAgent, resumeStreamAgent, runAgent, streamAgent, UnsupportedStoreError

**Types** (104): AccountedEmbedder, AccountedEmbeddings, AccountedMemoryEmbedder, AccountedMemoryLLM, AccountedMemoryLLMResult, AccountedUsage, AgentArrayElement, AgentCallOptions, AgentDef, AgentEvent, AgentEventV3, AgentMcpCatalogChange, AgentMcpEntry, AgentMcpReplay, AgentObjectCallOptions, AgentOutput, AgentPartialOutput, AgentResult, AgentRunChatInvocation, AgentRunChatState, AgentRunContextStateV3, AgentRunContextStepV3, AgentRunEnvelope, AgentRunEnvelopeV3, AgentRunLeaseOptions, AgentRunListPage, AgentRunListQuery, AgentRunMemoryExtraction, AgentRunMemoryExtractionV3, AgentRunMemoryIntentV3, AgentRunMemoryState, AgentRunMemoryStateV3, AgentRunModelAttempt, AgentRunModelRef, AgentRunModelState, AgentRunOptions, AgentRunOptionsV3, AgentRunPhase, AgentRunRecall, AgentRunReconcileOptions, AgentRunReconcileOptionsV3, AgentRunReconciliation, AgentRunRetry, AgentRunSession, AgentRunSessionV3, AgentRunStore, AgentRunStoreV3, AgentRunSummary, AgentRunTranscript, AgentStream, AgentStreamV3, AgentTool, AgentToolContext, AgentToolReceipt, AgentToolSet, AgentValidation, AgentValidator, AgentVerification, AgentVerifyContext, BudgetAdmission, BudgetAdmissionRestore, BudgetAggregate, BudgetAmounts, BudgetCompaction, BudgetHold, BudgetHoldQuery, BudgetHoldResolution, BudgetLedger, BudgetLedgerOptions, BudgetLedgerSnapshot, BudgetLimits, BudgetPruneOptions, BudgetPruneResult, BudgetReservation, BudgetReservationInput, BudgetScope, BudgetScopeUsage, BudgetSettlement, BudgetStore, BudgetStoreErrorCode, BudgetStoreMaintenance, BudgetStoreReservation, BudgetStoreReserveInput, BudgetSweepOptions, BudgetSweepResult, BudgetTotals, BudgetUsage, BudgetUsageOptions, BudgetWarning, BudgetWindow, CallAccounting, ContextBlobRead, DeuzAgent, ExecutionChildOptions, ExecutionContextOptions, ExecutionContextRestoreOptions, ExecutionContextSnapshot, ExecutionPolicy, ExecutionReservationInput, HandoffAgentDef, HandoffOptions, NativeExecutionContext, PersistentBudgetScope, UnknownPricePolicy

## `@deuz-sdk/core/swarm`

Bounded agent/reducer DAGs, runtime spawning, blackboards, rounds, leases, drain and recovery, atomic snapshots and cursor events.

**Values** (5): createInMemorySwarmStore, createRounds, createSwarm, SwarmConflictError, SwarmLeaseError

**Types** (38): CreateRoundsOptions, RoundsConsolidateInput, RoundsDecision, RoundsGroupPlan, Swarm, SwarmAgentBinding, SwarmCancelRequest, SwarmChannelEntry, SwarmChannelPost, SwarmCommit, SwarmDynamicLimits, SwarmEvent, SwarmEventInput, SwarmFailureContext, SwarmHandle, SwarmKey, SwarmLeaseOptions, SwarmOptions, SwarmOutcome, SwarmPruneOptions, SwarmRecovery, SwarmReducerBinding, SwarmReducerContext, SwarmResumeOptions, SwarmRounds, SwarmRunOptions, SwarmRunQuery, SwarmRunRecord, SwarmRunStatus, SwarmSnapshot, SwarmSpawnContext, SwarmSpawnRequest, SwarmStore, SwarmStoreCapability, SwarmTask, SwarmTaskRecord, SwarmTaskResult, SwarmTaskStatus

## `@deuz-sdk/core/swarm/sqlite`

Node-only SQLite persistence for swarm runs, native agent envelopes and events.

**Values** (1): createSqliteSwarmStore

**Types** (2): SqliteSwarmStore, SqliteSwarmStoreOptions

## `@deuz-sdk/core/swarm/postgres`

Node-only Postgres swarm store: every write one revision-gated statement.

**Values** (2): createPostgresSwarmStore, postgresSchemaName

**Types** (1): PostgresSwarmStoreOptions

## `@deuz-sdk/core/swarm/redis`

Node-only Redis swarm store: revision-gated commits as Lua scripts (Redis 7+).

**Values** (2): createRedisSwarmStore, wrapIoredisClient

**Types** (4): IoredisClientLike, RedisScriptClient, RedisSwarmStore, RedisSwarmStoreOptions

## `@deuz-sdk/core/ops`

Leases for cross-process runs: the LeaseProvider contract, an in-memory provider, native run lease keys and stale-run discovery.

**Values** (3): agentRunLeaseKey, createInMemoryLeaseProvider, findStaleAgentRuns

**Types** (6): FindStaleAgentRunsOptions, Lease, LeaseProvider, LeaseRenewal, LeaseRenewOptions, LeaseSignal

## `@deuz-sdk/core/ops/sqlite`

Node-only SQLite leases, native agent run store, V3 run store (2.4), schedule claims and persistent budget store.

**Values** (5): createSqliteAgentRunStoreV3, createSqliteBudgetStore, createSqliteOpsStore, RUNS_V3_SCHEMA_NAME, RUNS_V3_SCHEMA_VERSION

**Types** (5): SqliteAgentRunStoreV3Options, SqliteBudgetStore, SqliteBudgetStoreOptions, SqliteOpsStore, SqliteOpsStoreOptions

## `@deuz-sdk/core/ops/postgres`

Node-only Postgres leases, native agent run store, V3 run store (2.4), schedule claims and persistent budget store.

**Values** (3): createPostgresAgentRunStoreV3, createPostgresBudgetStore, createPostgresOpsStore

**Types** (4): PostgresAgentRunStoreV3Options, PostgresBudgetStoreOptions, PostgresOpsStore, PostgresOpsStoreOptions

## `@deuz-sdk/core/ops/redis`

Node-only Redis leases, native agent run store, schedule claims and persistent budget store.

**Values** (3): createRedisBudgetStore, createRedisOpsStore, wrapIoredisClient

**Types** (6): IoredisClientLike, RedisBudgetStore, RedisBudgetStoreOptions, RedisOpsStore, RedisOpsStoreOptions, RedisScriptClient

## `@deuz-sdk/core/evolve`

Evolutionary program search: evolve blocks, SEARCH/REPLACE patches, cascade, islands, zero-call resume.

**Values** (12): applySearchReplace, buildMutationPrompt, createInMemoryPopulationStore, evolve, evolveCandidateId, EvolveConflictError, EvolveLeaseError, EvolvePatchError, extractFullRewrite, parseEvolveBlocks, parseSearchReplace, resumeEvolve

**Types** (38): EvolveArtifacts, EvolveBanditState, EvolveBlock, EvolveCandidate, EvolveCandidateQuery, EvolveEvent, EvolveGenerationCommit, EvolveHandle, EvolveIslandOptions, EvolveIslandState, EvolveKey, EvolveLeaseOptions, EvolveMetrics, EvolveModel, EvolveMutationPrompt, EvolveNoveltyJudgeInput, EvolveNoveltyOptions, EvolveOptions, EvolvePatchErrorCode, EvolvePatchType, EvolvePopulationOptions, EvolvePromptContext, EvolvePromptProgram, EvolveRejection, EvolveRejectionKind, EvolveResult, EvolveRunRecord, EvolveSelection, EvolveStage, EvolveStageContext, EvolveStageOutput, EvolveStageResult, EvolveStatus, EvolveStopReason, ParsedEvolveSource, PopulationStore, ResumeEvolveOptions, SearchReplaceBlock

## `@deuz-sdk/core/evolve/sqlite`

Node-only SQLite population store for evolve.

**Values** (1): createSqlitePopulationStore

**Types** (2): SqlitePopulationStore, SqlitePopulationStoreOptions

## `@deuz-sdk/core/schedule`

Five-field UTC cron, a tick-driven scheduler with dedupe, verified webhooks, and IANA time-zone and DST helpers (2.4).

**Values** (14): assertTimeZone, createInMemoryClaim, createScheduler, handleSignal, nextOccurrence, nextZonedOccurrence, occurrencesBetween, parseCron, previousOccurrence, timeZoneOffset, verifyGitHubWebhook, verifyHmacSignature, verifySlackRequest, zonedOccurrencesBetween

**Types** (22): CronSchedule, HandleSignalOptions, HmacAlgorithm, HmacSignatureOptions, ScheduleCatchUp, ScheduleClaim, ScheduleDefinition, ScheduleOccurrence, ScheduleOccurrenceResult, Scheduler, SchedulerOptions, ScheduleStartOptions, ScheduleTickResult, SignalDispatchInput, SignalRejection, SignalVerification, SignatureEncoding, SlackVerifyOptions, ZonedCronOptions, ZonedDstGap, ZonedDstOverlap, ZonedOccurrence

## `@deuz-sdk/core/goal`

Goals, wakeups and events: versioned records, pure transitions, evidence-based acceptance, a GoalStore seam.

**Values** (17): assessGoal, createGoal, createGoalEvent, createInMemoryGoalStore, GOAL_EVENT_VERSION, GOAL_RECORD_VERSION, GOAL_SEEN_LIMIT, GoalError, goalEventFromOccurrence, goalEventFromSignal, goalWakeupEvent, goalWakeupKey, parseGoal, parseGoalEvent, serializeGoal, serializeGoalEvent, transitionGoal

**Types** (35): CreateGoalInput, GoalAcceptance, GoalBudget, GoalCommand, GoalCriterion, GoalCriterionAcceptance, GoalCriterionInput, GoalCriterionResult, GoalCriterionResultInput, GoalDependency, GoalErrorCode, GoalEvent, GoalEventInput, GoalEventSource, GoalEventSourceType, GoalEventTarget, GoalEvidence, GoalEvidenceInput, GoalEvidenceSource, GoalListPage, GoalListQuery, GoalOutcome, GoalPayloadRef, GoalRecord, GoalSpend, GoalStatus, GoalStore, GoalTransition, GoalTransitionOptions, GoalTransitionReason, GoalVerdict, GoalVerifierRef, GoalWaiting, GoalWaitReason, GoalWaitRequest

## `@deuz-sdk/core/goal/runtime`

Durable goals: a supervisor over the native executor, the goal runtime store, a time-zone aware durable scheduler, webhook delivery and verifyGoalAcceptance.

**Values** (16): createDurableScheduler, createGoalSupervisor, createInMemoryGoalRuntimeStore, createNativeRunLauncher, createWebhookHandler, DEFAULT_DURABLE_SCHEDULER, DEFAULT_GOAL_RUNTIME_POLICY, DEFAULT_GOAL_SUPERVISOR, goalDeliveryDigest, goalDependencyEvents, GoalError, goalInboxKey, goalLeaseKey, settleGoalEvent, toNodeHandler, verifyGoalAcceptance

**Types** (64): DurableSchedule, DurableScheduleChangeOptions, DurableScheduleEvent, DurableScheduleInput, DurableSchedulePage, DurableScheduleQuery, DurableScheduler, DurableSchedulerOptions, DurableSchedulerTickResult, FetchHandler, GoalAcceptanceVerification, GoalActiveRun, GoalArtifactResolver, GoalDeliveryContent, GoalDependencyEventsOptions, GoalErrorCode, GoalInboxApplication, GoalInboxDisposition, GoalInboxEnqueue, GoalInboxEnqueueResult, GoalInboxEntry, GoalInboxPage, GoalInboxQuery, GoalInboxSettlement, GoalLedgerWatermark, GoalResumeInput, GoalRunIntent, GoalRunIntentInput, GoalRunIntentPage, GoalRunIntentQuery, GoalRuntimeCommitResult, GoalRuntimePhase, GoalRuntimePolicy, GoalRuntimePruneOptions, GoalRuntimeState, GoalRuntimeStore, GoalSettledDisposition, GoalSubmitInput, GoalSupervision, GoalSupervisor, GoalSupervisorEvent, GoalSupervisorOptions, GoalSupervisorTickResult, GoalVerifier, GoalWatermarkAdvance, NativeRunLauncherOptions, NodeIncomingMessageLike, NodeServerResponseLike, ResolvedGoalArtifact, RunLauncher, RunLaunchRequest, RunLaunchResult, ScheduleAdvance, ScheduleAdvanceResult, ScheduleDstGap, ScheduleDstOverlap, ScheduleOccurrencePage, ScheduleOccurrenceQuery, ScheduleOccurrenceRecord, ScheduleSpec, VerifyGoalAcceptanceInput, WebhookHandlerOptions, WebhookTarget, WebhookVerification

## `@deuz-sdk/core/goal/runtime/sqlite`

Node-only SQLite goal runtime store: the first durable GoalStore.

**Values** (1): createSqliteGoalRuntimeStore

**Types** (2): SqliteGoalRuntimeStore, SqliteGoalRuntimeStoreOptions

## `@deuz-sdk/core/goal/runtime/postgres`

Node-only Postgres goal runtime store.

**Values** (1): createPostgresGoalRuntimeStore

**Types** (2): PostgresGoalRuntimeStore, PostgresGoalRuntimeStoreOptions

## `@deuz-sdk/core/autonomy`

Ensemble strategies: best-of-N, self-consistency, parallel agents, task planning.

**Values** (13): allTasksSettled, bestOfN, createTaskList, createVerifier, nextPendingTask, parallelAgents, parseTaskList, planTasks, selfConsistency, serializeTaskList, setTaskStatus, taskListProgress, updateTask

**Types** (23): BestOfNOptions, BestOfNResult, Candidate, CreateVerifierOptions, ParallelAgentResult, ParallelAgentsOptions, ParallelAgentsResult, ParallelAgentTask, PlanTasksOptions, SelfConsistencyOptions, SelfConsistencyResult, Task, TaskList, TaskStatus, Verifier, VerifierCheck, VerifierErrorCategory, VerifierResult, VerifyInput, VerifyStep, VerifyStepContext, VerifyStepResult, VoteGroup

## `@deuz-sdk/core/runtime`

Background runs: run store, run manager, live plan/activity feed, steering.

**Values** (5): createInMemoryRunStore, createRunManager, createSteeringController, emitActivity, emitPlanUpdate

**Types** (9): EmitActivityOptions, PartEmitter, PlanSnapshotInput, RunManager, RunManagerOptions, RunRecord, RunStatus, RunStore, SteeringController

## `@deuz-sdk/core/runtime/node`

File-backed run store and stale-run polling (Node only).

**Values** (2): createFileRunStore, pollStaleRuns

**Types** (2): FileRunStoreOptions, PollStaleRunsOptions

## `@deuz-sdk/core/browser`

Browser-control tools over a pluggable controller seam.

**Values** (1): createBrowserTools

**Types** (3): BrowserController, BrowserNavigateResult, BrowserToolsOptions

## `@deuz-sdk/core/browser/node`

Playwright-backed browser controller (Node only).

**Values** (1): createPlaywrightBrowser

**Types** (1): PlaywrightBrowserOptions

## `@deuz-sdk/core/pricing`

USD cost accounting: bundled price table and aliases, price provider, batch tier, cache savings.

**Values** (5): cacheSavings, createPriceProvider, PRICE_ALIASES, PRICES_2026, priceUsage

**Types** (6): CreatePriceProviderOptions, ModelPrice, PriceTable, PriceTier, PriceUsageOptions, ServiceTier

## `@deuz-sdk/core/middleware`

Removable model layers: logging, caching, PII redaction, fallback, injection guard.

**Values** (6): logging, promptInjectionGuard, redactPII, simpleCache, withFallback, wrapModel

**Types** (5): FallbackHooks, LanguageModelMiddleware, MiddlewareCallOptions, MiddlewareContext, WrappedModel

## `@deuz-sdk/core/guardrails`

Built-in input/tool-call/tool-result/output guardrails.

**Values** (4): maxOutputLength, maxToolResultLength, PROMPT_INJECTION_POLICY, promptInjectionGuardrail

**Types** (0): _none_

## `@deuz-sdk/core/image`

Synchronous image generation.

**Values** (2): createImageProvider, generateImage

**Types** (6): GeneratedImage, GenerateImageOptions, GenerateImageResult, ImageModel, ImageProvider, ImageProviderSettings

## `@deuz-sdk/core/speech`

Text to speech.

**Values** (3): createElevenLabs, createOpenAISpeech, generateSpeech

**Types** (7): GenerateSpeechOptions, GenerateSpeechResult, SpeechAudioFormat, SpeechModel, SpeechModelSurface, SpeechProvider, SpeechProviderSettings

## `@deuz-sdk/core/transcription`

Speech to text.

**Values** (3): createDeepgram, createOpenAITranscription, transcribe

**Types** (10): TranscribeOptions, TranscribeResult, TranscriptionInput, TranscriptionModel, TranscriptionProvider, TranscriptionProviderSettings, TranscriptionSegment, TranscriptionSurface, TranscriptionUsage, TranscriptionWord

## `@deuz-sdk/core/realtime`

Live speech-to-speech over the OpenAI Realtime and Gemini Live WebSockets, with tools and ephemeral tokens.

**Values** (7): createGeminiAuthToken, createGeminiLive, createOpenAIClientSecret, createOpenAIRealtime, createRealtimeSession, RealtimeError, realtimePriceTable

**Types** (27): CreateGeminiAuthTokenOptions, CreateOpenAIClientSecretOptions, GeminiLiveSettings, OpenAIRealtimeSettings, RealtimeAudioFormat, RealtimeDependencies, RealtimeErrorKind, RealtimeErrorOptions, RealtimeEvent, RealtimeEventOf, RealtimeEventType, RealtimeInputTranscription, RealtimeModalityTokens, RealtimeModel, RealtimeModelPrice, RealtimeResponseStatus, RealtimeSession, RealtimeSessionConfig, RealtimeSessionOptions, RealtimeSessionStatus, RealtimeSurface, RealtimeToken, RealtimeTokenBreakdown, RealtimeUsageTotals, RealtimeWebSocket, RealtimeWebSocketFactory, RealtimeWebSocketInit

## `@deuz-sdk/core/batch`

Provider batch APIs (OpenAI, Anthropic, Gemini): submit, wait, read results, batch-tier pricing and budget holds.

**Values** (3): BatchError, createBatchClient, createMemoryBatchJobStore

**Types** (19): BatchCallOptions, BatchClient, BatchClientOptions, BatchCounts, BatchErrorKind, BatchErrorOptions, BatchHold, BatchJob, BatchJobRequest, BatchJobStore, BatchProtocol, BatchRequest, BatchResult, BatchResultsOptions, BatchResultStatus, BatchState, BatchStatus, BatchSubmitOptions, BatchWaitOptions

## `@deuz-sdk/core/a2a`

Agent2Agent v1.0.0: call remote agents and serve your own over JSON-RPC or HTTP+JSON, a native agent run as a task included.

**Values** (7): A2AError, a2aText, createA2AAgentExecutor, createA2AClient, createA2AHandler, createInMemoryA2ATaskStore, fetchAgentCard

**Types** (66): A2AAgentAction, A2AAgentAnswers, A2AAgentCapabilities, A2AAgentCard, A2AAgentCardSignature, A2AAgentEngine, A2AAgentExecutorOptions, A2AAgentExtension, A2AAgentFailed, A2AAgentInterface, A2AAgentPendingActions, A2AAgentProvider, A2AAgentRunContext, A2AAgentRunOptions, A2AAgentSkill, A2AAgentStopped, A2AArtifact, A2AArtifactInput, A2AArtifactOptions, A2ABinding, A2ACallOptions, A2ACancelContext, A2ACancelTaskOptions, A2ACancelTaskRequest, A2AClient, A2AClientOptions, A2ADataPart, A2AErrorKind, A2AErrorOptions, A2AErrorReason, A2AExecuteFunction, A2AExecutionContext, A2AExecutor, A2AFetchAgentCardOptions, A2AGetTaskOptions, A2AGetTaskRequest, A2AHandler, A2AHandlerOptions, A2AHeaders, A2AMessage, A2AMessageDraft, A2AMessageInput, A2AOAuthFlows, A2APart, A2AProtocolBinding, A2ARawPart, A2ARole, A2ASecurityRequirement, A2ASecurityScheme, A2ASendMessageConfiguration, A2ASendMessageOptions, A2ASendMessageRequest, A2ASendMessageResponse, A2AStatusOptions, A2AStreamResponse, A2ASubscribeToTaskRequest, A2ATask, A2ATaskArtifactUpdateEvent, A2ATaskPushNotificationConfig, A2ATaskScope, A2ATaskState, A2ATaskStatus, A2ATaskStatusUpdateEvent, A2ATaskStore, A2ATextPart, A2AUrlPart

## `@deuz-sdk/core/headless`

Headless preview (Node only): run, resume and inspect native agent runs from a script, and check a model and its configuration first.

**Values** (7): doctor, exitCodeFor, HEADLESS_EXIT_CODES, inspectRun, loadProjectInstructions, resumeHeadless, runHeadless

**Types** (15): DoctorFinding, DoctorOptions, DoctorReport, DoctorSeverity, HeadlessCost, HeadlessOutcome, HeadlessPendingAction, HeadlessReport, HeadlessResumeOptions, HeadlessRetry, HeadlessRunOptions, HeadlessSessionOptions, ProjectInstructionFile, ProjectInstructions, ProjectInstructionsOptions

## `@deuz-sdk/core/video`

Video generation: submit, poll, download.

**Values** (6): createVideoProvider, downloadVideo, fetchVideoTask, generateVideo, submitVideo, waitForVideo

**Types** (13): DownloadedVideo, GenerateVideoOptions, GenerateVideoResult, SubmitVideoOptions, VideoConfig, VideoInputReference, VideoModel, VideoPollOptions, VideoProvider, VideoProviderSettings, VideoTask, VideoTaskStatus, WaitForVideoOptions

## `@deuz-sdk/core/midjourney`

Midjourney submit/poll/action flow.

**Values** (8): createMidjourney, fetchTask, imagine, submitAction, submitBlend, submitDescribe, submitImagine, waitForTask

**Types** (12): ImagineAndWaitOptions, MidjourneyButton, MidjourneyConfig, MidjourneyProvider, MidjourneyStatus, MidjourneyTask, SubmitActionOptions, SubmitBlendOptions, SubmitDescribeOptions, SubmitImagineOptions, SubmitResult, WaitForTaskOptions

## `@deuz-sdk/core/yunwu`

Yunwu relay: one key and base URL for chat, image, video, embeddings and Midjourney.

**Values** (12): createYunwu, createYunwuChat, createYunwuEmbedding, createYunwuImage, createYunwuVideo, yunwu, YUNWU_CHAT_MODELS, YUNWU_DEFAULT_BASE_URL, YUNWU_IMAGE_MODELS, YUNWU_MIDJOURNEY_MODELS, YUNWU_MODELS, YUNWU_VIDEO_MODELS

**Types** (5): YunwuChatModel, YunwuClient, YunwuImageModel, YunwuSettings, YunwuVideoModel

## `@deuz-sdk/core/memory`

Long-term memory: extract, reconcile, apply — behind one swappable store seam.

**Values** (24): applyEvents, applyMutations, assertScope, buildDecisionPrompt, buildExtractionPrompt, cosineSimilarity, createEmbedder, createInMemoryMemoryStore, createMemoryTools, defaultHashFn, defaultMemoryScorer, defineAccountedMemoryLLM, extractLinks, formatMemoriesForPrompt, isAccounted, isExpired, matchesScope, memoryEmbedderFromRag, parseDecision, parseFacts, planMemory, recall, remember, sweepExpired

**Types** (24): AccountedMemoryEmbedder, AccountedMemoryLLM, AccountedMemoryLLMResult, ApplyContext, Embedder, HashFn, MemoryCallOptions, MemoryEmbeddingMismatch, MemoryEvent, MemoryEventType, MemoryFact, MemoryHit, MemoryKind, MemoryLLM, MemoryMutation, MemoryQuery, MemoryRecord, MemoryScope, MemoryScorer, MemorySeams, MemoryStore, MemoryToolOptions, RememberOptions, WritePolicy

## `@deuz-sdk/core/memory/markdown`

Obsidian-style markdown vault as the memory store (Node only).

**Values** (3): _deserializeRecord, _serializeRecord, createMarkdownMemoryStore

**Types** (1): MarkdownMemoryStoreOptions

## `@deuz-sdk/core/memory/versioned`

Versioned memory with provenance: revisions, receipts, idempotent operations, forget, re-embed and the legacy import.

**Values** (9): createInMemoryVersionedMemoryStore, createMemorySession, createVersionedMemoryTools, defineAccountedMemoryLLM, EmbeddingMismatchError, importLegacyMemory, isAccounted, OperationConflictError, RevisionConflictError

**Types** (46): AccountedEmbeddings, AccountedMemoryEmbedder, AccountedMemoryLLM, AccountedMemoryLLMResult, AccountedUsage, CallAccounting, ConflictSubsystem, CreateMemorySessionOptions, ImportLegacyMemoryOptions, ImportLegacyMemoryResult, MemoryEmbeddingGeneration, MemoryEmbeddingMeta, MemoryExtractionInput, MemoryExtractionPolicy, MemoryForgetEvent, MemoryForgetListener, MemoryForgetResult, MemoryLink, MemoryOperationResult, MemoryOrigin, MemoryPruneHistoryOptions, MemoryPruneOperationsOptions, MemoryRecallInput, MemoryReembedItem, MemoryReembedOptions, MemoryReembedResult, MemoryRememberInput, MemorySession, MemorySourceKind, MemorySourceRef, MemoryWriteOptions, VersionedMemoryActor, VersionedMemoryCommit, VersionedMemoryCommitResult, VersionedMemoryHit, VersionedMemoryMutation, VersionedMemoryQuery, VersionedMemoryReceipt, VersionedMemoryReceiptEntry, VersionedMemoryRecord, VersionedMemoryRecordInput, VersionedMemoryRevision, VersionedMemoryStatus, VersionedMemoryStore, VersionedMemoryToolsOptions, VersionedMemoryVector

## `@deuz-sdk/core/memory/versioned/sqlite`

Node-only SQLite versioned memory store: hybrid FTS5 + vector search.

**Values** (1): createSqliteVersionedMemoryStore

**Types** (2): SqliteVersionedMemoryStore, SqliteVersionedMemoryStoreOptions

## `@deuz-sdk/core/memory/versioned/postgres`

Node-only Postgres versioned memory store: hybrid tsvector + vector search, pgvector optional.

**Values** (1): createPostgresVersionedMemoryStore

**Types** (2): PostgresVersionedMemoryStore, PostgresVersionedMemoryStoreOptions

## `@deuz-sdk/core/context`

One token budget for memory, RAG, transcript and skills: compileContext, the context compiler, working memory and the token estimator.

**Values** (19): ANTHROPIC_TOOL_FRAMING_TOKENS, applyWorkingMemoryPatch, compileContext, ContextBudgetExceededError, contextPackageBlob, contextWarnings, createContextCompiler, createMemoryContextSource, createRagContextSource, createSkillsContextSource, createTokenEstimator, createTranscriptContextSource, createWorkingMemory, DEFAULT_CONTEXT_BUDGET, DEFAULT_CONTEXT_REFRESH, estimateRequestOverhead, estimateRequestTokens, estimateTextTokens, workingMemoryTools

**Types** (56): ApplyWorkingMemoryPatchOptions, CompileContextInput, ContextBlobRef, ContextBlock, ContextBudget, ContextBudgetOptions, ContextCandidate, ContextCompiler, ContextCompilerState, ContextEntryReason, ContextEstimator, ContextLoopHooks, ContextManifest, ContextManifestEntry, ContextManifestSource, ContextPackage, ContextPackageBlob, ContextPlacedEntry, ContextPlacement, ContextProvenance, ContextRefreshOptions, ContextRefreshReason, ContextSource, ContextSourceKind, ContextSourceOptions, ContextSourceRequest, ContextSourceResult, ContextStepInput, ContextToolSchema, CreateContextCompilerOptions, CreateWorkingMemoryInput, MemoryContextSourceOptions, RagContextSourceOptions, RequestOverheadInput, SkillsContextSourceOptions, TokenEstimator, TokenEstimatorOptions, TranscriptContextSourceOptions, WorkingMemoryAttempt, WorkingMemoryConstraint, WorkingMemoryDecision, WorkingMemoryGoal, WorkingMemoryHandle, WorkingMemoryHypothesis, WorkingMemoryItemBase, WorkingMemoryList, WorkingMemoryObservation, WorkingMemoryOperation, WorkingMemoryPatch, WorkingMemoryPatchResult, WorkingMemoryQuestion, WorkingMemoryRejection, WorkingMemorySnapshot, WorkingMemoryTasks, WorkingMemoryToolsOptions, WorkingMemoryWriter

## `@deuz-sdk/core/rag`

Edge-safe RAG: sniff, parse, chunk, embed, dense + BM25 hybrid retrieval, citations.

**Values** (31): approxCountTokens, chunkBlocks, chunkFixed, chunkRecursive, citationsFromHits, COHERE_RERANK_DEFAULT_MODEL, cosineSimilarity, countTokensWith, createBm25Index, createCohereReranker, createMemoryVectorStore, createParserRegistry, csvToText, DEFAULT_CHUNK_OPTIONS, DEFAULT_SEPARATORS, defineAccountedEmbedder, estimatePdfTokens, estimateTokens, hybridRetrieve, identityReranker, indexChunks, modelSupportsDocuments, parse, parseCsv, RagError, reciprocalRankFusion, retrieve, shouldSendWhole, sniffMime, tokenize, toNativeDocumentPart

**Types** (31): AccountedEmbedder, AccountedEmbeddings, Bm25Index, Bm25Options, Chunk, ChunkOptions, CitationOptions, CohereRerankerSettings, Container, CountTokens, DocBlock, DocBlockType, DocMime, DocumentParser, EmbeddedChunk, Embedder, EmbeddingAccountingOptions, HybridRetrieveDeps, HybridRetrieveOptions, ParsedDocument, ParserRegistry, RagErrorCode, Reranker, RetrieveDeps, RetrieveOptions, RrfOptions, ScoredChunk, SendWholeInput, SniffResult, VectorStore, WithAccountedEmbedder

## `@deuz-sdk/core/rag/node`

PDF / DOCX / XLSX / HTML parsers for the RAG registry (Node only).

**Values** (5): defaultNodeParserRegistry, docxParser, htmlToBlocks, pdfParser, xlsxParser

**Types** (0): _none_

## `@deuz-sdk/core/skills`

Agent Skills: SKILL.md parsing, registry, matchers, catalog rendering, tool scoping.

**Values** (13): createSkillRegistry, embeddingMatcher, fetchSkillSource, lexicalMatcher, mergeSkillSources, normalizeResourcePath, parseSkill, renderSkillCatalog, scopeToolsToSkill, splitFrontmatter, staticSkillSource, validateSkillDescription, validateSkillName

**Types** (11): ParseSkillOptions, SkillCandidate, SkillManifest, SkillMatch, SkillMatcher, SkillMatchOptions, SkillRegistry, SkillSource, SkillSourceEntry, SkillValidationIssue, ToolSetLike

## `@deuz-sdk/core/skills/node`

Load skills from directories on disk (Node only).

**Values** (1): nodeSkillSource

**Types** (0): _none_

## `@deuz-sdk/core/skills/learning`

Experimental: a sourced, inert skill proposal from a verified run (proposeSkillFromRun).

**Values** (2): proposeSkillFromRun, SkillLearningError

**Types** (6): ProposeSkillFromRunOptions, SkillLearningErrorCode, SkillProposal, SkillProposalCost, SkillProposalStep, SkillSourceRef

## `@deuz-sdk/core/vertex`

Claude and Gemini through Vertex AI; edge-safe service-account JWT signing.

**Values** (5): CLOUD_PLATFORM_SCOPE, createServiceAccountKeyProvider, createVertexAnthropic, createVertexGoogle, createVertexGoogleNative

**Types** (3): ServiceAccountCredentials, ServiceAccountKeyProviderOptions, VertexSettings

## `@deuz-sdk/core/vertex/node`

Vertex Application Default Credentials (Node only).

**Values** (1): createAdcKeyProvider

**Types** (1): AdcKeyProviderOptions

## `@deuz-sdk/core/mcp`

MCP client over HTTP/SSE on either SDK line (2026-07-28 with the v2 SDK), connection pool, OAuth provider, tool conversion.

**Values** (10): createManagedConnection, createMcpClient, createMcpPool, createOAuthProvider, detectToolDrift, fingerprintTools, inMemoryTokenStore, registerElicitation, registerSamplingAndRoots, registerToolListChanged

**Types** (37): DeuzOAuthProvider, ManagedConnectionOptions, ManagedMcp, McpClient, McpClientHooks, McpClientOptions, McpConnectableConfig, McpConnectionPool, McpConnectionStatus, McpElicitationHandler, McpElicitationRequest, McpElicitationResult, McpGetPromptResult, McpHttpTransport, McpLifecycleOptions, McpOAuthOptions, McpPoolOptions, McpPrompt, McpPromptMessage, McpReconnectPolicy, McpResource, McpResourceContent, McpRootsClient, McpRootsOption, McpSamplingMessage, McpSamplingOptions, McpSamplingRequest, McpSamplingResult, McpSdkLine, McpSdkSelection, McpStatusInfo, McpStopReason, McpVersionNegotiation, ResolvedMcpRuntime, TokenStore, ToolDrift, ToolFingerprints

## `@deuz-sdk/core/mcp/stdio`

MCP over stdio — spawn a local server process (Node only).

**Values** (1): createStdioMcpClient

**Types** (12): McpClient, McpConnectionStatus, McpLifecycleOptions, McpReconnectPolicy, McpRootsClient, McpRootsOption, McpSamplingOptions, McpSdkLine, McpSdkSelection, McpStatusInfo, McpStdioOptions, McpVersionNegotiation

## `@deuz-sdk/core/mcp/node`

Node OAuth helpers for MCP: file token store, loopback redirect.

**Values** (2): createFileTokenStore, createLoopbackRedirect

**Types** (4): FileTokenStoreOptions, LoopbackRedirect, LoopbackRedirectOptions, TokenStore

## `@deuz-sdk/core/mcp/server`

Serve Deuz tools, native agent tools and whole agents as an MCP server over Streamable HTTP.

**Values** (1): createMcpServer

**Types** (9): DeuzMcpServer, McpAgentRunOptions, McpAuthInfo, McpServedAgent, McpServerFetchOptions, McpServerOptions, McpServerRequest, McpToolAnnotations, McpToolApprovalRequest

## `@deuz-sdk/core/mcp/server/stdio`

The same MCP server over stdio (Node only).

**Values** (1): serveMcpStdio

**Types** (12): DeuzMcpServer, McpAgentRunOptions, McpAuthInfo, McpServedAgent, McpServerOptions, McpServerRequest, McpStdioReadable, McpStdioServeOptions, McpStdioServerHandle, McpStdioWritable, McpToolAnnotations, McpToolApprovalRequest

## `@deuz-sdk/core/stores/sqlite`

One factory for memory + chat + session + run stores on node:sqlite; conditional chat store with transcript index and durable stream store (2.4).

**Values** (3): createSqliteConditionalChatStore, createSqliteDurableStreamStateStore, createSqliteStores

**Types** (7): SqliteConditionalChatStore, SqliteConditionalChatStoreOptions, SqliteDatabaseLike, SqliteDurableStreamStateStoreOptions, SqliteStatementLike, SqliteStoreOptions, SqliteStores

## `@deuz-sdk/core/stores/redis`

The same four store seams on Redis (runs since 2.3), over node-redis or a wrapped ioredis client; durable stream store (2.4).

**Values** (3): createRedisDurableStreamStateStore, createRedisStores, wrapIoredisClient

**Types** (7): IoredisClientLike, RedisClientLike, RedisDurableStreamStateStoreOptions, RedisScriptClient, RedisStoreOptions, RedisStores, RedisZMember

## `@deuz-sdk/core/stores/postgres`

The same four store seams on Postgres (pgvector when available); conditional chat store with transcript index and durable stream store (2.4).

**Values** (3): createPostgresConditionalChatStore, createPostgresDurableStreamStateStore, createPostgresStores

**Types** (6): PgClientLike, PostgresConditionalChatStore, PostgresConditionalChatStoreOptions, PostgresDurableStreamStateStoreOptions, PostgresStoreOptions, PostgresStores

## `@deuz-sdk/core/durable`

Checkpoints, resume-after-crash, and HMAC-signed tool approvals.

**Values** (9): CheckpointNotFoundError, CheckpointVersionError, createApprovalSigner, createInMemorySessionStore, deserializeCheckpoint, resumeDeuzChatResponse, resumeFromCheckpoint, resumeStreamFromCheckpoint, serializeCheckpoint

**Types** (8): AgentCheckpoint, ApprovalSigner, CheckpointStatus, CreateApprovalSignerOptions, ResumeDeuzChatOptions, ResumeOptions, SessionStore, SignedApprovalPayload

## `@deuz-sdk/core/otel`

OpenTelemetry bridge for traces and events.

**Values** (3): createOtelObserver, createOtelTracer, otelReady

**Types** (1): OtelTracerOptions

## `@deuz-sdk/core/observe`

Local-first observation events: observers, run summaries, reports. No hosted service.

**Values** (6): composeObservers, createCallbackObserver, createMemoryObserver, filterObserver, renderRunReport, summarizeRun

**Types** (3): MemoryObserver, RunReportOptions, RunSummary

## `@deuz-sdk/core/observe/node`

JSONL persistence for observation events (Node only).

**Values** (3): createJsonlObserver, readJsonlEvents, writeRunReport

**Types** (3): CreateJsonlObserverOptions, JsonlObserver, WriteRunReportOptions

## `@deuz-sdk/core/edge`

A curated re-export subset guaranteed to contain nothing Node-only.

**Values** (92): agentRunLeaseKey, agentTool, anthropicWebSearch, applySearchReplace, applyUIPart, assertTimeZone, assistantMessageFromTurn, branchBeforeUserMessage, BreakerOpenError, buildMutationPrompt, canonicalFromUI, CheckpointNotFoundError, CheckpointVersionError, clientToolResultMessage, composeObservers, costExceeds, createAgent, createApprovalSigner, createAssistantTurn, createCallbackObserver, createClient, createInMemoryChatStore, createInMemoryClaim, createInMemoryLeaseProvider, createInMemoryPopulationStore, createInMemorySessionStore, createMemoryObserver, createOtelObserver, createOtelTracer, createScheduler, deserializeChatRecord, deserializeCheckpoint, DeuzError, dropTrailingAssistant, durationExceeds, evolve, evolveCandidateId, EvolveConflictError, EvolveLeaseError, EvolvePatchError, extractFullRewrite, filePart, filesToImageParts, filterObserver, findStaleAgentRuns, generateObject, generateText, getModelCapabilities, googleSearch, handleSignal, handoff, hasToolCall, imagePart, isDeuzError, maxOutputLength, maxToolResultLength, nextOccurrence, nextZonedOccurrence, NoObjectGeneratedError, occurrencesBetween, openaiWebSearch, otelReady, parseCron, parseDeuzChatRequest, parseEvolveBlocks, parseSearchReplace, previousOccurrence, promptInjectionGuardrail, resolveDependencies, resolveModelProfile, resumeDeuzChatResponse, resumeEvolve, resumeFromCheckpoint, resumeStreamFromCheckpoint, sealAssistantTurn, serializeChatRecord, serializeCheckpoint, stepCountIs, streamChat, streamObject, summarizeRun, timeZoneOffset, tool, totalTokensExceed, uiFromMessages, UnpricedModelError, userMessageFromInput, validateChatRequest, verifyGitHubWebhook, verifyHmacSignature, verifySlackRequest, zonedOccurrencesBetween

**Types** (291): ActivityPart, AgentCallOptions, AgentCheckpoint, AgentDef, AgentObjectCallOptions, AgentToolDef, AnthropicThinkingType, ApprovalRequestedEvent, ApprovalResolvedEvent, ApprovalSigner, AssistantTurnState, BreakerState, BreakerStore, BudgetExceededPart, CallWarning, ChatHistory, ChatInput, ChatPersistOptions, ChatRecord, ChatStore, CheckpointFailedEvent, CheckpointLoadedEvent, CheckpointSavedEvent, CheckpointStatus, CitationPart, ClientConfig, Clock, CommonCallOptions, CompactionLayer, CompactionObserveEvent, CompactionOption, CompactionPart, CompactionPolicy, CompactionSkippedEvent, CostCalculatedEvent, CostPart, CreateApprovalSignerOptions, CronSchedule, DataPart, DeepPartial, Dependencies, DeuzAgent, DeuzChatRequest, DeuzClient, DeuzErrorJSON, DeuzOAuthProvider, DoneWhen, DoneWhenContext, DurableSessionOptions, EffortField, EffortLevel, EffortNoneMapping, Embed, EmbeddingModel, EmbeddingModelSurface, EmbeddingProvider, EmbeddingTaskType, EmbedMany, EmbedManyOptions, EmbedManyResult, EmbedOptions, EmbedResult, ErrorStreamPart, EvolveArtifacts, EvolveBanditState, EvolveBlock, EvolveCandidate, EvolveCandidateQuery, EvolveEvent, EvolveGenerationCommit, EvolveHandle, EvolveIslandOptions, EvolveIslandState, EvolveKey, EvolveLeaseOptions, EvolveMetrics, EvolveModel, EvolveMutationPrompt, EvolveNoveltyJudgeInput, EvolveNoveltyOptions, EvolveOptions, EvolvePatchErrorCode, EvolvePatchType, EvolvePopulationOptions, EvolvePromptContext, EvolvePromptProgram, EvolveRejection, EvolveRejectionKind, EvolveResult, EvolveRunRecord, EvolveSelection, EvolveStage, EvolveStageContext, EvolveStageOutput, EvolveStageResult, EvolveStatus, EvolveStopReason, FalseFinishPart, FindStaleAgentRunsOptions, FinishMeta, FinishReason, FinishStreamPart, GenerateObject, GenerateObjectOptions, GenerateObjectResult, GenerateText, GenerateTextOptions, GenerateTextResult, GuardrailBaseContext, GuardrailPart, Guardrails, HandleSignalOptions, HandoffAgentDef, HandoffOptions, HandoffPart, HmacAlgorithm, HmacSignatureOptions, ImagePart, InferSchemaOutput, InferToolInput, InferToolOutput, InputGuardrail, InputGuardrailContext, InputGuardrailResult, JSONSchema, KeyProvider, LanguageModel, Lease, LeaseProvider, LeaseRenewal, LeaseRenewOptions, LeaseSignal, Logger, McpClientLoopEntry, McpHttpLoopConfig, McpLoopEntry, McpOAuthOptions, McpStdioLoopConfig, MemoryObserver, Message, ModelCapabilities, ModelCompletedEvent, ModelFailedEvent, ModelFirstContentEvent, ModelId, ModelProfile, ModelProfileCache, ModelProfileClamp, ModelProfileEffort, ModelProfileLimits, ModelProfileSampling, ModelProfileThinking, ModelProfileUsage, ModelRetryEvent, ModelStartedEvent, ModelStatus, ModelSurface, ObservationCaptureOptions, ObservationLimits, ObservationOptions, ObservationRedactor, ObserveAttributes, ObserveAttributeValue, ObservedError, ObservedSubsystem, ObserveEvent, ObserveEventBase, ObservePrimitive, Observer, OperationCompletedEvent, OperationFailedEvent, OperationStartedEvent, OtelTracerOptions, OutputGuardrail, OutputGuardrailContext, OutputGuardrailResult, ParsedEvolveSource, Part, PlanTaskSnapshot, PlanUpdatePart, PopulationStore, PrepareStepResult, PriceProvider, PriceUsageOptions, ProfileCapability, ProfileSupport, Provider, ReasoningDeltaPart, ReasoningPart, RegistryMatch, ResolvedDependencies, ResumeDeuzChatOptions, ResumeEvolveOptions, ResumeOptions, Role, RunAbortedEvent, RunCompletedEvent, RunFailedEvent, RunStartedEvent, RunSummary, RunSuspendedEvent, ScheduleCatchUp, ScheduleClaim, ScheduleDefinition, ScheduleOccurrence, ScheduleOccurrenceResult, Scheduler, SchedulerOptions, ScheduleStartOptions, ScheduleTickResult, SearchReplaceBlock, ServiceTier, SessionStore, SignalDispatchInput, SignalRejection, SignalVerification, SignatureEncoding, SignedApprovalPayload, SlackVerifyOptions, SourcePart, Span, SpanOptions, StandardSchemaIssue, StandardSchemaProps, StandardSchemaResult, StandardSchemaV1, StepCompletedEvent, StepFinishPart, StepResult, StepStartedEvent, StepStartPart, StopCondition, StopDetails, StreamChat, StreamChatOptions, StreamChatResult, StreamObject, StreamObjectResult, StreamPart, SubAgentCompletedEvent, SubAgentFailedEvent, SubAgentPart, SubAgentStartedEvent, SubAgentSuspendedEvent, TextDeltaPart, TextPart, TokenStore, Tool, ToolApprovalRequest, ToolApprovalRequestPart, ToolApprovalResponse, ToolCall, ToolCallDeltaPart, ToolCallGuardrail, ToolCallGuardrailContext, ToolCallGuardrailResult, ToolCallOutcome, ToolCallPart, ToolChoice, ToolCompletedEvent, ToolDeniedEvent, ToolExecuteContext, ToolFailedEvent, ToolResult, ToolResultGuardrail, ToolResultGuardrailContext, ToolResultGuardrailResult, ToolResultPart, ToolResultStreamPart, ToolRunState, ToolSet, ToolStartedEvent, ToolStatePart, ToolUsePart, Tracer, UIMessage, UIMessagePart, UIToolCall, Usage, UsageMeta, ValidateChatOptions, ValidateChatResult, VerifyPart, VerifyStep, VerifyStepContext, VerifyStepResult, WarningPart, ZonedCronOptions, ZonedDstGap, ZonedDstOverlap, ZonedOccurrence

## `@deuz-sdk/core/ui`

The Deuz UI wire: SSE responses (native agent runs included), resumable streams, durable streams and the capability handshake (2.4), and the client-side reader.

**Values** (21): agentStateFromParts, connectDeuzStream, createDeuzStream, createInMemoryDurableStreamStateStore, createInMemoryStreamStateStore, DEFAULT_DURABLE_STREAM_BATCH, DEFAULT_DURABLE_STREAM_RETAIN_MS, DEUZ_CAPABILITIES, DEUZ_CAPABILITIES_HEADER, DEUZ_CAPABILITY, DEUZ_STREAM_VERSION, DEUZ_STREAM_VERSIONS, formatDeuzCapabilities, negotiateDeuzStreamVersion, parseDeuzCapabilities, readDeuzStream, resumeDeuzStreamResponse, toDeuzAgentStreamResponse, toDeuzObjectStreamResponse, toDeuzStreamResponse, toDeuzTextStreamResponse

**Types** (31): ConnectDeuzStreamOptions, CreateDeuzStreamOptions, DeuzAgentClientCall, DeuzAgentFrame, DeuzAgentResultFrame, DeuzAgentState, DeuzAgentStatus, DeuzAgentUnknownEffect, DeuzCapabilitiesOptions, DeuzCapabilitiesPart, DeuzCapability, DeuzStreamDoneRecord, DeuzStreamSource, DeuzStreamWriter, DeuzUIPart, DeuzWireVersion, DurableStreamBatch, DurableStreamBatchOptions, DurableStreamCommitResult, DurableStreamOpenResult, DurableStreamOptions, DurableStreamStateStore, InMemoryStreamStateStoreOptions, ReadDeuzStreamOptions, ResumeDeuzStreamOptions, StreamStateRecord, StreamStateStore, ToDeuzAgentStreamOptions, ToDeuzStreamOptions, ToDeuzTextStreamOptions, WriteDataOptions

## `@deuz-sdk/core/react`

Deprecated (2.4), removed in 3.0: legacy in-core React hooks, frozen at 2.2 (no 2.3 verdict matching or resumed-turn settlement, drops approval tokens, drops client calls without onToolCall). A development build warns once. Use @deuz-sdk/react.

**Values** (3): createUseChat, useChat, useObject

**Types** (6): UIMessage, UIToolCall, UseChatOptions, UseChatResult, UseObjectOptions, UseObjectResult

## `@deuz-sdk/core/chat`

The pure chat state engine plus validateChatRequest — the gate in front of client history; conditional chat stores and the transcript index (2.4).

**Values** (22): applyUIPart, assistantMessageFromTurn, branchBeforeUserMessage, canonicalFromUI, clientToolResultMessage, createAssistantTurn, createInMemoryChatStore, createInMemoryConditionalChatStore, createInMemoryTranscriptIndex, deserializeChatRecord, dropTrailingAssistant, filesToImageParts, indexChat, isConditionalChatStore, parseDeuzChatRequest, RevisionConflictError, sealAssistantTurn, serializeChatRecord, uiFromMessages, updateConditionalChat, userMessageFromInput, validateChatRequest

**Types** (25): AssistantTurnState, ChatHistory, ChatInput, ChatPersistOptions, ChatRecord, ChatStore, ChatTombstone, ConditionalChatMerge, ConditionalChatRead, ConditionalChatRecord, ConditionalChatStore, ConditionalChatWriteResult, DeuzChatRequest, InMemoryConditionalChatStoreOptions, MemoryScope, TranscriptHit, TranscriptIndex, TranscriptMessage, TranscriptSearchOptions, UIMessage, UIMessagePart, UIToolCall, UpdateConditionalChatOptions, ValidateChatOptions, ValidateChatResult

## `@deuz-sdk/core/chat/node`

File-backed chat store (Node only).

**Values** (1): createJsonlChatStore

**Types** (1): JsonlChatStoreOptions

## `@deuz-sdk/react`

React hooks and components: useChat, useObject, approval card, cost badge, chat snapshots (2.4).

**Values** (5): CostBadge, partsFromFiles, ToolApprovalCard, useChat, useObject

**Types** (24): AssistantTurnState, ChatHistory, ChatInput, ChatSnapshotGateV1, ChatSnapshotV1, CostBadgeProps, DeuzUIPart, Message, ToolApprovalCardProps, ToolApprovalRequest, ToolApprovalResponse, UIMessage, UIMessagePart, UIToolCall, UseChatAgent, UseChatBudgetExceeded, UseChatCost, UseChatCursorStore, UseChatOptions, UseChatResult, UseChatResumeOptions, UseChatStopDetails, UseObjectOptions, UseObjectResult

## Where a value lives (everything not exported from the root)

Reverse lookup for "which subpath do I import this from?". Root exports are omitted — try `@deuz-sdk/core` first.

- `_deserializeRecord` — `memory/markdown`
- `_serializeRecord` — `memory/markdown`
- `A2AError` — `a2a`
- `a2aText` — `a2a`
- `agentRunLeaseKey` — `ops`
- `agentStateFromParts` — `ui`
- `allTasksSettled` — `autonomy`
- `anthropic` — `anthropic`
- `ANTHROPIC_TOOL_FRAMING_TOKENS` — `context`
- `applyEvents` — `memory`
- `applyMutations` — `memory`
- `applySearchReplace` — `evolve`
- `applyUIPart` — `chat`
- `applyWorkingMemoryPatch` — `context`
- `approxCountTokens` — `rag`
- `assertScope` — `memory`
- `assertTimeZone` — `schedule`
- `assessGoal` — `goal`
- `assistantMessageFromTurn` — `chat`
- `azure` — `azure`, `providers`
- `BatchError` — `batch`
- `bedrock` — `bedrock`, `providers`
- `bestOfN` — `autonomy`
- `branchBeforeUserMessage` — `chat`
- `BudgetLedgerError` — `agent`
- `BudgetStoreError` — `agent`
- `buildDecisionPrompt` — `memory`
- `buildExtractionPrompt` — `memory`
- `buildMutationPrompt` — `evolve`
- `cacheSavings` — `pricing`
- `canonicalFromUI` — `chat`
- `cerebras` — `providers`
- `CheckpointNotFoundError` — `durable`
- `CheckpointVersionError` — `durable`
- `chunkBlocks` — `rag`
- `chunkFixed` — `rag`
- `chunkRecursive` — `rag`
- `citationsFromHits` — `rag`
- `clientToolResultMessage` — `chat`
- `CLOUD_PLATFORM_SCOPE` — `vertex`
- `codeActSystemPrompt` — `compute`
- `codeActTool` — `compute`
- `cohere` — `providers`
- `COHERE_RERANK_DEFAULT_MODEL` — `rag`
- `compileContext` — `context`
- `composeObservers` — `observe`
- `connectDeuzStream` — `ui`
- `ContextBudgetExceededError` — `context`
- `contextPackageBlob` — `context`
- `contextWarnings` — `context`
- `cosineSimilarity` — `memory`, `rag`
- `CostBadge` — `@deuz-sdk/react`
- `countTokensWith` — `rag`
- `createA2AAgentExecutor` — `a2a`
- `createA2AClient` — `a2a`
- `createA2AHandler` — `a2a`
- `createAdcKeyProvider` — `vertex/node`
- `createAgent` — `agent`
- `createAnthropic` — `anthropic`
- `createApprovalSigner` — `durable`
- `createAssistantTurn` — `chat`
- `createAzure` — `azure`, `providers`
- `createBatchClient` — `batch`
- `createBedrock` — `bedrock`, `providers`
- `createBm25Index` — `rag`
- `createBrowserTools` — `browser`
- `createBudgetLedger` — `agent`
- `createCallbackObserver` — `observe`
- `createCerebras` — `providers`
- `createCohere` — `providers`
- `createCohereReranker` — `rag`
- `createContextCompiler` — `context`
- `createDeepgram` — `transcription`
- `createDeepInfra` — `providers`
- `createDeepSeek` — `providers`
- `createDeuzStream` — `ui`
- `createDockerProcessRunner` — `compute/docker`
- `createDockerSandbox` — `compute/docker`
- `createDurableScheduler` — `goal/runtime`
- `createElevenLabs` — `speech`
- `createEmbedder` — `memory`
- `createExecutionContext` — `agent`
- `createFileRunStore` — `runtime/node`
- `createFileTokenStore` — `mcp/node`
- `createFileWorkspace` — `workspace/node`
- `createFireworks` — `providers`
- `createGeminiAuthToken` — `realtime`
- `createGeminiCache` — `google/extras`
- `createGeminiLive` — `realtime`
- `createGLM` — `providers`
- `createGoal` — `goal`
- `createGoalEvent` — `goal`
- `createGoalSupervisor` — `goal/runtime`
- `createGoogle` — `google`
- `createGoogleEmbedding` — `google`
- `createGoogleNative` — `google`
- `createGroq` — `providers`
- `createHyperbolic` — `providers`
- `createImageProvider` — `image`
- `createInMemoryA2ATaskStore` — `a2a`
- `createInMemoryAgentRunStore` — `agent`
- `createInMemoryAgentRunStoreV3` — `agent`
- `createInMemoryBudgetStore` — `agent`
- `createInMemoryChatStore` — `chat`
- `createInMemoryClaim` — `schedule`
- `createInMemoryConditionalChatStore` — `chat`
- `createInMemoryDurableStreamStateStore` — `ui`
- `createInMemoryGoalRuntimeStore` — `goal/runtime`
- `createInMemoryGoalStore` — `goal`
- `createInMemoryLeaseProvider` — `ops`
- `createInMemoryMemoryStore` — `memory`
- `createInMemoryPopulationStore` — `evolve`
- `createInMemoryProcessOperationStore` — `compute/docker`
- `createInMemoryRunStore` — `runtime`
- `createInMemorySessionStore` — `durable`
- `createInMemoryStreamStateStore` — `ui`
- `createInMemorySwarmStore` — `swarm`
- `createInMemoryTranscriptIndex` — `chat`
- `createInMemoryVersionedMemoryStore` — `memory/versioned`
- `createInMemoryWorkspace` — `workspace`
- `createJsonlChatStore` — `chat/node`
- `createJsonlObserver` — `observe/node`
- `createKimi` — `providers`
- `createLMStudio` — `providers`
- `createLoopbackRedirect` — `mcp/node`
- `createManagedConnection` — `mcp`
- `createMarkdownMemoryStore` — `memory/markdown`
- `createMcpClient` — `mcp`
- `createMcpPool` — `mcp`
- `createMcpServer` — `mcp/server`
- `createMemoryBatchJobStore` — `batch`
- `createMemoryContextSource` — `context`
- `createMemoryObserver` — `observe`
- `createMemorySession` — `memory/versioned`
- `createMemoryTools` — `memory`
- `createMemoryVectorStore` — `rag`
- `createMidjourney` — `midjourney`
- `createMiniMax` — `providers`
- `createMistral` — `providers`
- `createMockModel` — `testing`
- `createMoonshot` — `providers`
- `createNativeRunLauncher` — `goal/runtime`
- `createNodeSandbox` — `compute/node`
- `createNvidia` — `providers`
- `createOAuthProvider` — `mcp`
- `createOllama` — `providers`
- `createOpenAI` — `openai`
- `createOpenAIClientSecret` — `realtime`
- `createOpenAICompatible` — `providers`
- `createOpenAIEmbedding` — `openai`
- `createOpenAIRealtime` — `realtime`
- `createOpenAIResponses` — `openai`
- `createOpenAISpeech` — `speech`
- `createOpenAITranscription` — `transcription`
- `createOpenRouter` — `providers`
- `createOtelObserver` — `otel`
- `createOtelTracer` — `otel`
- `createParserRegistry` — `rag`
- `createPerplexity` — `providers`
- `createPlaywrightBrowser` — `browser/node`
- `createPostgresAgentRunStoreV3` — `ops/postgres`
- `createPostgresBudgetStore` — `ops/postgres`
- `createPostgresConditionalChatStore` — `stores/postgres`
- `createPostgresDurableStreamStateStore` — `stores/postgres`
- `createPostgresGoalRuntimeStore` — `goal/runtime/postgres`
- `createPostgresOpsStore` — `ops/postgres`
- `createPostgresStores` — `stores/postgres`
- `createPostgresSwarmStore` — `swarm/postgres`
- `createPostgresVersionedMemoryStore` — `memory/versioned/postgres`
- `createProviderRegistry` — `providers`
- `createQwen` — `providers`
- `createRagContextSource` — `context`
- `createRealtimeSession` — `realtime`
- `createRedisBudgetStore` — `ops/redis`
- `createRedisDurableStreamStateStore` — `stores/redis`
- `createRedisOpsStore` — `ops/redis`
- `createRedisStores` — `stores/redis`
- `createRedisSwarmStore` — `swarm/redis`
- `createRounds` — `swarm`
- `createRunManager` — `runtime`
- `createSambaNova` — `providers`
- `createScheduler` — `schedule`
- `createServiceAccountKeyProvider` — `vertex`
- `createSkillRegistry` — `skills`
- `createSkillsContextSource` — `context`
- `createSqliteAgentRunStoreV3` — `ops/sqlite`
- `createSqliteBudgetStore` — `ops/sqlite`
- `createSqliteConditionalChatStore` — `stores/sqlite`
- `createSqliteDurableStreamStateStore` — `stores/sqlite`
- `createSqliteGoalRuntimeStore` — `goal/runtime/sqlite`
- `createSqliteOpsStore` — `ops/sqlite`
- `createSqlitePopulationStore` — `evolve/sqlite`
- `createSqliteProcessOperationStore` — `compute/docker`
- `createSqliteStores` — `stores/sqlite`
- `createSqliteSwarmStore` — `swarm/sqlite`
- `createSqliteVersionedMemoryStore` — `memory/versioned/sqlite`
- `createStdioMcpClient` — `mcp/stdio`
- `createSteeringController` — `runtime`
- `createSwarm` — `swarm`
- `createTaskList` — `autonomy`
- `createTogether` — `providers`
- `createTokenEstimator` — `context`
- `createTranscriptContextSource` — `context`
- `createUseChat` — `react`
- `createVerifier` — `autonomy`
- `createVersionedMemoryTools` — `memory/versioned`
- `createVertexAnthropic` — `vertex`
- `createVertexGoogle` — `vertex`
- `createVertexGoogleNative` — `vertex`
- `createVideoProvider` — `video`
- `createVoyage` — `voyage`
- `createVoyageReranker` — `voyage`
- `createWebhookHandler` — `goal/runtime`
- `createWorkingMemory` — `context`
- `createWorkspaceTools` — `workspace`
- `createXai` — `xai`
- `createYunwu` — `yunwu`
- `createYunwuChat` — `yunwu`
- `createYunwuEmbedding` — `yunwu`
- `createYunwuImage` — `yunwu`
- `createYunwuVideo` — `yunwu`
- `csvToText` — `rag`
- `deepinfra` — `providers`
- `deepseek` — `providers`
- `DEFAULT_CHUNK_OPTIONS` — `rag`
- `DEFAULT_CONTEXT_BUDGET` — `context`
- `DEFAULT_CONTEXT_REFRESH` — `context`
- `DEFAULT_DOCKER_SANDBOX` — `compute/docker`
- `DEFAULT_DURABLE_SCHEDULER` — `goal/runtime`
- `DEFAULT_DURABLE_STREAM_BATCH` — `ui`
- `DEFAULT_DURABLE_STREAM_RETAIN_MS` — `ui`
- `DEFAULT_GOAL_RUNTIME_POLICY` — `goal/runtime`
- `DEFAULT_GOAL_SUPERVISOR` — `goal/runtime`
- `DEFAULT_SEPARATORS` — `rag`
- `defaultHashFn` — `memory`
- `defaultMemoryScorer` — `memory`
- `defaultNodeParserRegistry` — `rag/node`
- `defineAccountedEmbedder` — `rag`
- `defineAccountedMemoryLLM` — `memory`, `memory/versioned`
- `deleteGeminiCache` — `google/extras`
- `deserializeChatRecord` — `chat`
- `deserializeCheckpoint` — `durable`
- `detectToolDrift` — `mcp`
- `DEUZ_CAPABILITIES` — `ui`
- `DEUZ_CAPABILITIES_HEADER` — `ui`
- `DEUZ_CAPABILITY` — `ui`
- `DEUZ_STREAM_VERSION` — `ui`
- `DEUZ_STREAM_VERSIONS` — `ui`
- `digestWorkspace` — `workspace`
- `DockerSandboxError` — `compute/docker`
- `doctor` — `headless`
- `docxParser` — `rag/node`
- `downloadVideo` — `video`
- `dropTrailingAssistant` — `chat`
- `embeddingMatcher` — `skills`
- `EmbeddingMismatchError` — `memory/versioned`
- `emitActivity` — `runtime`
- `emitPlanUpdate` — `runtime`
- `estimatePdfTokens` — `rag`
- `estimateRequestOverhead` — `context`
- `estimateRequestTokens` — `context`
- `estimateTextTokens` — `context`
- `estimateTokens` — `rag`
- `evolve` — `evolve`
- `evolveCandidateId` — `evolve`
- `EvolveConflictError` — `evolve`
- `EvolveLeaseError` — `evolve`
- `EvolvePatchError` — `evolve`
- `ExecutionPersistenceError` — `agent`
- `ExecutionPolicyError` — `agent`
- `exitCodeFor` — `headless`
- `extractFullRewrite` — `evolve`
- `extractLinks` — `memory`
- `fetchAgentCard` — `a2a`
- `fetchSkillSource` — `skills`
- `fetchTask` — `midjourney`
- `fetchVideoTask` — `video`
- `filesToImageParts` — `chat`
- `filterObserver` — `observe`
- `findStaleAgentRuns` — `ops`
- `fingerprintTools` — `mcp`
- `fireworks` — `providers`
- `formatDeuzCapabilities` — `ui`
- `formatMemoriesForPrompt` — `memory`
- `generateImage` — `image`
- `generateSpeech` — `speech`
- `generateVideo` — `video`
- `getGeminiCache` — `google/extras`
- `glm` — `providers`
- `GOAL_EVENT_VERSION` — `goal`
- `GOAL_RECORD_VERSION` — `goal`
- `GOAL_SEEN_LIMIT` — `goal`
- `goalDeliveryDigest` — `goal/runtime`
- `goalDependencyEvents` — `goal/runtime`
- `GoalError` — `goal`, `goal/runtime`
- `goalEventFromOccurrence` — `goal`
- `goalEventFromSignal` — `goal`
- `goalInboxKey` — `goal/runtime`
- `goalLeaseKey` — `goal/runtime`
- `goalWakeupEvent` — `goal`
- `goalWakeupKey` — `goal`
- `google` — `google`
- `googleEmbedding` — `google`
- `googleNative` — `google`
- `groq` — `providers`
- `handleSignal` — `schedule`
- `HEADLESS_EXIT_CODES` — `headless`
- `htmlToBlocks` — `rag/node`
- `hybridRetrieve` — `rag`
- `hyperbolic` — `providers`
- `identityReranker` — `rag`
- `imagine` — `midjourney`
- `importLegacyMemory` — `memory/versioned`
- `indexChat` — `chat`
- `indexChunks` — `rag`
- `inMemoryTokenStore` — `mcp`
- `inspectRun` — `headless`
- `intersectExecutionPolicies` — `agent`
- `isAccounted` — `memory`, `memory/versioned`
- `isConditionalChatStore` — `chat`
- `isExpired` — `memory`
- `kimi` — `providers`
- `lexicalMatcher` — `skills`
- `listGeminiCaches` — `google/extras`
- `lmstudio` — `providers`
- `loadProjectInstructions` — `headless`
- `matchesScope` — `memory`
- `memoryEmbedderFromRag` — `memory`
- `mergeSkillSources` — `skills`
- `minimax` — `providers`
- `mistral` — `providers`
- `mockFetch` — `testing`
- `mockFetchSequence` — `testing`
- `modelSupportsDocuments` — `rag`
- `moonshot` — `providers`
- `negotiateDeuzStreamVersion` — `ui`
- `nextOccurrence` — `schedule`
- `nextPendingTask` — `autonomy`
- `nextZonedOccurrence` — `schedule`
- `nodeSkillSource` — `skills/node`
- `normalizeResourcePath` — `skills`
- `normalizeWorkspacePath` — `workspace`
- `nvidia` — `providers`
- `occurrencesBetween` — `schedule`
- `ollama` — `providers`
- `openai` — `openai`
- `openaiEmbedding` — `openai`
- `openaiResponses` — `openai`
- `openrouter` — `providers`
- `OperationConflictError` — `compute/docker`, `memory/versioned`
- `otelReady` — `otel`
- `parallelAgents` — `autonomy`
- `parse` — `rag`
- `parseCron` — `schedule`
- `parseCsv` — `rag`
- `parseDecision` — `memory`
- `parseDeuzCapabilities` — `ui`
- `parseDeuzChatRequest` — `chat`
- `parseEvolveBlocks` — `evolve`
- `parseFacts` — `memory`
- `parseGoal` — `goal`
- `parseGoalEvent` — `goal`
- `parseSearchReplace` — `evolve`
- `parseSkill` — `skills`
- `parseTaskList` — `autonomy`
- `partsFromFiles` — `@deuz-sdk/react`
- `pdfParser` — `rag/node`
- `perplexity` — `providers`
- `planMemory` — `memory`
- `planTasks` — `autonomy`
- `pollStaleRuns` — `runtime/node`
- `postgresSchemaName` — `swarm/postgres`
- `previousOccurrence` — `schedule`
- `PROMPT_INJECTION_POLICY` — `guardrails`
- `proposeSkillFromRun` — `skills/learning`
- `qwen` — `providers`
- `RagError` — `rag`
- `readDeuzStream` — `ui`
- `readJsonlEvents` — `observe/node`
- `RealtimeError` — `realtime`
- `realtimePriceTable` — `realtime`
- `recall` — `memory`
- `reciprocalRankFusion` — `rag`
- `reconcileAgentRun` — `agent`
- `registerElicitation` — `mcp`
- `registerSamplingAndRoots` — `mcp`
- `registerToolListChanged` — `mcp`
- `remember` — `memory`
- `renderRunReport` — `observe`
- `renderSkillCatalog` — `skills`
- `resumeAgent` — `agent`
- `resumeDeuzChatResponse` — `durable`
- `resumeDeuzStreamResponse` — `ui`
- `resumeEvolve` — `evolve`
- `resumeFromCheckpoint` — `durable`
- `resumeHeadless` — `headless`
- `resumeStreamAgent` — `agent`
- `resumeStreamFromCheckpoint` — `durable`
- `retrieve` — `rag`
- `RevisionConflictError` — `memory/versioned`, `chat`
- `runAgent` — `agent`
- `runEval` — `testing`
- `runEvalSuite` — `testing`
- `runGradedEval` — `testing`
- `runHeadless` — `headless`
- `RUNS_V3_SCHEMA_NAME` — `ops/sqlite`
- `RUNS_V3_SCHEMA_VERSION` — `ops/sqlite`
- `sambanova` — `providers`
- `scopeToolsToSkill` — `skills`
- `sealAssistantTurn` — `chat`
- `selfConsistency` — `autonomy`
- `serializeChatRecord` — `chat`
- `serializeCheckpoint` — `durable`
- `serializeGoal` — `goal`
- `serializeGoalEvent` — `goal`
- `serializeTaskList` — `autonomy`
- `serveMcpStdio` — `mcp/server/stdio`
- `setTaskStatus` — `autonomy`
- `settleGoalEvent` — `goal/runtime`
- `shellTool` — `compute`
- `shouldSendWhole` — `rag`
- `SkillLearningError` — `skills/learning`
- `sniffMime` — `rag`
- `splitFrontmatter` — `skills`
- `sseEvents` — `testing`
- `sseResponse` — `testing`
- `staticSkillSource` — `skills`
- `streamAgent` — `agent`
- `submitAction` — `midjourney`
- `submitBlend` — `midjourney`
- `submitDescribe` — `midjourney`
- `submitImagine` — `midjourney`
- `submitVideo` — `video`
- `summarizeRun` — `observe`
- `SwarmConflictError` — `swarm`
- `SwarmLeaseError` — `swarm`
- `sweepExpired` — `memory`
- `taskListProgress` — `autonomy`
- `timeZoneOffset` — `schedule`
- `toDeuzAgentStreamResponse` — `ui`
- `toDeuzObjectStreamResponse` — `ui`
- `toDeuzStreamResponse` — `ui`
- `toDeuzTextStreamResponse` — `ui`
- `together` — `providers`
- `tokenize` — `rag`
- `toNativeDocumentPart` — `rag`
- `toNodeHandler` — `goal/runtime`
- `ToolApprovalCard` — `@deuz-sdk/react`
- `transcribe` — `transcription`
- `transitionGoal` — `goal`
- `uiFromMessages` — `chat`
- `UnsupportedStoreError` — `agent`
- `updateConditionalChat` — `chat`
- `updateTask` — `autonomy`
- `uploadFile` — `google/extras`
- `useChat` — `react`, `@deuz-sdk/react`
- `useObject` — `react`, `@deuz-sdk/react`
- `userMessageFromInput` — `chat`
- `validateChatRequest` — `chat`
- `validateSkillDescription` — `skills`
- `validateSkillName` — `skills`
- `verifyGitHubWebhook` — `schedule`
- `verifyGoalAcceptance` — `goal/runtime`
- `verifyHmacSignature` — `schedule`
- `verifySlackRequest` — `schedule`
- `voyage` — `voyage`
- `VOYAGE_RERANK_DEFAULT_MODEL` — `voyage`
- `waitForFileActive` — `google/extras`
- `waitForTask` — `midjourney`
- `waitForVideo` — `video`
- `workingMemoryTools` — `context`
- `wrapIoredisClient` — `swarm/redis`, `ops/redis`, `stores/redis`
- `writeRunReport` — `observe/node`
- `xai` — `xai`
- `xlsxParser` — `rag/node`
- `yunwu` — `yunwu`
- `YUNWU_CHAT_MODELS` — `yunwu`
- `YUNWU_DEFAULT_BASE_URL` — `yunwu`
- `YUNWU_IMAGE_MODELS` — `yunwu`
- `YUNWU_MIDJOURNEY_MODELS` — `yunwu`
- `YUNWU_MODELS` — `yunwu`
- `YUNWU_VIDEO_MODELS` — `yunwu`
- `zonedOccurrencesBetween` — `schedule`
