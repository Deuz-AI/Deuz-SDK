/**
 * 06 — Build your own Manus: a fully autonomous, self-verifying agent composed
 * ONLY from published primitives. There is no agent class and no hidden runtime.
 *
 *   planTasks            -> decompose the goal into a TaskList (planner)
 *   agentTool executor   -> a sub-agent that acts by writing code + files
 *   Workspace            -> externalized memory (plan.json + artifacts)
 *   ComputeSandbox       -> CodeAct: the model writes code, the sandbox runs it
 *   verifyStep           -> verifier: re-drive until the answer passes
 *   compaction + budget  -> bounded long runs
 *   session (durable)    -> survive a crash (see example 05 for the resume half)
 *   RunManager + emit*   -> background bookkeeping + LIVE plan/activity feed
 *
 * Swap the Node reference sandbox/workspace for Docker/E2B + a real object store
 * in production — the seams are identical. `createNodeSandbox` runs code in a
 * child process of THIS process; it is a reference host, not isolation.
 */
import { agentTool, streamChat, totalTokensExceed } from '@deuz-sdk/core';
import type { Tool, ToolSet } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createPriceProvider } from '@deuz-sdk/core/pricing';
import {
  nextPendingTask,
  planTasks,
  serializeTaskList,
  setTaskStatus,
  taskListProgress,
  type TaskList,
} from '@deuz-sdk/core/autonomy';
import { createWorkspaceTools } from '@deuz-sdk/core/workspace';
import { createFileWorkspace } from '@deuz-sdk/core/workspace/node';
import { codeActSystemPrompt, codeActTool, shellTool } from '@deuz-sdk/core/compute';
import { createNodeSandbox } from '@deuz-sdk/core/compute/node';
import {
  createInMemoryRunStore,
  createRunManager,
  emitActivity,
  emitPlanUpdate,
} from '@deuz-sdk/core/runtime';
import { createInMemorySessionStore } from '@deuz-sdk/core/durable';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in your environment first.');
  process.exit(1);
}
const anthropic = createAnthropic({ apiKey }); // app layer owns the key
const model = anthropic('claude-opus-4-8');
const priceProvider = createPriceProvider();

const goal =
  process.argv.slice(2).join(' ') || 'Compute the 20th Fibonacci number and write it to result.txt';

// --- Seams: swap these two for Docker/E2B + S3 in production ---------------
const workspace = createFileWorkspace({ root: './.agent-workspace' });
const sandbox = createNodeSandbox({
  cwd: './.agent-workspace',
  allowedLanguages: ['python', 'bash', 'javascript'],
});

// --- Background bookkeeping + durable checkpoints --------------------------
const runManager = createRunManager({ store: createInMemoryRunStore() });
const sessionStore = createInMemorySessionStore();
const runId = `manus-${process.pid}`;
await runManager.startRun({ runId, goal });

/**
 * THE LIVE-VIEW FIX. `emitPlanUpdate`/`emitActivity` take a `PartEmitter`, and
 * the ONLY place one exists is `ctx.emitPart` inside a tool's `execute` — which
 * the loop populates when the parent call is STREAMING. Passing `undefined`
 * (what a buffered `generateText` leaves you with) makes them silent no-ops.
 * So: orchestrate with `streamChat`, and thread `ctx.emitPart` from the tools.
 */
function withActivity(tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (!execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: (args, ctx) => {
        emitActivity(ctx.emitPart, `running ${name}`);
        return execute(args, ctx);
      },
    };
  }
  return wrapped;
}

// 1) PLAN — decompose the goal into a TaskList and persist it.
let plan: TaskList = await planTasks(goal, { model });
await workspace.write('plan.json', serializeTaskList(plan));
await runManager.setPlan(runId, plan);
console.log(`Plan:\n${plan.tasks.map((t) => `  - [${t.id}] ${t.title}`).join('\n')}\n`);

// 2) EXECUTOR — a sub-agent that writes/reads files and runs code (CodeAct).
//    Its whole stream is forwarded live to the parent as `sub-agent` parts.
const executor = agentTool({
  name: 'executor',
  description: 'Executes one concrete sub-task by writing files and running code.',
  model,
  system: `${codeActSystemPrompt()} You work inside a sandboxed workspace; use the tools to read/write files and run code.`,
  tools: withActivity({
    ...createWorkspaceTools(workspace),
    ...codeActTool(sandbox, { languages: ['python', 'bash', 'javascript'] }),
    ...shellTool(sandbox),
  }),
  maxSteps: 12,
});

// 3) COMPLETION — a tool, deliberately: it is the one place with a live
//    `ctx.emitPart`, so the to-do panel updates as the model works.
const completeTask: Tool = {
  description: 'Mark a sub-task done or failed once it is verifiably finished.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      status: { type: 'string', enum: ['done', 'failed'] },
      notes: { type: 'string' },
    },
    required: ['taskId', 'status'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    const { taskId, status, notes } = args as {
      taskId: string;
      status: 'done' | 'failed';
      notes?: string;
    };
    plan = setTaskStatus(plan, taskId, status, notes); // reducers return NEW lists
    await workspace.write('plan.json', serializeTaskList(plan));
    await runManager.setPlan(runId, plan);
    emitPlanUpdate(ctx.emitPart, plan); // <- a real sink, not `undefined`
    return taskListProgress(plan);
  },
};

// 4) LOOP — orchestrate one task at a time; verifyStep re-drives until it passes.
for (let next = nextPendingTask(plan); next; next = nextPendingTask(plan)) {
  const task = next; // stable inside the closures below
  plan = setTaskStatus(plan, task.id, 'in_progress');

  const run = streamChat({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are an orchestrator. Delegate the current sub-task to the executor tool, ' +
          'then call completeTask with its id and the outcome.',
      },
      { role: 'user', content: `Goal: ${goal}\nCurrent sub-task [${task.id}]: ${task.title}` },
    ],
    tools: { executor, completeTask },
    maxSteps: 8,
    compaction: 'auto',
    budget: { usd: 10 },
    stopWhen: [totalTokensExceed(1_000_000)],
    deps: { priceProvider },
    session: { store: sessionStore, runId: `${runId}:${task.id}` },
    verifyStep: ({ text, attempt }) =>
      /\b(done|complete|finished|wrote|written)\b/i.test(text)
        ? { ok: true }
        : {
            ok: false,
            feedback: `Sub-task "${task.title}" is not verifiably complete. Actually perform it and confirm.`,
            retry: attempt < 2,
          },
  });

  // The live view. `StreamPart` is an OPEN union — always keep a `default`.
  for await (const part of run.fullStream) {
    switch (part.type) {
      case 'text-delta':
        process.stdout.write(part.text);
        break;
      case 'activity':
        console.log(`\n  . ${part.message}`);
        break;
      case 'plan-update':
        console.log(`\n  > ${part.tasks.map((t) => `${t.id}=${t.status}`).join(' ')}`);
        break;
      case 'sub-agent':
        if (part.part.type === 'activity') {
          console.log(`\n  . [${part.agentPath.join('>')}] ${part.part.message}`);
        }
        break;
      case 'verify':
        console.log(`\n  ? verify #${part.attempt}: ${part.ok ? 'ok' : 'retrying'}`);
        break;
      case 'error':
        console.error('\n  ! stream error:', part.error);
        break;
      default:
        break;
    }
  }
  await run.usage; // settle the run before starting the next task

  // The orchestrator may never call completeTask (budget, maxSteps, a refusal).
  // Settle the task ourselves so the plan stays honest.
  if (plan.tasks.find((t) => t.id === task.id)?.status === 'in_progress') {
    plan = setTaskStatus(plan, task.id, 'failed', 'not confirmed by the orchestrator');
    await workspace.write('plan.json', serializeTaskList(plan));
  }

  const progress = taskListProgress(plan);
  console.log(`\n[${progress.done}/${progress.total} done, ${progress.failed} failed]\n`);
}

await runManager.setStatus(runId, 'completed');
console.log('All tasks settled. Artifacts are in ./.agent-workspace');
