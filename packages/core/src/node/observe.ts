/**
 * `./observe/node` — Node-only JSONL observer (1.6). One event per line, every
 * line valid JSON, binary-safe via the durable `$deuzBytes` codec convention.
 * `emit()` stays synchronous: writes flow through an internal bounded queue
 * (overflow drops + counts — a slow disk can never affect the run), Node
 * built-ins load lazily (`await import('node:fs/promises')`) so this file
 * passes verify-package's plain import/require of every dist target.
 */
import type { ObserveEvent, ObservationOptions, Observer } from '../types/observe';

export interface JsonlObserver extends Observer {
  /** Events dropped by the queue cap or after close(). */
  readonly droppedCount: number;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateJsonlObserverOptions {
  file: string;
  /** false truncates the file on first write. Default true (append). */
  append?: boolean;
  /** Queue length that triggers a write. Default 1 (every event). */
  flushEvery?: number;
  /** Max buffered lines before events drop. Default 10_000. */
  maxQueueSize?: number;
  observation?: ObservationOptions;
  /** Write failures land here (else they are swallowed). Never affects the run. */
  onWriteError?: (error: unknown) => void;
}

const BYTES_TAG = '$deuzBytes';

// Minimal node builtin shapes; `as string` keeps tsup's dts builder from
// statically resolving node: specifiers (matches rag-node.ts / skills/node.ts).
interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  appendFile(path: string, data: string, encoding: string): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
}
interface NodePath {
  dirname(p: string): string;
}

async function loadFs(): Promise<NodeFs> {
  return (await import('node:fs/promises' as string)) as unknown as NodeFs;
}
async function loadPath(): Promise<NodePath> {
  return (await import('node:path' as string)) as unknown as NodePath;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Minimal identity envelope used when a payload cannot be serialized whole. */
function fallbackLine(event: ObserveEvent, note: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: event.type,
    eventId: event.eventId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    runId: event.runId,
    executionId: event.executionId,
    spanId: event.spanId,
    truncated: true,
    note,
  });
}

/** Serialize one event to a single JSON line — never throws. */
function toJsonLine(event: ObserveEvent, maxEventBytes: number): string {
  let line: string;
  try {
    const seen = new WeakSet<object>();
    line = JSON.stringify(event, function (this: unknown, key: string, value: unknown) {
      // Pre-toJSON holder read: Node Buffer's own toJSON runs before replacers.
      const raw = (this as Record<string, unknown>)[key];
      if (raw instanceof Uint8Array) return { [BYTES_TAG]: bytesToBase64(raw) };
      if (typeof value === 'bigint') return '[Unserializable]';
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Unserializable]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return fallbackLine(event, '[Unserializable]');
  }
  if (line.length > maxEventBytes) {
    // char length is a lower bound on UTF-8 bytes — cheap first check
    return fallbackLine(event, '[Truncated]');
  }
  return line;
}

export function createJsonlObserver(options: CreateJsonlObserverOptions): JsonlObserver {
  const append = options.append !== false;
  const flushEvery = Math.max(1, options.flushEvery ?? 1);
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? 10_000);
  const maxEventBytes = options.observation?.limits?.maxEventBytes ?? 65536;

  let queue: string[] = [];
  let dropped = 0;
  let pendingSinceWrite = 0;
  let initialized = false;
  let closed = false;
  // Single writer chain: appends stay ordered without awaiting in emit().
  let writing: Promise<void> = Promise.resolve();

  const drain = (): Promise<void> => {
    if (queue.length === 0) return writing;
    const lines = queue;
    queue = [];
    writing = writing.then(async () => {
      try {
        const fs = await loadFs();
        if (!initialized) {
          initialized = true;
          const path = await loadPath();
          const dir = path.dirname(options.file);
          if (dir && dir !== '.') await fs.mkdir(dir, { recursive: true });
          if (!append) await fs.writeFile(options.file, '');
        }
        await fs.appendFile(options.file, lines.map((l) => l + '\n').join(''), 'utf8');
      } catch (err) {
        // A failing sink never affects the run.
        try {
          options.onWriteError?.(err);
        } catch {
          // even the error handler must not propagate
        }
      }
    });
    return writing;
  };

  return {
    options: options.observation,
    get droppedCount() {
      return dropped;
    },
    emit(event) {
      if (closed || queue.length >= maxQueueSize) {
        dropped += 1;
        return;
      }
      queue.push(toJsonLine(event, maxEventBytes));
      pendingSinceWrite += 1;
      if (pendingSinceWrite >= flushEvery) {
        pendingSinceWrite = 0;
        void drain();
      }
    },
    async flush() {
      await drain();
    },
    async close() {
      closed = true;
      await drain();
    },
  };
}

/** Read a JSONL file back into events (restores `$deuzBytes` values). */
export async function readJsonlEvents(file: string): Promise<ObserveEvent[]> {
  const fs = await loadFs();
  const text = await fs.readFile(file, 'utf8');
  const events: ObserveEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    events.push(
      JSON.parse(line, (_key, value: unknown) => {
        if (
          typeof value === 'object' &&
          value !== null &&
          Object.keys(value).length === 1 &&
          typeof (value as Record<string, unknown>)[BYTES_TAG] === 'string'
        ) {
          try {
            return base64ToBytes((value as Record<string, string>)[BYTES_TAG]!);
          } catch {
            return value;
          }
        }
        return value;
      }) as ObserveEvent,
    );
  }
  return events;
}
