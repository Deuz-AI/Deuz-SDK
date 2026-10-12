/**
 * A native run with memory and a chat (2.3, 23.4): the run continues a stored
 * chat, recalls the user's preference once, acts on it, extracts what it
 * learned once it completed, and projects its turns into the chat after its
 * checkpoint (native-agents.mdx, "Memory, chat and model fail-over").
 */
import { createInMemoryAgentRunStore, runAgent } from '../../../src/agent-run';
import { createInMemoryChatStore } from '../../../src/chat';
import type { Message } from '../../../src/types/message';
import type { EvalTaskManifest } from '../../../src/testing';
import {
  completes,
  memoryRecord,
  offline,
  runWith,
  watchedMemory,
  type TaskModel,
} from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };
const ADA = { userId: 'ada' };
const ASK = 'Book me a seat on the 9:40 train to Ankara.';
const LEARNED = 'booked the 9:40 train to Ankara';

interface Booking {
  train: string;
  seat: string;
}

const isRecall = (message: Message) =>
  message.role === 'system' &&
  (message.providerMetadata?.deuz as { memoryRecall?: boolean } | undefined)?.memoryRecall === true;

/** Run the booking on `on`'s model, with ada's memory and her stored chat. */
export function bookWithMemory(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const memory = await watchedMemory(
      [memoryRecord('pref-1', 'prefers window seats', ADA)],
      [LEARNED],
    );
    // The chat so far, as an earlier run left it in the chat store.
    const chats = createInMemoryChatStore();
    await chats.saveChat({
      chatId: 'chat-ada',
      scope: ADA,
      messages: context.messages.slice(0, -1),
      messageIds: ['m-1', 'm-2'],
      updatedAt: 1,
    });
    const runs = createInMemoryAgentRunStore();
    const bookings: Booking[] = [];
    context.store.bookings = bookings;
    const result = await runAgent({
      ...runWith(on, context),
      messages: context.messages,
      memory: { seams: memory.seams, scope: ADA },
      chat: { store: chats, chatId: 'chat-ada', scope: ADA },
      session: { store: runs, runId: 'seat-2', scope: 'eval' },
      tools: {
        book_seat: {
          description: 'Book one seat on a train.',
          parameters: {
            type: 'object',
            properties: {
              train: { type: 'string', description: 'Departure time, HH:MM.' },
              seat: { type: 'string', enum: ['window', 'aisle'] },
            },
            required: ['train', 'seat'],
          },
          execute: ({ train, seat }: Booking) => {
            context.effect(`book:${train}:${seat}`);
            bookings.push({ train, seat });
            return `booked a ${seat} seat on the ${train}`;
          },
        },
      },
    });
    const envelope = await runs.load('seat-2');
    context.store.recall = {
      // The extraction searches too, for the facts it found; the recall asks the question.
      asked: memory.searches.filter((query) => query.text === ASK).length,
      status: envelope?.memory?.recall?.status,
      inHistory: (envelope?.messages ?? []).filter(isRecall).length,
    };
    const record = await chats.loadChat('chat-ada');
    context.store.chat = {
      status: envelope?.chat?.status,
      ids: record?.messageIds,
      isTranscript:
        JSON.stringify(record?.messages) === JSON.stringify(envelope?.transcript?.messages),
    };
    const extraction = envelope?.memory?.extraction;
    context.store.extraction = {
      status: extraction?.status,
      mutations: extraction?.mutations,
      written: (await memory.store.list(ADA))
        .filter((entry) => (entry.metadata?.deuz as { runId?: string } | undefined)?.runId)
        .map((entry) => ({
          text: entry.text,
          ofOperation:
            (entry.metadata?.deuz as { operationId?: string }).operationId ===
            extraction?.operationId,
        })),
    };
    return result;
  };
}

export const rememberedSeat: EvalTaskManifest = {
  id: 'memory-chat/remembered-seat',
  version: 1,
  title: 'Book with a preference from memory, continuing a stored chat',
  tags: ['memory', 'chat', 'native'],
  model: MOCK,
  start: {
    messages: [
      { role: 'user', content: 'I always take a window seat.' },
      { role: 'assistant', content: 'Noted: window seats from now on.' },
      { role: 'user', content: ASK },
    ],
  },
  tools: { allowed: ['book_seat'] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    {
      name: 'booked one window seat on the 9:40',
      check: (_outcome, context) => {
        const bookings = context.store.bookings as Booking[];
        return (
          bookings.length === 1 &&
          bookings[0]!.seat === 'window' &&
          /\b0?9:40\b/.test(bookings[0]!.train)
        );
      },
    },
    {
      name: "recalled once, with the user's question, into the run's history",
      check: (_outcome, context) =>
        JSON.stringify(context.store.recall) ===
        JSON.stringify({ asked: 1, status: 'recalled', inHistory: 1 }),
    },
    {
      name: 'the chat continues its stored record, the earlier ids kept',
      check: (_outcome, context) => {
        const chat = context.store.chat as {
          status?: string;
          ids?: string[];
          isTranscript: boolean;
        };
        return (
          chat.status === 'saved' &&
          chat.isTranscript &&
          JSON.stringify(chat.ids?.slice(0, 2)) === JSON.stringify(['m-1', 'm-2']) &&
          (chat.ids ?? []).slice(2).every((id, index) => id === `seat-2:${index + 2}`) &&
          (chat.ids ?? []).length > 3
        );
      },
    },
    {
      name: "what the run learned was extracted once, under the run's operation",
      check: (_outcome, context) =>
        JSON.stringify(context.store.extraction) ===
        JSON.stringify({
          status: 'completed',
          mutations: 1,
          written: [{ text: LEARNED, ofOperation: true }],
        }),
    },
  ],
  run: bookWithMemory(
    offline([
      {
        toolCalls: [{ toolName: 'book_seat', id: 's1', args: { train: '09:40', seat: 'window' } }],
      },
      { text: 'Booked a window seat on the 9:40 train to Ankara.' },
    ]),
  ),
};
