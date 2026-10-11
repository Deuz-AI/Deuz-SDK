/** Tool-loop tasks: parallel calls in one turn, and a chain where each call needs the last result. */
import { runAgent } from '../../../src/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { answerMentions, calledTools, completes, mockPrices, scripted } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

const WEATHER: Record<string, number> = { Paris: 18, Tokyo: 24 };

export const weatherReport: EvalTaskManifest = {
  id: 'tool-loop/weather-report',
  version: 1,
  title: 'Answer from two parallel tool calls',
  tags: ['tool-loop'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Weather in Paris and Tokyo, in one sentence?' }] },
  tools: { allowed: ['get_weather'] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    answerMentions('18', '24'),
    calledTools('get_weather', 'get_weather'),
    {
      name: 'answers in one sentence',
      check: (outcome) =>
        (outcome.text ?? '')
          .trim()
          .split(/[.!?](\s|$)/)
          .filter(Boolean).length === 1,
    },
  ],
  async run(context) {
    const { model } = scripted([
      {
        toolCalls: [
          { toolName: 'get_weather', args: { city: 'Paris' } },
          { toolName: 'get_weather', args: { city: 'Tokyo' } },
        ],
      },
      { text: 'Paris is 18°C and Tokyo is 24°C.' },
    ]);
    return runAgent({
      model,
      messages: context.messages,
      tools: {
        get_weather: {
          description: 'Current temperature of a city in °C.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
          execute: ({ city }: { city: string }) => ({ city, tempC: WEATHER[city] }),
        },
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
  },
};

const USERS: Record<string, string> = { 'ada@example.com': 'u-17' };
const ORDERS: Record<string, string[]> = { 'u-17': ['o-1', 'o-2', 'o-3'] };

export const chainedLookup: EvalTaskManifest = {
  id: 'tool-loop/chained-lookup',
  version: 1,
  title: 'Chain two lookups, each using the previous result',
  tags: ['tool-loop'],
  model: MOCK,
  start: {
    messages: [{ role: 'user', content: 'How many orders does ada@example.com have?' }],
  },
  tools: { allowed: ['find_user', 'list_orders'] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    answerMentions('3 orders'),
    calledTools('find_user', 'list_orders'),
    {
      name: 'list_orders got the id find_user returned',
      check: (_outcome, context) => context.store.listedFor === 'u-17',
    },
  ],
  async run(context) {
    const { model } = scripted([
      { toolCalls: [{ toolName: 'find_user', args: { email: 'ada@example.com' } }] },
      { toolCalls: [{ toolName: 'list_orders', args: { userId: 'u-17' } }] },
      { text: 'ada@example.com has 3 orders.' },
    ]);
    return runAgent({
      model,
      messages: context.messages,
      tools: {
        find_user: {
          description: 'Find a user id by email.',
          parameters: {
            type: 'object',
            properties: { email: { type: 'string' } },
            required: ['email'],
          },
          execute: ({ email }: { email: string }) => ({ userId: USERS[email] ?? null }),
        },
        list_orders: {
          description: 'List the order ids of a user.',
          parameters: {
            type: 'object',
            properties: { userId: { type: 'string' } },
            required: ['userId'],
          },
          execute: ({ userId }: { userId: string }) => {
            context.store.listedFor = userId;
            return ORDERS[userId] ?? [];
          },
        },
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
  },
};
