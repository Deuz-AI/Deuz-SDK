/**
 * The offline eval tasks of 2.3 (roadmap 23.7, part 1), in suite order. Part 2
 * (memory scope, compaction, provider fallback, UI replay) lands with the
 * native memory/chat/fallback and UI bridge work.
 */
import type { EvalTaskManifest } from '../../../src/testing';
import { deployApproved, deployDenied } from './approval';
import { clientTool, runawayLoop, verifierRetry } from './control';
import { mcpHotRefresh } from './mcp';
import { childApproval, delegatedResearch } from './nested';
import { sourcedAnswer } from './research';
import { interruptedRun } from './resume';
import { invoiceExtraction, invoiceRepair } from './structured-output';
import { chainedLookup, weatherReport } from './tool-loop';
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
];
