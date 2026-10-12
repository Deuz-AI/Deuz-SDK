/**
 * 14 — Native memory and chat: one recall, extraction on completion, a chat
 * projection, and model fail-over (2.3).
 *
 * A native run binds memory, its chat and its fallback models to its
 * checkpoint. It recalls ONCE, before its first model call: the memories become
 * a system message that every later call of the run sends again. Only a run
 * that completed is extracted into memory. The chat store holds a projection of
 * the checkpoint, written after it, so a chat store that fails never fails the
 * run, and `reconcileAgentRun` writes the projection later. A model call that
 * fails with a retryable error (a 5xx, a 429, a network error) before its first
 * content goes to the next of `fallbackModels`, inside the same run.
 */
import { generateText } from '@deuz-sdk/core';
import { createInMemoryAgentRunStore, reconcileAgentRun, streamAgent } from '@deuz-sdk/core/agent';
import type { AgentRunOptions, AgentRunSession } from '@deuz-sdk/core/agent';
import { createInMemoryChatStore } from '@deuz-sdk/core/chat';
import type { ChatStore } from '@deuz-sdk/core/chat';
import { createInMemoryMemoryStore } from '@deuz-sdk/core/memory';
import type { MemoryCallOptions, MemoryStore } from '@deuz-sdk/core/memory';
import { createOpenAI } from '@deuz-sdk/core/openai';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODELS -----------------------------------------------------------------
// No API key and no network. The primary's provider is down for this whole
// session: its fetch answers every request with a 503 itself. The fallback and
// the memory model are scripted, one reply per call, in order.
// REAL PROVIDER: replace the three models, for example with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
//   const primary = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-5.2');
//   const fallback = anthropic('claude-opus-4-8');
//   const memoryModel = anthropic('claude-haiku-4-5');
const primary = createOpenAI({
  apiKey: 'unused', // never sent: this fetch answers every request
  fetch: async () => {
    console.log('   [primary] 503 Service Unavailable');
    return new Response('{"error":{"message":"The service is overloaded."}}', { status: 503 });
  },
})('gpt-5.2');
const fallback = createMockModel({
  responses: [
    // run ada-1
    { text: 'Sorry about that, Ada. A replacement for order A-17 is on its way.' },
    // run ada-2: a tool call, then the answer
    { toolCalls: [{ toolName: 'track_order', args: { orderId: 'A-17' } }] },
    { text: 'Your replacement for order A-17 shipped today and arrives tomorrow.' },
  ],
});
// The memory pipeline's model: it extracts facts from a completed run's turns,
// then decides how they change what is stored.
const memoryModel = createMockModel({
  responses: [
    { text: `{"facts":[{"text":"Ada's order A-17 arrived broken.","kind":"episodic"}]}` },
    { text: `{"memory":[{"event":"ADD","text":"Ada's order A-17 arrived broken."}]}` },
    { text: '{"facts":[]}' },
  ],
});

// --- MEMORY -----------------------------------------------------------------
const memories = createInMemoryMemoryStore();
let searches = 0;
// Counts searches, to show that a run recalls once however many calls it makes.
const memoryStore: MemoryStore = {
  ...memories,
  search: (query) => {
    searches++;
    return memories.search(query);
  },
};
let memoryIds = 0;
const memory: MemoryCallOptions = {
  scope: { userId: 'ada' },
  seams: {
    store: memoryStore,
    llm: async ({ system, user }) => {
      const { text } = await generateText({
        model: memoryModel,
        instructions: system,
        prompt: user,
      });
      console.log(`   [memory model] ${text}`);
      return text;
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    generateId: () => `memory-${++memoryIds}`,
  },
};

// --- CHAT -------------------------------------------------------------------
const chats = createInMemoryChatStore();
let chatDatabaseUp = true;
// A chat store whose database can go down, to show a failed projection write.
const chatStore: ChatStore = {
  loadChat: (chatId) => chats.loadChat(chatId),
  saveChat: (record) => {
    if (!chatDatabaseUp) {
      console.log(`   [chat store] saving ${record.chatId} failed: connection refused`);
      throw new Error('connection refused');
    }
    console.log(`   [chat store] saved ${record.chatId}: ${record.messages.length} messages`);
    chats.saveChat(record);
  },
};
const chat = { store: chatStore, chatId: 'chat-1', scope: { userId: 'ada' } };

// --- THE AGENT --------------------------------------------------------------
const runs = createInMemoryAgentRunStore(); // durable: createSqliteOpsStore(...).agentRuns
const session = (runId: string): AgentRunSession => ({ store: runs, runId, scope: 'shop' });
const support: AgentRunOptions = {
  model: primary,
  fallbackModels: [fallback],
  maxRetries: 0, // fail over at once instead of retrying the primary first
  memory,
  chat,
  bindingId: 'support-v1', // bump it when the tools change meaning
  tools: {
    track_order: {
      description: 'Where an order is now.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
        additionalProperties: false,
      },
      execute: ({ orderId }: { orderId: string }) => {
        console.log(`   [tool] track_order(${orderId})`);
        return { orderId, status: 'shipped', eta: 'tomorrow' };
      },
    },
  },
};

/**
 * One native run, printing the fail-over and record warnings it streams as they
 * happen. (The scripted model also warns that the model registry does not know
 * it; a real model does not.)
 */
async function run(options: AgentRunOptions) {
  const stream = streamAgent(options);
  for await (const event of stream.events) {
    if (event.type !== 'part' || event.part.type !== 'warning') continue;
    const { setting, message } = event.part.warning;
    if (setting === 'fallbackModels' || setting === 'chat' || setting === 'memory')
      console.log(`   [warning: ${setting}] ${message}`);
  }
  const result = await stream.result;
  console.log(`   status: ${result.status}: "${result.text}"`);
  return result;
}

async function printChat() {
  const record = await chats.loadChat('chat-1');
  const ids = record?.messageIds ?? [];
  const messages = record?.messages.map((message, index) => `${ids[index]} ${message.role}`);
  console.log(`   chat-1: ${messages?.join(', ')}`);
}

console.log('1) Ada writes for the first time; the completed run is extracted into memory');
await run({
  ...support,
  session: session('ada-1'),
  prompt: "Hi, I'm Ada. My order A-17 arrived broken.",
});
// The checkpoint is the run's record: what it recalled, extracted and failed over.
const first = await runs.load('ada-1');
const extraction = first?.memory?.extraction;
console.log(`   recall: ${first?.memory?.recall.status} (nothing stored for ada yet)`);
console.log(`   extraction: ${extraction?.status}, mutations: ${extraction?.mutations}`);
for (const record of await memories.list({ userId: 'ada' })) {
  const deuz = record.metadata?.deuz as { runId: string } | undefined;
  console.log(`   memory: "${record.text}" (written by run ${deuz?.runId})`);
}
const models = first?.models;
const name = (ref: { provider: string; modelId: string }) => `${ref.provider}/${ref.modelId}`;
for (const attempt of models?.attempts ?? [])
  console.log(`   models: ${name(attempt.model)} failed at model step ${attempt.modelStep}`);
if (models) console.log(`   models: the run calls ${name(models.selected)} now`);
await printChat();

console.log('\n2) Ada comes back to chat-1; the chat database is down when the run ends');
chatDatabaseUp = false;
searches = 0;
const history = (await chats.loadChat('chat-1'))?.messages ?? [];
const second = await run({
  ...support,
  session: session('ada-2'),
  messages: [...history, { role: 'user', content: 'Any news on my replacement?' }],
});
const saved = await runs.load('ada-2');
const recall = saved?.memory?.recall;
console.log(`   recall: ${recall?.status}, ${recall?.count} memory, at index ${recall?.index}`);
const recalled = second.messages[recall?.index ?? -1];
console.log(`   ${recalled?.role}: ${JSON.stringify(recalled?.content)}`);
console.log(`   memory searches: ${searches}, model calls: ${second.modelSteps}`);
const projection = saved?.chat;
console.log(
  `   chat projection: ${projection?.status}, ${projection?.cursor} of ${saved?.transcript?.messages.length} messages acknowledged`,
);

console.log('\n3) the database is back: reconcileAgentRun writes the projection the run could not');
chatDatabaseUp = true;
const repaired = await reconcileAgentRun({ session: session('ada-2'), chat });
console.log(`   ${JSON.stringify(repaired)}`);
await printChat();
const again = await reconcileAgentRun({ session: session('ada-2'), chat });
console.log(`   a second pass finds nothing behind: ${JSON.stringify(again)}`);
