/**
 * The fault-injection scenarios of 2.3 (roadmap 23.7, part 1): one or more per
 * boundary, in dispatch order. Part 2 adds the boundaries that depend on native
 * memory/chat/fallback and the UI bridge (compaction, UI replay, chat
 * projection or memory write, fallback attempt and its settlement).
 */
import type { EvalTaskManifest } from '../../../src/testing';
import {
  mcpRefreshListFailure,
  mcpRefreshRecordFailure,
  mcpRefreshRecordFailureAccepted,
} from './mcp-boundaries';
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
];
