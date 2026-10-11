/**
 * Shared pieces of the offline eval tasks (2.3, roadmap 23.7): a scripted model
 * that counts its paid calls, workspace tools over the attempt's file snapshot,
 * and the acceptance criteria most tasks reuse.
 *
 * Offline tasks measure the SDK, not a model: the model's turns are scripted, so
 * what an attempt proves is that the loop, receipts, approvals, resume and
 * accounting carry a known-good plan to the accepted result, exactly once.
 */
import { createMockModel, type MockResponse } from '../../src/testing';
import { attachConfig, readConfig } from '../../src/internal/config-symbol';
import type { AgentToolSet } from '../../src/types/agent-run';
import type { LanguageModel } from '../../src/types/model';
import type { EvalAcceptance, EvalTaskContext, EvalTaskOutcome } from '../../src/testing';

export const parameters = { type: 'object' as const, properties: {} };

export const pathParameter = {
  type: 'object' as const,
  properties: { path: { type: 'string' } },
  required: ['path'],
};

/** A per-token price for the mock model, so offline attempts have a cost. */
export const mockPrices = {
  priceUsage: (_model: string, usage: { inputTokens: number; outputTokens: number }) =>
    (usage.inputTokens * 1 + usage.outputTokens * 4) / 1_000_000,
};

/** The mock model, with a counter of the model calls it served (each one is paid). */
export function scripted(responses: MockResponse[]): {
  model: LanguageModel;
  calls: () => number;
} {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  let calls = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return config.fetch!(input, init);
  }) as typeof globalThis.fetch;
  return { model: attachConfig({ ...base }, { ...config, fetch }), calls: () => calls };
}

/**
 * `read_file`, `write_file` and `list_files` over the attempt's `files`. A write
 * is an effect, identified by the call that made it (`modelStep`, `toolCallId`),
 * which is stable across a resume: a replayed write shows up as a repeat.
 */
export function workspaceTools(context: EvalTaskContext): AgentToolSet {
  return {
    list_files: {
      description: 'List the workspace files under a directory prefix.',
      parameters: pathParameter,
      execute: ({ path }: { path: string }) =>
        Object.keys(context.files)
          .filter((file) => file.startsWith(path))
          .sort(),
    },
    read_file: {
      description: 'Read one workspace file.',
      parameters: pathParameter,
      execute: ({ path }: { path: string }) => {
        const content = context.files[path];
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
    },
    write_file: {
      description: 'Replace the content of one workspace file.',
      parameters: {
        type: 'object' as const,
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      execute: ({ path, content }: { path: string; content: string }, call) => {
        context.effect(`write_file:${call.modelStep}:${call.toolCallId}`);
        context.files[path] = content;
        return `wrote ${content.length} characters to ${path}`;
      },
    },
  };
}

/** The run claimed completion. */
export const completes: EvalAcceptance = {
  name: 'completes',
  check: (outcome) => outcome.status === 'completed',
};

/** The final answer contains every fragment. */
export function answerMentions(...fragments: string[]): EvalAcceptance {
  return {
    name: `answer mentions ${fragments.join(', ')}`,
    check: (outcome) => fragments.every((fragment) => (outcome.text ?? '').includes(fragment)),
  };
}

/** The observer saw exactly these tool calls, in this order. */
export function calledTools(...names: string[]): EvalAcceptance {
  return {
    name: `called ${names.join(', ') || 'no tool'}`,
    check: (_outcome, context) => JSON.stringify(observedTools(context)) === JSON.stringify(names),
  };
}

export function observedTools(context: EvalTaskContext): string[] {
  return context.observer
    .events()
    .flatMap((event) => (event.type === 'tool.started' ? [event.toolName] : []));
}

/** A native result carries its cumulative usage and accounting already. */
export type Outcome = EvalTaskOutcome;
