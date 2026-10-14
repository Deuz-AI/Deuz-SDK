/**
 * The Docker runner's error (2.4). `code` says what failed; a daemon that
 * cannot be reached is `docker_unavailable`, never a success or a "not
 * found", so a cancel or a cleanup is never taken as done while the daemon is
 * down.
 */
import { DeuzError, type DeuzErrorJSON } from '../../errors';

export type DockerErrorCode =
  /** The CLI could not run, the daemon did not answer, or a command timed out. */
  | 'docker_unavailable'
  /** The CLI ran and failed for another reason (its stderr is in the message). */
  | 'docker_failed'
  /** The image is not present locally; it is never pulled. */
  | 'image_not_found'
  /** The container or file asked for does not exist. */
  | 'not_found'
  /** The staging archive would exceed `maxStagingBytes`. */
  | 'staging_too_large'
  /** The artifact exceeds `maxArtifactBytes`. */
  | 'artifact_too_large'
  /** Not a regular file under the workspace: a link, a directory, a device, or a path that leaves it. */
  | 'artifact_rejected'
  /** Artifacts are read only from a stopped container. */
  | 'process_running'
  /** No operation is recorded under that scope and id. */
  | 'operation_not_found';

export class DockerSandboxError extends DeuzError {
  readonly code: DockerErrorCode;
  /** The docker subcommand that failed, e.g. `create`. */
  readonly command?: string;
  /** The CLI's exit code, when it exited. */
  readonly exitCode?: number;

  constructor(
    code: DockerErrorCode,
    message: string,
    options: { command?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    if (options.command !== undefined) this.command = options.command;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
  }

  override toJSON(): DeuzErrorJSON {
    const json = super.toJSON();
    const details: Record<string, string | number | boolean> = { ...json.details };
    if (this.command !== undefined) details.command = this.command;
    if (this.exitCode !== undefined) details.exitCode = this.exitCode;
    return Object.keys(details).length > 0 ? { ...json, details } : json;
  }
}
