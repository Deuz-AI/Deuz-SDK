/**
 * The legacy checkpoint's version gate (2.3). Every build since 1.5 writes
 * `AgentCheckpoint.version` 1; a checkpoint with another version was written by
 * a newer Deuz SDK, or is not a checkpoint at all, and resuming it would replay
 * a history whose meaning this build cannot know. Its own module, free of the
 * loops, so every reader of a stored checkpoint can check it. Edge-safe.
 */
import { DeuzError } from '../errors';

/** A stored checkpoint in a format this build does not read (2.3). */
export class CheckpointVersionError extends DeuzError {
  readonly code = 'checkpoint_version_unsupported';
  /** Never a tool error the model could retry: a sub-agent's resume fails the run. */
  readonly fatalExecution = true;
  /** The version the checkpoint carries. */
  readonly version: unknown;
  readonly runId?: string;
  constructor(version: unknown, runId?: string) {
    super(
      `${runId === undefined ? 'Checkpoint' : `Checkpoint for runId '${runId}'`} has version ${
        typeof version === 'string' ? JSON.stringify(version) : String(version)
      }; this build reads version 1. A newer Deuz SDK probably wrote it: resume it with that version.`,
    );
    this.version = version;
    if (runId !== undefined) this.runId = runId;
  }
}

/**
 * @internal Throws `CheckpointVersionError` unless `checkpoint` is a version
 * this build reads. A checkpoint without a version is read as version 1: no
 * build wrote one, so it was built by hand, never by a newer SDK.
 */
export function assertCheckpointVersion(checkpoint: unknown, runId?: string): void {
  if (checkpoint === null || typeof checkpoint !== 'object') return;
  const { version, runId: own } = checkpoint as { version?: unknown; runId?: unknown };
  if (version !== undefined && version !== 1)
    throw new CheckpointVersionError(version, runId ?? (typeof own === 'string' ? own : undefined));
}
