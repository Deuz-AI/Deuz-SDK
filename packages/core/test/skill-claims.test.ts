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
import { generateText } from '../src/generate';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createPriceProvider, PRICES_2026, type PriceTable } from '../src/pricing';
import { createMockModel, type MockResponse } from '../src/testing';
import type { LanguageModel } from '../src/types/model';
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
