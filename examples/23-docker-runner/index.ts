/**
 * 23 — Docker runner (2.4, preview).
 *
 * `@deuz-sdk/core/compute/docker` runs code in local Linux containers through
 * the Docker CLI (`shell: false`). `createDockerSandbox` fits the
 * `ComputeSandbox` seam: a fresh container per call with no network, UID
 * 10001, every capability dropped and resource limits, the workspace staged
 * in and nothing copied back. `createDockerProcessRunner` runs a process that
 * outlives its host process: each step is recorded in a
 * `ProcessOperationStore` (here SQLite) before the next, so a restarted host
 * reconnects to the same container instead of starting it twice.
 *
 * No model is involved, so no API key either. Docker must be running, with
 * the pinned image already pulled: the SDK never pulls. Without them the
 * example says so and exits 0.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DockerSandboxError,
  OperationConflictError,
  createDockerProcessRunner,
  createDockerSandbox,
  createSqliteProcessOperationStore,
} from '@deuz-sdk/core/compute/docker';
import type { ProcessRunner, ProcessState } from '@deuz-sdk/core/compute/docker';
import { createInMemoryWorkspace } from '@deuz-sdk/core/workspace';

/** alpine 3.20, pinned by digest: the image the SDK's own Docker tests use. */
const IMAGE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
/** The Docker CLI. Core never reads the environment; this app does. */
const dockerPath = process.env.DOCKER_PATH || 'docker';
/** Every container this run makes carries this `deuz.scope` label. */
const SCOPE = `example-23-${process.pid}`;
const ORDERS = 'order,amount\nA-17,42\nA-18,19\nA-19,7\n';

const short = (id: string | undefined) => (id ?? '').replace('sha256:', '').slice(0, 12);

/** Polls an operation until it reaches one of `states` (or 20 s pass). */
async function settle(
  runner: ProcessRunner,
  operationId: string,
  states: ProcessState[],
): Promise<ProcessState> {
  let state = (await runner.poll(SCOPE, operationId)).state;
  for (let i = 0; i < 100 && !states.includes(state); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = (await runner.poll(SCOPE, operationId)).state;
  }
  return state;
}

async function main(): Promise<void> {
  console.log('1) a sandbox run: a fresh container per call, no network, UID 10001');
  const workspace = createInMemoryWorkspace();
  await workspace.write('orders.csv', ORDERS);
  const sandbox = createDockerSandbox({ image: IMAGE, dockerPath, scope: SCOPE, workspace });
  let first;
  try {
    first = await sandbox.runShell!({
      command:
        'echo "uid $(id -u)"; echo "orders $(($(wc -l < orders.csv) - 1))"; ' +
        '(wget -q -T 2 -O- http://1.1.1.1 >/dev/null 2>&1 && echo online) || echo offline; ' +
        'echo written > made.txt',
    });
  } catch (error) {
    if (!(error instanceof DockerSandboxError)) throw error;
    if (error.code === 'docker_unavailable') {
      console.log(`   skipped: Docker is not available (${error.message})`);
      console.log('   Start Docker (or set DOCKER_PATH to its CLI) and run the example again.');
      return;
    }
    if (error.code === 'image_not_found') {
      console.log(`   skipped: the pinned image is not on this machine, and the SDK never pulls`);
      console.log(`   Pull it once with: docker pull ${IMAGE}`);
      return;
    }
    throw error;
  }
  for (const line of first.stdout.trim().split('\n')) console.log(`   ${line}`);
  console.log(
    `   exit ${first.exitCode}; made.txt on the host: ${await workspace.exists('made.txt')}`,
  );
  const slow = await sandbox.runShell!({ command: 'sleep 30', timeoutMs: 1_000 });
  console.log(`   sleep 30 with a 1 s timeout: timedOut=${slow.timedOut}, exit ${slow.exitCode}`);
  const outside = await sandbox.runShell!({ command: 'pwd', cwd: '../etc' });
  console.log(`   cwd ../etc: exit ${outside.exitCode} (${outside.stderr.trim()})`);
  const tail = createDockerSandbox({ image: IMAGE, dockerPath, scope: SCOPE, maxOutputBytes: 64 });
  const long = await tail.runShell!({ command: 'seq 1 1000' });
  console.log(
    `   seq 1 1000 with a 64-byte tail: ends "${long.stdout.trim().split('\n').at(-1)}", truncated=${JSON.stringify(long.truncated)}`,
  );

  const dir = mkdtempSync(join(tmpdir(), 'deuz-docker-runner-'));
  const path = join(dir, 'process.sqlite');
  let store = createSqliteProcessOperationStore({ path });
  let runner = createDockerProcessRunner({ image: IMAGE, dockerPath, scope: SCOPE, store });
  const started: string[] = [];
  try {
    console.log('\n2) a process: recorded, created, staged, started once, then read back');
    const request = {
      operationId: 'orders-total',
      scope: SCOPE,
      command: [
        'sh',
        '-c',
        "mkdir -p out && awk -F, 'NR > 1 { s += $2 } END { print s }' orders.csv > out/total.txt && echo done",
      ],
      files: [{ path: 'orders.csv', content: ORDERS }],
    };
    started.push(request.operationId);
    const session = await runner.start(request);
    console.log(
      `   start: ${session.state}, container ${short(session.containerId)}, image ${short(session.imageId)}`,
    );
    const exited = await settle(runner, request.operationId, ['exited', 'failed']);
    const polled = await runner.poll(SCOPE, request.operationId);
    console.log(`   poll: ${exited}, exit code ${polled.exitCode}`);
    const output = await runner.readOutput(SCOPE, request.operationId);
    console.log(
      `   output: ${JSON.stringify(output.stdout)}, truncated ${output.truncated.stdout}`,
    );
    const artifact = await runner.readArtifact(SCOPE, request.operationId, 'out/total.txt');
    console.log(
      `   artifact ${artifact.path}: "${new TextDecoder().decode(artifact.bytes).trim()}", ${artifact.size} bytes, ${artifact.digest.slice(0, 19)}…`,
    );
    try {
      await runner.readArtifact(SCOPE, request.operationId, '../etc/passwd');
    } catch (error) {
      if (!(error instanceof DockerSandboxError)) throw error;
      console.log(`   artifact ../etc/passwd: ${error.code}`);
    }

    console.log('\n3) the host restarts: the same operation id reconnects and never starts twice');
    await store.close();
    store = createSqliteProcessOperationStore({ path });
    runner = createDockerProcessRunner({ image: IMAGE, dockerPath, scope: SCOPE, store });
    const again = await runner.start(request);
    console.log(
      `   start again: ${again.state}, same container ${again.containerId === session.containerId}`,
    );
    try {
      await runner.start({ ...request, command: ['sh', '-c', 'echo something else'] });
    } catch (error) {
      if (!(error instanceof OperationConflictError)) throw error;
      console.log(`   the same id with another command: ${error.code}`);
    }

    console.log('\n4) cancel: recorded first, then stop, a 2 s grace and a kill');
    started.push('long-job');
    const long = await runner.start({
      operationId: 'long-job',
      scope: SCOPE,
      command: ['sleep', '300'],
    });
    console.log(`   long-job: ${long.state}`);
    const cancelled = await runner.cancel(SCOPE, 'long-job');
    // `sleep` as PID 1 ignores SIGTERM, so the kill after the grace ends it.
    console.log(
      `   cancel: ${cancelled.state}, killed: ${[137, 143].includes(cancelled.exitCode ?? 0)}`,
    );

    console.log('\n5) reconcile and clean up: the SDK deletes nothing in the background');
    const report = await runner.reconcile({ scope: SCOPE });
    console.log(
      `   reconcile: ${report.matched.length} matched, ${report.orphans.length} orphans, ${report.lost.length} lost`,
    );
    for (const operationId of started) await runner.dispose(SCOPE, operationId);
    const kept = await runner.readOutput(SCOPE, 'orders-total');
    console.log(
      `   disposed both containers; the stored output tail is still ${JSON.stringify(kept.stdout)}`,
    );
    const records = await store.list({ scope: SCOPE });
    console.log(
      `   records: ${records.records.map((r) => `${r.operationId} ${r.state}`).join(', ')}`,
    );
    const pruned = await store.prune({ terminalBefore: Date.now() + 1 });
    console.log(`   prune: ${pruned} terminal records removed`);
    started.length = 0;
  } finally {
    // Leave no container behind, even when a step above failed.
    for (const operationId of started)
      await runner.dispose(SCOPE, operationId).catch(() => undefined);
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
