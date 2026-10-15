import { expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { candidate, fakeSource, recordingStoreV3 } from './fixtures/native-v3';
import { claudeTurn, scriptedFetch } from './fixtures/wire-turns';

it('review S1: the WM tail sits before the next thinking block', async () => {
  const script = scriptedFetch([
    claudeTurn(
      [
        { type: 'thinking', text: 'look it up', signature: 'sig-1' },
        { type: 'tool_use', id: 't1', name: 'lookup', json: '{}' },
      ],
      'tool_use',
    ),
    claudeTurn([
      { type: 'thinking', text: 'done', signature: 'sig-2' },
      { type: 'text', text: 'All set.' },
    ]),
  ]);
  const result = await runAgent({
    model: createAnthropic({ apiKey: 'k', fetch: script.fetch })('claude-opus-5-5'),
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store: recordingStoreV3(), runId: 'run-claude', scope: 'tenant' },
    tools: { lookup: { parameters: { type: 'object', properties: {} }, execute: () => 'ok' } },
    context: { sources: [fakeSource('docs', 'rag', [candidate('d', 'Deploys go to eu-west.')]).source] },
    workingMemory: { create: { scope: 'tenant', goal: 'Deploy safely', now: 1 } },
  });
  expect(result.status).toBe('completed');
  const bodies = script.bodies as unknown as { messages: { role: string; content: unknown }[]; thinking?: unknown }[];
  const show = (b: (typeof bodies)[number]) =>
    b.messages.map((m) => [
      m.role,
      typeof m.content === 'string'
        ? ['text:' + m.content.slice(0, 30)]
        : (m.content as { type: string; text?: string; signature?: string }[]).map(
            (c) => c.type + ':' + (c.text ?? c.signature ?? '').slice(0, 30),
          ),
    ]);
  // eslint-disable-next-line no-console
  console.log('req0', JSON.stringify(show(bodies[0]!)));
  // eslint-disable-next-line no-console
  console.log('req1', JSON.stringify(show(bodies[1]!)), JSON.stringify(bodies[1]!.thinking));
  const firstUser0 = JSON.stringify(bodies[0]!.messages[0]);
  const firstUser1 = JSON.stringify(bodies[1]!.messages[0]);
  expect(firstUser1).toBe(firstUser0);
});
