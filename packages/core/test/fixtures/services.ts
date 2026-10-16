/**
 * The live services the server-backed tests use (2.4). Every lookup goes
 * through here, so one switch decides whether a missing service skips or fails.
 *
 *   DEUZ_TEST_POSTGRES_URL       a database the tests may create schemas in,
 *                                e.g. postgres://postgres:deuz@localhost:5432/deuz
 *   DEUZ_TEST_REDIS_URL          e.g. redis://localhost:6379
 *   DEUZ_TEST_DOCKER=1           run the tests that drive a real Docker engine
 *   DEUZ_TEST_DOCKER_PATH        the docker CLI to run; default `docker` on PATH
 *   DEUZ_TEST_REQUIRE_SERVICES   `1` (every service) or a list: postgres,redis,docker
 *
 * Without its variable a service's tests skip, as in 2.3. A required service
 * that is missing FAILS instead: a lookup throws at the call site, which is a
 * test file's top level, so the file fails — a release gate must never count a
 * skip as a pass. `docker compose -f docker-compose.test.yml up -d` starts the
 * Postgres and Redis servers CI runs.
 */
import { spawnSync } from 'node:child_process';

export type TestService = 'postgres' | 'redis' | 'docker';

/** The environment a lookup reads; `process.env` unless a test passes its own. */
export type TestEnv = Readonly<Record<string, string | undefined>>;

const SERVICES: readonly TestService[] = ['postgres', 'redis', 'docker'];

const VARIABLES = {
  postgres: 'DEUZ_TEST_POSTGRES_URL',
  redis: 'DEUZ_TEST_REDIS_URL',
} as const;

const EXAMPLES = {
  postgres: 'postgres://postgres:deuz@localhost:5432/deuz',
  redis: 'redis://localhost:6379',
} as const;

/** The services DEUZ_TEST_REQUIRE_SERVICES names; an unknown name throws, so a typo cannot skip. */
export function requiredServices(env: TestEnv = process.env): ReadonlySet<TestService> {
  const value = (env.DEUZ_TEST_REQUIRE_SERVICES ?? '').trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return new Set();
  if (value === '1' || value === 'true' || value === 'all') return new Set(SERVICES);
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names)
    if (!SERVICES.includes(name as TestService))
      throw new Error(
        `DEUZ_TEST_REQUIRE_SERVICES names an unknown service ${JSON.stringify(name)}; ` +
          `use 1 or a list of ${SERVICES.join(', ')}.`,
      );
  return new Set(names as TestService[]);
}

function serverUrl(service: 'postgres' | 'redis', env: TestEnv): string | undefined {
  const variable = VARIABLES[service];
  const url = env[variable] || undefined;
  if (url === undefined && requiredServices(env).has(service))
    throw new Error(
      `DEUZ_TEST_REQUIRE_SERVICES requires ${service}, but ${variable} is not set. ` +
        `Start it with \`docker compose -f docker-compose.test.yml up -d\` and set ` +
        `${variable}=${EXAMPLES[service]}.`,
    );
  return url;
}

/** DEUZ_TEST_POSTGRES_URL, or `undefined` to skip. Throws when Postgres is required and unset. */
export function postgresUrl(env: TestEnv = process.env): string | undefined {
  return serverUrl('postgres', env);
}

/** DEUZ_TEST_REDIS_URL, or `undefined` to skip. Throws when Redis is required and unset. */
export function redisUrl(env: TestEnv = process.env): string | undefined {
  return serverUrl('redis', env);
}

/** The docker CLI the Docker tests run: DEUZ_TEST_DOCKER_PATH, else `docker` on PATH. */
export function dockerCommand(env: TestEnv = process.env): string {
  return env.DEUZ_TEST_DOCKER_PATH || 'docker';
}

/** Whether the engine answered, and its version or the reason it did not. */
export interface DockerProbe {
  ok: boolean;
  detail: string;
}

/** Asks the engine for its version: the CLI alone answers `docker version` with an error. */
function probeDocker(command: string): DockerProbe {
  const result = spawnSync(command, ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    shell: false,
    timeout: 20_000,
    windowsHide: true,
  });
  const version = result.stdout?.trim() ?? '';
  if (result.status === 0 && version) return { ok: true, detail: version };
  const detail = result.error?.message ?? (result.stderr?.trim() || `exit ${result.status}`);
  return { ok: false, detail };
}

/** One probe per CLI per test file: every Docker suite asks, the engine answers once. */
const probed = new Map<string, DockerProbe>();

/**
 * Whether the Docker tests run. False, so they skip, unless DEUZ_TEST_DOCKER=1;
 * then the engine must answer `docker version`, or this throws, as a
 * Postgres URL that names no server fails its tests. Throws, too, when Docker
 * is required and DEUZ_TEST_DOCKER is not 1.
 */
export function dockerAvailable(
  options: { env?: TestEnv; probe?: (command: string) => DockerProbe } = {},
): boolean {
  const env = options.env ?? process.env;
  if (env.DEUZ_TEST_DOCKER !== '1') {
    if (requiredServices(env).has('docker'))
      throw new Error(
        'DEUZ_TEST_REQUIRE_SERVICES requires docker, but DEUZ_TEST_DOCKER is not 1. ' +
          'Start Docker and set DEUZ_TEST_DOCKER=1.',
      );
    return false;
  }
  const command = dockerCommand(env);
  let answer: DockerProbe;
  if (options.probe) answer = options.probe(command);
  else {
    answer = probed.get(command) ?? probeDocker(command);
    probed.set(command, answer);
  }
  if (!answer.ok)
    throw new Error(`DEUZ_TEST_DOCKER=1, but \`docker version\` failed: ${answer.detail}`);
  return true;
}
