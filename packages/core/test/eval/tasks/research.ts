/**
 * Sourced research against a mock search index: the answer must cite only
 * pages the run actually fetched, and every figure it states must appear in one.
 */
import { runAgent } from '../../../src/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { completes, offline, runWith, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

const PAGES: Record<string, { title: string; body: string }> = {
  'https://docs.example.org/rivers/danube': {
    title: 'Danube',
    body: 'The Danube is 2,850 km long and flows through 10 countries.',
  },
  'https://docs.example.org/rivers/rhine': {
    title: 'Rhine',
    body: 'The Rhine is 1,230 km long and reaches the North Sea.',
  },
  'https://blog.example.net/rivers-ranked': {
    title: 'Rivers ranked (opinion)',
    body: 'Some say the Rhine is the longest river in Europe.',
  },
};

const ANSWER =
  'The Danube (2,850 km) is longer than the Rhine (1,230 km). ' +
  'Sources: [1] https://docs.example.org/rivers/danube [2] https://docs.example.org/rivers/rhine';

/** URLs in an answer, bare or inside a markdown link, without trailing punctuation. */
const URL_PATTERN = /https:\/\/[^\s)\]>"'`]+/g;
const urlsIn = (text: string): string[] =>
  (text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:]+$/, ''));

export const sourcedAnswer: EvalTaskManifest = {
  id: 'research/sourced-answer',
  version: 1,
  title: 'Answer with citations to fetched sources only',
  tags: ['research'],
  model: MOCK,
  start: {
    messages: [
      { role: 'user', content: 'Which is longer, the Danube or the Rhine? Cite sources.' },
    ],
  },
  tools: { allowed: ['search', 'fetch_page'] },
  budget: { usd: 0.01 },
  artifacts: ['citations'],
  acceptance: [
    completes,
    {
      name: 'cites at least two sources',
      check: (outcome) => urlsIn(outcome.text ?? '').length >= 2,
    },
    {
      name: 'cites only fetched pages',
      check: (outcome, context) => {
        const fetched = (context.store.fetched as string[] | undefined) ?? [];
        return urlsIn(outcome.text ?? '').every((url) => fetched.includes(url));
      },
    },
    {
      name: 'every figure appears in a fetched page',
      check: (outcome, context) => {
        const fetched = ((context.store.fetched as string[] | undefined) ?? []).map(
          (url) => PAGES[url]!.body,
        );
        const figures = (outcome.text ?? '').replace(URL_PATTERN, '').match(/\d[\d,]*/g);
        return (figures ?? [])
          .filter((figure) => figure.length > 1)
          .every((figure) => fetched.some((body) => body.includes(figure)));
      },
    },
  ],
  run: researchRivers(
    offline([
      { toolCalls: [{ toolName: 'search', args: { query: 'Danube Rhine length' } }] },
      {
        toolCalls: [
          { toolName: 'fetch_page', args: { url: 'https://docs.example.org/rivers/danube' } },
          { toolName: 'fetch_page', args: { url: 'https://docs.example.org/rivers/rhine' } },
        ],
      },
      { text: ANSWER },
    ]),
  ),
};

/** Run the research on `on`'s model. */
export function researchRivers(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const fetched: string[] = [];
    context.store.fetched = fetched;
    const result = await runAgent({
      ...runWith(on, context),
      messages: context.messages,
      tools: {
        search: {
          description: 'Search the index. Returns urls, titles and snippets.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          execute: () =>
            Object.entries(PAGES).map(([url, page]) => ({
              url,
              title: page.title,
              snippet: page.body.slice(0, 40),
            })),
        },
        fetch_page: {
          description: 'Fetch the full text of a page from the index.',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
          execute: ({ url }: { url: string }) => {
            const page = PAGES[url];
            if (!page) throw new Error(`not in the index: ${url}`);
            fetched.push(url);
            return page.body;
          },
        },
      },
    });
    context.artifact('citations', urlsIn(result.text));
    return result;
  };
}
