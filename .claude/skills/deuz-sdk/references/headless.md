<!-- verified: 2026-10-15 against @deuz-sdk/core@2.3.0 · api-contract sha256:03a491b97528
     sources: packages/core/src/node/headless.ts, packages/core/src/headless/{report,doctor,instructions}.ts,
     packages/core/src/{model-profile,agent-run}.ts, examples/13-headless/{index.ts,README.md},
     docs/content/docs/modules/headless.mdx -->

# Headless runs (2.3 preview)

**Load when:** running a native agent from a script, a CI job or a cron entry with no UI, branching a shell on how the run ended, resuming a stored run with the answers it waits for, loading a repository's `AGENTS.md` / `CLAUDE.md` into a run, giving a run Agent Skills from disk, or checking a model and its configuration before spending a call.

`@deuz-sdk/core/headless` is a **preview**, not a stable API: report fields, finding codes and exit codes can still change in a 2.x minor. It is **Node only** (it reads files, the environment and the Node version) and never reaches the edge-safe entries. There is no `deuz` binary, CLI package, TUI or daemon in 2.3; `examples/13-headless` is a small command line built on these functions (`run`, `inspect`, `doctor`, and `resume` with `--approve` / `--deny`, `--retry-call <id>`, `--reconcile <file.json>` and `--retry-failed`), keyless with its `--mock` scenarios, among them `crash` (a call whose effect is unknown) and `outage` (a failure in transit).

| Function | What it does |
| --- | --- |
| `runHeadless(options)` | `streamAgent` with a durable session, its events drained, and a `HeadlessReport` of the result |
| `resumeHeadless(options)` | `resumeStreamAgent` with the answers a report asked for, reported the same way |
| `inspectRun(store, runId)` | The report of a stored run, with no model call |
| `doctor(options)` | Why a model or configuration will not work, with no network call |
| `loadProjectInstructions(dir, options?)` | The project's instruction files as one message |
| `exitCodeFor(report)`, `HEADLESS_EXIT_CODES` | The exit code of a run report or a doctor report |

```ts
import { createInMemoryAgentRunStore } from '@deuz-sdk/core/agent';
import type { AgentToolSet } from '@deuz-sdk/core/agent';
import { exitCodeFor, inspectRun, resumeHeadless, runHeadless } from '@deuz-sdk/core/headless';
import { createMockModel } from '@deuz-sdk/core/testing';

const store = createInMemoryAgentRunStore(); // createSqliteOpsStore({ path }).agentRuns on one machine
const model = createMockModel({
  responses: [{ toolCalls: [{ toolName: 'deploy', args: { env: 'prod' } }] }, { text: 'Deployed to prod.' }],
});
const tools: AgentToolSet = {
  deploy: {
    description: 'Deploy the build.',
    parameters: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
    needsApproval: true,
    execute: ({ env }: { env: string }) => ({ deployed: env }),
  },
};

const first = await runHeadless({ model, prompt: 'Deploy.', tools, store, runId: 'deploy-7' });
console.log(first.outcome, exitCodeFor(first)); // pending 3

// Later, maybe in another process: read the stored run, decide, resume.
const waiting = await inspectRun(store, 'deploy-7');
const approvalResponses = waiting.pending.flatMap((action) =>
  action.kind === 'approval' ? [{ approvalId: action.approvalId, approved: true, token: action.token }] : [],
);
const done = await resumeHeadless({ model, tools, store, runId: 'deploy-7', approvalResponses });
console.log(done.outcome, done.output, exitCodeFor(done)); // completed Deployed to prod. 0
```

- **Options.** `runHeadless` takes `runAgent`'s options plus `store` (any durable `AgentRunStore`; the SQLite ops store's `agentRuns` is the default choice on one machine, Postgres and Redis fit the same way), `runId` (default: generated), `scope` (default `'headless'`), `skills`, `projectDir`, `projectInstructions` and `onEvent` (every event of the leg, for progress output; it must not throw). `resumeHeadless` takes `resumeAgent`'s options with the same session fields and no `prompt` / `messages` / `instructions`. Resume with the same model, tools, skills and output: the binding rejects a change, and that resume fails (exit 1) without touching the stored run.
- **Pricing.** Calls are priced with the bundled table unless `deps.priceProvider` is given, so the report carries the run's cost.
- **Rejections.** A leg rejects only when the project instructions cannot be loaded (`projectDir` is not a directory, an invalid `projectInstructions` option), a tool takes a skill tool's name, or `onEvent` threw; a skill folder that does not exist adds no skills. Everything that happens to the run itself is in the report.

## The report

`HeadlessReport` is plain JSON: `kind: 'deuz-headless-report'`, `version: 1`, `runId`, `scope`, `status` (the result status, or `'in-progress'` for a stored run with no result yet), `outcome`, `phase?` (where the stored run stands after the leg), `reason?` and `stopDetails?` (a stopped run's reason and the provider's explanation), `error?`, `pending` (what a pending run waits for), `usage`, `modelSteps`, `cost?` (`{ usd, complete, unpricedCalls, unknownCalls }` from the run's budget ledger; `usd` is a lower bound while `complete` is `false`), `retry?` (`HeadlessRetry`, `{ cause: 'model-call' | 'admission', phase: 'running' | 'finalizing', resumeWith: 'retryFailed' }`: the stored run failed in transit, see below), `verification?`, `warnings` (the leg's `CallWarning`s; `inspectRun` reports none), `output?` (a completed run's accepted output) and `text`.

| Code | `outcome` | When |
| --- | --- | --- |
| 0 | `completed` | The run finished with an accepted output (or a doctor report without errors) |
| 1 | `failed` | An error ended it: a provider error, a store failure, a lost lease, a binding changed on resume, answers the resume could not take |
| 2 | — | Usage: your own command line could not parse its arguments |
| 3 | `pending` | It waits: approvals, client tool results, calls whose effect is unknown, or a resume: a stored run with no result, or a run a lease drain stopped (reason `'drained'`) |
| 4 | `refused` | The model refused (stop reason `'refusal'`) |
| 5 | `cancelled` | Aborted or cancelled |
| 6 | `limit` | A limit you set: `budget.usd` / `budget.tokens`, `maxSteps`, a stop condition on cost, tokens, steps or duration (`costExceeds`, `totalTokensExceed`, `stepCountIs`, `durationExceeds`), the execution deadline, a timeout, or `unknownPrice: 'reject'` |
| 7 | `stopped` | Stopped short for another reason: a `hasToolCall` or custom `stopWhen` condition, a guardrail, a verifier that never accepted, an invalid output, a cut-off output, a changed MCP catalog |
| 8 | — | `doctor` found an error |

A run that did not complete never exits 0. `process.exitCode = exitCodeFor(report)` is the whole contract for a shell.

**Pending actions** each name the `resumeHeadless` option that answers them (`resumeWith`): `approval` (`approvalId`, `toolCallId`, `toolName`, `input`, `agentPath?`, `token?`; `'approvalResponses'`, echoing a signed approval's `token`), `client-tool` (`'clientToolResults'`), `unknown-effect` (`toolCallId`, `toolName`, `input`, `modelStep?`; `resumeWith: ['retryToolCallIds', 'reconciledToolResults']`: check the effect in the system it touched, then list the call in `retryToolCallIds` to run it again, or give the result that landed in `reconciledToolResults` so it never runs again; every unknown effect of the run needs an answer in the same resume) and `resume` (`phase`: the executor stopped before the run ended, or a lease drain stopped it; a plain resume continues it; with the report's `retry`, pass `retryFailed: true`). A `replay: 'idempotent'` tool's interrupted call is not listed, since it runs again by itself, unless a process older than 2.3 wrote its receipt (no replay policy recorded): then it is listed, and either answer, or a plain resume, settles it.

**A drained run.** A run a lease drain stopped (`'drain'` on its lease, as in a deploy) has not ended: its report is `pending` (exit 3) with `reason: 'drained'` and a pending `resume` in the phase it stopped in, as `inspectRun` reports the stored run, and a plain resume on any executor goes on from its last save. A drain that reached a resume before it took the run up wrote nothing, so that report lists what the run still waits for: its approvals, client results or unknown effects, and `retry` for a run that failed in transit. When the stored run cannot be read back, the list is empty and a warning says why.

**A failure in transit.** A report's `retry` says the stored run failed in transit (a model call with a retryable network or provider error, a transport timeout, an open breaker or a stream that broke off; a budget admission refused with a serialization conflict). The outcome keeps its code, `failed` (1), or `limit` (6) for a transport timeout, and `inspectRun` shows `retry` too. Resume with `retryFailed: true` to go on from the run's last checkpoint; completed calls do not run again (`references/native-execution.md`). A retried resume that stops again before its first write keeps `retry`: answer what it waits for and pass `retryFailed: true` once more.

**Answers a resume refuses.** On a run that has not ended, a resume that cannot take its answers fails before anything is written, with the `TypeError` in the report's `error` (exit 1, no `retry`): a client result or a recorded result (`reconciledToolResults`) for a call the run does not wait on, or a call listed in both `retryToolCallIds` and `reconciledToolResults`. A changed binding, and `retryFailed` for a failure that was not transient, are refused the same way on any run. A resume of a run that ended (completed, stopped, or failed and not retried) returns its stored result and ignores client results, recorded results, retry IDs, and `retryFailed` on a run that did not fail. A verdict or a `retryToolCallIds` entry that matches no pending call is ignored; a resume that answers nothing else leaves the run waiting (exit 3) and writes nothing.

`inspectRun` reports a run with no result as `in-progress` with a pending `resume`, plus any call whose outcome was never recorded; that picture is accurate only when no executor still drives the run. An unknown run ID rejects with a `TypeError`.

## Project instructions

`projectDir` loads the project's instruction files into the run's system message, after your `instructions` and before the skills list; `loadProjectInstructions(dir, { root?, maxBytes?, fileNames?, role? })` returns them on their own (`{ root, files, skipped, message? }`).

- **Discovery.** In each directory from the root down to `dir`: `AGENTS.md`, then `CLAUDE.md` (`fileNames` changes the list). The root is the nearest directory upwards holding `.git` (outside a repository only `dir`), or `root`, which must be `dir` or an ancestor. A `dir` that is not a directory rejects with a `TypeError`, so a mistyped path never reads its ancestors' files instead.
- **Precedence and nesting.** Outer files first and the files nearest `dir` last, so the nearest wins a conflict. Files below `dir` are not read, `@path` imports are not expanded, and a file that repeats an earlier one's text is included once.
- **Cap.** At most `maxBytes` (default 32 768) UTF-8 bytes; the files nearest `dir` are kept whole first, an outer file is cut (with a `[truncated: N more bytes not loaded]` line) or left out (`files[].truncated`, `includedBytes`).
- **Links.** A symlink or junction is followed only while it stays inside the root. A file whose real path is outside it is not read: `skipped` lists it (`reason: 'outside-root'`) and `runHeadless` reports it as a `warning` (`setting: 'projectDir'`).
- **Trust.** The files get the trust of the system message, the same as your own `instructions`: whoever can change them (a pull request from a fork) can steer the run and the tools it calls. Review the `AGENTS.md` / `CLAUDE.md` of a checkout you do not trust, or leave `projectDir` out. `projectInstructions: { role: 'user' }` delivers them as a user message ahead of the `prompt` or `messages` instead, which the model weighs below your instructions; it does not make them safe.
- Only the first leg loads them: they are part of the stored transcript, so a resume does not read them again.

## Skills

`skills` takes folders of Agent Skills (`<id>/SKILL.md`, read with `nodeSkillSource`). The first leg lists them in the system message, and every leg gets two tools, `load_skill` (a skill's body) and `read_skill_resource` (a text file bundled with it). Both read only skills the list holds, and only files whose real path is inside the skill's folder: a link leading out of it is refused. Both are `replay: 'idempotent'`, and a tool of your own cannot take either name. Pass the same `skills` when resuming: the tools are part of the run's binding.

## `doctor`

`doctor(options)` takes the run's own options (it reads `model`, `effort`, `temperature`, `topP`, `toolChoice`, `promptCaching`, `budget`, `capabilities`, `tools`, `skills`, `output` and `deps`; `env`, `apiKeyEnv` and `nodeVersion` override what it measures) and makes no network call. It calls only a `deps.priceProvider` you gave, once with a two-token usage, and never a `deps.keyProvider`.

```ts
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { doctor, exitCodeFor } from '@deuz-sdk/core/headless';

const report = await doctor({
  model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-5-5'),
  effort: 'none',
  temperature: 0.2,
  budget: { usd: 2 },
});
for (const finding of report.findings) console.log(finding.severity, finding.code, finding.message);
process.exitCode = exitCodeFor(report); // 8 when a finding is an error
```

The `DoctorReport` holds `ok`, `model`, `support` (`'pinned'` registry row, `'family'` Claude 5.x rules, or `'unknown'` fallback), the full `profile` (`resolveModelProfile`), `structuredOutput` (the mode and the strategy it takes), `priced`, `apiKey` (`source`: `factory`, `key-provider`, `keyless` or `missing`; the usual variable and whether it is set, never its value), `node` (version, the required `>=22.0.0`, supported) and `findings` (`{ severity, code, message, setting? }`). Codes: `node-version` (error), `node-sqlite` (warning: no unflagged `node:sqlite`), `missing-api-key` (error; core never reads the environment, so a key left there must still reach the factory), `key-provider` (info), `unknown-model`, `model-status` (preview or deprecated), `unpriced-model` (info; a warning under a USD budget; an error under a USD budget with `unknownPrice: 'reject'`), `price-lookup-failed`, `tools-unsupported` (error), `tools-unknown`, `tool-protocol` (error: tools only on another protocol), `structured-output`, `clamped-setting` / `unsupported-setting` (a requested value changed or dropped on the way to the wire) and `not-live-verified` (info, always: profiles come from documentation).

## Sharp edges

- A preview: pin your `@deuz-sdk/core` version if a script parses report fields or finding codes.
- Use a durable store for anything that outlives the process; the in-memory store loses the run on exit.
- Resume with the same model, tools, skills and output, or the resume fails (exit 1) and the stored run stays as it was.
- A pending `unknown-effect` needs a human or a check of the real system before any retry: a blind `retryToolCallIds` can repeat a side effect.
- Project instruction files are prompt input with system trust: load a checkout you do not trust only after review.

## Deep dive

- [/docs/modules/headless](/docs/modules/headless) — the report fields, outcomes and exit codes, pending runs, project instructions, skills, the doctor's findings.
- [/docs/modules/model-profiles](/docs/modules/model-profiles) — the profile the doctor reports.
- [/docs/modules/native-agents](/docs/modules/native-agents) — the native run, resume and recovery options a headless leg passes through (`references/native-execution.md`).
