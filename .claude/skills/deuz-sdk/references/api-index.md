<!-- GENERATED FILE — do not hand-edit.
     regenerate: node .claude/skills/deuz-sdk/scripts/generate-api-index.mjs
     source: packages/core/{package.json exports, tsup.config.ts} + src walk (export * followed)
     verified: 2026-09-26 against @deuz-sdk/core@2.1.0 · api-contract sha256:cb9f41a77273 -->

# API index — every subpath, every export

**Load when:** checking whether a name exists, finding which subpath exports it, or exploring an unfamiliar module.

`@deuz-sdk/core@2.1.0` ships **62 subpaths**; `@deuz-sdk/react` ships one. Names marked under **Types** are type-only — import them with `import type`, or a bundler-free runtime will crash looking for a value that was erased at compile time.

If anything here disagrees with `packages/core/package.json` `exports` or `tooling/api-contract.json`, those win — and this file is stale; regenerate it.

## `@deuz-sdk/core`

The six call functions, tool authoring, stop conditions, errors, and every canonical type.

**Values** (52): AbortError, agentTool, anthropicWebSearch, APICallError, AuthenticationError, BreakerOpenError, compactMessages, ContextOverflowError, costExceeds, createClient, createPriceProvider, DeuzError, durationExceeds, embed, embedMany, filePart, generateObject, generateText, getModelCapabilities, googleSearch, handoff, hasToolCall, InvalidRequestError, imagePart, isDeuzError, logging, maxOutputLength, maxToolResultLength, McpAuthorizationRequiredError, ModelNotFoundError, NetworkError, NoObjectGeneratedError, openaiWebSearch, OverloadedError, PRICES_2026, priceUsage, promptInjectionGuard, promptInjectionGuardrail, RateLimitError, redactPII, resolveDependencies, simpleCache, stepCountIs, streamChat, streamObject, TimeoutError, tool, ToolExecutionError, totalTokensExceed, UnsupportedCapabilityError, withFallback, wrapModel

**Types** (194): ActivityPart, AgentCheckpoint, AgentToolDef, AnthropicWebSearchConfig, APICallErrorOptions, ApprovalRequestedEvent, ApprovalResolvedEvent, BreakerState, BreakerStore, BudgetExceededPart, CallWarning, CheckpointFailedEvent, CheckpointLoadedEvent, CheckpointSavedEvent, CheckpointStatus, CitationPart, ClientConfig, Clock, CommonCallOptions, CompactionEvent, CompactionLayer, CompactionObserveEvent, CompactionOption, CompactionPart, CompactionPolicy, CompactionSkippedEvent, CompactMessagesDeps, CompactMessagesResult, CostCalculatedEvent, CostPart, CreatePriceProviderOptions, DataPart, DeepPartial, Dependencies, DeuzClient, DeuzErrorJSON, DeuzOAuthProvider, DoneWhen, DoneWhenContext, DurableSessionOptions, Embed, EmbeddingModel, EmbeddingModelSurface, EmbeddingProvider, EmbeddingTaskType, EmbedMany, EmbedManyOptions, EmbedManyResult, EmbedOptions, EmbedResult, ErrorStreamPart, FallbackHooks, FalseFinishPart, FinishMeta, FinishReason, FinishStreamPart, GenerateObject, GenerateObjectOptions, GenerateObjectResult, GenerateText, GenerateTextOptions, GenerateTextResult, GuardrailBaseContext, GuardrailPart, Guardrails, HandoffAgentDef, HandoffOptions, HandoffPart, ImagePart, InferSchemaOutput, InferToolInput, InferToolOutput, InputGuardrail, InputGuardrailContext, InputGuardrailResult, JSONSchema, KeyProvider, LanguageModel, LanguageModelMiddleware, Logger, McpClientLoopEntry, McpHttpLoopConfig, McpLoopEntry, McpOAuthOptions, McpStdioLoopConfig, Message, MiddlewareContext, ModelCapabilities, ModelCompletedEvent, ModelFailedEvent, ModelFirstContentEvent, ModelId, ModelPrice, ModelRetryEvent, ModelStartedEvent, ModelSurface, ObservationCaptureOptions, ObservationLimits, ObservationOptions, ObservationRedactor, ObserveAttributes, ObserveAttributeValue, ObservedError, ObservedSubsystem, ObserveEvent, ObserveEventBase, ObservePrimitive, Observer, OpenAIWebSearchConfig, OperationCompletedEvent, OperationFailedEvent, OperationStartedEvent, OutputGuardrail, OutputGuardrailContext, OutputGuardrailResult, Part, PlanTaskSnapshot, PlanUpdatePart, PrepareStepResult, PriceProvider, PriceTable, Provider, ReasoningDeltaPart, ReasoningPart, ResolvedDependencies, Role, RunAbortedEvent, RunCompletedEvent, RunFailedEvent, RunStartedEvent, RunSuspendedEvent, SessionStore, SourcePart, Span, SpanOptions, StandardSchemaIssue, StandardSchemaProps, StandardSchemaResult, StandardSchemaV1, StepCompletedEvent, StepFinishPart, StepResult, StepStartedEvent, StepStartPart, StopCondition, StreamChat, StreamChatOptions, StreamChatResult, StreamObject, StreamObjectResult, StreamPart, SubAgentCompletedEvent, SubAgentFailedEvent, SubAgentPart, SubAgentStartedEvent, SubAgentSuspendedEvent, TextDeltaPart, TextPart, TokenStore, Tool, ToolApprovalRequest, ToolApprovalRequestPart, ToolApprovalResponse, ToolCall, ToolCallDeltaPart, ToolCallGuardrail, ToolCallGuardrailContext, ToolCallGuardrailResult, ToolCallPart, ToolChoice, ToolCompletedEvent, ToolDeniedEvent, ToolExecuteContext, ToolFailedEvent, ToolResult, ToolResultGuardrail, ToolResultGuardrailContext, ToolResultGuardrailResult, ToolResultPart, ToolResultStreamPart, ToolRunState, ToolSet, ToolStartedEvent, ToolStatePart, ToolUsePart, Tracer, Usage, UsageMeta, VerifyPart, VerifyStep, VerifyStepContext, VerifyStepResult, WarningPart, WrappedModel

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

Deterministic mock models, SSE fixtures, fetch mocks, and eval runners for YOUR tests.

**Values** (7): createMockModel, mockFetch, mockFetchSequence, runEval, runGradedEval, sseEvents, sseResponse

**Types** (10): CreateMockModelOptions, EvalCase, EvalCaseResult, EvalReport, GradedCase, GradedCaseResult, GradedEvalReport, GradedSubtask, MockResponse, MockToolCall

## `@deuz-sdk/core/workspace`

A file-tree seam agents use as externalized memory, plus the tools that drive it.

**Values** (3): createInMemoryWorkspace, createWorkspaceTools, normalizeWorkspacePath

**Types** (3): Workspace, WorkspaceEntry, WorkspaceToolsOptions

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

## `@deuz-sdk/core/agent`

Native run/stream/resume, validated outputs, execution policies, shared and persistent budgets; also createAgent templates and handoff.

**Values** (15): BudgetLedgerError, BudgetStoreError, createAgent, createBudgetLedger, createExecutionContext, createInMemoryAgentRunStore, createInMemoryBudgetStore, ExecutionPersistenceError, ExecutionPolicyError, handoff, intersectExecutionPolicies, resumeAgent, resumeStreamAgent, runAgent, streamAgent

**Types** (54): AgentArrayElement, AgentCallOptions, AgentDef, AgentEvent, AgentObjectCallOptions, AgentOutput, AgentPartialOutput, AgentResult, AgentRunEnvelope, AgentRunOptions, AgentRunSession, AgentRunStore, AgentStream, AgentTool, AgentToolContext, AgentToolReceipt, AgentToolSet, AgentValidation, AgentValidator, AgentVerification, AgentVerifyContext, BudgetAdmission, BudgetAdmissionRestore, BudgetAggregate, BudgetCompaction, BudgetLedger, BudgetLedgerOptions, BudgetLedgerSnapshot, BudgetLimits, BudgetReservation, BudgetReservationInput, BudgetScope, BudgetScopeUsage, BudgetSettlement, BudgetStore, BudgetStoreErrorCode, BudgetStoreReservation, BudgetStoreReserveInput, BudgetTotals, BudgetUsage, BudgetUsageOptions, BudgetWarning, BudgetWindow, DeuzAgent, ExecutionChildOptions, ExecutionContextOptions, ExecutionContextRestoreOptions, ExecutionContextSnapshot, ExecutionPolicy, ExecutionReservationInput, HandoffAgentDef, HandoffOptions, NativeExecutionContext, PersistentBudgetScope

## `@deuz-sdk/core/swarm`

Bounded agent/reducer DAGs, runtime spawning, blackboards, rounds, leases, drain and recovery, atomic snapshots and cursor events.

**Values** (5): createInMemorySwarmStore, createRounds, createSwarm, SwarmConflictError, SwarmLeaseError

**Types** (36): CreateRoundsOptions, RoundsConsolidateInput, RoundsDecision, RoundsGroupPlan, Swarm, SwarmAgentBinding, SwarmCancelRequest, SwarmChannelEntry, SwarmChannelPost, SwarmCommit, SwarmDynamicLimits, SwarmEvent, SwarmEventInput, SwarmFailureContext, SwarmHandle, SwarmKey, SwarmLeaseOptions, SwarmOptions, SwarmOutcome, SwarmReducerBinding, SwarmReducerContext, SwarmResumeOptions, SwarmRounds, SwarmRunOptions, SwarmRunQuery, SwarmRunRecord, SwarmRunStatus, SwarmSnapshot, SwarmSpawnContext, SwarmSpawnRequest, SwarmStore, SwarmStoreCapability, SwarmTask, SwarmTaskRecord, SwarmTaskResult, SwarmTaskStatus

## `@deuz-sdk/core/swarm/sqlite`

Node-only SQLite persistence for swarm runs, native agent envelopes and events.

**Values** (1): createSqliteSwarmStore

**Types** (2): SqliteSwarmStore, SqliteSwarmStoreOptions

## `@deuz-sdk/core/swarm/postgres`

Node-only Postgres swarm store: every write one revision-gated statement.

**Values** (2): createPostgresSwarmStore, postgresSchemaName

**Types** (1): PostgresSwarmStoreOptions

## `@deuz-sdk/core/ops`

Leases for cross-process runs: the LeaseProvider contract and an in-memory provider.

**Values** (3): assertEnvelopeRevision, assertLeaseRequest, createInMemoryLeaseProvider

**Types** (4): Lease, LeaseProvider, LeaseRenewal, LeaseSignal

## `@deuz-sdk/core/ops/sqlite`

Node-only SQLite leases, native agent run store and persistent budget store.

**Values** (2): createSqliteBudgetStore, createSqliteOpsStore

**Types** (4): SqliteBudgetStore, SqliteBudgetStoreOptions, SqliteOpsStore, SqliteOpsStoreOptions

## `@deuz-sdk/core/ops/postgres`

Node-only Postgres leases, native agent run store and persistent budget store.

**Values** (2): createPostgresBudgetStore, createPostgresOpsStore

**Types** (3): PostgresBudgetStoreOptions, PostgresOpsStore, PostgresOpsStoreOptions

## `@deuz-sdk/core/evolve`

Evolutionary program search: evolve blocks, SEARCH/REPLACE patches, cascade, islands, zero-call resume.

**Values** (12): applySearchReplace, buildMutationPrompt, createInMemoryPopulationStore, evolve, evolveCandidateId, EvolveConflictError, EvolveLeaseError, EvolvePatchError, extractFullRewrite, parseEvolveBlocks, parseSearchReplace, resumeEvolve

**Types** (38): EvolveArtifacts, EvolveBanditState, EvolveBlock, EvolveCandidate, EvolveCandidateQuery, EvolveEvent, EvolveGenerationCommit, EvolveHandle, EvolveIslandOptions, EvolveIslandState, EvolveKey, EvolveLeaseOptions, EvolveMetrics, EvolveModel, EvolveMutationPrompt, EvolveNoveltyJudgeInput, EvolveNoveltyOptions, EvolveOptions, EvolvePatchErrorCode, EvolvePatchType, EvolvePopulationOptions, EvolvePromptContext, EvolvePromptProgram, EvolveRejection, EvolveRejectionKind, EvolveResult, EvolveRunRecord, EvolveSelection, EvolveStage, EvolveStageContext, EvolveStageOutput, EvolveStageResult, EvolveStatus, EvolveStopReason, ParsedEvolveSource, PopulationStore, ResumeEvolveOptions, SearchReplaceBlock

## `@deuz-sdk/core/evolve/sqlite`

Node-only SQLite population store for evolve.

**Values** (1): createSqlitePopulationStore

**Types** (2): SqlitePopulationStore, SqlitePopulationStoreOptions

## `@deuz-sdk/core/schedule`

Five-field UTC cron, a tick-driven scheduler with dedupe, and verified webhooks.

**Values** (10): createInMemoryClaim, createScheduler, handleSignal, nextOccurrence, occurrencesBetween, parseCron, previousOccurrence, verifyGitHubWebhook, verifyHmacSignature, verifySlackRequest

**Types** (18): CronSchedule, HandleSignalOptions, HmacAlgorithm, HmacSignatureOptions, ScheduleCatchUp, ScheduleClaim, ScheduleDefinition, ScheduleOccurrence, ScheduleOccurrenceResult, Scheduler, SchedulerOptions, ScheduleStartOptions, ScheduleTickResult, SignalDispatchInput, SignalRejection, SignalVerification, SignatureEncoding, SlackVerifyOptions

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

USD cost accounting: bundled price table, price provider, cache savings.

**Values** (4): cacheSavings, createPriceProvider, PRICES_2026, priceUsage

**Types** (3): CreatePriceProviderOptions, ModelPrice, PriceTable

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

**Values** (21): applyEvents, assertScope, buildDecisionPrompt, buildExtractionPrompt, cosineSimilarity, createEmbedder, createInMemoryMemoryStore, createMemoryTools, defaultHashFn, defaultMemoryScorer, extractLinks, formatMemoriesForPrompt, isExpired, matchesScope, memoryEmbedderFromRag, parseDecision, parseFacts, planMemory, recall, remember, sweepExpired

**Types** (20): ApplyContext, Embedder, HashFn, MemoryCallOptions, MemoryEvent, MemoryEventType, MemoryFact, MemoryHit, MemoryKind, MemoryLLM, MemoryMutation, MemoryQuery, MemoryRecord, MemoryScope, MemoryScorer, MemorySeams, MemoryStore, MemoryToolOptions, RememberOptions, WritePolicy

## `@deuz-sdk/core/memory/markdown`

Obsidian-style markdown vault as the memory store (Node only).

**Values** (3): _deserializeRecord, _serializeRecord, createMarkdownMemoryStore

**Types** (1): MarkdownMemoryStoreOptions

## `@deuz-sdk/core/rag`

Edge-safe RAG: sniff, parse, chunk, embed, dense + BM25 hybrid retrieval, citations.

**Values** (29): approxCountTokens, chunkBlocks, chunkFixed, chunkRecursive, citationsFromHits, COHERE_RERANK_DEFAULT_MODEL, cosineSimilarity, createBm25Index, createCohereReranker, createMemoryVectorStore, createParserRegistry, csvToText, DEFAULT_CHUNK_OPTIONS, DEFAULT_SEPARATORS, estimatePdfTokens, estimateTokens, hybridRetrieve, identityReranker, indexChunks, modelSupportsDocuments, parse, parseCsv, RagError, reciprocalRankFusion, retrieve, shouldSendWhole, sniffMime, tokenize, toNativeDocumentPart

**Types** (27): Bm25Index, Bm25Options, Chunk, ChunkOptions, CitationOptions, CohereRerankerSettings, Container, CountTokens, DocBlock, DocBlockType, DocMime, DocumentParser, EmbeddedChunk, Embedder, HybridRetrieveDeps, HybridRetrieveOptions, ParsedDocument, ParserRegistry, RagErrorCode, Reranker, RetrieveDeps, RetrieveOptions, RrfOptions, ScoredChunk, SendWholeInput, SniffResult, VectorStore

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

## `@deuz-sdk/core/vertex`

Claude and Gemini through Vertex AI; edge-safe service-account JWT signing.

**Values** (5): CLOUD_PLATFORM_SCOPE, createServiceAccountKeyProvider, createVertexAnthropic, createVertexGoogle, createVertexGoogleNative

**Types** (3): ServiceAccountCredentials, ServiceAccountKeyProviderOptions, VertexSettings

## `@deuz-sdk/core/vertex/node`

Vertex Application Default Credentials (Node only).

**Values** (1): createAdcKeyProvider

**Types** (1): AdcKeyProviderOptions

## `@deuz-sdk/core/mcp`

MCP client over HTTP/SSE, connection pool, OAuth provider, tool conversion.

**Values** (10): createManagedConnection, createMcpClient, createMcpPool, createOAuthProvider, detectToolDrift, fingerprintTools, inMemoryTokenStore, registerElicitation, registerSamplingAndRoots, registerToolListChanged

**Types** (34): DeuzOAuthProvider, ManagedConnectionOptions, ManagedMcp, McpClient, McpClientHooks, McpClientOptions, McpConnectableConfig, McpConnectionPool, McpConnectionStatus, McpElicitationHandler, McpElicitationRequest, McpElicitationResult, McpGetPromptResult, McpHttpTransport, McpLifecycleOptions, McpOAuthOptions, McpPoolOptions, McpPrompt, McpPromptMessage, McpReconnectPolicy, McpResource, McpResourceContent, McpRootsClient, McpRootsOption, McpSamplingMessage, McpSamplingOptions, McpSamplingRequest, McpSamplingResult, McpStatusInfo, McpStopReason, ResolvedMcpRuntime, TokenStore, ToolDrift, ToolFingerprints

## `@deuz-sdk/core/mcp/stdio`

MCP over stdio — spawn a local server process (Node only).

**Values** (1): createStdioMcpClient

**Types** (9): McpClient, McpConnectionStatus, McpLifecycleOptions, McpReconnectPolicy, McpRootsClient, McpRootsOption, McpSamplingOptions, McpStatusInfo, McpStdioOptions

## `@deuz-sdk/core/mcp/node`

Node OAuth helpers for MCP: file token store, loopback redirect.

**Values** (2): createFileTokenStore, createLoopbackRedirect

**Types** (4): FileTokenStoreOptions, LoopbackRedirect, LoopbackRedirectOptions, TokenStore

## `@deuz-sdk/core/stores/sqlite`

One factory for memory + chat + session + run stores on node:sqlite.

**Values** (1): createSqliteStores

**Types** (4): SqliteDatabaseLike, SqliteStatementLike, SqliteStoreOptions, SqliteStores

## `@deuz-sdk/core/stores/redis`

The same four store seams on Redis.

**Values** (1): createRedisStores

**Types** (4): RedisClientLike, RedisStoreOptions, RedisStores, RedisZMember

## `@deuz-sdk/core/stores/postgres`

The same four store seams on Postgres (pgvector when available).

**Values** (1): createPostgresStores

**Types** (3): PgClientLike, PostgresStoreOptions, PostgresStores

## `@deuz-sdk/core/durable`

Checkpoints, resume-after-crash, and HMAC-signed tool approvals.

**Values** (8): CheckpointNotFoundError, createApprovalSigner, createInMemorySessionStore, deserializeCheckpoint, resumeDeuzChatResponse, resumeFromCheckpoint, resumeStreamFromCheckpoint, serializeCheckpoint

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

**Values** (85): agentTool, anthropicWebSearch, applySearchReplace, applyUIPart, assertEnvelopeRevision, assertLeaseRequest, assistantMessageFromTurn, branchBeforeUserMessage, BreakerOpenError, buildMutationPrompt, canonicalFromUI, CheckpointNotFoundError, clientToolResultMessage, composeObservers, costExceeds, createAgent, createApprovalSigner, createAssistantTurn, createCallbackObserver, createClient, createInMemoryChatStore, createInMemoryClaim, createInMemoryLeaseProvider, createInMemoryPopulationStore, createInMemorySessionStore, createMemoryObserver, createOtelObserver, createOtelTracer, createScheduler, deserializeChatRecord, deserializeCheckpoint, DeuzError, dropTrailingAssistant, durationExceeds, evolve, evolveCandidateId, EvolveConflictError, EvolveLeaseError, EvolvePatchError, extractFullRewrite, filePart, filesToImageParts, filterObserver, generateObject, generateText, getModelCapabilities, googleSearch, handleSignal, handoff, hasToolCall, imagePart, isDeuzError, maxOutputLength, maxToolResultLength, nextOccurrence, NoObjectGeneratedError, occurrencesBetween, openaiWebSearch, otelReady, parseCron, parseDeuzChatRequest, parseEvolveBlocks, parseSearchReplace, previousOccurrence, promptInjectionGuardrail, resolveDependencies, resumeDeuzChatResponse, resumeEvolve, resumeFromCheckpoint, resumeStreamFromCheckpoint, sealAssistantTurn, serializeChatRecord, serializeCheckpoint, stepCountIs, streamChat, streamObject, summarizeRun, tool, totalTokensExceed, uiFromMessages, userMessageFromInput, validateChatRequest, verifyGitHubWebhook, verifyHmacSignature, verifySlackRequest

**Types** (265): ActivityPart, AgentCallOptions, AgentCheckpoint, AgentDef, AgentObjectCallOptions, AgentToolDef, ApprovalRequestedEvent, ApprovalResolvedEvent, ApprovalSigner, AssistantTurnState, BreakerState, BreakerStore, BudgetExceededPart, CallWarning, ChatHistory, ChatInput, ChatPersistOptions, ChatRecord, ChatStore, CheckpointFailedEvent, CheckpointLoadedEvent, CheckpointSavedEvent, CheckpointStatus, CitationPart, ClientConfig, Clock, CommonCallOptions, CompactionLayer, CompactionObserveEvent, CompactionOption, CompactionPart, CompactionPolicy, CompactionSkippedEvent, CostCalculatedEvent, CostPart, CreateApprovalSignerOptions, CronSchedule, DataPart, DeepPartial, Dependencies, DeuzAgent, DeuzChatRequest, DeuzClient, DeuzErrorJSON, DeuzOAuthProvider, DoneWhen, DoneWhenContext, DurableSessionOptions, Embed, EmbeddingModel, EmbeddingModelSurface, EmbeddingProvider, EmbeddingTaskType, EmbedMany, EmbedManyOptions, EmbedManyResult, EmbedOptions, EmbedResult, ErrorStreamPart, EvolveArtifacts, EvolveBanditState, EvolveBlock, EvolveCandidate, EvolveCandidateQuery, EvolveEvent, EvolveGenerationCommit, EvolveHandle, EvolveIslandOptions, EvolveIslandState, EvolveKey, EvolveLeaseOptions, EvolveMetrics, EvolveModel, EvolveMutationPrompt, EvolveNoveltyJudgeInput, EvolveNoveltyOptions, EvolveOptions, EvolvePatchErrorCode, EvolvePatchType, EvolvePopulationOptions, EvolvePromptContext, EvolvePromptProgram, EvolveRejection, EvolveRejectionKind, EvolveResult, EvolveRunRecord, EvolveSelection, EvolveStage, EvolveStageContext, EvolveStageOutput, EvolveStageResult, EvolveStatus, EvolveStopReason, FalseFinishPart, FinishMeta, FinishReason, FinishStreamPart, GenerateObject, GenerateObjectOptions, GenerateObjectResult, GenerateText, GenerateTextOptions, GenerateTextResult, GuardrailBaseContext, GuardrailPart, Guardrails, HandleSignalOptions, HandoffAgentDef, HandoffOptions, HandoffPart, HmacAlgorithm, HmacSignatureOptions, ImagePart, InferSchemaOutput, InferToolInput, InferToolOutput, InputGuardrail, InputGuardrailContext, InputGuardrailResult, JSONSchema, KeyProvider, LanguageModel, Lease, LeaseProvider, LeaseRenewal, LeaseSignal, Logger, McpClientLoopEntry, McpHttpLoopConfig, McpLoopEntry, McpOAuthOptions, McpStdioLoopConfig, MemoryObserver, Message, ModelCapabilities, ModelCompletedEvent, ModelFailedEvent, ModelFirstContentEvent, ModelId, ModelRetryEvent, ModelStartedEvent, ModelSurface, ObservationCaptureOptions, ObservationLimits, ObservationOptions, ObservationRedactor, ObserveAttributes, ObserveAttributeValue, ObservedError, ObservedSubsystem, ObserveEvent, ObserveEventBase, ObservePrimitive, Observer, OperationCompletedEvent, OperationFailedEvent, OperationStartedEvent, OtelTracerOptions, OutputGuardrail, OutputGuardrailContext, OutputGuardrailResult, ParsedEvolveSource, Part, PlanTaskSnapshot, PlanUpdatePart, PopulationStore, PrepareStepResult, PriceProvider, Provider, ReasoningDeltaPart, ReasoningPart, ResolvedDependencies, ResumeDeuzChatOptions, ResumeEvolveOptions, ResumeOptions, Role, RunAbortedEvent, RunCompletedEvent, RunFailedEvent, RunStartedEvent, RunSummary, RunSuspendedEvent, ScheduleCatchUp, ScheduleClaim, ScheduleDefinition, ScheduleOccurrence, ScheduleOccurrenceResult, Scheduler, SchedulerOptions, ScheduleStartOptions, ScheduleTickResult, SearchReplaceBlock, SessionStore, SignalDispatchInput, SignalRejection, SignalVerification, SignatureEncoding, SignedApprovalPayload, SlackVerifyOptions, SourcePart, Span, SpanOptions, StandardSchemaIssue, StandardSchemaProps, StandardSchemaResult, StandardSchemaV1, StepCompletedEvent, StepFinishPart, StepResult, StepStartedEvent, StepStartPart, StopCondition, StreamChat, StreamChatOptions, StreamChatResult, StreamObject, StreamObjectResult, StreamPart, SubAgentCompletedEvent, SubAgentFailedEvent, SubAgentPart, SubAgentStartedEvent, SubAgentSuspendedEvent, TextDeltaPart, TextPart, TokenStore, Tool, ToolApprovalRequest, ToolApprovalRequestPart, ToolApprovalResponse, ToolCall, ToolCallDeltaPart, ToolCallGuardrail, ToolCallGuardrailContext, ToolCallGuardrailResult, ToolCallPart, ToolChoice, ToolCompletedEvent, ToolDeniedEvent, ToolExecuteContext, ToolFailedEvent, ToolResult, ToolResultGuardrail, ToolResultGuardrailContext, ToolResultGuardrailResult, ToolResultPart, ToolResultStreamPart, ToolRunState, ToolSet, ToolStartedEvent, ToolStatePart, ToolUsePart, Tracer, UIMessage, UIMessagePart, UIToolCall, Usage, UsageMeta, ValidateChatOptions, ValidateChatResult, VerifyPart, VerifyStep, VerifyStepContext, VerifyStepResult, WarningPart

## `@deuz-sdk/core/ui`

The Deuz UI wire: SSE responses, resumable streams, and the client-side reader.

**Values** (11): connectDeuzStream, createDeuzStream, createInMemoryStreamStateStore, DEUZ_STREAM_VERSION, DEUZ_STREAM_VERSIONS, negotiateDeuzStreamVersion, readDeuzStream, resumeDeuzStreamResponse, toDeuzObjectStreamResponse, toDeuzStreamResponse, toDeuzTextStreamResponse

**Types** (15): ConnectDeuzStreamOptions, CreateDeuzStreamOptions, DeuzStreamDoneRecord, DeuzStreamSource, DeuzStreamWriter, DeuzUIPart, DeuzWireVersion, InMemoryStreamStateStoreOptions, ReadDeuzStreamOptions, ResumeDeuzStreamOptions, StreamStateRecord, StreamStateStore, ToDeuzStreamOptions, ToDeuzTextStreamOptions, WriteDataOptions

## `@deuz-sdk/core/react`

Legacy in-core React hooks — prefer the @deuz-sdk/react package.

**Values** (3): createUseChat, useChat, useObject

**Types** (6): UIMessage, UIToolCall, UseChatOptions, UseChatResult, UseObjectOptions, UseObjectResult

## `@deuz-sdk/core/chat`

The pure chat state engine plus validateChatRequest — the gate in front of client history.

**Values** (16): applyUIPart, assistantMessageFromTurn, branchBeforeUserMessage, canonicalFromUI, clientToolResultMessage, createAssistantTurn, createInMemoryChatStore, deserializeChatRecord, dropTrailingAssistant, filesToImageParts, parseDeuzChatRequest, sealAssistantTurn, serializeChatRecord, uiFromMessages, userMessageFromInput, validateChatRequest

**Types** (13): AssistantTurnState, ChatHistory, ChatInput, ChatPersistOptions, ChatRecord, ChatStore, DeuzChatRequest, MemoryScope, UIMessage, UIMessagePart, UIToolCall, ValidateChatOptions, ValidateChatResult

## `@deuz-sdk/core/chat/node`

File-backed chat store (Node only).

**Values** (1): createJsonlChatStore

**Types** (1): JsonlChatStoreOptions

## `@deuz-sdk/react`

React hooks and components: useChat, useObject, approval card, cost badge.

**Values** (5): CostBadge, partsFromFiles, ToolApprovalCard, useChat, useObject

**Types** (20): AssistantTurnState, ChatHistory, ChatInput, CostBadgeProps, DeuzUIPart, Message, ToolApprovalCardProps, ToolApprovalRequest, ToolApprovalResponse, UIMessage, UIMessagePart, UIToolCall, UseChatBudgetExceeded, UseChatCost, UseChatCursorStore, UseChatOptions, UseChatResult, UseChatResumeOptions, UseObjectOptions, UseObjectResult

## Where a value lives (everything not exported from the root)

Reverse lookup for "which subpath do I import this from?". Root exports are omitted — try `@deuz-sdk/core` first.

- `_deserializeRecord` — `memory/markdown`
- `_serializeRecord` — `memory/markdown`
- `allTasksSettled` — `autonomy`
- `anthropic` — `anthropic`
- `applyEvents` — `memory`
- `applySearchReplace` — `evolve`
- `applyUIPart` — `chat`
- `approxCountTokens` — `rag`
- `assertEnvelopeRevision` — `ops`
- `assertLeaseRequest` — `ops`
- `assertScope` — `memory`
- `assistantMessageFromTurn` — `chat`
- `azure` — `azure`, `providers`
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
- `composeObservers` — `observe`
- `connectDeuzStream` — `ui`
- `cosineSimilarity` — `memory`, `rag`
- `CostBadge` — `@deuz-sdk/react`
- `createAdcKeyProvider` — `vertex/node`
- `createAgent` — `agent`
- `createAnthropic` — `anthropic`
- `createApprovalSigner` — `durable`
- `createAssistantTurn` — `chat`
- `createAzure` — `azure`, `providers`
- `createBedrock` — `bedrock`, `providers`
- `createBm25Index` — `rag`
- `createBrowserTools` — `browser`
- `createBudgetLedger` — `agent`
- `createCallbackObserver` — `observe`
- `createCerebras` — `providers`
- `createCohere` — `providers`
- `createCohereReranker` — `rag`
- `createDeepgram` — `transcription`
- `createDeepInfra` — `providers`
- `createDeepSeek` — `providers`
- `createDeuzStream` — `ui`
- `createElevenLabs` — `speech`
- `createEmbedder` — `memory`
- `createExecutionContext` — `agent`
- `createFileRunStore` — `runtime/node`
- `createFileTokenStore` — `mcp/node`
- `createFileWorkspace` — `workspace/node`
- `createFireworks` — `providers`
- `createGeminiCache` — `google/extras`
- `createGLM` — `providers`
- `createGoogle` — `google`
- `createGoogleEmbedding` — `google`
- `createGoogleNative` — `google`
- `createGroq` — `providers`
- `createHyperbolic` — `providers`
- `createImageProvider` — `image`
- `createInMemoryAgentRunStore` — `agent`
- `createInMemoryBudgetStore` — `agent`
- `createInMemoryChatStore` — `chat`
- `createInMemoryClaim` — `schedule`
- `createInMemoryLeaseProvider` — `ops`
- `createInMemoryMemoryStore` — `memory`
- `createInMemoryPopulationStore` — `evolve`
- `createInMemoryRunStore` — `runtime`
- `createInMemorySessionStore` — `durable`
- `createInMemoryStreamStateStore` — `ui`
- `createInMemorySwarmStore` — `swarm`
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
- `createMemoryObserver` — `observe`
- `createMemoryTools` — `memory`
- `createMemoryVectorStore` — `rag`
- `createMidjourney` — `midjourney`
- `createMiniMax` — `providers`
- `createMistral` — `providers`
- `createMockModel` — `testing`
- `createMoonshot` — `providers`
- `createNodeSandbox` — `compute/node`
- `createNvidia` — `providers`
- `createOAuthProvider` — `mcp`
- `createOllama` — `providers`
- `createOpenAI` — `openai`
- `createOpenAICompatible` — `providers`
- `createOpenAIEmbedding` — `openai`
- `createOpenAIResponses` — `openai`
- `createOpenAISpeech` — `speech`
- `createOpenAITranscription` — `transcription`
- `createOpenRouter` — `providers`
- `createOtelObserver` — `otel`
- `createOtelTracer` — `otel`
- `createParserRegistry` — `rag`
- `createPerplexity` — `providers`
- `createPlaywrightBrowser` — `browser/node`
- `createPostgresBudgetStore` — `ops/postgres`
- `createPostgresOpsStore` — `ops/postgres`
- `createPostgresStores` — `stores/postgres`
- `createPostgresSwarmStore` — `swarm/postgres`
- `createProviderRegistry` — `providers`
- `createQwen` — `providers`
- `createRedisStores` — `stores/redis`
- `createRounds` — `swarm`
- `createRunManager` — `runtime`
- `createSambaNova` — `providers`
- `createScheduler` — `schedule`
- `createServiceAccountKeyProvider` — `vertex`
- `createSkillRegistry` — `skills`
- `createSqliteBudgetStore` — `ops/sqlite`
- `createSqliteOpsStore` — `ops/sqlite`
- `createSqlitePopulationStore` — `evolve/sqlite`
- `createSqliteStores` — `stores/sqlite`
- `createSqliteSwarmStore` — `swarm/sqlite`
- `createStdioMcpClient` — `mcp/stdio`
- `createSteeringController` — `runtime`
- `createSwarm` — `swarm`
- `createTaskList` — `autonomy`
- `createTogether` — `providers`
- `createUseChat` — `react`
- `createVerifier` — `autonomy`
- `createVertexAnthropic` — `vertex`
- `createVertexGoogle` — `vertex`
- `createVertexGoogleNative` — `vertex`
- `createVideoProvider` — `video`
- `createVoyage` — `voyage`
- `createVoyageReranker` — `voyage`
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
- `DEFAULT_SEPARATORS` — `rag`
- `defaultHashFn` — `memory`
- `defaultMemoryScorer` — `memory`
- `defaultNodeParserRegistry` — `rag/node`
- `deleteGeminiCache` — `google/extras`
- `deserializeChatRecord` — `chat`
- `deserializeCheckpoint` — `durable`
- `detectToolDrift` — `mcp`
- `DEUZ_STREAM_VERSION` — `ui`
- `DEUZ_STREAM_VERSIONS` — `ui`
- `docxParser` — `rag/node`
- `downloadVideo` — `video`
- `dropTrailingAssistant` — `chat`
- `embeddingMatcher` — `skills`
- `emitActivity` — `runtime`
- `emitPlanUpdate` — `runtime`
- `estimatePdfTokens` — `rag`
- `estimateTokens` — `rag`
- `evolve` — `evolve`
- `evolveCandidateId` — `evolve`
- `EvolveConflictError` — `evolve`
- `EvolveLeaseError` — `evolve`
- `EvolvePatchError` — `evolve`
- `ExecutionPersistenceError` — `agent`
- `ExecutionPolicyError` — `agent`
- `extractFullRewrite` — `evolve`
- `extractLinks` — `memory`
- `fetchSkillSource` — `skills`
- `fetchTask` — `midjourney`
- `fetchVideoTask` — `video`
- `filesToImageParts` — `chat`
- `filterObserver` — `observe`
- `fingerprintTools` — `mcp`
- `fireworks` — `providers`
- `formatMemoriesForPrompt` — `memory`
- `generateImage` — `image`
- `generateSpeech` — `speech`
- `generateVideo` — `video`
- `getGeminiCache` — `google/extras`
- `glm` — `providers`
- `google` — `google`
- `googleEmbedding` — `google`
- `googleNative` — `google`
- `groq` — `providers`
- `handleSignal` — `schedule`
- `htmlToBlocks` — `rag/node`
- `hybridRetrieve` — `rag`
- `hyperbolic` — `providers`
- `identityReranker` — `rag`
- `imagine` — `midjourney`
- `indexChunks` — `rag`
- `inMemoryTokenStore` — `mcp`
- `intersectExecutionPolicies` — `agent`
- `isExpired` — `memory`
- `kimi` — `providers`
- `lexicalMatcher` — `skills`
- `listGeminiCaches` — `google/extras`
- `lmstudio` — `providers`
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
- `otelReady` — `otel`
- `parallelAgents` — `autonomy`
- `parse` — `rag`
- `parseCron` — `schedule`
- `parseCsv` — `rag`
- `parseDecision` — `memory`
- `parseDeuzChatRequest` — `chat`
- `parseEvolveBlocks` — `evolve`
- `parseFacts` — `memory`
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
- `qwen` — `providers`
- `RagError` — `rag`
- `readDeuzStream` — `ui`
- `readJsonlEvents` — `observe/node`
- `recall` — `memory`
- `reciprocalRankFusion` — `rag`
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
- `resumeStreamAgent` — `agent`
- `resumeStreamFromCheckpoint` — `durable`
- `retrieve` — `rag`
- `runAgent` — `agent`
- `runEval` — `testing`
- `runGradedEval` — `testing`
- `sambanova` — `providers`
- `scopeToolsToSkill` — `skills`
- `sealAssistantTurn` — `chat`
- `selfConsistency` — `autonomy`
- `serializeChatRecord` — `chat`
- `serializeCheckpoint` — `durable`
- `serializeTaskList` — `autonomy`
- `setTaskStatus` — `autonomy`
- `shellTool` — `compute`
- `shouldSendWhole` — `rag`
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
- `toDeuzObjectStreamResponse` — `ui`
- `toDeuzStreamResponse` — `ui`
- `toDeuzTextStreamResponse` — `ui`
- `together` — `providers`
- `tokenize` — `rag`
- `toNativeDocumentPart` — `rag`
- `ToolApprovalCard` — `@deuz-sdk/react`
- `transcribe` — `transcription`
- `uiFromMessages` — `chat`
- `updateTask` — `autonomy`
- `uploadFile` — `google/extras`
- `useChat` — `react`, `@deuz-sdk/react`
- `useObject` — `react`, `@deuz-sdk/react`
- `userMessageFromInput` — `chat`
- `validateChatRequest` — `chat`
- `validateSkillDescription` — `skills`
- `validateSkillName` — `skills`
- `verifyGitHubWebhook` — `schedule`
- `verifyHmacSignature` — `schedule`
- `verifySlackRequest` — `schedule`
- `voyage` — `voyage`
- `VOYAGE_RERANK_DEFAULT_MODEL` — `voyage`
- `waitForFileActive` — `google/extras`
- `waitForTask` — `midjourney`
- `waitForVideo` — `video`
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
