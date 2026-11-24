import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAcpAgent } from '@deuz-sdk/core/acp';
import { nodeStreamsToAcpTransport } from '@deuz-sdk/core/acp/stdio';
import { CLI_VERSION, runCli, type CliIo } from '../src/index';
import { resolveCommand } from '../src/spawn';

const FIXTURE = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));

// claude-opus-5-5 costs $4 in / $20 out per million: 1000 + 1000 tokens = $0.024.
const USAGE = { input_tokens: 1000, output_tokens: 1000 };
const SPEND_USD = 0.024;

let upstream: Server;
let upstreamUrl: string;
const seen: { path: string; apiKey: string | undefined }[] = [];
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'deuz-cli-'));
  upstream = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ path: req.url ?? '', apiKey: req.headers['x-api-key'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: USAGE,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

function sink(): { stream: PassThrough; text(): string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  return { stream, text: () => text };
}

function fakeIo(extra: Partial<CliIo> = {}) {
  const stdout = sink();
  const stderr = sink();
  const io: Partial<CliIo> = {
    stdin: new PassThrough(),
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: undefined,
      OPENAI_BASE_URL: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_MANTLE: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined,
      CLAUDE_CODE_USE_FOUNDRY: undefined,
      CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
      CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: undefined,
    },
    cwd: tmp,
    signals: { on: () => {}, off: () => {} },
    untilStopped: async () => {},
    ...extra,
  };
  return { io, stdout: stdout.text, stderr: stderr.text };
}

function anthropicRequest(base: string): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

describe('deuz: help, version and usage errors', () => {
  it('prints the version and the help, exit 0', async () => {
    const version = fakeIo();
    expect(await runCli(['--version'], version.io)).toBe(0);
    expect(version.stdout().trim()).toBe(CLI_VERSION);

    const help = fakeIo();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.stdout()).toContain('Usage: deuz <command>');
    // A receipt file is written only with --receipts.
    expect(help.stdout()).toContain('--receipts <file> keeps a receipt per request');

    const meterHelp = fakeIo();
    expect(await runCli(['meter', '--help'], meterHelp.io)).toBe(0);
    expect(meterHelp.stdout()).toContain('--budget-usd');
    expect(meterHelp.stdout()).toContain('--store');
    // Codex on a ChatGPT login ignores OPENAI_BASE_URL: no `-- codex` example.
    expect(meterHelp.stdout()).not.toMatch(/^ {2}deuz meter .* -- codex$/m);
    expect(meterHelp.stdout()).toContain('Codex on a ChatGPT login ignores OPENAI_BASE_URL');

    const acpHelp = fakeIo();
    expect(await runCli(['acp', '--help'], acpHelp.io)).toBe(0);
    expect(acpHelp.stdout()).toContain("priced by Deuz's bundled table");
    expect(acpHelp.stdout()).toContain('module sets deps.priceProvider');
  });

  it('exits 2 with a one-line hint for an unknown command, an unknown flag and a bad value', async () => {
    const cases: [string[], RegExp][] = [
      [['deploy'], /unknown command 'deploy'.*deuz --help/],
      [['meter', '--budjet-usd', '5'], /unknown option '--budjet-usd'.*deuz meter --help/],
      [['meter', '--budget-usd', 'five'], /--budget-usd must be a nonnegative number/],
      [['meter', '--budget-usd', '5', '--window', 'fortnight'], /unknown --window 'fortnight'/],
      [['meter', '--budget-usd', '5', 'claude'], /put the command after '--'/],
      [['meter', '--store', 'b.sqlite'], /--store needs a ceiling/],
      [['acp'], /needs the agent module/],
    ];
    for (const [argv, pattern] of cases) {
      const { io, stderr } = fakeIo();
      expect(await runCli(argv, io), argv.join(' ')).toBe(2);
      const lines = stderr().trimEnd().split('\n');
      expect(lines, argv.join(' ')).toHaveLength(1);
      expect(lines[0]).toMatch(pattern);
    }
  });
});

describe('resolveCommand on Windows', () => {
  const files = new Set([
    'C:\\tools\\claude.exe',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    'C:\\proj\\node_modules\\.bin\\vitest.cmd',
  ]);
  const host = {
    platform: 'win32' as const,
    env: {
      Path: 'C:\\tools;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\proj\\node_modules\\.bin',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    },
    cwd: 'C:\\proj',
    isFile: (path: string) => files.has(path),
  };

  it('runs an .exe directly and a .cmd shim through cmd.exe with quoted, escaped arguments', () => {
    expect(resolveCommand('claude', ['-p', 'a & b'], host)).toEqual({
      file: 'C:\\tools\\claude.exe',
      args: ['-p', 'a & b'],
      windowsVerbatimArguments: false,
    });
    const codex = resolveCommand('codex', ['say "hi" & exit'], host);
    expect(codex.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(codex.windowsVerbatimArguments).toBe(true);
    expect(codex.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // The metacharacters are caret-escaped twice: once for cmd.exe /c, once for
    // the shim's own `%*`, which a global npm shim passes through cmd.exe again.
    expect(codex.args[3]).toBe(
      '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd ^^^"say^^^ \\^^^"hi\\^^^"^^^ ^^^&^^^ exit^^^""',
    );
    const vitest = resolveCommand('vitest', ['a&b'], host);
    expect(vitest.args[3]).toBe('"C:\\proj\\node_modules\\.bin\\vitest.cmd ^^^"a^^^&b^^^""');
    // cmd.exe cuts a command line at a line break, so such an argument is refused.
    expect(() => resolveCommand('codex', ['line 1\nline 2'], host)).toThrow(/line break/);
    // Not found: left to spawn, which reports ENOENT (exit 127).
    expect(resolveCommand('nope', [], host).file).toBe('nope');
    expect(resolveCommand('claude', [], { ...host, platform: 'linux' }).file).toBe('claude');
  });
});

describe('deuz meter', () => {
  it('serves until stopped: prints the env lines, logs each request, refuses at the ceiling, keeps the budget in SQLite', async () => {
    const store = join(tmp, 'budget.sqlite');
    const receipts = join(tmp, 'receipts.jsonl');
    const statuses: number[] = [];
    const first = fakeIo({
      platform: 'linux',
      untilStopped: async () => {
        const url = /listening on (http:\/\/\S+)/.exec(first.stdout())![1]!;
        for (let i = 0; i < 2; i++) {
          const response = await anthropicRequest(url);
          statuses.push(response.status);
          await response.text();
        }
      },
    });
    const argv = [
      'meter',
      '--budget-usd',
      '0.01',
      '--store',
      store,
      '--receipts',
      receipts,
      '--port',
      '0',
      '--anthropic-upstream',
      upstreamUrl,
    ];
    expect(await runCli(argv, first.io)).toBe(0);

    // One request may overshoot (its measured cost exceeds its estimate); the next is refused.
    expect(statuses).toEqual([200, 402]);
    expect(first.stdout()).toMatch(/export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+\n/);
    expect(first.stdout()).toMatch(/export OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/v1\n/);
    expect(first.stdout()).toContain('key deuz:meter');
    const log = first.stderr();
    expect(log).toMatch(
      /POST \/v1\/messages · claude-opus-5-5 · 200 completed · 2,000 tok · \$0\.0240 · \$0\.00 of \$0\.0100 left/,
    );
    expect(log).toMatch(/402 refused · budget deuz:meter exhausted \(usd\)/);
    expect(log).toContain('2 metered requests (1 completed, 1 refused)');
    expect(log).not.toContain('sk-test');
    const lines = readFileSync(receipts, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { outcome: string; usd?: number });
    expect(lines.map((r) => r.outcome)).toEqual(['completed', 'refused']);
    expect(lines[0]!.usd).toBeCloseTo(SPEND_USD, 6);
    expect(seen.filter((s) => s.path === '/v1/messages')).toHaveLength(1);
    expect(seen[0]!.apiKey).toBe('sk-test');

    // A second process sees the spend; the same key with another window is refused clearly.
    const again = fakeIo({ platform: 'linux' });
    expect(
      await runCli(['meter', '--budget-usd', '0.01', '--store', store, '--port', '0'], again.io),
    ).toBe(0);
    expect(again.stdout()).toContain('$0.00 of $0.0100 left');
    const conflict = fakeIo();
    expect(
      await runCli(
        [
          'meter',
          '--budget-usd',
          '1',
          '--store',
          store,
          '--key',
          'deuz:meter',
          '--window',
          'day',
          '--port',
          '0',
        ],
        conflict.io,
      ),
    ).toBe(1);
    expect(conflict.stderr()).toMatch(
      /budget key 'deuz:meter' already exists with a different window/,
    );
  });

  it('prints PowerShell and cmd lines on Windows shells', async () => {
    const { io, stdout } = fakeIo({ platform: 'win32', env: { PATH: '' } });
    expect(await runCli(['meter', '--port', '0'], io)).toBe(0);
    expect(stdout()).toMatch(/\$env:ANTHROPIC_BASE_URL = "http:\/\/127\.0\.0\.1:\d+"/);
    expect(stdout()).toMatch(/set OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/v1/);
    expect(stdout()).toContain('budget: none');
  });

  it('runs a real child after --: injects the base URLs, meters its traffic, exits with its code', async () => {
    seen.length = 0;
    const script = `(async () => {
      const r = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-child', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await r.text();
      console.log(JSON.stringify({ a: process.env.ANTHROPIC_BASE_URL, o: process.env.OPENAI_BASE_URL, d: process.env.DEUZ_METER_URL, status: r.status }));
      process.exit(7);
    })();`;
    const { io, stdout, stderr } = fakeIo({ untilStopped: undefined });
    const code = await runCli(
      [
        'meter',
        '--budget-usd',
        '5',
        '--anthropic-upstream',
        upstreamUrl,
        '--',
        process.execPath,
        '-e',
        script,
      ],
      io,
    );
    expect(code).toBe(7);
    const report = JSON.parse(stdout().trim()) as {
      a: string;
      o: string;
      d: string;
      status: number;
    };
    expect(report.a).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(report.o).toBe(`${report.a}/v1`);
    expect(report.d).toBe(report.a);
    expect(report.status).toBe(200);
    expect(seen).toEqual([{ path: '/v1/messages', apiKey: 'sk-child' }]);
    expect(stderr()).toContain('1 metered request (1 completed), 2,000 tokens, $0.0240 measured');
    expect(stderr()).toContain('budget deuz:meter: $4.98 of $5.00 left');
  });

  it('refuses to start a command whose base URL points elsewhere, unless an upstream flag names it', async () => {
    const redirected = fakeIo({
      untilStopped: undefined,
      env: { ...process.env, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' },
    });
    expect(await runCli(['meter', '--', 'deuz-no-such-command-xyz'], redirected.io)).toBe(2);
    expect(redirected.stderr()).toMatch(/OPENAI_BASE_URL is set to another endpoint/);
    expect(redirected.stderr()).not.toContain('openrouter');

    // The provider's own URL, or an explicit flag, is fine.
    for (const [env, flags] of [
      [{ OPENAI_BASE_URL: 'https://api.openai.com/v1' }, []],
      [{ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }, ['--openai-upstream', upstreamUrl]],
    ] as const) {
      const ok = fakeIo({ untilStopped: undefined, env: { ...process.env, ...env } });
      expect(await runCli(['meter', ...flags, '--', 'deuz-no-such-command-xyz'], ok.io)).toBe(127);
    }
  });

  it('refuses to start a command while a Claude Code provider switch is set, naming it but not its value', async () => {
    const base = fakeIo().io.env!;
    const switched = fakeIo({
      untilStopped: undefined,
      env: { ...base, CLAUDE_CODE_USE_BEDROCK: 'value-must-not-leak', CLAUDE_CODE_USE_VERTEX: '1' },
    });
    expect(await runCli(['meter', '--', 'deuz-no-such-command-xyz'], switched.io)).toBe(2);
    expect(switched.stderr()).toMatch(
      /CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX are set: Claude Code would send its model traffic to that provider instead of the meter/,
    );
    expect(switched.stderr()).not.toContain('value-must-not-leak');

    // An off value is not a switch.
    const off = fakeIo({ untilStopped: undefined, env: { ...base, CLAUDE_CODE_USE_FOUNDRY: '0' } });
    expect(await runCli(['meter', '--', 'deuz-no-such-command-xyz'], off.io)).toBe(127);
  });

  it('exits 127 when the command cannot be found', async () => {
    const { io, stderr } = fakeIo({ untilStopped: undefined });
    expect(await runCli(['meter', '--', 'deuz-no-such-command-xyz'], io)).toBe(127);
    expect(stderr()).toContain("cannot start 'deuz-no-such-command-xyz': command not found");
  });
});

describe('deuz acp', () => {
  it('reports a missing module, a missing export and a wrong shape clearly (exit 1)', async () => {
    const cases: [string[], RegExp][] = [
      [['acp', './nope/agent.js'], /no such file: .*agent\.js/],
      [
        ['acp', FIXTURE, '--export', 'agent'],
        /has no export 'agent' \(it exports: broken, default, factory, priced\); pass --export <name>/,
      ],
      [['acp', FIXTURE, '--export', 'broken'], /export 'broken' of .* has no 'run'/],
    ];
    for (const [argv, pattern] of cases) {
      const { io, stdout, stderr } = fakeIo();
      expect(await runCli(argv, io), argv.join(' ')).toBe(1);
      expect(stderr()).toMatch(pattern);
      expect(stdout()).toBe('');
    }
  });

  it('serves the module over ACP on stdio, with protocol on stdout and logs on stderr', async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const stderr = sink();
    const running = runCli(['acp', FIXTURE, '--budget-usd', '5', '--footer'], {
      stdin: toAgent,
      stdout: fromAgent,
      stderr: stderr.stream,
      cwd: tmp,
      env: process.env,
      signals: { on: () => {}, off: () => {} },
    });
    const client = await connectAcpAgent({
      transport: nodeStreamsToAcpTransport(fromAgent, toAgent, { endOnClose: true }),
    });
    expect(client.agent.agentInfo?.name).toBe('fixture-agent');
    const session = await client.newSession({ cwd: tmp });
    const result = await session.prompt('hi').result;
    expect(result.text).toContain('hello from the fixture');
    expect(result.text).toContain('budget');
    await client.close();
    expect(await running).toBe(0);
    expect(stderr.text()).toMatch(
      /deuz acp: serving fixture-agent from .*agent\.mjs over stdio; budget \$5\.00/,
    );
  });

  it('prices a turn under --budget-usd when the module names no price provider', async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const running = runCli(
      ['acp', FIXTURE, '--export', 'priced', '--budget-usd', '5', '--footer'],
      {
        stdin: toAgent,
        stdout: fromAgent,
        stderr: new PassThrough(),
        cwd: tmp,
        env: process.env,
        signals: { on: () => {}, off: () => {} },
      },
    );
    const client = await connectAcpAgent({
      transport: nodeStreamsToAcpTransport(fromAgent, toAgent, { endOnClose: true }),
    });
    const session = await client.newSession({ cwd: tmp });
    const result = await session.prompt('hi').result;
    expect(result.text).toContain('priced reply');
    // 1,000 input tokens at $4/M plus 500 output at $20/M: the ceiling counts real dollars.
    expect(result.text).toContain('turn $0.0140');
    expect(result.text).toContain('remaining $4.99');
    expect(result.text).not.toContain('unpriced');
    await client.close();
    expect(await running).toBe(0);
  });

  it('calls a factory export with the arguments after --', async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const running = runCli(['acp', FIXTURE, '--export', 'factory', '--', 'alpha'], {
      stdin: toAgent,
      stdout: fromAgent,
      stderr: new PassThrough(),
      cwd: tmp,
      signals: { on: () => {}, off: () => {} },
    });
    const client = await connectAcpAgent({
      transport: nodeStreamsToAcpTransport(fromAgent, toAgent, { endOnClose: true }),
    });
    expect(client.agent.agentInfo?.name).toBe('factory-alpha');
    await client.close();
    expect(await running).toBe(0);
  });
});
