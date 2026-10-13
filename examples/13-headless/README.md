# Headless — run, resume, inspect, doctor

**Shows:** the 2.3 headless preview, `@deuz-sdk/core/headless`, as a small command line. `run` starts a native run and prints a report; `resume` continues it in another process; `inspect` reads a stored run without a model call; `doctor` checks the model, its price, the API key and the Node version before anything runs. `--json` prints the report as JSON for automation, and every command exits with `exitCodeFor(report)`, so a script can branch on the result. Runs live in a SQLite file (`createSqliteOpsStore({ path }).agentRuns`), so `run` and `resume` can be separate processes, hours apart.

It is a preview: the report shapes and the exit codes can still change. There is no `deuz` binary; the command line is this file.

**Run:** from the repo root, `npm install && npm run build`, then

```sh
npm run -s dev -w @deuz-examples/13-headless -- doctor
npm run -s dev -w @deuz-examples/13-headless -- run "Publish the 2.3.0 notes." --run-id notes-1
echo $?   # 3: the run waits for an approval
npm run -s dev -w @deuz-examples/13-headless -- inspect notes-1 --json
npm run -s dev -w @deuz-examples/13-headless -- resume notes-1 --approve
echo $?   # 0: completed
```

`-s` keeps npm's own error lines out of the output; the exit code passes through. `node --experimental-strip-types examples/13-headless/index.ts <command>` runs it directly. No API key needed; Node ≥ 22.6 for the type stripping, and `node:sqlite`, which ships unflagged from Node 22.13 and 23.4. The SQLite file defaults to `deuz-headless-example.sqlite` in the temporary directory and keeps its runs between sessions: pass `--db <file>` to choose another, or use new run IDs to start over. Relative paths (`--db`, `--skills`, `--reconcile`) are taken from the directory you ran the command in.

**When the outcome of a call is unknown.** `--mock crash` makes the run store go down while `tag_release` runs: the tag lands, and its outcome is never recorded. The report names the call and both ways to answer it.

```sh
npm run -s dev -w @deuz-examples/13-headless -- run "Tag 2.3.0." --run-id tag-1 --mock crash
echo $?   # 1: the run store went down mid-call
npm run -s dev -w @deuz-examples/13-headless -- inspect tag-1
echo $?   # 3: tag_release (call_1) started and its outcome was never recorded
echo '[{ "toolCallId": "call_1", "output": { "tag": "v2.3.0" } }]' > landed.json
npm run -s dev -w @deuz-examples/13-headless -- resume tag-1 --reconcile landed.json
echo $?   # 0: the tag is recorded as it landed, and not created again
```

Check the effect first (here: does the tag exist?). If it landed, `--reconcile <file>` records what the call returned (a JSON array of `{ "toolCallId", "output", "isError"? }`) and the call never runs again; if it did not, `--retry-call call_1` runs it once more. A plain `resume` stops again with `tool-reconciliation-required` (exit 3) and writes nothing.

**When the run failed in transit.** `--mock outage` opens the circuit breaker (`deps.breakerStore`), as a shared breaker store does while a provider is down, so the model call fails before it is sent. The failure is transient, so the report carries `retry`.

```sh
npm run -s dev -w @deuz-examples/13-headless -- run "Draft the notes." --run-id draft-1 --mock outage
echo $?   # 1: failed, and the report says it can be retried
npm run -s dev -w @deuz-examples/13-headless -- resume draft-1 --retry-failed
echo $?   # 0: it went on from its last checkpoint
```

Without `--retry-failed`, a resume returns the stored failure (exit 1). `--retry-failed` on a failure that was not transient fails the resume (exit 1) and leaves the stored run as it was.

| Command | Options |
| --- | --- |
| `run "<prompt>"` | `--run-id <id>`, `--skills <dir>` (repeatable), `--budget-usd <n>`, `--mock approval\|complete\|refusal\|crash\|outage` |
| `resume <run-id>` | `--approve` or `--deny` answers the approval the stored run waits on, even when a failed leg's report does not list it (after a failure in transit, give the verdict again with `--retry-failed`); `--retry-call <call-id>` (repeatable) runs an unknown effect again; `--reconcile <file.json>` records the results that landed; `--retry-failed` re-enters a run that failed in transit; pass the same `--skills` as the run |
| `inspect <run-id>` | none: no model call |
| `doctor` | `--budget-usd <n>`, `--model <id>` |

Every command also takes `--json` and `--db <file>`.

| Exit code | Meaning |
| --- | --- |
| 0 | completed (or `doctor` found no errors) |
| 1 | failed (when the failure was transient, the report's `retry` says so); also a resume whose answers the run could not take, which writes nothing |
| 2 | usage: invalid arguments, an unknown run ID, or a `--reconcile` file that cannot be read as JSON |
| 3 | pending: waiting for an approval, a client tool result, a decision on an unknown effect, or a resume |
| 4 | refused by the model |
| 5 | cancelled |
| 6 | a budget, step, deadline or timeout limit stopped it (a transport timeout also carries `retry`, like a failure in transit) |
| 7 | stopped short for another reason (a guardrail, the verifier, a cut-off output) |
| 8 | `doctor` found errors |

**Real provider:** without a key, the model is `createMockModel` from `@deuz-sdk/core/testing`, scripted per command (`--mock refusal` shows exit 4). Set `ANTHROPIC_API_KEY` to run on `claude-opus-4-8`, or pass `--model <id>` for another Anthropic model; `--mock` then has no effect. The example reads the key from the environment and passes it to the factory; core never reads `process.env`. `doctor --model claude-opus-5-5` without the key shows the `missing-api-key` error and exits 8.

**Look at:** `run` reads the `AGENTS.md` and `CLAUDE.md` files from the git root down to the directory you ran it in into the system message (`projectDir`). Those files get the trust of the system message: on a checkout you do not trust, review them first or drop `projectDir`. A file that a link leads outside the repository is skipped and reported as a warning. `--skills <dir>` adds a skills list plus the `load_skill` and `read_skill_resource` tools. Those tools are part of the run's binding, so a `resume` without the same `--skills` fails (exit 1) and leaves the stored run as it was. With `--budget-usd` on the scripted model, the report carries an `unpriced-model` warning: the model has no price, so the USD budget does not count its calls, and `cost.complete` is `false`.
