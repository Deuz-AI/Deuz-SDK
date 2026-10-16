/**
 * The service lookups every server-backed test goes through (2.4): a missing
 * service skips, as in 2.3, unless DEUZ_TEST_REQUIRE_SERVICES says it must be
 * there, and then it fails. Every case passes its own environment.
 */
import { describe, expect, it } from 'vitest';
import {
  dockerAvailable,
  dockerCommand,
  postgresUrl,
  redisUrl,
  requiredServices,
} from './fixtures/services';

const PG = 'postgres://postgres:deuz@localhost:5432/deuz';
const REDIS = 'redis://localhost:6379';

describe('test services', () => {
  it('hands back the URL a variable names, and nothing when it is unset or empty', () => {
    expect(postgresUrl({})).toBeUndefined();
    expect(redisUrl({})).toBeUndefined();
    expect(postgresUrl({ DEUZ_TEST_POSTGRES_URL: '' })).toBeUndefined();
    expect(postgresUrl({ DEUZ_TEST_POSTGRES_URL: PG })).toBe(PG);
    expect(redisUrl({ DEUZ_TEST_REDIS_URL: REDIS })).toBe(REDIS);
  });

  it('fails a missing service when every service is required', () => {
    for (const value of ['1', 'true', 'all']) {
      const env = { DEUZ_TEST_REQUIRE_SERVICES: value };
      expect(() => postgresUrl(env)).toThrow(
        /DEUZ_TEST_REQUIRE_SERVICES requires postgres, but DEUZ_TEST_POSTGRES_URL is not set/,
      );
      expect(() => redisUrl(env)).toThrow(/DEUZ_TEST_REDIS_URL is not set/);
      expect(() => postgresUrl(env)).toThrow(/docker-compose\.test\.yml/);
      expect(postgresUrl({ ...env, DEUZ_TEST_POSTGRES_URL: PG })).toBe(PG);
    }
  });

  it('requires only the services a list names', () => {
    const env = { DEUZ_TEST_REQUIRE_SERVICES: 'postgres, docker' };
    expect([...requiredServices(env)].sort()).toEqual(['docker', 'postgres']);
    expect(redisUrl(env)).toBeUndefined();
    expect(() => postgresUrl(env)).toThrow(/requires postgres/);
  });

  it('requires nothing when the variable is unset, empty or 0, and refuses unknown names', () => {
    for (const env of [{}, { DEUZ_TEST_REQUIRE_SERVICES: '' }, { DEUZ_TEST_REQUIRE_SERVICES: '0' }])
      expect(requiredServices(env).size).toBe(0);
    // A typo must not quietly turn a required service back into a skip.
    expect(() => postgresUrl({ DEUZ_TEST_REQUIRE_SERVICES: 'postgress' })).toThrow(
      /unknown service "postgress".*postgres, redis, docker/,
    );
  });

  it('skips Docker unless DEUZ_TEST_DOCKER=1, and fails it when required', () => {
    let probes = 0;
    const probe = () => {
      probes++;
      return { ok: true, detail: '29.0.0' };
    };
    expect(dockerAvailable({ env: {}, probe })).toBe(false);
    expect(dockerAvailable({ env: { DEUZ_TEST_DOCKER: '0' }, probe })).toBe(false);
    expect(probes).toBe(0);
    expect(() => dockerAvailable({ env: { DEUZ_TEST_REQUIRE_SERVICES: 'docker' }, probe })).toThrow(
      /requires docker, but DEUZ_TEST_DOCKER is not 1/,
    );
  });

  it('probes the engine when DEUZ_TEST_DOCKER=1, and fails when it does not answer', () => {
    const env = { DEUZ_TEST_DOCKER: '1' };
    expect(dockerAvailable({ env, probe: () => ({ ok: true, detail: '29.0.0' }) })).toBe(true);
    expect(() =>
      dockerAvailable({
        env,
        probe: () => ({ ok: false, detail: 'Cannot connect to the Docker daemon' }),
      }),
    ).toThrow(
      /DEUZ_TEST_DOCKER=1, but `docker version` failed: Cannot connect to the Docker daemon/,
    );
  });

  it('runs the docker CLI on PATH unless DEUZ_TEST_DOCKER_PATH names another', () => {
    expect(dockerCommand({})).toBe('docker');
    expect(dockerCommand({ DEUZ_TEST_DOCKER_PATH: 'C:\\Docker\\docker.exe' })).toBe(
      'C:\\Docker\\docker.exe',
    );
  });

  it.skipIf(process.env.DEUZ_TEST_DOCKER !== '1')(
    'finds the real Docker engine this machine runs',
    () => {
      expect(dockerAvailable()).toBe(true);
    },
  );
});
