/**
 * The fault-injection scenarios of 2.3 (roadmap 23.7, part 1): one or more per
 * boundary, in dispatch order. Part 2 adds the boundaries that depend on native
 * memory/chat/fallback and the UI bridge (compaction, UI replay, chat
 * projection or memory write, fallback attempt and its settlement).
 */
import type { EvalTaskManifest } from '../../../src/testing';
import { mcpRefreshListFailure, mcpRefreshRecordFailure } from './mcp-boundaries';
import {
  childInitialization,
  maxTokensMidToolCall,
  midStream,
  refusalMidToolCall,
  verifierAbort,
  verifierDeadline,
} from './model-boundaries';
import {
  admissionStoreFailure,
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
  afterReceipt,
  beforeDispatch,
} from './tool-boundaries';

export const faultScenarios: readonly EvalTaskManifest[] = [
  beforeDispatch,
  afterApproval,
  afterEffect,
  afterEffectIdempotent,
  afterReceipt,
  midStream,
  verifierAbort,
  verifierDeadline,
  childInitialization,
  swarmCancelCommit,
  leaseLoss,
  leaseRenewFailure,
  admissionStoreFailure,
  settleFailure,
  spawnCommitFailure,
  mcpRefreshListFailure,
  mcpRefreshRecordFailure,
  refusalMidToolCall,
  maxTokensMidToolCall,
];
