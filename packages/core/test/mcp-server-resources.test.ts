/**
 * `@deuz-sdk/core/mcp/server` (2.5) — resources, URI templates, prompts and the
 * mutable catalog on the Deuz MCP server.
 *
 * What this file pins, on the real v2 server SDK with no network:
 *
 * - static resources and templates list and read, text and binary, with the
 *   same per-request identity tools get (`authInfo`, `runtimeContext`), so a
 *   read can be scoped to a tenant and `null` answers not-found;
 * - prompts list their declared arguments and a bad `prompts/get` is rejected
 *   BEFORE `get` runs;
 * - `server.catalog` changes are served at once and announced with
 *   `list_changed` where the session can carry it (2026-07-28 listen streams
 *   over HTTP and stdio, a 2025-era stdio session), and `resources/updated`
 *   reaches subscribers only, and only those whose identity can read the URI;
 * - template variables reach `read` decoded, and a value that escapes its
 *   RFC 6570 operator is resource-not-found unless the template opts into
 *   `rawVariables`;
 * - a 2025-era client over stateless HTTP is never offered `resources.subscribe`.
 *
 * HTTP clients are wired into `server.fetch` through a fetch shim; stdio runs
 * over the in-process pipe from `helpers/mcp-pipe-transport.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { Client as V2Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1HttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  PromptListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpServer,
  type DeuzMcpServer,
  type McpAuthInfo,
  type McpServerOptions,
} from '../src/mcp/server';
import { serveMcpStdio, type McpStdioServerHandle } from '../src/node/mcp-server';
import { InvalidRequestError } from '../src/errors';
import { stdioPipe } from './helpers/mcp-pipe-transport';

const ENDPOINT = 'http://deuz-mcp.test/mcp';

const servers: DeuzMcpServer[] = [];
const closers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

function serve(options: McpServerOptions): DeuzMcpServer {
  const server = createMcpServer(options);
  servers.push(server);
  return server;
}

function fetchInto(server: DeuzMcpServer, authInfo?: McpAuthInfo) {
  return (input: string | URL, init?: RequestInit): Promise<Response> =>
    server.fetch(new Request(input, init), authInfo ? { authInfo } : undefined);
}

/** A 2026-07-28 client over HTTP. */
async function modernHttp(server: DeuzMcpServer, authInfo?: McpAuthInfo): Promise<V2Client> {
  const client = new V2Client(
    { name: 'v2', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: fetchInto(server, authInfo) }),
  );
  closers.push(client);
  return client;
}

/** A 2025-11-25 client (v1 SDK) over stateless HTTP. */
async function legacyHttp(server: DeuzMcpServer): Promise<V1Client> {
  const client = new V1Client({ name: 'v1', version: '1.0.0' });
  await client.connect(new V1HttpTransport(new URL(ENDPOINT), { fetch: fetchInto(server) }));
  closers.push(client);
  return client;
}

async function stdio(server: DeuzMcpServer) {
  const pipe = stdioPipe();
  const handle: McpStdioServerHandle = await serveMcpStdio(server, {
    stdin: pipe.stdin,
    stdout: pipe.stdout,
  });
  closers.push(handle);
  return pipe;
}

const auth = (clientId: string): McpAuthInfo => ({ token: `t-${clientId}`, clientId, scopes: [] });

/** Notes keyed by tenant: a tenant reads and lists only its own. */
const NOTES: Record<string, Record<string, string>> = {
  acme: { n1: 'acme note one', n2: 'acme note two' },
  globex: { n1: 'globex note' },
};

function catalogOptions(): McpServerOptions {
  return {
    name: 'deuz-resources',
    runtimeContext: (request) => ({ tenant: request.authInfo?.clientId ?? 'anonymous' }),
    resources: {
      readme: {
        uri: 'docs://readme',
        title: 'Readme',
        mimeType: 'text/markdown',
        read: () => '# Hello',
      },
      logo: {
        uri: 'assets://logo.png',
        mimeType: 'image/png',
        read: () => new Uint8Array([137, 80, 78, 71]),
      },
    },
    resourceTemplates: {
      note: {
        uriTemplate: 'notes://{id}',
        mimeType: 'text/plain',
        description: 'A note of the calling tenant.',
        list: ({ runtimeContext }) => {
          const { tenant } = runtimeContext as { tenant: string };
          return Object.keys(NOTES[tenant] ?? {}).map((id) => ({ uri: `notes://${id}`, name: id }));
        },
        read: ({ variables, runtimeContext }) => {
          const { tenant } = runtimeContext as { tenant: string };
          return NOTES[tenant]?.[String(variables.id)] ?? null;
        },
      },
    },
    prompts: {
      review: {
        description: 'Review a diff.',
        arguments: {
          diff: { description: 'The diff to review.', required: true },
          tone: { description: 'friendly or strict' },
        },
        schema: z.object({ diff: z.string(), tone: z.enum(['friendly', 'strict']).optional() }),
        get: ({ diff, tone }, { request }) => ({
          description: `Review for ${request.authInfo?.clientId ?? 'anonymous'}`,
          messages: [
            { role: 'user', content: `Review this (${tone ?? 'friendly'}):\n${diff}` },
            { role: 'assistant', content: { type: 'text', text: 'On it.' } },
          ],
        }),
      },
    },
  };
}

describe('resources and templates', () => {
  it('lists static resources, tenant-scoped template entries and templates; reads text and binary', async () => {
    const server = serve(catalogOptions());
    const client = await modernHttp(server, auth('acme'));

    const listed = await client.listResources();
    expect(listed.resources.map((r) => r.uri)).toEqual([
      'docs://readme',
      'assets://logo.png',
      'notes://n1',
      'notes://n2',
    ]);
    expect(listed.resources[0]).toMatchObject({
      name: 'readme',
      title: 'Readme',
      mimeType: 'text/markdown',
    });
    // A template-enumerated entry inherits the template's metadata.
    expect(listed.resources[2]).toMatchObject({ name: 'n1', mimeType: 'text/plain' });

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({ name: 'note', uriTemplate: 'notes://{id}' }),
    ]);

    const readme = await client.readResource({ uri: 'docs://readme' });
    expect(readme.contents).toEqual([
      { uri: 'docs://readme', text: '# Hello', mimeType: 'text/markdown' },
    ]);
    const logo = await client.readResource({ uri: 'assets://logo.png' });
    expect(logo.contents).toEqual([
      {
        uri: 'assets://logo.png',
        blob: btoa(String.fromCharCode(137, 80, 78, 71)),
        mimeType: 'image/png',
      },
    ]);
  });

  it('scopes template reads to the verified caller, and null is resource-not-found', async () => {
    const server = serve(catalogOptions());
    const acme = await modernHttp(server, auth('acme'));
    const globex = await modernHttp(server, auth('globex'));

    expect((await acme.readResource({ uri: 'notes://n2' })).contents[0]).toMatchObject({
      text: 'acme note two',
    });
    expect((await globex.readResource({ uri: 'notes://n1' })).contents[0]).toMatchObject({
      text: 'globex note',
    });
    // globex has no n2: the read answers not-found instead of leaking acme's.
    await expect(globex.readResource({ uri: 'notes://n2' })).rejects.toThrow(/not found/i);
    expect((await globex.listResources()).resources.map((r) => r.uri)).not.toContain('notes://n2');
  });

  it('a throwing read fails that request with its message', async () => {
    const server = serve({
      name: 'failing',
      resources: {
        secret: {
          uri: 'vault://secret',
          read: ({ request }) => {
            if (!request.authInfo) throw new Error('unauthorized: no verified caller');
            return 'shh';
          },
        },
      },
    });
    const anonymous = await modernHttp(server);
    await expect(anonymous.readResource({ uri: 'vault://secret' })).rejects.toThrow(
      /unauthorized: no verified caller/,
    );
    const known = await modernHttp(server, auth('acme'));
    expect((await known.readResource({ uri: 'vault://secret' })).contents[0]).toMatchObject({
      text: 'shh',
    });
  });

  it('decodes template variables and refuses values that escape their operator', async () => {
    const read = vi.fn(({ variables }: { variables: Record<string, string | string[]> }) =>
      JSON.stringify(variables),
    );
    const server = serve({
      name: 'variables',
      resourceTemplates: {
        note: { uriTemplate: 'notes://{id}', read },
        file: { uriTemplate: 'files:///{+path}', read },
        raw: { uriTemplate: 'raw://{id}', rawVariables: true, read },
      },
    });
    const client = await modernHttp(server);
    const variablesOf = async (uri: string) => {
      const [content] = (await client.readResource({ uri })).contents;
      return JSON.parse(content && 'text' in content ? content.text : 'null') as unknown;
    };

    expect(await variablesOf('notes://hello%20world')).toEqual({ id: 'hello world' });
    expect(await variablesOf('files:///a/b%20c')).toEqual({ path: 'a/b c' });
    expect(await variablesOf('raw://hello%20world')).toEqual({ id: 'hello%20world' });
    expect(await variablesOf('raw://42?tenant=x')).toEqual({ id: '42?tenant=x' });
    read.mockClear();

    for (const uri of [
      'notes://42?tenant=x', // '{id}' ran into the query
      'notes://42#top', // ... or the fragment
      'notes://..%2F..%2Fetc', // a path separator in one segment
      'notes://%2E%2E', // a dot segment
      'notes://a%5Cb', // a backslash
      'notes://bad%ZZ', // invalid percent-encoding
      'notes://%C3%28', // not UTF-8
      'notes://a%00b', // a control character
      'files:///a/b?x=1', // '{+path}' stops at the query
      'files:///a/..%2Fb', // decodes to a dot segment
    ]) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow(/not found/i);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects broken definitions at construction and at ready()', async () => {
    expect(() =>
      createMcpServer({
        name: 'dupe',
        resources: {
          a: { uri: 'docs://x', read: () => 'a' },
          b: { uri: 'docs://x', read: () => 'b' },
        },
      }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      createMcpServer({
        name: 'relative',
        resources: { a: { uri: 'just/a/path', read: () => 'a' } },
      }),
    ).toThrow(/invalid uri/);
    const badTemplate = serve({
      name: 'bad-template',
      resourceTemplates: { t: { uriTemplate: 'notes://{id', read: () => 'x' } },
    });
    await expect(badTemplate.ready()).rejects.toThrow(/invalid uriTemplate/);
  });
});

describe('prompts', () => {
  it('lists declared arguments and builds messages with the caller identity', async () => {
    const server = serve(catalogOptions());
    const client = await modernHttp(server, auth('acme'));

    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual([
      expect.objectContaining({
        name: 'review',
        description: 'Review a diff.',
        arguments: [
          { name: 'diff', description: 'The diff to review.', required: true },
          { name: 'tone', description: 'friendly or strict', required: false },
        ],
      }),
    ]);

    const result = await client.getPrompt({
      name: 'review',
      arguments: { diff: '+a', tone: 'strict' },
    });
    expect(result.description).toBe('Review for acme');
    expect(result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Review this (strict):\n+a' } },
      { role: 'assistant', content: { type: 'text', text: 'On it.' } },
    ]);
  });

  it('rejects a missing, unknown or schema-invalid argument before get runs', async () => {
    const get = vi.fn(() => 'never');
    const server = serve({
      name: 'strict-prompts',
      prompts: {
        p: {
          arguments: { level: { required: true } },
          schema: z.object({ level: z.enum(['low', 'high']) }),
          get,
        },
        proto: { arguments: { constructor: { required: true } }, get },
      },
    });
    const client = await modernHttp(server);

    await expect(client.getPrompt({ name: 'p', arguments: {} })).rejects.toThrow(
      /missing required argument 'level'/,
    );
    await expect(client.getPrompt({ name: 'proto', arguments: {} })).rejects.toThrow(
      /missing required argument 'constructor'/,
    );
    await expect(
      client.getPrompt({ name: 'p', arguments: { level: 'low', extra: 'x' } }),
    ).rejects.toThrow(/unknown argument 'extra'/);
    await expect(client.getPrompt({ name: 'p', arguments: { level: 'medium' } })).rejects.toThrow(
      /Invalid arguments for prompt p/,
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe('the mutable catalog', () => {
  it('serves changes on the next request and pushes list_changed on a 2026-07-28 HTTP listen stream', async () => {
    const server = serve({
      name: 'mutable',
      tools: { ping: { parameters: { type: 'object' }, execute: () => 'pong' } },
    });
    const client = await modernHttp(server);
    const changed = vi.fn();
    client.setNotificationHandler('notifications/tools/list_changed', changed);
    const subscription = await client.listen({ toolsListChanged: true });
    closers.push(subscription);
    expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });

    await server.catalog.setTool('echo', {
      description: 'Echo.',
      parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      execute: (args) => (args as { v: string }).v,
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ping', 'echo']);
    expect(await client.callTool({ name: 'echo', arguments: { v: 'hi' } })).toMatchObject({
      content: [{ type: 'text', text: 'hi' }],
    });

    expect(await server.catalog.removeTool('ping')).toBe(true);
    expect(await server.catalog.removeTool('ping')).toBe(false);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    await expect(
      server.catalog.setTool('broken', { parameters: { type: 'object' } }),
    ).rejects.toThrow(/no execute/);
  });

  it('a 2025-era stateless HTTP client sees changes on its next list but is never offered subscribe', async () => {
    const server = serve({ name: 'legacy-http', resources: {} });
    const client = await legacyHttp(server);

    expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: true });
    expect((await client.listResources()).resources).toEqual([]);
    await server.catalog.setResource('motd', { uri: 'text://motd', read: () => 'hello' });
    expect((await client.listResources()).resources.map((r) => r.name)).toEqual(['motd']);
    expect((await client.readResource({ uri: 'text://motd' })).contents[0]).toMatchObject({
      text: 'hello',
    });
    await expect(
      server.catalog.setResource('other', { uri: 'text://motd', read: () => 'clash' }),
    ).rejects.toThrow(/already serves/);
  });

  it('a 2025-era stdio session gets list_changed pushed and resources/updated for its subscriptions only', async () => {
    const server = createMcpServer({
      name: 'stdio-catalog',
      prompts: {},
      resources: {
        a: { uri: 'mem://a', read: () => 'A' },
        b: { uri: 'mem://b', read: () => 'B' },
      },
    });
    const pipe = await stdio(server);
    const client = new V1Client({ name: 'v1', version: '1.0.0' });
    closers.push(client);
    const promptsChanged = vi.fn();
    const updated = vi.fn();
    client.setNotificationHandler(PromptListChangedNotificationSchema, promptsChanged);
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updated(n.params.uri));
    await client.connect(pipe.transport() as never);

    expect(client.getServerCapabilities()?.resources).toEqual({
      listChanged: true,
      subscribe: true,
    });
    expect((await client.listPrompts()).prompts).toEqual([]);

    await server.catalog.setPrompt('greet', { get: () => 'Say hello.' });
    await vi.waitFor(() => expect(promptsChanged).toHaveBeenCalledTimes(1));
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['greet']);
    expect((await client.getPrompt({ name: 'greet' })).messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Say hello.' } },
    ]);

    await client.subscribeResource({ uri: 'mem://a' });
    await server.catalog.resourceUpdated('mem://b');
    await server.catalog.resourceUpdated('mem://a');
    await vi.waitFor(() => expect(updated).toHaveBeenCalledWith('mem://a'));
    expect(updated).not.toHaveBeenCalledWith('mem://b');

    // Declared without a trailing slash, listed (and subscribed) with one.
    await server.catalog.setResource('site', { uri: 'https://example.com', read: () => 'S' });
    const listed = (await client.listResources()).resources.find((r) => r.name === 'site');
    expect(listed?.uri).toBe('https://example.com/');
    await client.subscribeResource({ uri: listed!.uri });
    await server.catalog.resourceUpdated('https://example.com');
    await vi.waitFor(() => expect(updated).toHaveBeenCalledWith('https://example.com/'));
  });

  it('a 2026-07-28 stdio session receives catalog changes on its listen stream', async () => {
    const server = createMcpServer({ name: 'stdio-modern', resources: {} });
    const pipe = await stdio(server);
    const client = new V2Client(
      { name: 'v2', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    closers.push(client);
    const listChanged = vi.fn();
    const updated = vi.fn();
    client.setNotificationHandler('notifications/resources/list_changed', listChanged);
    client.setNotificationHandler('notifications/resources/updated', (n) => updated(n.params.uri));
    await client.connect(pipe.transport() as never);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    const subscription = await client.listen({
      resourcesListChanged: true,
      resourceSubscriptions: ['mem://doc'],
    });
    closers.push(subscription);

    await server.catalog.setResource('doc', { uri: 'mem://doc', read: () => 'v1' });
    await vi.waitFor(() => expect(listChanged).toHaveBeenCalled());
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(['mem://doc']);

    await server.catalog.resourceUpdated('mem://doc');
    await vi.waitFor(() => expect(updated).toHaveBeenCalledWith('mem://doc'));
  });

  it('delivers resources/updated on an HTTP listen stream only to callers who can read the URI', async () => {
    const server = serve(catalogOptions());
    const acme = await modernHttp(server, auth('acme'));
    const globex = await modernHttp(server, auth('globex'));
    const acmeUpdated = vi.fn();
    const globexUpdated = vi.fn();
    acme.setNotificationHandler('notifications/resources/updated', (n) =>
      acmeUpdated(n.params.uri),
    );
    globex.setNotificationHandler('notifications/resources/updated', (n) =>
      globexUpdated(n.params.uri),
    );
    closers.push(await acme.listen({ resourceSubscriptions: ['notes://n2'] }));
    // globex asks for acme's n2 too; only n1 is globex's to read.
    closers.push(await globex.listen({ resourceSubscriptions: ['notes://n2', 'notes://n1'] }));

    await server.catalog.resourceUpdated('notes://n2');
    await server.catalog.resourceUpdated('notes://n1');
    await vi.waitFor(() => expect(acmeUpdated).toHaveBeenCalledWith('notes://n2'));
    // Frames are judged in order: n1 arriving means n2 was already dropped.
    await vi.waitFor(() => expect(globexUpdated).toHaveBeenCalledWith('notes://n1'));
    expect(globexUpdated).not.toHaveBeenCalledWith('notes://n2');
    expect(acmeUpdated).not.toHaveBeenCalledWith('notes://n1');
  });

  it('a stdio session gets resources/updated only for URIs its identity can read', async () => {
    const server = createMcpServer({
      name: 'stdio-scoped',
      runtimeContext: () => ({ tenant: 'acme' }),
      resources: {
        mine: { uri: 'mem://mine', read: () => 'mine' },
        theirs: {
          uri: 'mem://theirs',
          read: ({ runtimeContext }) =>
            (runtimeContext as { tenant: string }).tenant === 'globex' ? 'theirs' : null,
        },
      },
    });
    const pipe = await stdio(server);
    const client = new V2Client(
      { name: 'v2', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    closers.push(client);
    const updated = vi.fn();
    client.setNotificationHandler('notifications/resources/updated', (n) => updated(n.params.uri));
    await client.connect(pipe.transport() as never);
    closers.push(await client.listen({ resourceSubscriptions: ['mem://theirs', 'mem://mine'] }));

    await server.catalog.resourceUpdated('mem://theirs');
    await server.catalog.resourceUpdated('mem://mine');
    await vi.waitFor(() => expect(updated).toHaveBeenCalledWith('mem://mine'));
    expect(updated).not.toHaveBeenCalledWith('mem://theirs');
  });

  it('keeps a tools-only server exactly as in 2.4: no resources or prompts capability', async () => {
    const server = serve({
      name: 'tools-only',
      tools: { ping: { parameters: { type: 'object' }, execute: () => 'pong' } },
    });
    const client = await modernHttp(server);
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
  });
});
