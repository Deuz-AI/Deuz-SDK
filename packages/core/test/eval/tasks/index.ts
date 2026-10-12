/**
 * The offline eval tasks of 2.3 (roadmap 23.7), in suite order: part 1, then
 * the tasks over the features 2.3 added (native memory and chat, model
 * fail-over, the UI bridge, goals, batches and the MCP server).
 */
import type { EvalTaskManifest } from '../../../src/testing';
import { deployApproved, deployDenied } from './approval';
import { batchTriage } from './batch';
import { clientTool, runawayLoop, verifierRetry } from './control';
import { primaryDown } from './fallback';
import { scheduledDigest } from './goal';
import { mcpHotRefresh } from './mcp';
import { servedOrderLookup } from './mcp-server';
import { rememberedSeat } from './memory-chat';
import { childApproval, delegatedResearch } from './nested';
import { sourcedAnswer } from './research';
import { interruptedRun } from './resume';
import { invoiceExtraction, invoiceRepair } from './structured-output';
import { chainedLookup, weatherReport } from './tool-loop';
import { uiApprovalRoundTrip } from './ui';
import { configMigration, offByOne } from './workspace';

export const offlineTasks: readonly EvalTaskManifest[] = [
  weatherReport,
  chainedLookup,
  invoiceExtraction,
  invoiceRepair,
  offByOne,
  configMigration,
  sourcedAnswer,
  deployApproved,
  deployDenied,
  delegatedResearch,
  childApproval,
  interruptedRun,
  mcpHotRefresh,
  clientTool,
  verifierRetry,
  runawayLoop,
  rememberedSeat,
  primaryDown,
  uiApprovalRoundTrip,
  scheduledDigest,
  batchTriage,
  servedOrderLookup,
];
