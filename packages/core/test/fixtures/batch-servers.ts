/**
 * In-memory stand-ins for the three provider batch APIs (BA2), routed through
 * an injected `fetch`. Their shapes follow the providers' SDK types (openai
 * 7.32 `Batch` / `FileObject`, @anthropic-ai/sdk 0.133 `MessageBatch` and
 * results lines, @google/genai 2.28's REST converters); they let the batch
 * module be driven end to end offline. Nothing here is the real service.
 */

type Json = Record<string, unknown>;

export interface RecordedCall {
  method: string;
  url: string;
  headers: Headers;
  body?: unknown;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const urlOf = (input: string | URL | Request): URL =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

const jsonl = (lines: unknown[]): string =>
  lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

// ---------------------------------------------------------------------------
// OpenAI: Files + Batches
// ---------------------------------------------------------------------------

/** How one OpenAI batch request ends: a reply body, an HTTP error, or a line-level error. */
export type OpenAILine =
  | { body: unknown }
  | { status: number; body: unknown }
  | { error: { code: string; message: string } };

export function fakeOpenAIBatches(base = 'https://api.openai.com/v1') {
  const files = new Map<string, { purpose: string; name: string; content: string }>();
  const batches = new Map<string, Json>();
  const calls: RecordedCall[] = [];
  let ids = 0;
  const prefix = new URL(base).pathname.replace(/\/$/, '');

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = urlOf(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.href, headers: new Headers(init.headers), body: init.body });
    const route = url.pathname.slice(prefix.length);
    if (method === 'POST' && route === '/files') {
      const form = init.body as FormData;
      const file = form.get('file') as File;
      const id = `file-${++ids}`;
      files.set(id, {
        purpose: String(form.get('purpose')),
        name: file.name,
        content: await file.text(),
      });
      return json({ id, object: 'file', purpose: 'batch', status: 'processed', bytes: file.size });
    }
    if (method === 'POST' && route === '/batches') {
      const body = JSON.parse(init.body as string) as Json;
      const input = files.get(body.input_file_id as string);
      if (!input) return json({ error: { message: 'No such file' } }, 400);
      const id = `batch_${++ids}`;
      const total = input.content.trim().split('\n').length;
      const batch: Json = {
        id,
        object: 'batch',
        endpoint: body.endpoint,
        input_file_id: body.input_file_id,
        completion_window: body.completion_window,
        status: 'validating',
        created_at: 1_700_000_000,
        expires_at: 1_700_086_400,
        request_counts: { total, completed: 0, failed: 0 },
        ...(body.metadata ? { metadata: body.metadata } : {}),
      };
      batches.set(id, batch);
      return json(batch);
    }
    let match = /^\/batches\/([^/]+)$/.exec(route);
    if (method === 'GET' && match) {
      const batch = batches.get(decodeURIComponent(match[1]!));
      return batch ? json(batch) : json({ error: { message: 'No such batch' } }, 404);
    }
    match = /^\/batches\/([^/]+)\/cancel$/.exec(route);
    if (method === 'POST' && match) {
      const batch = batches.get(decodeURIComponent(match[1]!));
      if (!batch) return json({ error: { message: 'No such batch' } }, 404);
      batch.status = 'cancelling';
      batch.cancelling_at = 1_700_000_100;
      return json(batch);
    }
    match = /^\/files\/([^/]+)\/content$/.exec(route);
    if (method === 'GET' && match) {
      const file = files.get(decodeURIComponent(match[1]!));
      return file ? new Response(file.content) : json({ error: { message: 'No such file' } }, 404);
    }
    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 500);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    files,
    batches,
    /** The parsed lines of a batch's uploaded input file. */
    inputLines(batchId: string): Json[] {
      const batch = batches.get(batchId)!;
      return files
        .get(batch.input_file_id as string)!
        .content.trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Json);
    },
    setStatus(batchId: string, status: string): void {
      batches.get(batchId)!.status = status;
    },
    /** End a batch: write its output and error files the way the Batch API does. */
    finish(batchId: string, status: string, lines: Record<string, OpenAILine>): void {
      const batch = batches.get(batchId)!;
      const output: unknown[] = [];
      const errors: unknown[] = [];
      let n = 0;
      for (const [customId, line] of Object.entries(lines)) {
        const id = `batch_req_${++n}`;
        if ('error' in line)
          errors.push({ id, custom_id: customId, response: null, error: line.error });
        else {
          const statusCode = 'status' in line ? line.status : 200;
          const record = {
            id,
            custom_id: customId,
            response: { status_code: statusCode, request_id: `req_${n}`, body: line.body },
            error: null,
          };
          (statusCode === 200 ? output : errors).push(record);
        }
      }
      if (output.length) {
        files.set(`file-out-${batchId}`, {
          purpose: 'batch_output',
          name: 'out.jsonl',
          content: jsonl(output),
        });
        batch.output_file_id = `file-out-${batchId}`;
      }
      if (errors.length) {
        files.set(`file-err-${batchId}`, {
          purpose: 'batch_output',
          name: 'err.jsonl',
          content: jsonl(errors),
        });
        batch.error_file_id = `file-err-${batchId}`;
      }
      batch.status = status;
      const counts = batch.request_counts as Json;
      counts.completed = output.length;
      counts.failed = errors.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic: Message Batches
// ---------------------------------------------------------------------------

export type AnthropicResult =
  | { type: 'succeeded'; message: unknown }
  | { type: 'errored'; error: unknown }
  | { type: 'canceled' }
  | { type: 'expired' };

export function fakeAnthropicBatches(base = 'https://api.anthropic.com') {
  const batches = new Map<string, { batch: Json; requests: Json[]; results?: string }>();
  const calls: RecordedCall[] = [];
  let ids = 0;
  const prefix = new URL(base).pathname.replace(/\/$/, '');

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = urlOf(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.href, headers: new Headers(init.headers), body: init.body });
    const route = url.pathname.slice(prefix.length);
    if (method === 'POST' && route === '/v1/messages/batches') {
      const body = JSON.parse(init.body as string) as { requests: Json[] };
      const id = `msgbatch_${++ids}`;
      const batch: Json = {
        id,
        type: 'message_batch',
        processing_status: 'in_progress',
        request_counts: {
          processing: body.requests.length,
          succeeded: 0,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
        created_at: '2026-10-10T00:00:00Z',
        expires_at: '2026-10-11T00:00:00Z',
        ended_at: null,
        cancel_initiated_at: null,
        archived_at: null,
        results_url: null,
      };
      batches.set(id, { batch, requests: body.requests });
      return json(batch);
    }
    let match = /^\/v1\/messages\/batches\/([^/]+)$/.exec(route);
    if (method === 'GET' && match) {
      const entry = batches.get(decodeURIComponent(match[1]!));
      return entry
        ? json(entry.batch)
        : json({ type: 'error', error: { type: 'not_found_error', message: 'x' } }, 404);
    }
    match = /^\/v1\/messages\/batches\/([^/]+)\/cancel$/.exec(route);
    if (method === 'POST' && match) {
      const entry = batches.get(decodeURIComponent(match[1]!))!;
      entry.batch.processing_status = 'canceling';
      entry.batch.cancel_initiated_at = '2026-10-10T01:00:00Z';
      return json(entry.batch);
    }
    match = /^\/v1\/messages\/batches\/([^/]+)\/results$/.exec(route);
    if (method === 'GET' && match) {
      const entry = batches.get(decodeURIComponent(match[1]!));
      return entry?.results !== undefined
        ? new Response(entry.results)
        : json({ type: 'error', error: { type: 'not_found_error', message: 'x' } }, 404);
    }
    return json(
      { type: 'error', error: { type: 'api_error', message: `unexpected ${method} ${route}` } },
      500,
    );
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    batches,
    /** End a batch with one result per custom_id (any order). */
    finish(
      batchId: string,
      results: Record<string, AnthropicResult>,
      options: { resultsUrl?: string } = {},
    ): void {
      const entry = batches.get(batchId)!;
      const counts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
      for (const result of Object.values(results)) counts[result.type]++;
      entry.results = jsonl(
        Object.entries(results).map(([custom_id, result]) => ({ custom_id, result })),
      );
      Object.assign(entry.batch, {
        processing_status: 'ended',
        request_counts: counts,
        ended_at: '2026-10-10T02:00:00Z',
        results_url: options.resultsUrl ?? `${base}/v1/messages/batches/${batchId}/results`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini: batchGenerateContent (Developer API)
// ---------------------------------------------------------------------------

export function fakeGeminiBatches() {
  const batches = new Map<string, { operation: Json; requests: Json[] }>();
  const files = new Map<string, string>();
  const calls: RecordedCall[] = [];
  let ids = 0;

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = urlOf(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.href, headers: new Headers(init.headers), body: init.body });
    const route = decodeURIComponent(url.pathname);
    let match = /^\/v1beta\/models\/([^:]+):batchGenerateContent$/.exec(route);
    if (method === 'POST' && match) {
      const body = JSON.parse(init.body as string) as {
        batch: { displayName?: string; inputConfig: { requests: { requests: Json[] } } };
      };
      const name = `batches/b${++ids}`;
      const operation: Json = {
        name,
        metadata: {
          '@type': 'type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch',
          model: `models/${match[1]}`,
          displayName: body.batch.displayName,
          state: 'BATCH_STATE_PENDING',
          createTime: '2026-10-10T00:00:00Z',
        },
      };
      batches.set(name, { operation, requests: body.batch.inputConfig.requests.requests });
      return json(operation);
    }
    match = /^\/v1beta\/(batches\/[^/:]+)$/.exec(route);
    if (method === 'GET' && match) {
      const entry = batches.get(match[1]!);
      return entry
        ? json(entry.operation)
        : json({ error: { code: 404, message: 'x', status: 'NOT_FOUND' } }, 404);
    }
    match = /^\/v1beta\/(batches\/[^/:]+):cancel$/.exec(route);
    if (method === 'POST' && match) {
      const entry = batches.get(match[1]!)!;
      (entry.operation.metadata as Json).state = 'BATCH_STATE_CANCELLED';
      return json({});
    }
    match = /^\/v1beta\/(files\/[^/:]+):download$/.exec(route);
    if (method === 'GET' && match && url.searchParams.get('alt') === 'media') {
      const content = files.get(match[1]!);
      return content !== undefined
        ? new Response(content)
        : json({ error: { code: 404, message: 'x' } }, 404);
    }
    return json({ error: { code: 500, message: `unexpected ${method} ${route}` } }, 500);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    batches,
    files,
    setState(name: string, state: string): void {
      (batches.get(name)!.operation.metadata as Json).state = state;
    },
    /** End a batch with inlined responses (`{ response }` or `{ error }`, metadata echoed by default). */
    finish(name: string, state: string, responses: Json[]): void {
      const metadata = batches.get(name)!.operation.metadata as Json;
      metadata.state = state;
      metadata.output = { inlinedResponses: { inlinedResponses: responses } };
    },
    /** End a batch whose responses were written to a file instead. */
    finishToFile(name: string, state: string, lines: Json[]): void {
      const metadata = batches.get(name)!.operation.metadata as Json;
      files.set('files/out-1', jsonl(lines));
      metadata.state = state;
      metadata.output = { responsesFile: 'files/out-1' };
    },
  };
}
