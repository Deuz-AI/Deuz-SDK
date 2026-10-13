/**
 * Fault-injection helpers (2.3, roadmap 23.7). Each fault is injected at one
 * boundary through the hooks the regression tests already use: a store that
 * fails one write (durable receipts), a lease provider whose renewal fails, a
 * budget store whose reserve or settle fails, a model stream that breaks.
 *
 * Every scenario asserts the same three things: no effect ran twice (the
 * harness fails a repeated `context.effect` key), no billed model call
 * vanished from the accounting, and the recovery the documentation promises.
 * The recovery label a scenario returns is derived from what it observed, never
 * hard-coded, so the harness's comparison with `fault.recovery` means something.
 */
import {
  createMockModel,
  sseResponse,
  type EvalAcceptance,
  type MockResponse,
} from '../../../src/testing';
import { attachConfig, readConfig } from '../../../src/internal/config-symbol';
import { createAnthropic } from '../../../src/anthropic';
import { createOpenAI } from '../../../src/openai';
import type { AgentRunEnvelope, AgentRunStore } from '../../../src/types/agent-run';
import type { LanguageModel } from '../../../src/types/model';
import { openaiTurn, scriptedFetch, type ScriptStep } from '../../fixtures/wire-turns';

export { memoryRecord, mockPrices, parameters, scripted, watchedMemory } from '../support';

/** What one default mock turn bills: 10 input + 5 output tokens at the mock prices. */
export const TURN = { tokens: 15, usd: (10 * 1 + 5 * 4) / 1_000_000 };

/** The test model the fault scenarios are written against. */
export const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

/** Receipt stages as `toolCallId:stage`. */
export const stages = (envelope: AgentRunEnvelope | undefined): string[] =>
  Object.values(envelope?.toolResults ?? {}).map((r) => `${r.toolCallId}:${r.stage}`);

/** A store that fails the first write `when` selects, like a crash or an outage; healthy otherwise. */
export function failingOnce(
  inner: AgentRunStore,
  when: (envelope: AgentRunEnvelope) => boolean,
  onFail: () => void = () => {},
): AgentRunStore {
  let failed = false;
  return {
    load: (runId) => inner.load(runId),
    save(envelope) {
      if (!failed && when(envelope)) {
        failed = true;
        onFail();
        throw new Error('store down');
      }
      return inner.save(envelope);
    },
  };
}

/**
 * A process that dies during the model call after the save recording `stage`
 * (`<id>:<stage>`): that call's budget reservation, the first save at a later
 * model step, lands, and every save after it fails. `onFail` runs once, at the
 * first write the dead process could not make.
 */
export function diesDuringNextModelCall(
  inner: AgentRunStore,
  stage: string,
  onFail: () => void = () => {},
): AgentRunStore {
  let step: number | undefined;
  let dead = false;
  let failed = false;
  return {
    load: (runId) => inner.load(runId),
    save(envelope) {
      if (dead) {
        if (!failed) onFail();
        failed = true;
        throw new Error('process died');
      }
      if (step === undefined) {
        if (stages(envelope).includes(stage)) step = envelope.modelSteps;
      } else if (envelope.modelSteps > step) dead = true;
      return inner.save(envelope);
    },
  };
}

/**
 * No lost cost: the run's accounting commits at least what every billed model
 * call cost (`store.billedCalls`, counted at the model). A call whose outcome is
 * unknown stays held at its estimate, which is never below its actual cost.
 */
export const costKept: EvalAcceptance = {
  name: 'no billed call is missing from the accounting',
  check: (outcome, context) => {
    const calls = context.store.billedCalls as number | undefined;
    const committed = outcome.accounting?.committed;
    if (calls === undefined || committed === undefined) return false;
    return committed.tokens >= calls * TURN.tokens && committed.usd >= calls * TURN.usd - 1e-12;
  },
};

/** The effect identified by `key` ran exactly once in the world. */
export function ranOnce(key: string): EvalAcceptance {
  return {
    name: `${key} ran exactly once`,
    check: (_outcome, context) =>
      ((context.store.effects as string[] | undefined) ?? []).filter((e) => e === key).length === 1,
  };
}

/**
 * A mock model whose FIRST response stream breaks off after its first event,
 * as a dropped connection does mid-stream; later calls are healthy.
 */
export function breakingOnce(responses: MockResponse[]): {
  model: LanguageModel;
  calls: () => number;
} {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  let calls = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const response = await config.fetch!(input, init);
    if (calls !== 1) return response;
    const text = await response.text();
    const cut = text.indexOf('\n\n') + 2;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.error(new TypeError('terminated'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { model: attachConfig({ ...base }, { ...config, fetch }), calls: () => calls };
}

/** A Claude model on the scripted Anthropic wire; `wire` keeps every request body. */
export function claudeOn(modelId: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createAnthropic({ apiKey: 'offline', fetch: wire.fetch })(modelId), wire };
}

/** An OpenAI-compatible model on the scripted Chat Completions wire. */
export function openaiOn(modelId: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createOpenAI({ apiKey: 'offline', fetch: wire.fetch })(modelId), wire };
}

/**
 * An OpenAI-compatible model that answers each request from its body, as a
 * model answers from the history it is sent: a step replayed after a crash
 * gets the same answer again.
 */
export function openaiAnswering(modelId: string, answer: (body: string) => string) {
  const bodies: string[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    bodies.push(body);
    return sseResponse([answer(body)]);
  }) as typeof globalThis.fetch;
  return {
    model: createOpenAI({ apiKey: 'offline', fetch })(modelId),
    calls: () => bodies.length,
    bodies: () => [...bodies],
  };
}

/** A Chat Completions turn that bills what a mock turn bills: 10 input + 5 output tokens. */
export function gptTurn(turn: Parameters<typeof openaiTurn>[0]): string {
  return openaiTurn(turn, { prompt_tokens: 10, completion_tokens: 5 });
}
