/**
 * Claims the Agent Skills make (skills/deuz-sdk, its .claude mirror, skills/migrate-from-ai-sdk),
 * each held against the code it describes (W3 review V5-1 .. V5-6). A block pins the behaviour
 * first, then checks that the skill text says so, in every copy that carries the claim.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { streamChat } from '../src';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { generateText } from '../src/generate';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import { hasToolCall, stepCountIs } from '../src/inference/stop';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { exitCodeFor, runHeadless } from '../src/node/headless';
import { createOtelObserver, createOtelTracer } from '../src/otel';
import { createPriceProvider, PRICES_2026, type PriceTable } from '../src/pricing';
import { createMockModel, type MockResponse } from '../src/testing';
import type { AgentToolSet } from '../src/types/agent-run';
import type { LanguageModel } from '../src/types/model';
import type { ToolExecuteContext } from '../src/types/tool';
import type { Usage } from '../src/types/usage';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
const parameters = { type: 'object' as const, properties: {} };

/** A file of the deuz-sdk skill in both copies: the source and its .claude mirror. */
const bothCopies = (file: string) => [`skills/deuz-sdk/${file}`, `.claude/skills/deuz-sdk/${file}`];

/** A scripted model under its own id, so pricing can tell two of them apart. */
function named(modelId: string, responses: MockResponse[]): LanguageModel {
  const base = createMockModel({ responses });
  return attachConfig({ ...base, modelId }, readConfig(base)!);
}

/** Every Markdown file of both skills, the mirror included, as repository paths. */
function skillMarkdown(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push(relative(REPO, path).replace(/\\/g, '/'));
    }
  };
  walk(join(REPO, 'skills'));
  walk(join(REPO, '.claude/skills'));
  return files.sort();
}

const MILLION: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2_000_000,
};

describe('createPriceProvider takes an options object (W3 review V5-1)', () => {
  it('ignores a table passed positionally; { table } prices it', () => {
    const table: PriceTable = { ...PRICES_2026, 'acme-1': { input: 1, output: 2 } };
    expect(createPriceProvider({ table }).priceUsage('acme-1', MILLION)).toBe(3);
    // A PriceTable is an index signature, so TypeScript accepts it as the options object.
    expect(createPriceProvider(table).priceUsage('acme-1', MILLION)).toBeUndefined();
  });

  it('no skill passes createPriceProvider anything but an options object', () => {
    const positional = skillMarkdown().flatMap((path) =>
      (read(path).match(/createPriceProvider\((?![){])[^)]*\)/g) ?? []).map(
        (call) => `${path}: ${call}`,
      ),
    );
    expect(positional).toEqual([]);
  });
});

describe('migration.md, LangGraph sharp edges (W3 review V5-2)', () => {
  it("a parent's onToolCall guardrail refuses a sub-agent's own call", async () => {
    const run = async (guarded: boolean) => {
      const secret = vi.fn(async () => 'leaked');
      const child = createMockModel({
        responses: [{ toolCalls: [{ toolName: 'secret', id: 's1', args: {} }] }, { text: 'ok' }],
      });
      await generateText({
        model: createMockModel({
          responses: [
            { toolCalls: [{ toolName: 'worker', id: 'w1', args: { prompt: 'go' } }] },
            { text: 'done' },
          ],
        }),
        prompt: 'go',
        maxSteps: 4,
        tools: {
          worker: agentTool({
            name: 'worker',
            description: 'does work',
            model: child,
            tools: { secret: { parameters, execute: secret } },
          }),
        },
        ...(guarded
          ? {
              guardrails: {
                onToolCall: ({ toolCall }: { toolCall: { toolName: string } }) =>
                  toolCall.toolName === 'secret'
                    ? { action: 'block' as const, reason: 'no' }
                    : undefined,
              },
            }
          : {}),
      });
      return secret.mock.calls.length;
    };
    expect(await run(false)).toBe(1); // control: the child does call it
    expect(await run(true)).toBe(0); // the parent's guardrail stops it
  });

  it("after a handoff the target's calls are priced at the target's model", async () => {
    const priced: string[] = [];
    const priceProvider = {
      priceUsage: (model: string, _usage: Usage) => {
        priced.push(model);
        return model === 'target-model' ? 100 : 1;
      },
    };
    const root = named('root-model', [
      { toolCalls: [{ toolName: 'transfer_to_billing', id: 't1', args: { reason: 'refund' } }] },
    ]);
    const target = named('target-model', [{ text: 'billing here' }]);
    const result = streamChat({
      model: root,
      prompt: 'refund please',
      tools: handoff({ billing: { model: target, instructions: 'You handle billing.' } }),
      maxSteps: 4,
      deps: { priceProvider },
    });
    const costs: number[] = [];
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'cost') costs.push(part.costUsd);
      if (part.type === 'text-delta') text += part.text;
    }
    expect(text).toBe('billing here');
    expect(priced).toEqual(['root-model', 'target-model']);
    expect(costs.at(-1)).toBe(101); // priced at the root model it would be 2
  });

  it('no skill says sub-agents lose the tool guardrails or that a handoff is priced at the root model', () => {
    const stale = skillMarkdown().flatMap((path) =>
      read(path)
        .split('\n')
        .filter(
          (line) =>
            /[Ss]ub-agents do not inherit `guardrails`/.test(line) ||
            /priced against the root model/.test(line),
        )
        .map((line) => `${path}: ${line.slice(0, 80)}`),
    );
    expect(stale).toEqual([]);
  });

  it.each(bothCopies('references/migration.md'))(
    '%s says sub-agents inherit onToolCall and onToolResult',
    (path) => {
      expect(read(path)).toMatch(/[Ss]ub-agents inherit[^\n]*`onToolCall`[^\n]*`onToolResult`/);
    },
  );
});

describe('migration.md: typed per-tool context and runtimeContext (W3 review V5-3)', () => {
  it('a native tool receives only its own validated context, never sent to the provider', async () => {
    const base = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] }, { text: 'done' }],
    });
    const config = readConfig(base)!;
    const bodies: string[] = [];
    const model = attachConfig(
      { ...base },
      {
        ...config,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(String(init!.body));
          return config.fetch!(input, init);
        }) as typeof fetch,
      },
    );
    const seen: unknown[] = [];
    const result = await runAgent({
      model,
      prompt: 'look it up',
      toolsContext: { lookup: { tenant: 'tenant-7f3a' }, other: { tenant: 'not-yours' } },
      tools: {
        lookup: {
          parameters,
          validateContext: (value: unknown) => {
            const tenant = (value as { tenant?: unknown } | undefined)?.tenant;
            if (typeof tenant !== 'string') throw new TypeError('tenant required');
            return { tenant };
          },
          execute: (_args, context) => {
            seen.push(context.context);
            return 'ok';
          },
        },
        other: { parameters, execute: () => 'unused' },
      },
    });
    expect(result.status).toBe('completed');
    expect(seen).toEqual([{ tenant: 'tenant-7f3a' }]);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join('\n')).not.toContain('tenant-7f3a');
  });

  it('runtimeContext reaches all four guardrail hooks', async () => {
    const tenant = { id: 'acme' };
    const seen: Record<string, unknown> = {};
    await generateText({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'done' }],
      }),
      prompt: 'go',
      maxSteps: 3,
      runtimeContext: tenant,
      tools: { probe: { parameters, execute: async () => 'ok' } },
      guardrails: {
        onInput: (ctx) => void (seen.onInput = ctx.runtimeContext),
        onToolCall: (ctx) => void (seen.onToolCall = ctx.runtimeContext),
        onToolResult: (ctx) => void (seen.onToolResult = ctx.runtimeContext),
        onOutput: (ctx) => void (seen.onOutput = ctx.runtimeContext),
      },
    });
    expect(seen).toEqual({
      onInput: tenant,
      onToolCall: tenant,
      onToolResult: tenant,
      onOutput: tenant,
    });
  });

  it('no skill says typed per-tool context still has no equivalent, or counts three guardrail hooks', () => {
    const stale = skillMarkdown().flatMap((path) =>
      read(path)
        .split('\n')
        .filter(
          (line) => /still have no equivalent/.test(line) || /all three guardrail hooks/.test(line),
        )
        .map((line) => `${path}: ${line.slice(0, 80)}`),
    );
    expect(stale).toEqual([]);
  });

  it.each(bothCopies('references/migration.md'))(
    '%s points every toolsContext mention at the native runAgent tools that have it',
    (path) => {
      const lines = read(path)
        .split('\n')
        .filter((line) => line.includes('`toolsContext`'));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.filter((line) => !/native `runAgent`/.test(line))).toEqual([]);
    },
  );
});

describe('migrate-from-ai-sdk rules: runtimeContext, typed tool context, OTel (W3 review V5-4)', () => {
  it('runtimeContext reaches a legacy tool by reference, and the OTel bridge exists', async () => {
    const seen: unknown[] = [];
    const tenant = { id: 'acme' };
    await generateText({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'done' }],
      }),
      prompt: 'go',
      maxSteps: 3,
      runtimeContext: tenant,
      tools: {
        probe: {
          parameters,
          execute: async (_args: unknown, ctx: ToolExecuteContext) => {
            seen.push(ctx.runtimeContext);
            return 'ok';
          },
        },
      },
    });
    expect(seen).toEqual([tenant]);
    expect(seen[0]).toBe(tenant);
    expect(typeof createOtelTracer).toBe('function');
    expect(typeof createOtelObserver).toBe('function');
  });

  it('no skill lists runtimeContext or typed tool context as having no equivalent', () => {
    const stale = skillMarkdown().flatMap((path) =>
      read(path)
        .split('\n')
        .filter(
          (line) =>
            /`runtimeContext` — close over what the tool needs/.test(line) ||
            /Typed per-tool context injection of any kind/.test(line),
        )
        .map((line) => `${path}: ${line.slice(0, 80)}`),
    );
    expect(stale).toEqual([]);
  });

  it('rules/imports.md maps registerTelemetry + @ai-sdk/otel to @deuz-sdk/core/otel', () => {
    const row = read('skills/migrate-from-ai-sdk/rules/imports.md')
      .split('\n')
      .find((line) => line.includes('registerTelemetry'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/no equivalent/i);
    expect(row).toMatch(/createOtelTracer[^\n]*'@deuz-sdk\/core\/otel'/);
  });
});

describe('headless.md: which stop conditions exit 6 (W3 review V5-5)', () => {
  const tools: AgentToolSet = {
    ping: {
      description: 'Ping.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => 'pong',
    },
  };
  const run = (runId: string, stopWhen: Parameters<typeof runHeadless>[0]['stopWhen']) =>
    runHeadless({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'ping', args: {} }] }, { text: 'done' }],
      }),
      prompt: 'Ping once.',
      tools,
      store: createInMemoryAgentRunStore(),
      runId,
      stopWhen,
    });

  it('hasToolCall and a custom predicate exit 7; a step, token, cost or time bound exits 6', async () => {
    const byTool = await run('by-tool', hasToolCall('ping'));
    expect(byTool).toMatchObject({ status: 'stopped', reason: 'hasToolCall', outcome: 'stopped' });
    expect(exitCodeFor(byTool)).toBe(7);
    const custom = await run('custom', ({ steps }) => steps.length >= 1);
    expect(custom).toMatchObject({ status: 'stopped', reason: 'custom', outcome: 'stopped' });
    expect(exitCodeFor(custom)).toBe(7);
    const bySteps = await run('by-steps', stepCountIs(1));
    expect(bySteps).toMatchObject({ reason: 'stepCountIs', outcome: 'limit' });
    expect(exitCodeFor(bySteps)).toBe(6);
  });

  it.each(bothCopies('references/headless.md'))(
    '%s puts only the bounds under exit 6 and the other stop conditions under 7',
    (path) => {
      const rows = read(path).split('\n');
      const row = (code: number) => rows.find((line) => line.startsWith(`| ${code} |`)) ?? '';
      // "a stop condition" alone would claim hasToolCall and custom stops too.
      expect(row(6)).not.toMatch(/a stop condition,/);
      for (const name of ['costExceeds', 'totalTokensExceed', 'stepCountIs', 'durationExceeds'])
        expect(row(6)).toContain(`\`${name}\``);
      expect(row(7)).toContain('`hasToolCall`');
    },
  );
});
