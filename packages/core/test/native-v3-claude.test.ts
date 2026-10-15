/**
 * native-v3-claude.test.ts (2.4, spec §2.3 "Yerleşim ve prompt cache") — on
 * a Claude 5.x model, which binds preserved thinking to the transcript
 * prefix (an earlier turn rewritten drops it, `drop_block`), a V3 run's
 * context placement never rewrites anything earlier: across a retrieval
 * refresh every request starts with the previous request's blocks (thinking
 * signatures included), only the working memory tail is replaced, and the
 * system prompt and tools never change.
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { createContextCompiler } from '../src/context/compiler';
import { candidate, fakeSource, recordingStoreV3 } from './fixtures/native-v3';
import { claudeTurn, scriptedFetch } from './fixtures/wire-turns';

const parameters = { type: 'object', properties: {} };

interface ClaudeRequest {
  system?: unknown;
  tools?: unknown;
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
}

/** A request's conversation as one list of role-tagged blocks (adjacent turns may merge). */
function blocks(request: ClaudeRequest): string[] {
  return request.messages.flatMap((message) =>
    typeof message.content === 'string'
      ? [JSON.stringify([message.role, { type: 'text', text: message.content }])]
      : message.content.map((block) => JSON.stringify([message.role, block])),
  );
}

const isTail = (block: string) => block.includes('<deuz_working_memory ');

describe('V3 placement on a model that binds thinking to the prefix', () => {
  it('only appends: every request starts with the previous one, its tail aside', async () => {
    const script = scriptedFetch([
      claudeTurn(
        [
          { type: 'thinking', text: 'look it up', signature: 'sig-1' },
          { type: 'tool_use', id: 't1', name: 'lookup', json: '{}' },
        ],
        'tool_use',
      ),
      claudeTurn(
        [
          { type: 'thinking', text: 'and again', signature: 'sig-2' },
          { type: 'tool_use', id: 't2', name: 'lookup', json: '{}' },
        ],
        'tool_use',
      ),
      claudeTurn([
        { type: 'thinking', text: 'done', signature: 'sig-3' },
        { type: 'text', text: 'All set.' },
      ]),
    ]);
    const answer = [candidate('doc-1', 'Deploys go to eu-west.')];
    const compiler = createContextCompiler({ sources: [fakeSource('docs', 'rag', answer).source] });
    let lookups = 0;
    const result = await runAgent({
      model: createAnthropic({ apiKey: 'k', fetch: script.fetch })('claude-opus-5-5'),
      instructions: 'Be careful.',
      prompt: 'Deploy the service',
      checkpointVersion: 3,
      session: { store: recordingStoreV3(), runId: 'run-claude', scope: 'tenant' },
      tools: {
        lookup: {
          parameters,
          execute: () => {
            // The first lookup teaches the host something: it asks for a refresh.
            if (++lookups === 1) {
              answer.push(candidate('doc-2', 'The deploy window is 02:00 UTC.'));
              compiler.requestRefresh();
            }
            return 'ok';
          },
        },
      },
      context: compiler,
      workingMemory: { create: { scope: 'tenant', goal: 'Deploy safely', now: 1 } },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'All set.' });
    const requests = script.bodies as unknown as ClaudeRequest[];
    expect(requests).toHaveLength(3);
    for (let k = 1; k < requests.length; k++) {
      const before = blocks(requests[k - 1]!);
      const after = blocks(requests[k]!);
      expect(isTail(before.at(-1)!)).toBe(true);
      expect(isTail(after.at(-1)!)).toBe(true);
      // Byte for byte, the earlier blocks (thinking signatures included) are kept.
      expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
      expect(requests[k]!.system).toEqual(requests[0]!.system);
      expect(requests[k]!.tools).toEqual(requests[0]!.tools);
    }
    // The refresh at step 1 appended its new record after step 0's turn, and
    // step 1's own turn followed it: nothing was inserted before an earlier block.
    const last = blocks(requests[2]!).join('\n');
    expect(last.indexOf('02:00 UTC')).toBeGreaterThan(last.indexOf('sig-1'));
    expect(last.indexOf('02:00 UTC')).toBeLessThan(last.indexOf('sig-2'));
  });
});
