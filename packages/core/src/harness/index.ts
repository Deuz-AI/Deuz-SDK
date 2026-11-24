/**
 * `@deuz-sdk/core/harness` (2.5) — run an external coding harness (Claude
 * Code, Codex CLI, Gemini CLI, OpenCode) as a budgeted Deuz sub-agent. The
 * harness is driven over ACP; its permission requests are decided by a Deuz
 * policy, callback or the parent run's approver; its model traffic goes
 * through a deuz meter, so it is charged to a persistent budget and refused at
 * the ceiling; and the cost it declares about itself is recorded next to what
 * the meter measured.
 *
 * This subpath is edge-safe: presets, the permission policy and `runAcpHarness`
 * over any ACP connection. `runHarness` and `harnessTool`, which spawn the
 * harness and a meter on a loopback port, are in `@deuz-sdk/core/harness/node`.
 *
 * The honest limit: a harness runs its own tools and sends a permission
 * request only when it chooses to. Results count the tool calls that went
 * through a Deuz decision apart from those Deuz only observed.
 */
export { runAcpHarness, compareHarnessCost, createHarnessReceiptCollector } from './run';
export { evaluateHarnessPolicy, matchHarnessPath, normalizeHarnessPath } from './policy';
export {
  CLAUDE_CODE_PROVIDER_SWITCHES,
  HARNESS_PRESETS,
  claudeCodeHarness,
  codexHarness,
  defaultHarnessEnv,
  geminiCliHarness,
  opencodeHarness,
} from './presets';
export type { HarnessPresetName } from './presets';
export type * from './types';
