/**
 * The fault-injection scenarios of 2.3 (roadmap 23.7): one or more per
 * boundary, in dispatch order, then the boundaries of native memory, chat and
 * model fail-over (23.4) and of the UI bridge (23.5).
 */
import type { EvalTaskManifest } from '../../../src/testing';
import { compactionPreservedThinking } from './compaction-boundaries';
import { fallbackBudgetSettlement, providerFallback } from './fallback-boundaries';
import {
  mcpRefreshListFailure,
  mcpRefreshRecordFailure,
  mcpRefreshRecordFailureAccepted,
} from './mcp-boundaries';
import { memoryScopeSharedContext, memoryScopeWidened } from './memory-boundaries';
import {
  childInitialization,
  maxTokensMidToolCall,
  midStream,
  midStreamRetried,
  refusalMidToolCall,
  verifierAbort,
  verifierDeadline,
} from './model-boundaries';
import {
  admissionStoreFailure,
  admissionStoreFailureRetried,
  leaseLoss,
  leaseRenewFailure,
  settleFailure,
  spawnCommitFailure,
  swarmCancelCommit,
} from './ops-boundaries';
import {
  afterApproval,
  afterEffect,
  afterEffectIdempotent,
  afterEffectReconciled,
  afterReceipt,
  beforeDispatch,
} from './tool-boundaries';
import { uiDisconnectReplay } from './ui-boundaries';

export const faultScenarios: readonly EvalTaskManifest[] = [
  beforeDispatch,
  afterApproval,
  afterEffect,
  afterEffectIdempotent,
  afterEffectReconciled,
  afterReceipt,
  midStream,
  midStreamRetried,
  verifierAbort,
  verifierDeadline,
  childInitialization,
  swarmCancelCommit,
  leaseLoss,
  leaseRenewFailure,
  admissionStoreFailure,
  admissionStoreFailureRetried,
  settleFailure,
  spawnCommitFailure,
  mcpRefreshListFailure,
  mcpRefreshRecordFailure,
  mcpRefreshRecordFailureAccepted,
  refusalMidToolCall,
  maxTokensMidToolCall,
  memoryScopeWidened,
  memoryScopeSharedContext,
  providerFallback,
  fallbackBudgetSettlement,
  compactionPreservedThinking,
  uiDisconnectReplay,
];
