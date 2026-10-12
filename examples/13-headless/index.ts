/**
 * Headless — a command line on `@deuz-sdk/core/headless` (2.3 preview).
 *
 *   run "<prompt>"   start a native run        resume <run-id>   continue one
 *   inspect <run-id> read a stored run         doctor            check the setup
 *
 * Every command prints a report (`--json` prints it as JSON) and exits with
 * `exitCodeFor(report)`: 0 only for a completed run or a doctor report without
 * errors; 3 while a run waits for you, 4 for a refusal, and so on (README).
 * Runs live in a SQLite file, so `run` and `resume` can be separate processes.
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { BreakerStore } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import type { AgentEvent, AgentRunStore, AgentToolSet } from '@deuz-sdk/core/agent';
import {
  HEADLESS_EXIT_CODES,
  doctor,
  exitCodeFor,
  inspectRun,
  loadProjectInstructions,
  resumeHeadless,
  runHeadless,
} from '@deuz-sdk/core/headless';
import type { DoctorReport, HeadlessReport } from '@deuz-sdk/core/headless';
import { createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createMockModel } from '@deuz-sdk/core/testing';
import type { MockResponse } from '@deuz-sdk/core/testing';

const USAGE = `usage: index.ts <command> [options]

  run "<prompt>"     start a run          --run-id <id>, --skills <dir>, --budget-usd <n>
  resume <run-id>    continue a run       --approve | --deny (for a pending approval)
                                          --retry-call <call-id> (run an unknown effect again)
                                          --reconcile <file.json> (record the results that landed)
                                          --retry-failed (re-enter a run that failed in transit)
  inspect <run-id>   read a stored run    (no model call)
  doctor             check model, key, price and Node before running

  --json             print the report as JSON
  --db <file>        the SQLite run store (default: <tmp>/deuz-headless-example.sqlite)
  --model <id>       an Anthropic model id; the key comes from ANTHROPIC_API_KEY
  --mock <scenario>  without a model: approval (default), complete, refusal, crash or outage`;

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(HEADLESS_EXIT_CODES.usage);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        db: { type: 'string', default: join(tmpdir(), 'deuz-headless-example.sqlite') },
        model: { type: 'string' },
        mock: { type: 'string', default: 'approval' },
        'run-id': { type: 'string' },
        skills: { type: 'string', multiple: true },
        'budget-usd': { type: 'string' },
        approve: { type: 'boolean', default: false },
        deny: { type: 'boolean', default: false },
        'retry-call': { type: 'string', multiple: true },
        reconcile: { type: 'string' },
        'retry-failed': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    return usage((error as Error).message);
  }
}
const { values, positionals } = parse();
const [command, argument] = positionals;

// `npm run -w` starts this script in the example's folder; INIT_CWD is where
// you ran npm. Relative paths and the project instructions are taken from there.
const here = process.env.INIT_CWD ?? process.cwd();
const skills = values.skills?.map((dir) => resolve(here, dir));

// --- MODEL ------------------------------------------------------------------
// With `--model` (or ANTHROPIC_API_KEY set) the run calls Anthropic. Without
// either it runs on a scripted model: no key, no network. Core never reads the
// environment; this app reads the key and passes it to the factory.
const apiKey = process.env.ANTHROPIC_API_KEY;
const modelId = values.model ?? (apiKey ? 'claude-opus-4-8' : undefined);
/** The scripted scenario of this `run`, if any (`--mock`). */
const scenario = modelId === undefined && command === 'run' ? values.mock : undefined;

/** One scripted reply per model call of THIS process, so run and resume each get their own. */
function scripted(): MockResponse[] {
  if (command === 'resume') {
    if (values.deny) return [{ text: 'Left the notes unpublished.' }];
    if (values.reconcile || values['retry-call']) return [{ text: 'Tagged v2.3.0.' }];
    if (values['retry-failed']) return [{ text: 'The notes are ready.' }];
    return [{ text: 'Published the notes.' }];
  }
  switch (values.mock) {
    case 'complete':
    case 'outage':
      return [{ text: 'The notes are ready.' }];
    case 'refusal':
      return [{ text: '', finishReason: 'content_filter' }];
    case 'approval':
      return [{ toolCalls: [{ toolName: 'publish_notes', args: { version: '2.3.0' } }] }];
    case 'crash':
      return [{ toolCalls: [{ toolName: 'tag_release', args: { version: '2.3.0' } }] }];
    default:
      return usage(`unknown --mock scenario: ${values.mock}`);
  }
}
const model =
  modelId !== undefined
    ? createAnthropic({ apiKey })(modelId)
    : createMockModel({ responses: scripted() });

// The same tools on every leg of a run: they are part of its binding (bump
// the bindingId when they change).
const bindingId = 'headless-example-v2';
const tools: AgentToolSet = {
  publish_notes: {
    description: 'Publish the release notes for a version.',
    parameters: {
      type: 'object',
      properties: { version: { type: 'string' } },
      required: ['version'],
      additionalProperties: false,
    },
    needsApproval: true,
    execute: ({ version }: { version: string }) => ({ published: version }),
  },
  tag_release: {
    description: 'Create the git tag of a release version.',
    parameters: {
      type: 'object',
      properties: { version: { type: 'string' } },
      required: ['version'],
      additionalProperties: false,
    },
    execute: ({ version }: { version: string }) => {
      // The effect a crash can leave unrecorded (`--mock crash`).
      console.error(`  effect   tagged v${version}`);
      return { tag: `v${version}` };
    },
  },
};
const budget = values['budget-usd'] ? { usd: Number(values['budget-usd']) } : undefined;

// --- FAULTS (scripted model only) -------------------------------------------
/**
 * `--mock crash`: the run store goes down once a tool call has started, as if
 * the machine died mid-call. The call's effect lands; its outcome is never saved.
 */
function goesDownMidCall(store: AgentRunStore): AgentRunStore {
  let down = false;
  return {
    load: (runId) => store.load(runId),
    save: async (envelope) => {
      if (down) throw new Error('the run store went down');
      await store.save(envelope);
      if (Object.values(envelope.toolResults ?? {}).some((r) => r.stage === 'executing'))
        down = true;
    },
  };
}

/**
 * `--mock outage`: the provider is down. The circuit breaker the workers share
 * (`deps.breakerStore`) reports it open, so the model call fails before it is
 * sent: a transient failure the run records, so `resume --retry-failed` can
 * re-enter it later.
 */
const outage: BreakerStore = {
  get: () => ({ failures: 5, cooldownUntil: Date.now() + 60_000 }),
  set: () => {},
};

/** `--reconcile <file>`: the results that landed, `[{ "toolCallId": "call_1", "output": … }]`. */
async function recorded(
  file: string,
): Promise<{ toolCallId: string; output: unknown; isError?: boolean }[]> {
  // Passed on as it is: the resume checks it against the run before it writes anything.
  return JSON.parse(await readFile(resolve(here, file), 'utf-8'));
}

// --- OUTPUT -----------------------------------------------------------------
function print(report: HeadlessReport | DoctorReport): void {
  process.exitCode = exitCodeFor(report);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (report.kind === 'deuz-headless-doctor') {
    const { model: m, support, priced, apiKey: key, node } = report;
    console.log(`doctor: ${report.ok ? 'ok' : 'errors found'} (exit ${process.exitCode})`);
    console.log(`  model    ${m.provider}/${m.modelId} on ${m.protocol}, support: ${support}`);
    console.log(`  effort   ${report.profile.effort.levels.join(', ') || 'none'}`);
    console.log(`  output   ${report.structuredOutput.strategy} strategy, priced: ${priced}`);
    console.log(`  key      ${key.source} (${key.envVar} set: ${key.inEnvironment})`);
    console.log(`  node     ${node.version} (${node.supported ? 'supported' : 'unsupported'})`);
    for (const f of report.findings)
      console.log(`  ${f.severity.padEnd(7)} ${f.code}: ${f.message}`);
    return;
  }
  if (streamed) process.stderr.write('\n');
  const why = report.reason ?? report.error?.message;
  console.log(
    `${report.runId}: ${report.outcome}${why ? ` (${why})` : ''}, exit ${process.exitCode}`,
  );
  if (report.output !== undefined) console.log(`  output   ${JSON.stringify(report.output)}`);
  const cost = report.cost;
  console.log(
    `  usage    ${report.usage.totalTokens} tokens in ${report.modelSteps} model steps` +
      (cost
        ? `, $${cost.usd}${cost.complete ? '' : ` (incomplete: ${cost.unpricedCalls} unpriced)`}`
        : ''),
  );
  for (const action of report.pending) {
    if (action.kind === 'approval')
      console.log(
        `  waiting  approval of ${action.toolName}(${JSON.stringify(action.input)}): resume ${report.runId} --approve or --deny`,
      );
    else if (action.kind === 'unknown-effect')
      console.log(
        `  waiting  ${action.toolName}(${JSON.stringify(action.input)}) started and its outcome was never recorded: check it, then resume ${report.runId} --retry-call ${action.toolCallId} or --reconcile <file>`,
      );
    else if (action.kind === 'resume') console.log(`  waiting  resume ${report.runId}`);
    else
      console.log(`  waiting  ${action.kind} ${action.toolName}, answered by ${action.resumeWith}`);
  }
  if (report.retry)
    console.log(
      `  retry    it failed in transit (${report.retry.cause}): resume ${report.runId} --retry-failed`,
    );
  for (const w of report.warnings) console.log(`  warning  ${w.type}: ${w.message}`);
}

// Progress goes to stderr, so `--json` keeps stdout to the report alone.
let streamed = false;
const onEvent = values.json
  ? undefined
  : (event: AgentEvent<unknown>) => {
      if (event.type === 'part' && event.part.type === 'text-delta') {
        process.stderr.write(event.part.text);
        streamed = true;
      }
    };

// --- COMMANDS ---------------------------------------------------------------
if (command === 'doctor') {
  print(await doctor({ model, tools, ...(budget ? { budget } : {}) }));
} else if (command === 'run' || command === 'resume' || command === 'inspect') {
  if (command !== 'run' && !argument) usage(`${command} needs a run id`);
  const ops = createSqliteOpsStore({ path: resolve(here, values.db) });
  try {
    if (command === 'inspect') {
      print(await inspectRun(ops.agentRuns, argument!));
    } else if (command === 'run') {
      const project = await loadProjectInstructions(here);
      if (!values.json && project.files.length > 0)
        console.error(
          `project instructions: ${project.files.map((f) => f.relativePath).join(', ')}`,
        );
      print(
        await runHeadless({
          model,
          prompt: argument ?? 'Publish the release notes for 2.3.0.',
          tools,
          bindingId,
          ...(budget ? { budget } : {}),
          store: scenario === 'crash' ? goesDownMidCall(ops.agentRuns) : ops.agentRuns,
          scope: 'example',
          ...(values['run-id'] ? { runId: values['run-id'] } : {}),
          projectDir: here,
          ...(skills ? { skills } : {}),
          ...(scenario === 'outage' ? { deps: { breakerStore: outage } } : {}),
          onEvent,
        }),
      );
    } else {
      // The answers: verdicts for the approvals the stored run waits for, calls
      // to run again, results that landed, a retry of a failure in transit.
      const reconciled =
        values.reconcile !== undefined
          ? { reconciledToolResults: await recorded(values.reconcile) }
          : {};
      const waiting = await inspectRun(ops.agentRuns, argument!);
      const verdicts = waiting.pending.flatMap((action) =>
        action.kind === 'approval' && (values.approve || values.deny)
          ? [{ approvalId: action.approvalId, approved: values.approve, token: action.token }]
          : [],
      );
      print(
        await resumeHeadless({
          model,
          tools,
          bindingId,
          store: ops.agentRuns,
          scope: 'example',
          runId: argument!,
          ...(skills ? { skills } : {}),
          approvalResponses: verdicts,
          ...(values['retry-call'] ? { retryToolCallIds: values['retry-call'] } : {}),
          ...reconciled,
          ...(values['retry-failed'] ? { retryFailed: true } : {}),
          onEvent,
        }),
      );
    }
  } catch (error) {
    // An unknown run id or an unreadable --reconcile file is a usage error;
    // everything that happens to a run is in its report.
    console.error((error as Error).message);
    process.exitCode = HEADLESS_EXIT_CODES.usage;
  } finally {
    await ops.close();
  }
} else {
  usage(command ? `unknown command: ${command}` : undefined);
}
