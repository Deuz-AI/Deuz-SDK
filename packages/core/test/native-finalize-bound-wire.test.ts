/**
 * native-finalize-bound-wire.test.ts (2.3, F22 hand-off from D1 to D2) — on a
 * model that binds thinking to the request prefix (Claude 5.x on the Anthropic
 * wire), every loop request carries the ROOT agent's declared tools and a
 * handoff rides the transcript as a tool-set change. A native finalization on a
 * leg that did not run the loop (a resume after the loop completed) rebuilds
 * its tool request: it must be that same declared wire, not the active agent's
 * own tools, or the prefix the thinking is bound to changes. Not live-verified.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { handoff } from '../src/inference/handoff';
import type { AgentRunOptions, AgentRunSession, AgentRunStore } from '../src/types/agent-run';
import { claudeTurn, scriptedFetch, type ScriptStep } from './fixtures/wire-turns';

const parameters = { type: 'object' as const, properties: {} };

function claude(id: string, script: ScriptStep[]) {
  const wire = scriptedFetch(script);
  return { model: createAnthropic({ apiKey: 'k', fetch: wire.fetch })(id), wire };
}

describe('native finalization on a bound model after a handoff', () => {
  it('a resumed finalization sends the loop’s declared tools', async () => {
    const root = claude('claude-opus-5-5', [
      claudeTurn(
        [{ type: 'tool_use', id: 'toolu_t', name: 'transfer_to_expert', json: '{}' }],
        'tool_use',
      ),
    ]);
    const expert = claude('claude-sonnet-5-5', [
      claudeTurn([{ type: 'text', text: 'draft' }]),
      claudeTurn([{ type: 'text', text: '{"answer":1}' }]),
    ]);
    const inner = createInMemoryAgentRunStore();
    let crash = true;
    const store: AgentRunStore = {
      load: inner.load,
      save: (envelope) => {
        // The persist right before the first finalization call.
        if (crash && envelope.phase === 'finalizing' && envelope.finalizationAttempts === 1) {
          crash = false;
          throw new Error('process died');
        }
        return inner.save(envelope);
      },
    };
    const options: AgentRunOptions<{ answer: number }> & { session: AgentRunSession } = {
      model: root.model,
      prompt: 'ask the expert',
      session: { store, runId: 'bound-final', scope: 'tenant' },
      tools: {
        lookup: { parameters, execute: () => 'v' },
        ...handoff({
          expert: { model: expert.model, tools: { deep: { parameters, execute: () => 'd' } } },
        }),
      },
      output: {
        schema: { type: 'object', properties: { answer: { type: 'number' } } },
        mode: 'json',
        validate: (value) => value as { answer: number },
      },
    };
    expect((await runAgent(options)).status).toBe('failed');
    const resumed = await resumeAgent(options);
    expect(resumed).toMatchObject({ status: 'completed', output: { answer: 1 } });
    const [loopRequest, finalRequest] = expert.wire.bodies as { tools?: unknown }[];
    expect(finalRequest!.tools).toEqual(loopRequest!.tools);
  });
});
