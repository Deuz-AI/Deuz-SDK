/**
 * redis-ioredis-keyprefix.test.ts — the Redis stores behind an ioredis client
 * configured with `keyPrefix`. ioredis prefixes only the keys a command
 * declares (for EVAL, the numkeys keys), never an argument, and the server
 * knows nothing of the prefix. So every key a 2.3 store's script touches has
 * to come from a key the script declares; the store pack sends plain commands,
 * whose keys ioredis knows.
 *
 * A real ioredis client builds every command here, prefix included, and its
 * wire is an ioredis-mock server created WITHOUT a prefix, as a real server
 * would be. The stores' shared contracts run through it, and after each test
 * every key on the server must carry the prefix.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  createRedisBudgetStore,
  createRedisOpsStore,
  wrapIoredisClient,
} from '../src/node/ops-redis';
import { createRedisSwarmStore } from '../src/node/swarm-redis';
import { createRedisStores, type RedisClientLike } from '../src/node/store-redis';
import {
  assertChatStoreContract,
  assertMemoryStoreContract,
  assertSessionStoreContract,
} from './fixtures/store-conformance';
import { runStoreContracts } from './fixtures/run-store-conformance';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';
import { initialSnapshot, swarmStoreContracts } from './fixtures/swarm-store-conformance';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import {
  agentRunListContracts,
  agentRunPruneContracts,
  agentRunStoreContracts,
} from './fixtures/agent-run-store-conformance';
import {
  scheduleClaimContracts,
  scheduleClaimPruneContracts,
} from './fixtures/schedule-claim-conformance';
import { mockRedisServer, type MockRedisServer } from './fixtures/redis-harness';

const PREFIX = 'app:';

/** The command ioredis hands its connection, prefix already applied. */
interface WireCommand {
  name: string;
  args: unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
  promise: Promise<unknown>;
}

type MockCommands = Record<string, (...args: string[]) => Promise<unknown>>;

const opened: Redis[] = [];
const servers: MockRedisServer[] = [];
afterEach(async () => {
  for (const io of opened.splice(0)) io.disconnect();
  for (const server of servers.splice(0))
    for (const key of await server.redis.keys('*')) expect(key.startsWith(PREFIX), key).toBe(true);
});

/** A fresh server, and a real ioredis client with `keyPrefix` whose commands reach it. */
function prefixed(): { server: MockRedisServer; client: Required<RedisClientLike> } {
  const server = mockRedisServer();
  servers.push(server);
  const io = new Redis({ keyPrefix: PREFIX, lazyConnect: true });
  opened.push(io);
  // Every command ioredis builds goes to the server exactly as it would be sent.
  (io as unknown as { sendCommand(command: WireCommand): Promise<unknown> }).sendCommand = (
    command,
  ) => {
    const [first, ...rest] = command.args.map(String);
    const declared = Number(rest[0]);
    const reply =
      command.name === 'eval'
        ? server.client.eval(first!, {
            keys: rest.slice(1, 1 + declared),
            arguments: rest.slice(1 + declared),
          })
        : (server.redis as unknown as MockCommands)[command.name]!(first!, ...rest);
    reply.then(command.resolve, command.reject);
    return command.promise;
  };
  return { server, client: wrapIoredisClient(io) };
}

assertMemoryStoreContract('Redis store pack through ioredis keyPrefix', async () => ({
  store: createRedisStores({ client: prefixed().client }).memory,
}));
assertChatStoreContract('Redis store pack through ioredis keyPrefix', async () => ({
  store: createRedisStores({ client: prefixed().client }).chats,
}));
assertSessionStoreContract('Redis store pack through ioredis keyPrefix', async () => ({
  store: createRedisStores({ client: prefixed().client }).sessions,
}));
runStoreContracts('Redis store pack through ioredis keyPrefix', async () => ({
  store: createRedisStores({ client: prefixed().client }).runs,
}));

budgetStoreContracts(
  'Redis budget store through ioredis keyPrefix',
  async () => {
    const { server, client } = prefixed();
    return { store: createRedisBudgetStore({ client }), advance: server.advance, now: server.now };
  },
  { hours: true },
);
swarmStoreContracts(
  'Redis swarm store through ioredis keyPrefix',
  () => createRedisSwarmStore({ client: prefixed().client }),
  { spawn: true, channels: true, list: true, prune: true },
);
leaseProviderContracts('Redis lease provider through ioredis keyPrefix', async () => {
  const { server, client } = prefixed();
  const ops = createRedisOpsStore({ client });
  return { provider: ops.leases, advance: server.advance, ttl: 1_000, now: server.now };
});
agentRunStoreContracts(
  'Redis agent run store through ioredis keyPrefix',
  async () => createRedisOpsStore({ client: prefixed().client }).agentRuns,
);
agentRunPruneContracts('Redis agent run retention through ioredis keyPrefix', async () => {
  const { server, client } = prefixed();
  const ops = createRedisOpsStore({ client });
  return { store: ops.agentRuns, advance: server.advance, now: server.now };
});
agentRunListContracts('Redis agent run listing through ioredis keyPrefix', async () => {
  const { server, client } = prefixed();
  const ops = createRedisOpsStore({ client });
  return { store: ops.agentRuns, advance: server.advance, now: server.now, frozen: true };
});
scheduleClaimContracts(
  'Redis claims through ioredis keyPrefix',
  async () => createRedisOpsStore({ client: prefixed().client }).claims,
);
scheduleClaimPruneContracts('Redis claim retention through ioredis keyPrefix', async () => {
  const { server, client } = prefixed();
  const ops = createRedisOpsStore({ client });
  return { claim: ops.claims, advance: server.advance, now: server.now };
});

const scope = { key: 'u', limits: { tokens: 100 } };

describe('Redis budget store through ioredis keyPrefix', () => {
  it('writes every key under the prefix', async () => {
    const { server, client } = prefixed();
    const store = createRedisBudgetStore({ client });
    expect(
      await store.reserve({ requestId: 'r1', modelId: 'm', tokens: 50, scopes: [scope] }),
    ).toMatchObject({ admitted: true });
    expect(await server.redis.exists('app:{deuz:budget}:scope:u')).toBe(1);
    expect(await server.redis.exists('{deuz:budget}:scope:u')).toBe(0);
  });

  it('settles and releases the holds it lists', async () => {
    const { server, client } = prefixed();
    const store = createRedisBudgetStore({ client });
    await store.reserve({ requestId: 'r1', modelId: 'm', tokens: 50, scopes: [scope] });
    await store.reserve({ requestId: 'r2', modelId: 'm', tokens: 30, scopes: [scope] });
    expect((await store.holds({ before: server.now() + 1 })).map((hold) => hold.requestId)).toEqual(
      ['r1', 'r2'],
    );
    await store.settle('r1', { tokens: 20, usd: 0 });
    await store.release('r2');
    expect(await store.usage('u')).toEqual({ tokens: 20, usd: 0 });
    expect(await store.holds({ before: server.now() + 1 })).toEqual([]);
  });

  it('prunes the record of a closed request', async () => {
    const { server, client } = prefixed();
    const store = createRedisBudgetStore({ client });
    expect(
      await store.reserve({ requestId: 'd1', modelId: 'm', tokens: 500, scopes: [scope] }),
    ).toMatchObject({ admitted: false });
    expect(await server.redis.exists('app:{deuz:budget}:req:d1')).toBe(1);
    await server.advance(1);
    expect(await store.prune({ before: server.now() })).toMatchObject({ requests: 1 });
    expect(await server.redis.exists('app:{deuz:budget}:req:d1')).toBe(0);
  });
});

describe('Redis swarm store through ioredis keyPrefix', () => {
  it('lists the runs it created', async () => {
    const store = createRedisSwarmStore({ client: prefixed().client });
    await store.create(initialSnapshot('a'), []);
    expect(await store.head({ scope: 'a', runId: 'same' })).toBeDefined();
    expect(await store.listRuns({ limit: 10 })).toHaveLength(1);
    expect(await store.listRuns({ status: 'running', limit: 10 })).toHaveLength(1);
  });

  it('prunes a settled run with its keys and index entries', async () => {
    const { server, client } = prefixed();
    const store = createRedisSwarmStore({ client });
    await store.create(initialSnapshot('a'), []);
    await store.commit({
      scope: 'a',
      runId: 'same',
      expectedRevision: 0,
      run: { status: 'completed', updatedAt: 9 },
    });
    expect(await store.prune({ before: 10 })).toBe(1);
    expect(await store.head({ scope: 'a', runId: 'same' })).toBeUndefined();
    expect(await store.listRuns({ limit: 10 })).toEqual([]);
    for (const key of await server.redis.keys('app:{deuz:swarm}:ix*'))
      expect(await server.redis.zcard(key)).toBe(0);
  });
});
