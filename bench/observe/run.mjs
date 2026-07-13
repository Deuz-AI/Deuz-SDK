/**
 * Observation overhead benchmark (ADVISORY — not a CI gate; %-thresholds on
 * shared machines are flaky by nature). Runs the built dist against a mock
 * SSE fetch, no network. Usage:
 *
 *   npm run build && node bench/observe/run.mjs
 *
 * Scenarios: observer off (fast path) · no-op tracer · callback observer ·
 * memory observer · full content capture · 5 parallel tools · 20-step run.
 */
import { streamChat, generateText } from '../../dist/index.js';
import { createAnthropic } from '../../dist/anthropic.js';
import { createMemoryObserver, createCallbackObserver } from '../../dist/observe.js';

const ITERATIONS = 200;
const WARMUP = 20;

const SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

function sse(events) {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

const TEXT_STREAM = sse([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
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
      delta: { type: 'text_delta', text: 'hello world' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function toolStream(names) {
  const blocks = names.flatMap((name, i) => [
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: `t_${name}_${i}`, name },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: '{"city":"x"}' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: i } },
  ]);
  return sse([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
    },
    ...blocks,
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 2 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function sseResponse(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sequenceFetch(bodies) {
  let i = 0;
  return async () => sseResponse(bodies[Math.min(i++, bodies.length - 1)]);
}

const noopTracer = { startSpan: () => ({ setAttribute() {}, recordException() {}, end() {} }) };

async function singleTurn(deps) {
  const model = createAnthropic({ apiKey: 'k', fetch: sequenceFetch([TEXT_STREAM]) })(
    'claude-opus-4-8',
  );
  const res = streamChat({ model, messages: [{ role: 'user', content: 'hi' }], deps });
  await res.usage;
}

async function parallelTools(deps) {
  const fetch = sequenceFetch([toolStream(['a', 'b', 'c', 'd', 'e']), TEXT_STREAM]);
  const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
  const tools = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].map((n) => [n, { parameters: SCHEMA, execute: async () => 'r' }]),
  );
  await generateText({
    model,
    messages: [{ role: 'user', content: 'go' }],
    tools,
    maxSteps: 3,
    deps,
  });
}

async function twentySteps(deps) {
  const bodies = [...Array.from({ length: 20 }, () => toolStream(['a'])), TEXT_STREAM];
  const model = createAnthropic({ apiKey: 'k', fetch: sequenceFetch(bodies) })('claude-opus-4-8');
  await generateText({
    model,
    messages: [{ role: 'user', content: 'go' }],
    tools: { a: { parameters: SCHEMA, execute: async () => 'r' } },
    maxSteps: 25,
    deps,
  });
}

async function measure(label, run, makeDeps, iterations = ITERATIONS) {
  for (let i = 0; i < WARMUP; i++) await run(makeDeps());
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await run(makeDeps());
  const ms = performance.now() - start;
  return { label, usPerRun: Math.round((ms / iterations) * 1000) };
}

const captureAll = {
  capture: {
    messages: true,
    outputText: true,
    reasoning: true,
    toolInputs: true,
    toolOutputs: true,
    errorMessages: true,
    providerMetadata: true,
  },
};

const rows = [];
rows.push(await measure('single-turn / observer OFF (fast path)', singleTurn, () => ({})));
rows.push(
  await measure('single-turn / no-op tracer (bridge)', singleTurn, () => ({ tracer: noopTracer })),
);
rows.push(
  await measure('single-turn / callback observer', singleTurn, () => ({
    observer: createCallbackObserver(() => {}),
  })),
);
rows.push(
  await measure('single-turn / memory observer', singleTurn, () => ({
    observer: createMemoryObserver(),
  })),
);
rows.push(
  await measure('single-turn / memory + FULL capture', singleTurn, () => ({
    observer: createMemoryObserver({ observation: captureAll }),
  })),
);
rows.push(await measure('5 parallel tools / observer OFF', parallelTools, () => ({}), 100));
rows.push(
  await measure(
    '5 parallel tools / memory observer',
    parallelTools,
    () => ({ observer: createMemoryObserver() }),
    100,
  ),
);
rows.push(await measure('20-step run / observer OFF', twentySteps, () => ({}), 30));
rows.push(
  await measure(
    '20-step run / memory observer',
    twentySteps,
    () => ({ observer: createMemoryObserver() }),
    30,
  ),
);

const base = new Map([
  ['single-turn', rows[0].usPerRun],
  ['5 parallel tools', rows[5].usPerRun],
  ['20-step run', rows[7].usPerRun],
]);
console.log('\nObservation overhead (mock fetch, no network — advisory numbers):\n');
for (const row of rows) {
  const key = [...base.keys()].find((k) => row.label.startsWith(k));
  const delta = key ? (((row.usPerRun - base.get(key)) / base.get(key)) * 100).toFixed(1) : '0.0';
  console.log(
    `${row.label.padEnd(45)} ${String(row.usPerRun).padStart(7)} µs/run  (${delta >= 0 ? '+' : ''}${delta}%)`,
  );
}
