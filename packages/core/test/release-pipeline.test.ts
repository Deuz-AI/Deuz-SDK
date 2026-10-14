/**
 * The release pipeline (2.4 spec §5.3, §5.4), held against .github/workflows.
 *
 * In 2.3.0 `changeset publish` ran core's prepublishOnly (the whole check) beside react's
 * build. A test timed out under that load: react reached npm, core did not, and only a
 * re-run of the job published it. So: the tag commit passes the same CI workflow a pull
 * request does before anything is published, a missing backend fails instead of skipping,
 * and the release does not finish green unless BOTH packages are on npm at the tag's
 * version. The post-publish check is not only read here but run, with an `npm` shell
 * function standing in for the registry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string | number>;
  with?: Record<string, string | number | boolean>;
}
interface Job {
  name?: string;
  'runs-on'?: string;
  uses?: string;
  needs?: string | string[];
  env?: Record<string, string | number>;
  services?: Record<string, { image: string }>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { branches?: string[] } | null>;
  jobs: Record<string, Job>;
}

// js-yaml ships no types; it is in the tree through eslint and @changesets/cli.
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
const CI_TEXT = read('.github/workflows/ci.yml');
const ci = yaml.load(CI_TEXT) as Workflow;
const release = yaml.load(read('.github/workflows/release.yml')) as Workflow;
const coreScripts = (
  JSON.parse(read('packages/core/package.json')) as { scripts: Record<string, string> }
).scripts;

const runs = (job: Job | undefined) => (job?.steps ?? []).map((step) => step.run ?? '');
const nodeVersion = (job: Job | undefined) =>
  job?.steps?.find((step) => step.uses?.startsWith('actions/setup-node'))?.with?.['node-version'];
const env = (job: Job | undefined, name: string) =>
  job?.env?.[name] === undefined ? undefined : String(job.env[name]);
const needs = (job: Job | undefined) => [job?.needs ?? []].flat();

/** The server containers `integration` defines; every server-backed job uses the same. */
function expectBackends(job: Job | undefined, names: string[]): void {
  const images: Record<string, string> = { postgres: 'postgres:16', redis: 'redis:7' };
  for (const name of names) expect(job?.services?.[name]?.image).toBe(images[name]);
  if (names.includes('postgres')) {
    expect(env(job, 'DEUZ_TEST_POSTGRES_URL')).toBe('postgres://postgres:deuz@localhost:5432/deuz');
  }
  if (names.includes('redis'))
    expect(env(job, 'DEUZ_TEST_REDIS_URL')).toBe('redis://localhost:6379');
}

/**
 * The jobs commented out in ci.yml, uncommented: a block that starts at `  # <job>:` and
 * runs while lines stay commented at that indent.
 */
function commentedJobs(text: string): Record<string, Job> {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {2}# [a-z][\w-]*:\s*$/.test(lines[i]!)) continue;
    for (; i < lines.length && /^ {2}#/.test(lines[i]!); i++)
      out.push(lines[i]!.replace(/^ {2}# ?/, '  '));
  }
  return out.length === 0 ? {} : ((yaml.load(`jobs:\n${out.join('\n')}`) as Workflow).jobs ?? {});
}

describe('ci.yml', () => {
  it('runs on pull requests and pushes to main, and release.yml can call it', () => {
    expect(ci.on).toHaveProperty('pull_request');
    expect(ci.on.push?.branches).toContain('main');
    expect(ci.on).toHaveProperty('workflow_call');
  });

  it('the integration job fails on a missing Postgres or Redis instead of skipping', () => {
    const job = ci.jobs.integration;
    expectBackends(job, ['postgres', 'redis']);
    expect(env(job, 'DEUZ_TEST_REQUIRE_SERVICES')).toBe('1');
    expect(runs(job)).toContain('npm run test -w @deuz-sdk/core');
  });

  it('a docker job runs the core suite on Linux, Node 22, with Docker and every backend required', () => {
    const job = ci.jobs.docker;
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    expect(String(nodeVersion(job))).toBe('22');
    expect(env(job, 'DEUZ_TEST_DOCKER')).toBe('1');
    expect(env(job, 'DEUZ_TEST_REQUIRE_SERVICES')).toBe('1');
    // Required services are required: with no server here, every Postgres or Redis test
    // would fail this job rather than skip.
    expectBackends(job, ['postgres', 'redis']);
    expect(runs(job)).toContain('npm run test -w @deuz-sdk/core');
  });

  it('the rollback job runs exactly when core has a test:rollback script, and is ready until then', () => {
    const active = ci.jobs.rollback;
    const job = coreScripts['test:rollback'] ? active : commentedJobs(CI_TEXT).rollback;
    // An active job without the script would fail every run; a script without the job
    // would never run. The commented-out job is the one to switch on.
    if (!coreScripts['test:rollback']) expect(active).toBeUndefined();
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    expect(String(nodeVersion(job))).toBe('22');
    expectBackends(job, ['postgres']);
    expect(env(job, 'DEUZ_TEST_REQUIRE_SERVICES')).toBe('1');
    expect(runs(job)).toContain('npm run test:rollback -w @deuz-sdk/core');
  });
});

describe('release.yml', () => {
  const publish = release.jobs.publish;
  const steps = publish?.steps ?? [];
  const at = (match: (step: Step) => boolean) => steps.findIndex(match);
  const verify = at((step) => step.run === 'npm run release:verify');
  const publishing = at((step) => step.run?.includes('changeset publish') ?? false);
  const confirming = at((step) => step.run?.includes('npm view') ?? false);
  const githubRelease = at((step) => step.run?.includes('gh release create') ?? false);

  it('publishes only after every job of the CI workflow passed on the tag commit', () => {
    const caller = Object.entries(release.jobs).find(
      ([, job]) => job.uses === './.github/workflows/ci.yml',
    );
    expect(caller).toBeDefined();
    expect(needs(publish)).toContain(caller![0]);
  });

  it('keeps release:verify as the gate right before publishing', () => {
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(publishing).toBeGreaterThan(verify);
  });

  it('checks npm after publishing, also when the publish step failed, and before the GitHub release', () => {
    expect(confirming).toBeGreaterThan(publishing);
    expect(githubRelease).toBeGreaterThan(confirming);
    // A failed publish (one package out, the other not) is the case the check exists for.
    const id = steps[publishing]?.id;
    expect(id).toBeTruthy();
    expect(steps[confirming]?.if).toContain(`steps.${id}.outcome`);
    // "Retry for a few minutes": the registry lags behind a successful publish.
    const { ATTEMPTS, DELAY_SECONDS } = steps[confirming]?.env ?? {};
    const budget = Number(ATTEMPTS) * Number(DELAY_SECONDS);
    expect(budget).toBeGreaterThanOrEqual(120);
    expect(budget).toBeLessThanOrEqual(900);
  });
});

/** True when `bash` runs here and sees this process's environment (not WSL's bash, say). */
function bashWorks(): boolean {
  const probe = spawnSync('bash', ['-c', 'printf %s "$DEUZ_BASH_PROBE"'], {
    env: { ...process.env, DEUZ_BASH_PROBE: 'ok' },
    encoding: 'utf8',
  });
  return probe.status === 0 && probe.stdout === 'ok';
}

/**
 * `npm view <spec> version` against a pretend registry. FAKE_REGISTRY lists
 * `<spec>=<n>`: the spec answers from its n-th lookup on; any other spec, and an
 * earlier lookup, answers the way npm 11 answers a version it lacks (E404, exit 1).
 */
const FAKE_NPM = [
  'npm() {',
  '  local spec="" arg seen entry',
  '  for arg in "$@"; do case "$arg" in @*@*) spec="$arg" ;; esac; done',
  '  printf "%s\\n" "$*" >> "$FAKE_NPM_LOG"',
  '  seen="$(grep -cF -- " $spec " "$FAKE_NPM_LOG" || true)"',
  '  for entry in $FAKE_REGISTRY; do',
  '    if [ "${entry%=*}" = "$spec" ] && [ "$seen" -ge "${entry##*=}" ]; then',
  '      printf "%s\\n" "${spec##*@}"',
  '      return 0',
  '    fi',
  '  done',
  '  echo "npm error code E404" >&2',
  '  return 1',
  '}',
].join('\n');

describe.skipIf(!bashWorks())('release.yml: the post-publish npm check, run', () => {
  const step = (release.jobs.publish?.steps ?? []).find((s) => s.run?.includes('npm view'));
  const scratch = mkdtempSync(join(tmpdir(), 'deuz-release-check-'));
  let calls = 0;
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function confirm(registry: string, overrides: Record<string, string> = {}) {
    const log = join(scratch, `npm-${calls++}.log`).replace(/\\/g, '/');
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${FAKE_NPM}\n${step?.run ?? 'exit 99'}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...Object.fromEntries(Object.entries(step?.env ?? {}).map(([k, v]) => [k, String(v)])),
          GITHUB_REF_NAME: 'v9.8.7',
          GITHUB_RUN_ID: '4242',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'Deuz-AI/Deuz-SDK',
          ATTEMPTS: '4',
          DELAY_SECONDS: '0',
          FAKE_REGISTRY: registry,
          FAKE_NPM_LOG: log,
          ...overrides,
        },
      },
    );
    const lookups = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: result.status, output: `${result.stdout}${result.stderr}`, lookups };
  }

  it("passes when both packages are on npm at the tag's version", () => {
    const { status, lookups } = confirm('@deuz-sdk/core@9.8.7=1 @deuz-sdk/react@9.8.7=1');
    expect(status).toBe(0);
    expect(lookups.some((line) => line.includes(' @deuz-sdk/core@9.8.7 '))).toBe(true);
    expect(lookups.some((line) => line.includes(' @deuz-sdk/react@9.8.7 '))).toBe(true);
    // Fresh metadata on every look, not npm's cached packument.
    expect(lookups.every((line) => line.includes('--prefer-online'))).toBe(true);
  });

  it('waits out registry lag: a package that shows up on the third look still passes', () => {
    const { status, lookups } = confirm('@deuz-sdk/core@9.8.7=1 @deuz-sdk/react@9.8.7=3');
    expect(status).toBe(0);
    expect(lookups.filter((line) => line.includes('@deuz-sdk/react@')).length).toBe(3);
  });

  it('fails naming the missing package and how to re-run, after every attempt', () => {
    const { status, output, lookups } = confirm('@deuz-sdk/react@9.8.7=1');
    expect(status).not.toBe(0);
    expect(lookups.filter((line) => line.includes('@deuz-sdk/core@')).length).toBe(4);
    const error = output.split('\n').find((line) => line.startsWith('::error'));
    expect(error).toContain('@deuz-sdk/core@9.8.7');
    expect(error).not.toContain('@deuz-sdk/react@9.8.7');
    expect(error).toContain('gh run rerun 4242 --failed');
  });

  it("a version other than the tag's does not count", () => {
    const { status, output } = confirm('@deuz-sdk/core@9.8.6=1 @deuz-sdk/react@9.8.6=1');
    expect(status).not.toBe(0);
    const error = output.split('\n').find((line) => line.startsWith('::error'));
    expect(error).toContain('@deuz-sdk/core@9.8.7');
    expect(error).toContain('@deuz-sdk/react@9.8.7');
  });
});
