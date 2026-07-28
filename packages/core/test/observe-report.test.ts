/**
 * Run report (1.9): the HTML viewer over the 1.6 observation protocol.
 * Covers the run/step/tool tree, `summarizeRun` parity, hostile-payload
 * escaping in every context the data lands in (HTML text, attribute, inline
 * <script> JSON), P0 secret redaction, total-function behaviour on empty /
 * aborted / adversarial input, and the "nothing is fetched" guarantee.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { renderRunReport, summarizeRun, createMemoryObserver } from '../src/observe';
import { createJsonlObserver, writeRunReport } from '../src/node/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, JSONSchema, ObserveEvent, ToolSet, Usage } from '../src/index';

function usage(input: number, output: number): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: input + output,
  };
}

let seq = 0;
/** Stamp the identity fields the runtime would add. `sequence` auto-increments. */
function ev(
  partial: Partial<ObserveEvent> & { type: ObserveEvent['type']; spanId: string },
): ObserveEvent {
  const sequence = partial.sequence ?? seq++;
  return {
    schemaVersion: 1,
    eventId: `x1:${sequence}`,
    sequence,
    timestamp: 1_700_000_000_000 + sequence * 10,
    runId: 'run-1',
    executionId: 'x1',
    ...partial,
  } as ObserveEvent;
}

/**
 * A run with the full tree: run → step → (model, tool) → sub-agent, one tool
 * failure, an approval and a checkpoint. spanIds are the nesting.
 */
function scriptedRun(): ObserveEvent[] {
  seq = 0;
  return [
    ev({
      type: 'run.started',
      spanId: 'sp-run',
      operation: 'generate-text',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      surface: 'anthropic',
      durable: false,
      resumed: false,
      messageCount: 2,
      toolCount: 1,
    }),
    ev({
      type: 'step.started',
      spanId: 'sp-step0',
      parentSpanId: 'sp-run',
      stepIndex: 0,
      model: 'claude-opus-4-8',
      messageCount: 2,
      activeToolCount: 1,
      cumulativeUsage: usage(0, 0),
    }),
    ev({
      type: 'model.started',
      spanId: 'sp-model0',
      parentSpanId: 'sp-step0',
      stepIndex: 0,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      surface: 'anthropic',
      maxRetries: 2,
      messageCount: 2,
      toolCount: 1,
    }),
    ev({
      type: 'model.first-content',
      spanId: 'sp-model0',
      parentSpanId: 'sp-step0',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      contentType: 'tool-call',
      ttftMs: 120,
    }),
    ev({
      type: 'model.completed',
      spanId: 'sp-model0',
      parentSpanId: 'sp-step0',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      durationMs: 420,
      ttftMs: 120,
      retryCount: 0,
      finishReason: 'tool_use',
      usage: usage(100, 20),
      outputTextLength: 0,
      reasoningLength: 0,
      toolCallCount: 1,
    }),
    ev({
      type: 'tool.started',
      spanId: 'sp-tool0',
      parentSpanId: 'sp-step0',
      stepIndex: 0,
      toolCallId: 'call-1',
      toolName: 'getWeather',
      needsApproval: false,
      executionMode: 'server',
      parallel: false,
      capturedInput: { city: 'Ankara' },
    }),
    ev({
      type: 'tool.completed',
      spanId: 'sp-tool0',
      parentSpanId: 'sp-step0',
      toolCallId: 'call-1',
      toolName: 'getWeather',
      durationMs: 35,
      outputType: 'object',
      capturedOutput: { tempC: 31 },
    }),
    ev({
      type: 'tool.started',
      spanId: 'sp-tool1',
      parentSpanId: 'sp-step0',
      toolCallId: 'call-2',
      toolName: 'brokenTool',
      needsApproval: false,
      executionMode: 'server',
      parallel: true,
    }),
    ev({
      type: 'tool.failed',
      spanId: 'sp-tool1',
      parentSpanId: 'sp-step0',
      toolCallId: 'call-2',
      toolName: 'brokenTool',
      durationMs: 3,
      selfHealed: true,
      consecutiveFailureCount: 1,
      error: {
        name: 'ToolExecutionError',
        category: 'tool',
        code: 'tool_execution',
        message: 'upstream exploded',
      },
    }),
    ev({
      type: 'subagent.started',
      spanId: 'sp-sub',
      parentSpanId: 'sp-tool0',
      agentName: 'researcher',
      depth: 1,
      parentToolCallId: 'call-1',
      model: 'claude-opus-4-8',
      durable: false,
    }),
    ev({
      type: 'step.started',
      spanId: 'sp-sub-step',
      parentSpanId: 'sp-sub',
      agentPath: ['researcher'],
      stepIndex: 0,
      model: 'claude-opus-4-8',
      messageCount: 1,
      activeToolCount: 0,
      cumulativeUsage: usage(0, 0),
    }),
    ev({
      type: 'subagent.completed',
      spanId: 'sp-sub',
      parentSpanId: 'sp-tool0',
      agentName: 'researcher',
      depth: 1,
      durationMs: 90,
      stepCount: 1,
      usage: usage(10, 5),
    }),
    ev({
      type: 'approval.requested',
      spanId: 'sp-appr',
      parentSpanId: 'sp-step0',
      approvalId: 'call-2',
      toolCallId: 'call-2',
      toolName: 'brokenTool',
      mode: 'server',
    }),
    ev({
      type: 'checkpoint.saved',
      spanId: 'sp-ckpt',
      parentSpanId: 'sp-run',
      checkpointRunId: 'run-1',
      stepId: 'run-1#0',
      checkpointStepIndex: 1,
      checkpointStatus: 'running',
      durationMs: 4,
      messageCount: 4,
      pendingApprovalCount: 0,
      usage: usage(100, 20),
    }),
    ev({
      type: 'step.completed',
      spanId: 'sp-step0',
      parentSpanId: 'sp-run',
      stepIndex: 0,
      durationMs: 500,
      finishReason: 'tool_use',
      toolCallCount: 2,
      toolResultCount: 2,
      toolErrorCount: 1,
      deniedToolCount: 0,
      usage: usage(100, 20),
      cumulativeUsage: usage(100, 20),
    }),
    ev({
      type: 'run.completed',
      spanId: 'sp-run',
      status: 'completed',
      durationMs: 640,
      finishReason: 'stop',
      endReason: 'natural',
      stepCount: 1,
      modelCallCount: 1,
      toolCallCount: 2,
      toolErrorCount: 1,
      deniedToolCount: 0,
      retryCount: 0,
      approvalCount: 1,
      checkpointCount: 1,
      subAgentCount: 1,
      usage: usage(110, 25),
      costUsd: 0.00123,
    }),
  ];
}

describe('renderRunReport — structure and numbers', () => {
  const events = scriptedRun();
  const html = renderRunReport(events, { title: 'Scripted run' });

  it('emits one self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Scripted run</title>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    // exactly one inline stylesheet + one inline script, nothing else
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('renders the run/step/tool tree with sub-agent nesting', () => {
    for (const label of [
      'Run · generate-text',
      'Step #0 · claude-opus-4-8',
      'Model · claude-opus-4-8',
      'Tool · getWeather',
      'Tool · brokenTool',
      'Sub-agent · researcher',
      'Approval · brokenTool',
      'Checkpoint · run-1#0',
    ]) {
      expect(html).toContain(label);
    }
    // nesting: run before step before its tool, each inside a .kids container
    const run = html.indexOf('Run · generate-text');
    const step = html.indexOf('Step #0');
    const tool = html.indexOf('Tool · getWeather');
    const sub = html.indexOf('Sub-agent · researcher');
    expect(run).toBeLessThan(step);
    expect(step).toBeLessThan(tool);
    expect(tool).toBeLessThan(sub); // the sub-agent hangs off the tool span
    expect(html.indexOf('class="kids"')).toBeLessThan(step);
    // agentPath badge for the sub-agent's own step
    expect(html).toContain('class="chip agent">researcher</span>');
  });

  it('reports summarizeRun’s numbers verbatim', () => {
    const summary = summarizeRun(events);
    expect(summary.status).toBe('completed');
    expect(html).toContain(`<b>${summary.stepCount}</b><span>steps</span>`);
    expect(html).toContain(`<b>${summary.modelCallCount}</b><span>model calls</span>`);
    expect(html).toContain(`<b>${summary.toolCallCount}</b><span>tool calls</span>`);
    expect(html).toContain(`<b>${summary.toolErrorCount}</b><span>tool errors</span>`);
    expect(html).toContain(`<b>${summary.approvalCount}</b><span>approvals</span>`);
    expect(html).toContain(`<b>${summary.checkpointCount}</b><span>checkpoints</span>`);
    expect(html).toContain(`<b>${summary.subAgentCount}</b><span>sub-agents</span>`);
    expect(html).toContain(`<b>${summary.usage.inputTokens}</b><span>input tokens</span>`);
    expect(html).toContain(`<b>${summary.usage.totalTokens}</b><span>total tokens</span>`);
    expect(html).toContain(`<b>${events.length}</b><span>events</span>`);
    expect(html).toContain('<span>cost</span>'); // costUsd resolved
    expect(html).toContain('pill completed');
  });

  it('renders timings and the terminal outcome', () => {
    expect(html).toContain('420ms'); // model.completed durationMs
    expect(html).toContain('ttftMs 120');
    expect(html).toContain('640ms'); // run duration
    expect(html).toContain('endReason natural');
    expect(html).toContain('finishReason stop');
    expect(html).toContain('2023-11-14T22:13:20.000Z'); // startedAt, from the event
  });

  it('surfaces errors from the summary and the failing span', () => {
    expect(html).toContain('Errors (1)');
    expect(html).toContain('name ToolExecutionError');
    expect(html).toContain('category tool');
    expect(html).toContain('upstream exploded');
    expect(html).toContain('class="node k-tool bad"');
  });

  it('is deterministic — same events in, same bytes out', () => {
    expect(renderRunReport(scriptedRun(), { title: 'Scripted run' })).toBe(html);
  });

  it('fetches nothing: no external URL, no remote asset, no link/img/src', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/href\s*=/i);
  });

  it('honours the theme option', () => {
    expect(renderRunReport(events, { theme: 'dark' })).toContain('data-theme="dark"');
    expect(renderRunReport(events, { theme: 'dark' })).not.toContain('prefers-color-scheme');
    expect(renderRunReport(events)).toContain('@media (prefers-color-scheme:dark)');
  });
});

describe('renderRunReport — hostile payloads', () => {
  const XSS = '<script>alert(1)</script>';
  const hostile = (): ObserveEvent[] => {
    seq = 0;
    return [
      ev({
        type: 'run.started',
        spanId: 'sp-run',
        operation: 'generate-text',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        surface: 'anthropic',
        durable: false,
        resumed: false,
      }),
      ev({
        type: 'tool.started',
        spanId: 'sp-tool',
        parentSpanId: 'sp-run',
        toolCallId: 'c1',
        // a hallucinated tool name lands in text, an attribute AND the inline
        // script's JSON — all three contexts at once
        toolName: '<img src=x onerror="alert(1)">',
        needsApproval: false,
        executionMode: 'server',
        parallel: false,
        capturedInput: { q: '</script><script>alert(2)</script>' },
      }),
      ev({
        type: 'tool.completed',
        spanId: 'sp-tool',
        parentSpanId: 'sp-run',
        toolCallId: 'c1',
        toolName: '<img src=x onerror="alert(1)">',
        durationMs: 1,
        outputType: 'object',
        capturedOutput: {
          html: XSS,
          close: '</script>',
          quotes: `" onmouseover='alert(3)' \``,
          link: 'javascript:alert(4)',
          amp: '&lt;already escaped&gt;',
        },
      }),
      ev({
        type: 'run.failed',
        spanId: 'sp-run',
        status: 'failed',
        durationMs: 5,
        error: {
          name: '<b>Err</b>',
          category: 'tool',
          message: `boom ${XSS} "quoted"`,
        },
        stepCount: 0,
        modelCallCount: 0,
        toolCallCount: 1,
        retryCount: 0,
      }),
    ];
  };
  const html = renderRunReport(hostile(), { title: XSS });

  it('never emits attacker markup', () => {
    expect(html).not.toContain(XSS);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Err</b>');
    // the ONE script/style pair is ours; the payload closed neither
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    // ...and the escaped forms are present, i.e. the text survived as text
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapes the attribute context', () => {
    // the label tooltip carries the same hostile name — quotes must be entities
    expect(html).toContain('title="Tool · &lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
    expect(html).not.toMatch(/title="[^"]*<img/);
    expect(html).not.toContain(`onmouseover='alert(3)'`);
  });

  it('escapes the inline-script string context', () => {
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script).toContain('window.__DEUZ_RUN__=');
    // < > & never reach the script as raw bytes — only as \uXXXX escapes
    expect(script).toContain('\\u003c');
    expect(script).not.toContain('</');
    expect(script).not.toContain('<img');
    expect(script).not.toContain('<!--');
    // the payload is still readable JSON once a parser unescapes \uXXXX
    const marker = 'window.__DEUZ_RUN__=';
    const start = script.indexOf(marker) + marker.length;
    const json = script.slice(start, script.indexOf(';\n(function', start));
    const parsed = JSON.parse(json) as { nodes: Array<{ label: string }> };
    expect(parsed.nodes.some((n) => n.label.includes('<img src=x'))).toBe(true);
  });

  it('never turns payload text into a link', () => {
    expect(html).not.toMatch(/href\s*=/i);
    expect(html).not.toMatch(/<a\s/i);
    // the javascript: URL survives as inert escaped text inside a <pre>
    expect(html).toContain('javascript:alert(4)');
  });

  it('renders the failed terminal outcome', () => {
    expect(html).toContain('pill failed');
    expect(html).toContain('Errors (1)');
  });
});

describe('renderRunReport — P0 secret redaction', () => {
  const KEY = 'sk-ant-api03-PLANTEDKEYVALUE0000111222';
  const BEARER = 'Bearer planted.jwt.value';
  const events = (): ObserveEvent[] => {
    seq = 0;
    return [
      ev({
        type: 'run.started',
        spanId: 'sp-run',
        operation: 'generate-text',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        surface: 'anthropic',
        durable: false,
        resumed: false,
        capturedMessages: [{ role: 'user', content: `my key is ${KEY}, use it` }],
      }),
      ev({
        type: 'model.completed',
        spanId: 'sp-model',
        parentSpanId: 'sp-run',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        durationMs: 10,
        retryCount: 0,
        finishReason: 'stop',
        usage: usage(1, 1),
        outputTextLength: 4,
        reasoningLength: 0,
        toolCallCount: 0,
        capturedOutputText: `here it is: ${KEY}`,
        // a header bag reaching a sink: the KEY name must redact the value
        capturedProviderMetadata: {
          headers: { authorization: BEARER, 'x-api-key': KEY, cookie: 'session=planted' },
        },
      }),
      // a scalar field whose NAME is secret-shaped (chip path)
      ev({
        type: 'operation.started',
        spanId: 'sp-op',
        parentSpanId: 'sp-run',
        subsystem: 'mcp',
        operation: 'listTools',
        token: KEY,
      } as never),
      ev({
        type: 'run.failed',
        spanId: 'sp-run',
        status: 'failed',
        durationMs: 5,
        error: { name: 'AuthenticationError', category: 'authentication', message: `bad ${KEY}` },
        stepCount: 0,
        modelCallCount: 1,
        toolCallCount: 0,
        retryCount: 0,
      }),
    ];
  };
  const html = renderRunReport(events());

  it('never renders a planted key, bearer token or raw header value', () => {
    expect(html).not.toContain(KEY);
    expect(html).not.toContain('planted.jwt.value');
    expect(html).not.toContain('session=planted');
    expect(html).not.toContain('sk-ant-');
    expect(html).toContain('[REDACTED]');
  });

  it('redacts in the inline script too', () => {
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script).not.toContain(KEY);
  });
});

describe('renderRunReport — total function', () => {
  it('renders an empty event list', () => {
    const html = renderRunReport([]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('No events to display');
    expect(html).toContain('<b>0</b><span>events</span>');
  });

  it('renders a truncated, aborted run with no terminal counters', () => {
    seq = 0;
    const html = renderRunReport([
      ev({
        type: 'run.started',
        spanId: 'sp-run',
        operation: 'stream-chat',
        provider: 'openai',
        model: 'gpt-5.2',
        surface: 'responses',
        durable: false,
        resumed: false,
      }),
      ev({
        type: 'model.started',
        spanId: 'sp-model',
        parentSpanId: 'sp-run',
        provider: 'openai',
        model: 'gpt-5.2',
        surface: 'responses',
        maxRetries: 2,
        messageCount: 1,
        toolCount: 0,
        truncated: true,
      }),
      ev({
        type: 'run.aborted',
        spanId: 'sp-run',
        status: 'aborted',
        durationMs: 12,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          totalTokens: 0,
        },
      }),
    ]);
    expect(html).toContain('pill aborted');
    expect(html).toContain('truncated');
    expect(html).toContain('Model · gpt-5.2');
  });

  it('renders a run with no terminal event as running', () => {
    seq = 0;
    const html = renderRunReport([
      ev({
        type: 'run.started',
        spanId: 'sp-run',
        operation: 'stream-chat',
        provider: 'xai',
        model: 'grok-5',
        surface: 'chat_completions',
        durable: false,
        resumed: false,
      }),
    ]);
    expect(html).toContain('pill running');
  });

  it('survives adversarial identity fields: span cycles, bad timestamps, bytes, cycles', () => {
    seq = 0;
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const html = renderRunReport([
      // a parentSpanId cycle must not recurse forever
      ev({ type: 'compaction', spanId: 'A', parentSpanId: 'B', layer: 'summarize' } as never),
      ev({ type: 'compaction.skipped', spanId: 'B', parentSpanId: 'A', reason: 'too small' }),
      // NaN / out-of-range epochs must not throw out of Date#toISOString
      ev({ type: 'cost.calculated', spanId: 'C', timestamp: Number.NaN } as never),
      ev({ type: 'cost.calculated', spanId: 'D', timestamp: 1e21 } as never),
      ev({
        type: 'tool.completed',
        spanId: 'E',
        toolCallId: 'c',
        toolName: 't',
        durationMs: 1,
        outputType: 'object',
        capturedOutput: { bytes: new Uint8Array([1, 2, 3]), big: 1n, deep: cyclic },
      }),
      // no spanId at all
      ev({ type: 'operation.completed', spanId: '', subsystem: 'rag', operation: 'x' } as never),
    ]);
    expect(html).toContain('[Uint8Array 3B]');
    expect(html).toContain('[Unserializable]');
    expect(html).toContain('Compaction · summarize');
    expect(html).toContain('—'); // the unrenderable timestamps
  });

  it('selects one run out of many and points at the rest', () => {
    seq = 0;
    const a = ev({
      type: 'run.started',
      spanId: 'sp-a',
      operation: 'generate-text',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      surface: 'anthropic',
      durable: false,
      resumed: false,
    });
    const b = {
      ...ev({
        type: 'run.started',
        spanId: 'sp-b',
        operation: 'embed',
        provider: 'voyage',
        model: 'voyage-3',
        surface: 'chat_completions',
        durable: false,
        resumed: false,
      }),
      runId: 'run-2',
      executionId: 'x2',
    } as ObserveEvent;

    const first = renderRunReport([a, b]);
    expect(first).toContain('1 other run(s) in this input');
    expect(first).toContain('Run · generate-text');
    expect(first).not.toContain('Run · embed');

    const picked = renderRunReport([a, b], { runId: 'run-2' });
    expect(picked).toContain('Run · embed');
    expect(picked).not.toContain('Run · generate-text');

    expect(renderRunReport([a, b], { runId: 'nope' })).toContain('No events to display for run');
  });

  it('orders execution legs by first timestamp and labels them', () => {
    seq = 0;
    const legTwo = {
      ...ev({
        type: 'step.started',
        spanId: 'sp-s2',
        stepIndex: 1,
        model: 'm',
        messageCount: 1,
        activeToolCount: 0,
        cumulativeUsage: usage(1, 1),
      }),
      executionId: 'x2',
      sequence: 0,
      timestamp: 1_700_000_100_000,
    } as ObserveEvent;
    const legOne = ev({
      type: 'run.started',
      spanId: 'sp-run',
      operation: 'generate-text',
      provider: 'anthropic',
      model: 'm',
      surface: 'anthropic',
      durable: false,
      resumed: false,
    });
    const html = renderRunReport([legTwo, legOne]);
    expect(html).toContain('leg 1/2');
    expect(html).toContain('leg 2/2');
    expect(html.indexOf('Run · generate-text')).toBeLessThan(html.indexOf('Step #1'));
    expect(html).toContain('<b>2</b><span>execution legs</span>');
  });
});

describe('renderRunReport — over REAL runtime events', () => {
  const SCHEMA: JSONSchema = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  };

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

  const TOOL_STREAM = sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
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
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
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

  it('renders a real tool-loop run: real spans nest, hostile tool output stays inert', async () => {
    const mem = createMemoryObserver({
      observation: {
        capture: { messages: true, outputText: true, toolInputs: true, toolOutputs: true },
      },
    });
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const tools: ToolSet = {
      lookup: {
        parameters: SCHEMA,
        // a real tool result travelling the real pipeline into the report
        execute: () => '<script>alert(1)</script> key sk-ant-api03-REALPIPEKEY000111222',
      },
    };
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools,
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });

    const events = mem.latestRun()!;
    expect(events.length).toBeGreaterThan(5);
    const html = renderRunReport(events, { title: 'Real run' });

    expect(html).toContain('Run · generate-text');
    expect(html).toContain('Step #0');
    expect(html).toContain('Tool · lookup');
    expect(html).toContain('Model · claude-opus-4-8');
    expect(html).toContain('pill completed');
    expect(html).toContain('class="kids"'); // real parentSpanIds produced nesting
    expect(html).toContain(`<b>${summarizeRun(events).stepCount}</b><span>steps</span>`);
    // the hostile output and the planted key never survive
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('sk-ant-');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('writeRunReport (node)', () => {
  function tempFile(name: string): string {
    return join(mkdtempSync(join(tmpdir(), 'deuz-report-')), name);
  }

  it('writes the rendered document from in-memory events', async () => {
    const to = tempFile('run.html');
    await writeRunReport({ events: scriptedRun(), to, title: 'From memory' });
    const html = await readFile(to, 'utf8');
    expect(html).toBe(renderRunReport(scriptedRun(), { title: 'From memory' }));
    expect(html).toContain('<title>From memory</title>');
  });

  it('reads a JSONL file written by createJsonlObserver', async () => {
    const jsonlPath = tempFile('run.jsonl');
    const jsonl = createJsonlObserver({ file: jsonlPath });
    for (const event of scriptedRun()) jsonl.emit(event);
    await jsonl.close();

    const to = join(jsonlPath, '..', 'nested', 'report.html');
    await writeRunReport({ from: jsonlPath, to });
    const html = await readFile(to, 'utf8');
    expect(html).toContain('Tool · getWeather');
    expect(html).toContain('<b>1</b><span>steps</span>');
  });

  it('rejects a call with neither events nor a source file', async () => {
    await expect(writeRunReport({ to: tempFile('x.html') })).rejects.toThrow(/events.*from/s);
  });
});
