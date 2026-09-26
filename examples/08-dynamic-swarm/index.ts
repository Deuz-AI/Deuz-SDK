/**
 * 08 — Dynamic swarm: tasks that spawn tasks, a group blackboard, and rounds (2.2).
 *
 * Part 1: a planner agent returns a validated list of leads, and its `spawn`
 * hook turns that output into one scout task per lead plus a digest. The
 * children commit atomically with the planner's result. The scouts share the
 * `leads` group's blackboard through the `blackboard_post` / `blackboard_read`
 * tools, and the digest reducer pages the same channel with `readChannel`.
 *
 * Part 2: `createRounds` runs agents round by round, and a consolidator decides
 * after each round which groups continue, with how many agents and what prompt.
 */
import { createAgent } from '@deuz-sdk/core/agent';
import { createInMemorySwarmStore, createRounds, createSwarm } from '@deuz-sdk/core/swarm';
import type { SwarmHandle } from '@deuz-sdk/core/swarm';
import { createMockModel } from '@deuz-sdk/core/testing';
import type { MockResponse } from '@deuz-sdk/core/testing';

// --- MODELS -----------------------------------------------------------------
// Scripted models, so this runs without an API key: each agent replies in
// order, one reply per model call. REAL PROVIDER: give every agent a real model,
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
//   const planner = createAgent({ model }); // and the same for scout and explorer
const scripted = (...responses: MockResponse[]) =>
  createAgent({ model: createMockModel({ responses }) });
const call = (toolName: string, args: object): MockResponse => ({
  toolCalls: [{ toolName, args }],
});

const planner = scripted({ text: '{"leads":["the retry docs","the open issues"]}' });
const scout = scripted(
  // plan/scout1 posts a finding to its group's board.
  call('blackboard_post', { text: 'The retry docs never mention jitter.' }),
  { text: 'Posted.' },
  // plan/scout2 reads the board first, then adds its own finding.
  call('blackboard_read', {}),
  call('blackboard_post', { text: 'Issues #41 and #57 show synchronized retry storms.' }),
  { text: 'Posted.' },
);
const explorer = scripted(
  { text: 'Lead: every client retries at the same instant.' },
  { text: 'Fix A: full jitter.' },
  { text: 'Fix B: decorrelated jitter.' },
);

const rounds = createRounds({
  id: 'search',
  maxRounds: 2,
  initial: { wide: { agent: 'explorer', count: 1, prompt: 'Find the root cause of the storms.' } },
  consolidate({ round, groups }) {
    const outputs = Object.values(groups).flatMap((results) => results.map((r) => r.output));
    // Decide the next round at run time: which groups, how many agents, what prompt.
    if (round === 1)
      return { groups: { deep: { agent: 'explorer', count: 2, prompt: `Fix: ${outputs[0]}` } } };
    return { stop: true, summary: outputs };
  },
});

const swarm = createSwarm({
  store: createInMemorySwarmStore(),
  // Runtime spawning needs limits; createRounds needs maxSpawnDepth >= maxRounds.
  dynamic: { maxTasks: 50, maxSpawnDepth: 4 },
  // One task at a time keeps the scripted replies in order. With a real model,
  // keep the default (5) and the agents of a group run in parallel.
  concurrency: 1,
  agents: {
    planner: {
      agent: planner,
      output: {
        mode: 'json',
        schema: {
          type: 'object',
          properties: { leads: { type: 'array', items: { type: 'string' } } },
          required: ['leads'],
        },
        validate(value) {
          const leads = (value as { leads?: unknown } | null)?.leads;
          if (!Array.isArray(leads) || !leads.every((lead) => typeof lead === 'string'))
            throw new Error('expected { leads: string[] }');
          return { leads };
        },
      },
      // Runs on the planner's accepted output; the children commit with its result.
      spawn: (output, context) => {
        const scouts = (output as { leads: string[] }).leads.map((lead, index) => ({
          key: `scout${index + 1}`, // the task ID becomes plan/scout1, ...
          agent: 'scout',
          prompt: `Investigate ${lead} and post one finding.`,
          group: 'leads',
        }));
        // `after` waits for every scout to settle, whether it succeeds or not.
        const after = scouts.map((task) => `${context.taskId}/${task.key}`);
        return [...scouts, { key: 'digest', reducer: 'digest', after }];
      },
    },
    scout: { agent: scout, blackboard: { read: 'group', post: true } },
    explorer,
  },
  reducers: {
    digest: {
      execute: async (_results, context) =>
        (await context.readChannel('leads')).map((note) => `#${note.sequence} ${note.text}`),
    },
    ...rounds.reducers,
  },
});

// The durable journal, read while the run executes: one line per control event.
async function traced(handle: SwarmHandle) {
  const printing = (async () => {
    for await (const event of handle.events({ afterSequence: 0 })) {
      const fields = [event.type, event.taskId, event.detail && `[${event.detail}]`];
      console.log(`   ${event.sequence}. ${fields.filter(Boolean).join(' ')}`);
    }
  })();
  const outcome = await handle.result;
  await printing;
  return outcome;
}

console.log('1) planner -> spawned scouts on a shared blackboard -> digest');
const first = await traced(
  await swarm.run({
    scope: 'tenant-a',
    runId: 'storms',
    tasks: [{ id: 'plan', agent: 'planner', prompt: 'Split "retry storms" into leads.' }],
  }),
);
const task = (id: string) => first.tasks.find((record) => record.task.id === id)?.result;
const parts = (task('plan/scout2')?.agentResult?.messages ?? []).flatMap((message) =>
  Array.isArray(message.content) ? message.content : [],
);
console.log('   plan/scout2 used the board:');
for (const use of parts) {
  if (use.type !== 'tool_use') continue;
  const result = parts.find((part) => part.type === 'tool_result' && part.toolUseId === use.id);
  const value = result?.type === 'tool_result' ? result.result : undefined;
  console.log(`     ${use.name}(${JSON.stringify(use.input)}) -> ${JSON.stringify(value)}`);
}
console.log(`   digest: ${JSON.stringify(task('plan/digest')?.output)}`);

console.log('\n2) createRounds: explore, consolidate, go deeper');
const second = await traced(
  await swarm.run({ scope: 'tenant-a', runId: 'storm-rounds', tasks: rounds.tasks }),
);
console.log(`   last consolidator: ${JSON.stringify(second.tasks.at(-1)?.result?.output)}`);
