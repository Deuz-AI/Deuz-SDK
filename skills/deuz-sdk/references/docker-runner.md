<!-- verified: 2026-10-15 against @deuz-sdk/core@2.3.0 · api-contract sha256:99750a8aa5fa
     sources: packages/core/src/compute/docker/{index,types,errors,engine,sandbox,runner,memory-store,store-shared}.ts,
     packages/core/src/node/{process-ops-sqlite,compute}.ts, packages/core/src/types/compute.ts, packages/core/src/compute.ts,
     .changeset/{2-4-l6,2-4-fc}.md, docs/content/docs/modules/docker.mdx (lane D1) -->

# Docker sandbox and process runner (2.4, preview)

**Load when:** model-written code must run isolated (not as a child of your host, which `createNodeSandbox` is), or a long process must survive your host restarting — reconnect instead of starting twice, cancel reliably, read its output and files after it stopped. Also when upgrading `createNodeSandbox` users: its 2.4 behaviour changes are at the end.

`@deuz-sdk/core/compute/docker` is Node-only and preview (the API may change in 2.5; the stored record is versioned). It drives the Docker CLI as a child process with `shell: false` and targets Linux containers; it was verified with Docker Desktop on Windows 11 and a Linux engine in CI. It never mounts a host directory or the Docker socket and never pulls an image. Docs: `/docs/modules/docker` (2.4).

| Piece | What it is |
| --- | --- |
| `createDockerSandbox({ image, ... })` | A `ComputeSandbox` (`runCode`, `runShell`) for `codeActTool` / `shellTool`: each run in a fresh container, always removed |
| `createDockerProcessRunner({ image, store, ... })` | A reconnectable `ProcessRunner`: `start`, `poll`, `readOutput`, `readArtifact`, `cancel`, `dispose`, `reconcile` |
| `createInMemoryProcessOperationStore({ deps? })`, `createSqliteProcessOperationStore({ path \| database, wal?, clock? })` | Where operations are recorded (no PostgreSQL store: a container lives on one host's daemon) |
| `DEFAULT_DOCKER_SANDBOX`, `DockerSandboxError`, `OperationConflictError` | Defaults; infrastructure failures (`code`); an operation id reused for another request |

```ts
import { codeActTool, shellTool } from '@deuz-sdk/core/compute';
import {
  createDockerProcessRunner,
  createDockerSandbox,
  createSqliteProcessOperationStore,
} from '@deuz-sdk/core/compute/docker';
import { createInMemoryWorkspace } from '@deuz-sdk/core/workspace';

const workspace = createInMemoryWorkspace();
await workspace.write('data/input.txt', 'three\nlines\nhere\n');

// The image must already be local: it is resolved to its immutable id and never pulled.
const sandbox = createDockerSandbox({ image: 'alpine:3.20', workspace, scope: 'acme' });
const tools = { ...codeActTool(sandbox, { languages: ['sh'] }), ...shellTool(sandbox, { needsApproval: true }) };

const counted = await sandbox.runShell!({ command: 'wc -l < input.txt', cwd: 'data' });
console.log(counted.exitCode, counted.stdout.trim()); // 0 3

// A process that outlives this host process.
const store = createSqliteProcessOperationStore({ path: './process-ops.db' });
const runner = createDockerProcessRunner({ image: 'alpine:3.20', store });
const request = {
  operationId: 'report-2026-10-15', // the idempotency key
  scope: 'acme',
  command: ['sh', '-c', 'mkdir -p out && echo "total: 42" > out/report.txt'],
  deadlineAt: Date.now() + 60_000,
};
let session = await runner.start(request); // after a restart the same call reconnects
while (session.state === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 250));
  session = await runner.poll('acme', request.operationId);
}
const artifact = await runner.readArtifact('acme', request.operationId, 'out/report.txt');
console.log(session.exitCode, artifact.digest.slice(0, 7)); // 0 sha256:
await runner.dispose('acme', request.operationId); // removes the container; the record stays 'disposed'
console.log(Object.keys(tools));
```

## Isolation defaults (`DEFAULT_DOCKER_SANDBOX`)

| Option | Default |
| --- | --- |
| `image` | required; resolved once to its immutable id; `image_not_found` when not local |
| `dockerPath`, `dockerArgs` | `'docker'`; global CLI flags before every subcommand, e.g. `['--context', 'build-box']` |
| `user` | `'10001:10001'` (numeric `uid` or `uid:gid`; staged files are owned by it) |
| `network` | `'none'` |
| `limits` | `cpus` 1, `memoryBytes` 512 MiB (memory-swap equal: no swap), `pids` 128, `storageBytes` unset (`--storage-opt size`, only on drivers that support it) |
| `workdir` | `'/workspace'` (absolute; its parent must exist in the image) |
| `readOnlyRootFilesystem`, `tmpfsBytes` | `false`; with `true`: `--read-only`, a tmpfs `/tmp` of 64 MiB and a writable workspace volume |
| `maxStagingBytes`, `maxArtifactBytes`, `maxOutputBytes` | 256 MiB, 64 MiB, 1 MiB per stream (the tail is kept, `truncated` set) |
| `runTimeoutMs` | 30 s for a sandbox run without `timeoutMs` (then `docker kill`) |
| `interpreters` | `python3 -c`, `bash -c`, `sh -c`, `node -e` by language; the image must contain them |
| `workspace`, `scope`, `labels`, `deps` | Staged into every container through a bounded tar; the `deuz.scope` label; extra labels (`deuz.*` keys are the SDK's: `TypeError`); clock, ids, logger, observer |

Every container gets `--cap-drop ALL`, `--security-opt no-new-privileges`, `--restart no` and an empty `--entrypoint` (the argv runs exactly as given), plus the labels `deuz.operation-id`, `deuz.scope`, `deuz.sdk-version`, `deuz.kind`, and `deuz.run-timeout-ms` (sandbox runs) or `deuz.request-digest` (runner operations). Env values travel in a private temporary env file, never on a command line.

## Sandbox behaviour

- `runShell` runs `/bin/sh -c <command>`; `runCode` the interpreter prefix plus the code. An unknown language returns `exitCode: null` without starting anything.
- `cwd` resolves inside the workspace; outside it is refused (`exitCode: null`, the reason in `stderr`), nothing runs.
- What a run writes stays in its container: nothing is copied back to the host workspace.
- An abort while a run is still preparing keeps the command from starting (`Aborted before start.`, `timedOut: true`).
- Infrastructure failures reject with `DockerSandboxError` (`docker_unavailable`, `docker_failed`, `image_not_found`, `staging_too_large`, …); what the program does is the result.

## The process runner

- **Fixed start order**, each step a compare-and-set on the record: `recorded` → container `created` (named `deuz-<sha256 of scope and operation id>`) → `staged` → a durable `start-dispatched` → one start command → `running` → `exited`. `start` with the same id and request resumes wherever it stopped; the same id with another request throws `OperationConflictError` (subsystem `'process'`). A running or exited container is never started again.
- **Unknown outcomes are explicit.** A start whose outcome is unknown becomes `needs-reconcile`; `reconcile()` marks it `failed` (`start_unconfirmed`) once the record is 30 s old, never starting it. A container that vanished makes the record `lost`, never recreated under that id. A start the daemon refuses is `start_failed`; an OOM kill sets `oom_killed`. Reusing an id whose old container was never disposed fails with `container_conflict`: `dispose`, then prune, before reusing an id.
- **Cancel** is recorded first (`cancel-requested`), then `docker stop -t 2`, a kill if still running, and a state check. While the daemon is unreachable it stays `cancel-requested` (`docker_unavailable`) and the next `poll`, `cancel` or `reconcile` finishes it. A container that never started is removed before `cancelled` is committed.
- **Deadlines are not durable** (`durableTimeout: false`): the runner enforces `deadlineAt` with its own timer while it runs; a deadline that passed while the host was down cancels the process at the next `start`, `poll` or `reconcile` (before starting it, if it never started).
- **Output and artifacts.** `readOutput` is the live `docker logs --tail` window, or after exit / `dispose` the tail stored at exit. `readArtifact(scope, id, path)` reads only from a stopped container (`process_running` otherwise), only a regular file under the workspace with real directory parents, up to `maxArtifactBytes` (`artifact_rejected`, `artifact_too_large`, `not_found`); its `digest` is the `deuz-workspace-v1` per-file digest. The record stores env keys and file sizes, never env values or contents.
- **Cleanup is explicit.** `dispose` removes the container (record stays `disposed`); `reconcile({ scope?, removeOrphans? })` matches labelled containers to records and reports orphans (`{ matched, orphans, lost, removed }`), removing them only with `removeOrphans: true` — a sandbox container or staging helper only once no run can still use it (30 min after create or exit, or past its run timeout); `store.prune({ terminalBefore })` drops old terminal records. Nothing is deleted in the background.
- **SQLite store:** table `deuz_process_ops` with its own `deuz_process_ops_schema` version table; `PRAGMA user_version` and every existing schema version are untouched; a borrowed `database` stays open on `close()`.
- **Spans:** `deuz.process.start`, `poll`, `cancel`, `exit`, `reconcile` with operation ids, states, exit codes and counts, never output.

## `createNodeSandbox` in 2.4 (`@deuz-sdk/core/compute/node`)

- **Behaviour change (H3):** `runShell`'s `cwd` is confined to the sandbox root (`options.cwd`, else the host working directory). A relative path resolves against the root; `..`, an absolute path elsewhere, a symlink or junction pointing out, or a missing directory is refused with `exitCode: null` and the reason in `stderr`, and nothing runs. The shell tool's `cwd` description says so.
- A timeout or abort kills the whole process tree: the process group on POSIX (each child now leads its own group, so a terminal Ctrl-C no longer reaches it directly) and `taskkill /T /F` on Windows; children start with `windowsHide`. A timed-out or aborted run reports `exitCode: null` on every platform.
- `CodeExecutionResult.truncated?: { stdout, stderr }` is set when a stream was cut at `maxOutputBytes` (the Node sandbox keeps the head, the Docker sandbox the tail).
- It is still not a security boundary; use the Docker sandbox (or E2B, a microVM, a remote runner) for untrusted input.

## Deep dive

- `/docs/modules/docker` (2.4) — start order, recovery, cancel, artifacts, reconcile, errors and limits.
- [/docs/modules/autonomy](/docs/modules/autonomy) — `codeActTool`, `shellTool` and the `ComputeSandbox` seam.
