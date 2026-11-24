// A `deuz acp` module for the tests: a mock model, no tools.
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createMockModel } from '@deuz-sdk/core/testing';

export default {
  info: { name: 'fixture-agent', version: '1.0.0' },
  run: { model: createMockModel({ responses: [{ text: 'hello from the fixture' }] }) },
};

/** A factory export: called with the arguments after `--`. */
export function factory({ argv }) {
  return {
    info: { name: `factory-${argv[0] ?? 'none'}`, version: '1.0.0' },
    run: { model: createMockModel({ responses: [{ text: 'factory reply' }] }) },
  };
}

/** Wrong shape: no `run`. */
export const broken = { info: { name: 'broken', version: '0' } };

/**
 * A model the bundled price table knows (claude-opus-5-5), on a scripted
 * Anthropic wire: 1,000 input and 500 output tokens a turn, no network.
 */
function scriptedAnthropic() {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return async (_url, init) => {
    const { model } = JSON.parse(String(init?.body ?? '{}'));
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model, content: [] };
    const body =
      event('message_start', {
        type: 'message_start',
        message: { ...message, stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1 } },
      }) +
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'priced reply' },
      }) +
      event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 500 },
      }) +
      event('message_stop', { type: 'message_stop' });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
}

/** No `deps.priceProvider`: `deuz acp --budget-usd` must price it by itself. */
export const priced = {
  info: { name: 'priced-agent', version: '1.0.0' },
  run: {
    model: createAnthropic({ apiKey: 'test-key', fetch: scriptedAnthropic() })('claude-opus-5-5'),
    maxOutputTokens: 1000,
  },
};
