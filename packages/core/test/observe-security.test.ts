/**
 * P0 secret-leak matrix (§27.7): with content capture FULLY ON and secrets
 * planted in every reachable channel, no default-redaction-covered secret may
 * appear in any observation event or JSONL line.
 */
import { describe, it, expect } from 'vitest';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver, composeObservers } from '../src/observe';
import { createJsonlObserver, readJsonlEvents } from '../src/node/observe';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, JSONSchema } from '../src/index';

function fastClock(): Clock {
  let now = 0;
  return {
    now: () => (now += 5),
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

// Values that must NEVER surface in any event or JSONL line.
const PLANTED_SECRETS = [
  'sk-ant-planted-anthropic-secret-000111222',
  'sk-planted0openai0secret0000111222',
  'AIzaPlantedGoogleSecret0123456789',
  'Bearer planted.bearer.token',
  'planted-password-value',
  'planted-cookie-value',
  'eyJhbGciOiJIUzI1NiJ9.eyJwbGFudGVkIjoxfQ.plantedjwtsignature000',
];

const TOOL_CALL_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'leaky' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      // the model itself echoes a secret into the tool input
      delta: {
        type: 'input_json_delta',
        partial_json: '{"city":"Paris sk-ant-planted-anthropic-secret-000111222"}',
      },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const FINAL_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      // the model echoes secrets into its output text
      delta: {
        type: 'text_delta',
        text: 'done AIzaPlantedGoogleSecret0123456789 and Bearer planted.bearer.token',
      },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('observation secret-leak matrix (P0)', () => {
  it('no planted secret survives into events or JSONL — even with full capture ON', async () => {
    const mem = createMemoryObserver({
      observation: {
        capture: {
          messages: true,
          outputText: true,
          reasoning: true,
          toolInputs: true,
          toolOutputs: true,
          errorMessages: true,
          providerMetadata: true,
        },
      },
    });
    const file = join(mkdtempSync(join(tmpdir(), 'deuz-sec-')), 'runs.jsonl');
    const jsonl = createJsonlObserver({ file });
    const observer = composeObservers(mem, jsonl);

    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      // the FACTORY key is a planted secret — it must never reach an event
      model: createAnthropic({ apiKey: 'sk-ant-planted-anthropic-secret-000111222', fetch })(
        'claude-opus-4-8',
      ),
      messages: [
        {
          role: 'user',
          // secrets planted straight into the prompt
          content:
            'use sk-planted0openai0secret0000111222 with Bearer planted.bearer.token ' +
            'and eyJhbGciOiJIUzI1NiJ9.eyJwbGFudGVkIjoxfQ.plantedjwtsignature000',
        },
      ],
      headers: { 'x-api-key': 'sk-planted0openai0secret0000111222' },
      tools: {
        leaky: {
          parameters: SCHEMA,
          execute: async () => ({
            // secrets planted in the tool OUTPUT under secret-looking keys
            password: 'planted-password-value',
            cookie: 'planted-cookie-value',
            token: 'Bearer planted.bearer.token',
            note: 'raw sk-ant-planted-anthropic-secret-000111222 in free text',
          }),
        },
      },
      maxSteps: 5,
      deps: { observer, clock: fastClock() },
    });
    await jsonl.close();

    const serializedEvents = JSON.stringify(mem.events());
    const jsonlText = await readFile(file, 'utf8');
    for (const secret of PLANTED_SECRETS) {
      expect(serializedEvents).not.toContain(secret);
      expect(jsonlText).not.toContain(secret);
    }
    // sanity: capture DID happen (we are testing redaction, not absence)
    expect(serializedEvents).toContain('[REDACTED]');
    // and the events still round-trip as valid JSONL
    expect((await readJsonlEvents(file)).length).toBeGreaterThan(0);
  });

  it('default capture (everything off): not even redacted content appears', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'sk-ant-planted-anthropic-secret-000111222', fetch })(
        'claude-opus-4-8',
      ),
      messages: [{ role: 'user', content: 'prompt sk-planted0openai0secret0000111222' }],
      tools: {
        leaky: {
          parameters: SCHEMA,
          execute: async () => ({ password: 'planted-password-value' }),
        },
      },
      maxSteps: 5,
      deps: { observer: mem, clock: fastClock() },
    });
    const serialized = JSON.stringify(mem.events());
    for (const secret of PLANTED_SECRETS) expect(serialized).not.toContain(secret);
    // no captured payload fields exist at all by default
    expect(serialized).not.toContain('capturedMessages');
    expect(serialized).not.toContain('capturedInput');
    expect(serialized).not.toContain('capturedOutput');
  });

  it('a MALICIOUS custom redactor cannot reintroduce secrets — default redaction is the final barrier', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { leaky: { parameters: SCHEMA, execute: async () => ({ ok: true }) } },
      maxSteps: 5,
      deps: {
        observer: {
          options: {
            capture: { toolInputs: true, toolOutputs: true, outputText: true },
            // Hostile redactor: replaces every captured payload with fresh
            // secrets AFTER the first default sweep already ran.
            redact: () => ({
              stolenKey: 'sk-ant-planted-anthropic-secret-000111222',
              bearer: 'Bearer planted.bearer.token',
              google: 'AIzaPlantedGoogleSecret0123456789',
              password: 'planted-password-value',
              jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJwbGFudGVkIjoxfQ.plantedjwtsignature000',
            }),
          },
          emit: (e) => mem.emit(e),
        },
        clock: fastClock(),
      },
    });
    const serialized = JSON.stringify(mem.events());
    for (const secret of PLANTED_SECRETS) expect(serialized).not.toContain(secret);
    // the sweep DID run over the redactor's output (values became [REDACTED]),
    // and the run itself completed untouched
    expect(serialized).toContain('[REDACTED]');
    expect(mem.events().at(-1)!.type).toBe('run.completed');
  });

  it('a truncated payload cannot leak a decodable secret prefix (redaction precedes truncation)', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJwbGFudGVkIjoxfQ.plantedjwtsignature000';
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        leaky: {
          parameters: SCHEMA,
          // the JWT sits right at the truncation boundary: naive
          // truncate-then-redact would keep a decodable header+payload prefix
          execute: async () => 'x'.repeat(90) + jwt + 'y'.repeat(50),
        },
      },
      maxSteps: 5,
      deps: {
        observer: {
          options: { capture: { toolOutputs: true }, limits: { maxStringLength: 120 } },
          emit: (e) => mem.emit(e),
        },
        clock: fastClock(),
      },
    });
    const serialized = JSON.stringify(mem.events());
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9'); // not even the header segment
    expect(serialized).toContain('[REDACTED]');
  });
});
