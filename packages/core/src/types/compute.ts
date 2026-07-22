/**
 * Compute / CodeAct (1.8 additive) — the seam an autonomous agent uses to take
 * ACTION as executable code instead of rigid tool schemas (Manus's "CodeAct":
 * the model writes Python/JS/shell, a sandbox runs it, the agent reads the
 * output and self-corrects). The seam is storage/host-agnostic:
 * `@deuz-sdk/core/compute/node` ships a `node:child_process` reference sandbox,
 * and a real isolation backend (Docker, E2B, Daytona, Fly Machines, a remote
 * runner) implements the same two methods.
 *
 * SECURITY: a `ComputeSandbox` runs untrusted, model-authored code. The seam
 * says nothing about isolation — that is the backend's job. Never point a
 * `codeActTool` at a sandbox that shares the host's filesystem, secrets, or
 * network in production; see the compute docs for the adapter contract.
 */

/** One file produced by an execution (backend-dependent; may be empty). */
export interface ComputeArtifact {
  /** Path of the artifact relative to the run's working directory. */
  path: string;
  /** Raw bytes, when the backend can return them inline. */
  bytes?: Uint8Array;
  /** Detected MIME type, when known. */
  mime?: string;
}

/** A request to run a snippet of code in the sandbox. */
export interface CodeExecutionRequest {
  /** Language id — e.g. `'python'`, `'javascript'`, `'bash'`. Backend-defined set. */
  language: string;
  /** Source to execute. */
  code: string;
  /** Wall-clock timeout; the backend kills the process past it (`timedOut: true`). */
  timeoutMs?: number;
  /** Cancellation — the backend must kill the process when it fires. */
  signal?: AbortSignal;
  /** Optional stdin piped to the process. */
  stdin?: string;
  /** Extra environment variables (backends that support it). */
  env?: Record<string, string>;
}

/** The outcome of an execution. Shared by `runCode` and `runShell`. */
export interface CodeExecutionResult {
  /** Captured standard output (may be truncated by the tool wrapper). */
  stdout: string;
  /** Captured standard error, kept SEPARATE from stdout. */
  stderr: string;
  /** Process exit code; `null` when killed by a signal / timeout. */
  exitCode: number | null;
  /** True when the run was killed by the timeout or a caller abort. */
  timedOut?: boolean;
  /** Files the run produced, when the backend surfaces them. */
  artifacts?: ComputeArtifact[];
  /** Wall-clock duration in ms, when the backend measures it. */
  durationMs?: number;
}

/** A request to run a shell command in the sandbox. */
export interface ShellExecutionRequest {
  /** The command line to run (interpreted by the backend's shell). */
  command: string;
  /** Working directory, relative to the sandbox root. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/** Same shape as a code execution outcome. */
export type ShellExecutionResult = CodeExecutionResult;

/**
 * The compute seam. `runCode` is mandatory (CodeAct's core); `runShell` is
 * optional (a code-only backend can omit it — `shellTool` then reports the
 * limitation to the model as a self-healing error).
 */
export interface ComputeSandbox {
  runCode(request: CodeExecutionRequest): Promise<CodeExecutionResult>;
  runShell?(request: ShellExecutionRequest): Promise<ShellExecutionResult>;
}
