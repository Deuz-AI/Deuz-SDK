# Headless — run, resume, inspect, doctor

**Shows:** the 2.3 headless preview, `@deuz-sdk/core/headless`, as a small command line. `run` starts a native run and prints a report; `resume` continues it in another process; `inspect` reads a stored run without a model call; `doctor` checks the model, its price, the API key and the Node version before anything runs. `--json` prints the report as JSON for automation, and every command exits with `exitCodeFor(report)`, so a script can branch on the result. Runs live in a SQLite file (`createSqliteOpsStore({ path }).agentRuns`), so `run` and `resume` can be separate processes, hours apart.

It is a preview: the report shapes and the exit codes can still change. There is no `deuz` binary; the command line is this file.

**Run:** from the repo root, `npm install && npm run build`, then

```sh
npm run -s dev -w @deuz-examples/headless -- doctor
npm run -s dev -w @deuz-examples/headless -- run "Publish the 2.3.0 notes." --run-id notes-1
echo $?   # 3: the run waits for an approval
npm run -s dev -w @deuz-examples/headless -- inspect notes-1 --json
npm run -s dev -w @deuz-examples/headless -- resume notes-1 --approve
echo $?   # 0: completed
```

`-s` keeps npm's own error lines out of the output; the exit code passes through. `node --experimental-strip-types examples/headless/index.ts <command>` runs it directly. No API key needed; Node ≥ 22.6 for the type stripping, and `node:sqlite`, which ships unflagged from Node 22.13 and 23.4. The SQLite file defaults to `deuz-headless-example.sqlite` in the temporary directory; pass `--db <file>` to choose another.

| Command | Options |
| --- | --- |
| `run "<prompt>"` | `--run-id <id>`, `--skills <dir>` (repeatable), `--budget-usd <n>`, `--mock approval\|complete\|refusal` |
| `resume <run-id>` | `--approve` or `--deny` answers the pending approval; pass the same `--skills` as the run |
| `inspect <run-id>` | none: no model call |
| `doctor` | `--budget-usd <n>`, `--model <id>` |

Every command also takes `--json` and `--db <file>`.

| Exit code | Meaning |
| --- | --- |
| 0 | completed (or `doctor` found no errors) |
| 1 | failed |
| 2 | usage: invalid arguments, or an unknown run ID |
| 3 | pending: waiting for an approval, a client tool result, a decision on an unknown effect, or a resume |
| 4 | refused by the model |
| 5 | cancelled |
| 6 | a budget, step, deadline or timeout limit stopped it |
| 7 | stopped short for another reason (a guardrail, the verifier, a cut-off output) |
| 8 | `doctor` found errors |

**Real provider:** without a key, the model is `createMockModel` from `@deuz-sdk/core/testing`, scripted per command (`--mock refusal` shows exit 4). Set `ANTHROPIC_API_KEY` to run on `claude-opus-4-8`, or pass `--model <id>` for another Anthropic model. The example reads the key from the environment and passes it to the factory; core never reads `process.env`. `doctor --model claude-opus-5-5` without the key shows the `missing-api-key` error and exits 8.

**Look at:** `run` reads the `AGENTS.md` and `CLAUDE.md` files from the git root down to the working directory into the system message (`projectDir`), and `--skills <dir>` adds a skills list plus the `load_skill` and `read_skill_resource` tools. Those tools are part of the run's binding, so a `resume` without the same `--skills` fails (exit 1) and leaves the stored run as it was. With `--budget-usd` on the scripted model, the report carries an `unpriced-model` warning: the model has no price, so the USD budget does not count its calls, and `cost.complete` is `false`.
