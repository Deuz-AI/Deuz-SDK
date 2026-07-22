/**
 * `@deuz-sdk/core/compute` (1.8) — the edge-safe CodeAct layer: wrap a
 * `ComputeSandbox` seam as tools the model calls by WRITING CODE, plus a
 * recommended CodeAct system prompt. This module is pure (no node builtins);
 * the actual process isolation lives behind the seam (`@deuz-sdk/core/compute/node`
 * is the reference, Docker/E2B/etc. are drop-in adapters).
 *
 * SECURITY: `codeActTool`/`shellTool` execute untrusted model-authored code
 * through the sandbox you pass. Approval (`needsApproval`) gates WHETHER a call
 * runs; it is NOT isolation. Point these at a real sandbox in production — never
 * a host that shares your filesystem, secrets, or network.
 */
import type { JSONSchema } from './types/schema';
import type { Tool, ToolSet } from './types/tool';
import type { ComputeSandbox, CodeExecutionResult, ShellExecutionResult } from './types/compute';

export type {
  ComputeSandbox,
  ComputeArtifact,
  CodeExecutionRequest,
  CodeExecutionResult,
  ShellExecutionRequest,
  ShellExecutionResult,
} from './types/compute';

/** Truncate text to a char budget with a visible marker (keeps the tail out). */
function capText(text: string, max: number | undefined): string {
  if (max === undefined || text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** Project a raw execution result into the model-facing shape (bytes stripped). */
function toToolResult(result: CodeExecutionResult, maxOutputChars: number | undefined): unknown {
  return {
    stdout: capText(result.stdout, maxOutputChars),
    stderr: capText(result.stderr, maxOutputChars),
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    // Only artifact METADATA goes to the model — never raw bytes in context.
    ...(result.artifacts && result.artifacts.length > 0
      ? {
          artifacts: result.artifacts.map((a) => ({
            path: a.path,
            ...(a.mime ? { mime: a.mime } : {}),
          })),
        }
      : {}),
  };
}

export interface CodeActToolOptions {
  /** Tool key/name the model calls. Default `'runCode'`. */
  name?: string;
  /** Restrict the languages offered to the model (JSON-Schema enum). */
  languages?: string[];
  /** Per-call wall-clock timeout passed to the sandbox. */
  timeoutMs?: number;
  /** Cap stdout/stderr length fed back to the model. Default 10_000 chars each. */
  maxOutputChars?: number;
  /** Route every execution through `approveToolCall` (HITL). Default false. */
  needsApproval?: boolean;
  /** Override the tool description. */
  description?: string;
}

const DEFAULT_MAX_OUTPUT = 10_000;

/**
 * Turn a `ComputeSandbox` into a CodeAct tool: the model supplies `{ language,
 * code }`, the sandbox runs it, and the tool returns `{ stdout, stderr,
 * exitCode }`. A thrown sandbox becomes a self-healing is_error result (the
 * loop feeds it back so the model can switch strategy — Python fails, try
 * shell), exactly the Manus self-correction loop.
 */
export function codeActTool(sandbox: ComputeSandbox, options: CodeActToolOptions = {}): ToolSet {
  const name = options.name ?? 'runCode';
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const languageSchema: JSONSchema = {
    type: 'string',
    description: 'Programming language to execute the code as.',
    ...(options.languages ? { enum: options.languages } : {}),
  };
  const parameters: JSONSchema = {
    type: 'object',
    properties: {
      language: languageSchema,
      code: { type: 'string', description: 'Source code to execute in the sandbox.' },
    },
    required: ['language', 'code'],
    additionalProperties: false,
  };
  const tool: Tool = {
    description:
      options.description ??
      'Execute code in a sandbox and observe stdout/stderr. Prefer writing code to accomplish tasks; read the output and correct yourself if it fails.',
    parameters,
    ...(options.needsApproval ? { needsApproval: true } : {}),
    execute: async (args, ctx) => {
      const { language, code } = args as { language: string; code: string };
      const result = await sandbox.runCode({
        language,
        code,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return toToolResult(result, maxOutput);
    },
  };
  return { [name]: tool };
}

export interface ShellToolOptions {
  /** Tool key/name the model calls. Default `'runShell'`. */
  name?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Route every command through `approveToolCall` (HITL). Default false. */
  needsApproval?: boolean;
  description?: string;
}

/**
 * Turn a `ComputeSandbox` with `runShell` into a shell tool: the model supplies
 * `{ command, cwd? }`. If the sandbox has no `runShell`, the tool reports that
 * to the model as a self-healing error rather than throwing out of the loop.
 */
export function shellTool(sandbox: ComputeSandbox, options: ShellToolOptions = {}): ToolSet {
  const name = options.name ?? 'runShell';
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const parameters: JSONSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command line to run.' },
      cwd: { type: 'string', description: 'Working directory (relative to the sandbox root).' },
    },
    required: ['command'],
    additionalProperties: false,
  };
  const tool: Tool = {
    description:
      options.description ?? 'Run a shell command in the sandbox and observe stdout/stderr.',
    parameters,
    ...(options.needsApproval ? { needsApproval: true } : {}),
    execute: async (args, ctx) => {
      if (!sandbox.runShell) {
        throw new Error('This compute sandbox does not support shell execution (runShell).');
      }
      const { command, cwd } = args as { command: string; cwd?: string };
      const result: ShellExecutionResult = await sandbox.runShell({
        command,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return toToolResult(result, maxOutput);
    },
  };
  return { [name]: tool };
}

/**
 * A recommended CodeAct system-prompt block. Steers the model to act by writing
 * code (not describing what it would do), inspect the real output, and
 * self-correct — the discipline that makes an autonomous loop reliable.
 */
export function codeActSystemPrompt(): string {
  return [
    'You act by writing and running code, not by describing steps.',
    'When a task needs computation, data access, file work, or verification, WRITE code and run it with the available execution tool, then read the real stdout/stderr before continuing.',
    'If a run fails, read the error, fix the code or switch approach (e.g. from a script to direct shell commands), and try again — never present a plan as if it were a result.',
    'Keep each snippet small and check its output before building on it.',
  ].join(' ');
}
