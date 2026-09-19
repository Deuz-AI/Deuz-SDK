/** Fatal execution infrastructure failures must never become model-retryable tool errors. */
export class ExecutionPersistenceError extends Error {
  readonly code = 'execution_persistence_error';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ExecutionPersistenceError';
  }
}

export function isFatalExecutionError(error: unknown): boolean {
  return (
    error instanceof ExecutionPersistenceError ||
    (error instanceof Error && 'fatalExecution' in error && error.fatalExecution === true)
  );
}
