/**
 * Lane L2 acceptance scenarios (new.txt §5.1): the context compiler's
 * relevant selection, budget with mandatory content, refresh-limit fallback
 * and required-source failure (area `context`), and the transcript source
 * with `resolveSource` (area `transcript`). Each builds its own sources,
 * clock and stores inside the scenario.
 */
import { describe, expect } from 'vitest';
import { createContextCompiler } from '../../src/context/compiler';
import {
  createMemoryContextSource,
  createRagContextSource,
  createSkillsContextSource,
  createTranscriptContextSource,
} from '../../src/context/sources';
import type {
  ContextCandidate,
  ContextManifestEntry,
  ContextPackage,
  ContextSource,
  ContextStepInput,
} from '../../src/context/types';
import type { WorkingMemorySnapshot } from '../../src/context/working-memory/types';
import { ContextBudgetExceededError } from '../../src/errors';
import { sha256Digest } from '../../src/internal/digest';
import {
  createInMemoryMemoryStore,
  memoryEmbedderFromRag,
  type MemoryRecord,
  type MemoryScope,
} from '../../src/memory';
import type {
  MemoryRecallInput,
  MemorySession,
  MemorySourceRef,
  VersionedMemoryHit,
} from '../../src/memory/versioned/types';
import { hybridRetrieve } from '../../src/rag';
import { createSkillRegistry, staticSkillSource } from '../../src/skills';
import type { ChatRecord } from '../../src/chat';
import type {
  TranscriptHit,
  TranscriptIndex,
  TranscriptMessage,
} from '../../src/types/chat-conditional';
import type { Message } from '../../src/types/message';
import type { CallWarning } from '../../src/types/methods';
import { corpusIndex, embedText } from '../fixtures/retrieval-corpus';
import { scenario } from './registry';

const clock = { now: () => 5_000, setTimeout: () => () => {} };

function step(
  n: number,
  messages: Message[],
  extra: Partial<ContextStepInput> = {},
): ContextStepInput {
  return {
    runId: 'run-l2',
    step: n,
    messages,
    model: { provider: 'test', modelId: 'm', contextWindow: 200_000, maxOutputTokens: 8_000 },
    overheadTokens: 800,
    ...extra,
  };
}

function workingMemory(
  activeTaskId: string,
  revision: number,
  constraints: string[] = [],
): WorkingMemorySnapshot {
  return {
    kind: 'deuz-working-memory',
    version: 1,
    revision,
    scope: 'tenant-l2',
    goal: { text: 'Organise the Izmir offsite', writer: 'host', revision: 1, at: 0 },
    constraints: constraints.map((text, index) => ({
      id: `c${index + 1}`,
      text,
      writer: 'host' as const,
      revision: 1,
      at: 0,
    })),
    tasks: {
      list: {
        goal: 'offsite',
        tasks: [
          { id: 'flights', title: 'Book flights for the team', status: 'in_progress' },
          { id: 'hotel', title: 'Reserve the hotel', status: 'pending' },
          { id: 'budget', title: 'Send the expense summary', status: 'pending' },
        ],
      },
      listRevision: 1,
      activeTaskId,
    },
    observations: [],
    hypotheses: [],
    decisions: [],
    questions: [],
    attempts: [],
    applied: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const selected = (pkg: ContextPackage, source: string): ContextManifestEntry[] =>
  pkg.manifest.entries.filter((entry) => entry.source === source && entry.selected);

const appendText = (pkg: ContextPackage): string =>
  (pkg.blocks.find((block) => block.placement === 'append')?.messages[0]?.content as string) ?? '';

function skillsRegistry() {
  const skill = (name: string, description: string, body: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  return createSkillRegistry({
    source: staticSkillSource({
      'travel-booking': {
        raw: skill(
          'travel-booking',
          'Book business flights and hotels in the travel portal',
          'TRAVEL SKILL BODY: open the portal, pick economy.',
        ),
      },
      'expense-report': {
        raw: skill(
          'expense-report',
          'File an expense report with receipts',
          'EXPENSE SKILL BODY: attach receipts.',
        ),
      },
      'incident-runbook': {
        raw: skill(
          'incident-runbook',
          'Run an incident channel and postmortem',
          'INCIDENT SKILL BODY',
        ),
      },
    }),
  });
}

describe('L2 context scenarios', () => {
  scenario('context', 'relevant-selection', async () => {
    // RAG over the labelled corpus, legacy memory with an embedder, and the skill catalog.
    const { store, bm25, embedder } = await corpusIndex();
    const rag = createRagContextSource({
      retrieve: (query, topK) =>
        hybridRetrieve(query, { embedder, store, bm25 }, { topK, perStageK: 20 }),
    });
    const memoryStore = createInMemoryMemoryStore();
    const scope: MemoryScope = { userId: 'ada' };
    const facts = [
      ['pref-seat', 'Ada prefers a window seat on business flights'],
      ['pref-airline', 'Ada flies with the national airline when she books a flight'],
      ['pet', 'Ada has a cat called Pamuk who sleeps on the keyboard during long video calls'],
      ['music', 'Ada listens to jazz and old Turkish records while coding late in the evening'],
      ['garden', 'Ada grows tomatoes and peppers on her balcony every summer in Ankara'],
      ['language', 'Ada is learning Japanese and practises with a tutor on Tuesday evenings'],
      ['editor', 'Ada uses a dark editor theme with a large monospace font for reviews'],
      ['coffee', 'Ada drinks her coffee black and avoids anything with sugar or syrup'],
    ] as const;
    await memoryStore.upsert(
      facts.map(
        ([id, text]): MemoryRecord => ({
          id,
          text,
          hash: id,
          kind: 'semantic',
          scope,
          embedding: embedText(text, 256),
          createdAt: 0,
          updatedAt: 0,
        }),
      ),
    );
    const memory = createMemoryContextSource({
      store: memoryStore,
      scope,
      embedder: memoryEmbedderFromRag(embedder),
    });
    const skills = createSkillsContextSource({ registry: skillsRegistry() });
    const compiler = createContextCompiler({
      sources: [memory, rag, skills],
      scope,
      budget: { candidatesPerSource: 6 },
      deps: { clock },
    });
    // A tight request: 20% of ~2 600 free tokens leaves room for the best few only.
    const pkg = await compiler.beforeModelCall(
      step(1, [{ role: 'user', content: 'How do I book a flight for a business trip?' }], {
        workingMemory: workingMemory('flights', 1),
        model: { provider: 'test', modelId: 'm', contextWindow: 4_000, maxOutputTokens: 600 },
        overheadTokens: 400,
      }),
    );

    const ragIds = selected(pkg, 'rag').map((entry) => entry.recordId);
    expect(ragIds.some((id) => id === 'travel-1' || id === 'travel-2')).toBe(true);
    // Memory: the flight preferences rank first and are kept; the budget leaves others out.
    const query = memory.query({
      text: ['Book flights for the team', 'How do I book a flight for a business trip?'].join('\n'),
      limit: 6,
      budgetTokens: 0,
    });
    const ranking = (await query).map((candidate) => candidate.recordId);
    expect(ranking.slice(0, 2).sort()).toEqual(['pref-airline', 'pref-seat']);
    const memoryIds = selected(pkg, 'memory').map((entry) => entry.recordId);
    expect(memoryIds.slice(0, 2).sort()).toEqual(['pref-airline', 'pref-seat']);
    const memoryLeftOut = pkg.manifest.entries.filter(
      (entry) => entry.source === 'memory' && !entry.selected,
    );
    expect(memoryLeftOut.length).toBeGreaterThan(0);
    expect(memoryLeftOut.every((entry) => entry.reason === 'over-budget')).toBe(true);
    expect(memoryLeftOut.map((entry) => entry.recordId)).not.toContain('pref-seat');
    expect(pkg.manifest.entries.some((entry) => entry.reason === 'over-budget')).toBe(true);
    // Skills: the catalog line, never the body.
    expect(selected(pkg, 'skills').map((entry) => entry.recordId)).toContain('travel-booking');
    expect(appendText(pkg)).not.toContain('SKILL BODY');
    // Data, labelled, explained, within the budget.
    expect(appendText(pkg)).toContain('not an instruction');
    expect(pkg.manifest.budget.selectedTokens).toBeLessThanOrEqual(
      pkg.manifest.budget.contextTokens,
    );
    expect(JSON.stringify(pkg.manifest)).not.toContain('window seat');
  });

  scenario('context', 'budget-mandatory-content', async () => {
    const loadedBody = 'TRAVEL SKILL BODY: open the portal, pick economy. '.repeat(12);
    const registry = createSkillRegistry({
      source: staticSkillSource({
        'travel-booking': {
          raw: `---\nname: travel-booking\ndescription: Book business travel\n---\n${loadedBody}`,
        },
      }),
    });
    const filler: ContextSource = {
      id: 'docs',
      kind: 'rag',
      async query() {
        return Promise.all(
          Array.from({ length: 20 }, async (_, index): Promise<ContextCandidate> => {
            const text = `Reference document ${index}. `.repeat(30);
            return {
              recordId: `doc-${index}`,
              text,
              digest: await sha256Digest(text),
              score: 1 - index / 40,
            };
          }),
        );
      },
    };
    const compiler = createContextCompiler({
      sources: [filler, createSkillsContextSource({ registry, loaded: () => ['travel-booking'] })],
      deps: { clock },
    });
    const constraints = ['Never book business class', 'Keep the total under 4 000 euros'];
    const messages: Message[] = [{ role: 'user', content: 'Book the flights now.' }];
    const tight = {
      model: { provider: 'test', modelId: 'm', contextWindow: 6_000, maxOutputTokens: 1_000 },
      overheadTokens: 400,
      workingMemory: workingMemory('flights', 1, constraints),
    };
    const pkg = await compiler.beforeModelCall(step(1, messages, tight));

    // Mandatory content is whole: the loaded skill and every host constraint.
    expect(appendText(pkg)).toContain(loadedBody.trim());
    expect(
      selected(pkg, 'skills').find((entry) => entry.recordId === 'travel-booking/SKILL.md'),
    ).toMatchObject({ reason: 'mandatory' });
    const tail = pkg.blocks.find((block) => block.placement === 'ephemeral-tail')!;
    for (const constraint of constraints) expect(tail.messages[0]!.content).toContain(constraint);
    // Optional content fills only what the budget leaves.
    const docs = pkg.manifest.entries.filter((entry) => entry.source === 'docs');
    expect(docs.some((entry) => entry.selected)).toBe(true);
    expect(docs.some((entry) => entry.reason === 'over-budget')).toBe(true);
    const optionalTokens = docs.filter((e) => e.selected).reduce((sum, e) => sum + e.tokens, 0);
    expect(optionalTokens).toBeLessThanOrEqual(pkg.manifest.budget.contextTokens);

    // When mandatory content cannot fit, the call fails explicitly instead of cutting it.
    const starved = createContextCompiler({
      sources: [createSkillsContextSource({ registry, loaded: () => ['travel-booking'] })],
    });
    await expect(
      starved.beforeModelCall(
        step(1, messages, {
          ...tight,
          model: { provider: 'test', modelId: 'm', contextWindow: 1_500, maxOutputTokens: 1_000 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'context_budget_exceeded', phase: 'compile' });
    // On an overflow retry the same rule holds under the smaller budget.
    await compiler.beforeModelCall(step(2, messages, tight));
    const overflow = compiler.onOverflow({ ...step(2, messages, tight), inputTokens: 700 });
    await expect(overflow).rejects.toBeInstanceOf(ContextBudgetExceededError);
    await expect(overflow).rejects.toMatchObject({ phase: 'overflow-retry' });
  });

  scenario('context', 'refresh-limit-fallback', async () => {
    const calls: string[] = [];
    const memory: ContextSource = {
      id: 'memory',
      kind: 'memory',
      async query(request) {
        calls.push(request.text);
        const text = `Fact for: ${request.text}`;
        return [
          { recordId: `fact-${calls.length}`, text, digest: await sha256Digest(text), score: 1 },
        ];
      },
    };
    const compiler = createContextCompiler({ sources: [memory], deps: { clock } });
    const history: Message[] = [{ role: 'user', content: 'Plan the offsite.' }];
    const plan: Array<[task: string, refresh?: boolean]> = [
      ['flights'], // 1: initial
      ['hotel'], // 2: task changed, but within minSteps
      ['hotel'], // 3: due: active-task-changed
      ['hotel', true], // 4: host request
      ['budget'], // 5: within minSteps of 4
      ['budget'], // 6: due: active-task-changed (pass 4)
      ['budget', true], // 7: host request past the limit
      ['budget'], // 8: nothing due
    ];
    const packages: ContextPackage[] = [];
    for (const [index, [task, refresh]] of plan.entries()) {
      const pkg = await compiler.beforeModelCall(
        step(index + 1, history, {
          workingMemory: workingMemory(task, index + 1),
          ...(refresh ? { refresh } : {}),
        }),
      );
      packages.push(pkg);
      history.push(...(pkg.blocks.find((b) => b.placement === 'append')?.messages ?? []));
      history.push({ role: 'assistant', content: `step ${index + 1} done` });
    }
    expect(calls).toHaveLength(4);
    expect(
      packages.map((pkg) => [pkg.manifest.refresh, pkg.manifest.pass, pkg.manifest.fallback]),
    ).toEqual([
      ['initial', 1, undefined],
      ['reused', 1, undefined],
      ['active-task-changed', 2, undefined],
      ['host-request', 3, undefined],
      ['reused', 3, undefined],
      ['active-task-changed', 4, undefined],
      ['reused', 4, 'pass-limit'],
      ['reused', 4, undefined],
    ]);
    // The working memory is compiled every step, past the limit too.
    for (const [index, pkg] of packages.entries()) {
      const tail = pkg.blocks.find((block) => block.placement === 'ephemeral-tail')!;
      expect(tail.messages[0]!.content).toContain(`revision="${index + 1}"`);
    }
    // Earlier retrieval stays in history; reuse appends nothing.
    expect(packages[6]!.blocks.map((block) => block.placement)).toEqual(['ephemeral-tail']);
    expect(compiler.state()).toMatchObject({ passes: 4, lastRefreshStep: 6 });
  });

  scenario(
    'context',
    'required-source-failure',
    async () => {
      const outage = new Error('policy service unavailable');
      let policyCalls = 0;
      const policies: ContextSource = {
        id: 'policies',
        kind: 'rag',
        required: true,
        async query() {
          policyCalls++;
          throw outage;
        },
      };
      const flaky: ContextSource = {
        id: 'web-notes',
        kind: 'rag',
        async query() {
          throw new TypeError('notes index offline');
        },
      };
      const memoryText = 'Ada prefers morning flights';
      const memory: ContextSource = {
        id: 'memory',
        kind: 'memory',
        async query() {
          return [
            { recordId: 'm1', text: memoryText, digest: await sha256Digest(memoryText), score: 1 },
          ];
        },
      };
      const messages: Message[] = [{ role: 'user', content: 'Book the flight.' }];

      // A required source that fails stops the model call with its own error, changing nothing.
      const strict = createContextCompiler({ sources: [memory, policies], deps: { clock } });
      await expect(strict.beforeModelCall(step(1, messages))).rejects.toBe(outage);
      expect(policyCalls).toBe(1);
      expect(strict.state()).toEqual({ version: 1, passes: 0, placed: [] });

      // An optional source that fails is a warning; the package is built without it.
      const warnings: CallWarning[] = [];
      const lenient = createContextCompiler({
        sources: [memory, flaky],
        deps: { clock },
        onWarning: (warning) => warnings.push(warning),
      });
      const pkg = await lenient.beforeModelCall(step(1, messages));
      expect(pkg.manifest.fallback).toBe('source-failed');
      expect(pkg.manifest.sources.map((s) => [s.source, s.status])).toEqual([
        ['memory', 'ok'],
        ['web-notes', 'failed'],
      ]);
      expect(appendText(pkg)).toContain(memoryText);
      expect(warnings.map((warning) => [warning.type, warning.setting])).toEqual([
        ['context-source-failed', 'web-notes'],
      ]);
    },
    { fault: true },
  );
});

/** A small in-memory transcript index for the scenario (lane L7A builds the real ones). */
function fakeTranscriptIndex(): TranscriptIndex {
  const chats = new Map<string, ChatRecord>();
  const within = (record: ChatRecord, scope: MemoryScope) =>
    (Object.keys(scope) as (keyof MemoryScope)[]).every(
      (key) => scope[key] === undefined || record.scope[key] === scope[key],
    );
  const entry = (record: ChatRecord, index: number): TranscriptMessage => ({
    chatId: record.chatId,
    messageId: record.messageIds?.[index] ?? `${record.chatId}-${index}`,
    index,
    message: record.messages[index]!,
  });
  return {
    async index(record) {
      chats.set(record.chatId, record);
    },
    async remove(chatId) {
      chats.delete(chatId);
    },
    async search(scope, query, options) {
      const words = query
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 3);
      const hits: TranscriptHit[] = [];
      for (const record of chats.values()) {
        if (!within(record, scope)) continue;
        if (options?.chatIds && !options.chatIds.includes(record.chatId)) continue;
        record.messages.forEach((message, index) => {
          const text = typeof message.content === 'string' ? message.content.toLowerCase() : '';
          const score = words.filter((word) => text.includes(word)).length;
          if (score > 0) hits.push({ ...entry(record, index), score });
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, options?.limit ?? 10);
    },
    async resolveSource(scope, ref) {
      const record = ref.chatId ? chats.get(ref.chatId) : undefined;
      if (!record || !within(record, scope)) return undefined;
      const index = record.messageIds?.indexOf(ref.messageId ?? '') ?? -1;
      return index >= 0 ? entry(record, index) : undefined;
    },
  };
}

describe('L2 transcript scenario', () => {
  scenario('transcript', 'compiler-source-resolve', async () => {
    const index = fakeTranscriptIndex();
    const chat = (
      id: string,
      scope: MemoryScope,
      texts: Array<[Message['role'], string]>,
    ): ChatRecord => ({
      chatId: id,
      scope,
      messages: texts.map(([role, content]) => ({ role, content })),
      messageIds: texts.map((_, i) => `${id}-m${i}`),
      updatedAt: 0,
    });
    await index.index(
      chat('trip-chat', { userId: 'ada' }, [
        ['user', 'For the Izmir offsite I want flights on Friday morning.'],
        ['assistant', 'Noted: Friday morning flights to Izmir.'],
      ]),
    );
    await index.index(
      chat('budget-chat', { userId: 'ada' }, [['user', 'My manager approved 4 000 euros.']]),
    );
    await index.index(
      chat('other-user', { userId: 'bob' }, [['user', 'Izmir flights for Bob on Sunday.']]),
    );

    // A recalled memory record cites the message it came from.
    const digest = await sha256Digest('My manager approved 4 000 euros.');
    const cited: MemorySourceRef = {
      kind: 'user',
      chatId: 'budget-chat',
      messageId: 'budget-chat-m0',
      digest,
    };
    const foreign: MemorySourceRef = {
      kind: 'user',
      chatId: 'other-user',
      messageId: 'other-user-m0',
      digest,
    };
    const hit: VersionedMemoryHit = {
      record: {
        id: 'budget-limit',
        revision: 1,
        scope: { userId: 'ada' },
        text: 'The offsite budget is 4 000 euros',
        kind: 'semantic',
        origin: 'inferred',
        sources: [cited, foreign],
        status: 'active',
        operationId: 'op-1',
        recordedAt: 1,
        createdAt: 1,
        digest,
      },
      score: 0.9,
      match: 'lexical',
    };
    const recalled: VersionedMemoryHit[] = [];
    const session = {
      scope: { userId: 'ada' },
      recall: async (_input: MemoryRecallInput) => {
        recalled.splice(0, recalled.length, hit);
        return [hit];
      },
    } as unknown as MemorySession;

    const transcript = createTranscriptContextSource({
      index,
      scope: { userId: 'ada' },
      around: 1,
      refs: () => recalled.flatMap((h) => h.record.sources),
    });
    // The memory source runs first in the config, so its citations are known to the transcript source.
    const memory = createMemoryContextSource({ session });
    const sequential: ContextSource = {
      id: 'transcript',
      kind: 'transcript',
      query: async (request) => {
        await memory.query(request);
        return transcript.query(request);
      },
    };
    const compiler = createContextCompiler({
      sources: [memory, sequential],
      scope: { userId: 'ada' },
      deps: { clock },
    });
    const pkg = await compiler.beforeModelCall(
      step(1, [{ role: 'user', content: 'Which Izmir flights did we agree on?' }]),
    );
    const transcriptEntries = selected(pkg, 'transcript').map((entry) => entry.recordId);
    expect(transcriptEntries).toContain('budget-chat/budget-chat-m0'); // resolved citation
    expect(transcriptEntries.some((id) => id.startsWith('trip-chat/'))).toBe(true); // search hit
    expect(transcriptEntries.some((id) => id.startsWith('other-user/'))).toBe(false); // other scope
    const text = appendText(pkg);
    expect(text).toContain('kind="transcript"');
    expect(text).toContain('My manager approved 4 000 euros.');
    expect(text).not.toContain('Bob');

    // resolveSource keeps its scope check, and a source never widens its pinned scope.
    expect(await index.resolveSource({ userId: 'ada' }, foreign)).toBeUndefined();
    await expect(
      transcript.query({ text: 'Izmir', limit: 5, budgetTokens: 0, scope: { userId: 'bob' } }),
    ).rejects.toThrow(TypeError);
  });
});
