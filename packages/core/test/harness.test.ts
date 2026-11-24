/**
 * Harness as a budgeted sub-agent (2.5): a real child process speaking ACP
 * over stdio (test/fixtures/harness/fake-acp-harness.mjs) calls its model
 * through the meter, which forwards to a fake Anthropic upstream on a
 * 127.0.0.1 port. No real harness and no real provider is called.
 */
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createApprovalSigner } from '../src/durable';
import { generateText } from '../src/index';
import { createMockModel } from '../src/testing';
import type { MeterReceipt } from '../src/meter/index';
import {
  CLAUDE_CODE_PROVIDER_SWITCHES,
  HARNESS_PRESETS,
  claudeCodeHarness,
  compareHarnessCost,
  evaluateHarnessPolicy,
  matchHarnessPath,
  runAcpHarness,
  type HarnessSpec,
} from '../src/harness/index';
import { connectAcpAgent, createAcpPeer, createInMemoryAcpTransportPair } from '../src/acp';
import { harnessTool, runHarness } from '../src/node/harness';
import { createMeterProxy } from '../src/node/meter';
import { spawnAcpAgent } from '../src/node/acp-stdio';
import { AcpError } from '../src/acp/errors';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'harness',
  'fake-acp-harness.mjs',
);
const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness');

// Default env: ANTHROPIC_BASE_URL=<meter>, OPENAI_BASE_URL=<meter>/v1.
const fake: HarnessSpec = { name: 'fake', command: process.execPath, args: [FIXTURE] };

let upstream: Server;
let upstreamUrl = '';
let upstreamCalls = 0;

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    upstreamCalls++;
    const { model } = JSON.parse(body) as { model: string };
    res.writeHead(200, {
      'content-type': 'application/json',
      'request-id': `req_${upstreamCalls}`,
    });
    res.end(
      JSON.stringify({
        id: `msg_${upstreamCalls}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'patched' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const meter = () => ({
  upstreams: [{ provider: 'anthropic', kind: 'anthropic' as const, baseUrl: upstreamUrl }],
});
const script = (value: Record<string, unknown>) => JSON.stringify(value);
// claude-sonnet-4-5: 1000 in x $3/M + 500 out x $15/M.
const MEASURED_USD = 0.0105;

describe('runHarness: the whole chain on a real child process', () => {
  it('spawns, decides a permission, measures through the meter and records the declared cost', async () => {
    const store = createInMemoryBudgetStore();
    const sink: MeterReceipt[] = [];
    const signer = createApprovalSigner({ secret: 'test-secret' });
    const result = await runHarness({
      harness: fake,
      cwd: WORKSPACE,
      prompt: script({
        edits: ['src/a.ts'],
        reads: ['README.md'],
        calls: 1,
        declare: MEASURED_USD,
      }),
      budget: { store, scopes: [{ key: 'harness:test', limits: { usd: 1 } }] },
      meter: meter(),
      policy: {
        rules: [{ name: 'edit-in-workspace', decision: 'allow', kinds: 'edit', paths: ['**'] }],
      },
      signer,
      runId: 'run-1',
      receipts: (receipt) => void sink.push(receipt),
      stderr: 'ignore',
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('patched');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      toolCallId: 'edit-1',
      decision: 'allow',
      decidedBy: 'policy',
      rule: 'edit-in-workspace',
      optionId: 'yes',
      kind: 'edit',
    });
    expect(result.toolCalls).toEqual({
      observed: 2,
      decided: 1,
      allowed: 1,
      denied: 0,
      observedOnly: 1,
    });
    expect(result.calls.find((call) => call.toolCallId === 'edit-1')?.status).toBe('completed');

    const measured = result.cost.measured!;
    expect(measured.exact).toBe(true);
    expect(measured.requests).toBe(1);
    expect(measured.usd).toBeCloseTo(MEASURED_USD, 10);
    expect(measured.receipts[0]).toMatchObject({
      source: 'measured',
      settlement: 'measured',
      outcome: 'completed',
      model: 'claude-sonnet-4-5',
      budgetKeys: ['harness:test'],
    });
    expect(result.cost.declared).toEqual({
      amount: MEASURED_USD,
      currency: 'USD',
      usd: MEASURED_USD,
    });
    expect(result.cost.comparison).toMatchObject({ status: 'consistent', diverged: false });
    expect(result.receipts.map((receipt) => receipt.source)).toEqual(['measured', 'declared']);
    expect(result.receipts[1]).toMatchObject({
      provider: 'acp:fake',
      route: 'acp:session/prompt',
      settlement: 'none',
    });
    // The host's sinks get both: measured from the meter, declared from the run.
    expect(sink.map((receipt) => receipt.source).sort()).toEqual(['declared', 'measured']);
    expect((await store.usage('harness:test')).usd).toBeCloseTo(MEASURED_USD, 10);
    expect(result.budget).toEqual({ exhausted: false, refused: 0, exhaustedKeys: [] });

    const payload = await signer.verify(result.decisions[0]!.token!);
    expect(payload).toMatchObject({
      toolCallId: 'edit-1',
      toolName: 'fake.edit',
      runId: 'run-1',
      input: { decision: 'allow', decidedBy: 'policy' },
    });
  });

  it('refuses at the ceiling with 402, cancels the turn and reports the exhausted scope', async () => {
    const store = createInMemoryBudgetStore();
    const result = await runHarness({
      harness: fake,
      cwd: WORKSPACE,
      // 1000-token ceiling: the first call is admitted on its estimate and settles at 1500, the second is refused.
      prompt: script({ calls: 3, declare: 0.02 }),
      budget: { store, scopes: [{ key: 'harness:tight', limits: { tokens: 1000 } }] },
      meter: meter(),
      stderr: 'ignore',
    });
    expect(result.text).toContain('patched');
    expect(result.text).toContain('budget refused: billing_error');
    expect(result.stopReason).toBe('cancelled');
    expect(result.budget).toEqual({
      exhausted: true,
      refused: 1,
      exhaustedKeys: ['harness:tight'],
    });
    const refused = result.cost.measured!.receipts.find(
      (receipt) => receipt.outcome === 'refused',
    )!;
    expect(refused).toMatchObject({
      status: 402,
      refusal: { reason: 'budget_exceeded', key: 'harness:tight', dimension: 'tokens' },
    });
    expect(result.cost.measured!.requests).toBe(2);
    // Declared $0.02 against measured $0.0105: flagged.
    expect(result.cost.comparison.status).toBe('diverged');
    expect(result.cost.comparison.deltaUsd).toBeCloseTo(MEASURED_USD - 0.02, 10);
  });

  it('denies by policy outside the workspace and by a deny rule, and the harness sees the rejection', async () => {
    const result = await runHarness({
      harness: fake,
      cwd: WORKSPACE,
      prompt: script({ edits: ['../../../outside.txt', 'config/.env', 'src/ok.ts'] }),
      meter: false,
      policy: {
        rules: [
          { name: 'no-secrets', decision: 'deny', paths: ['**/.env'] },
          { decision: 'allow', kinds: ['edit'], paths: ['**'] },
        ],
        default: 'deny',
      },
      stderr: 'ignore',
    });
    expect(
      result.decisions.map((d) => [d.toolCallId, d.decision, d.decidedBy, d.rule ?? null]),
    ).toEqual([
      ['edit-1', 'deny', 'policy', null],
      ['edit-2', 'deny', 'policy', 'no-secrets'],
      ['edit-3', 'allow', 'policy', 'rules[1]'],
    ]);
    expect(result.decisions[0]!.optionId).toBe('no');
    expect(result.calls.map((call) => call.status)).toEqual(['failed', 'failed', 'completed']);
    expect(result.toolCalls).toMatchObject({ decided: 3, allowed: 1, denied: 2, observedOnly: 0 });
    expect(result.cost.measured).toBeUndefined();
    expect(result.cost.comparison.status).toBe('unavailable');
  });

  it('asks the callback, then the approver; a throwing callback denies', async () => {
    const approve = vi.fn(async (_call: unknown, _context: unknown) => true);
    const onPermission = vi.fn((request: { paths: readonly string[] }) => {
      if (request.paths[0]!.endsWith('callback.ts')) return 'deny' as const;
      if (request.paths[0]!.endsWith('boom.ts')) throw new Error('callback broke');
      return undefined;
    });
    const result = await runHarness({
      harness: fake,
      cwd: WORKSPACE,
      prompt: script({ edits: ['callback.ts', 'boom.ts', 'approver.ts'] }),
      meter: false,
      onPermission,
      approveToolCall: approve,
      stderr: 'ignore',
    });
    expect(result.decisions.map((d) => [d.decision, d.decidedBy])).toEqual([
      ['deny', 'callback'],
      ['deny', 'callback'],
      ['allow', 'approver'],
    ]);
    expect(result.decisions[1]!.reason).toBe('callback broke');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toMatchObject({
      toolCallId: 'edit-3',
      toolName: 'fake.edit',
      args: { kind: 'edit', title: 'Edit approver.ts' },
    });
  });

  it('cancels the turn when the signal aborts', async () => {
    const controller = new AbortController();
    const result = await runHarness({
      harness: fake,
      cwd: WORKSPACE,
      prompt: script({ reads: ['a.ts'], hang: true }),
      meter: meter(),
      signal: controller.signal,
      onUpdate: (update) => {
        if (update.sessionUpdate === 'tool_call') controller.abort();
      },
      stderr: 'ignore',
    });
    expect(result.stopReason).toBe('cancelled');
    expect(result.toolCalls).toMatchObject({ observed: 1, decided: 0, observedOnly: 1 });
    expect(result.cost.comparison.status).toBe('undeclared');
    expect(result.cost.measured!.requests).toBe(0);
  });

  it('shuts down a harness that ignores the cancel instead of waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const [agentSide, clientSide] = createInMemoryAcpTransportPair();
      let prompted!: () => void;
      const promptSeen = new Promise<void>((resolve) => (prompted = resolve));
      createAcpPeer({
        transport: agentSide,
        requests: {
          initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }),
          'session/new': () => ({ sessionId: 's1' }),
          'session/prompt': () => {
            prompted();
            return new Promise(() => undefined); // never answers, ignores session/cancel
          },
        },
      });
      const controller = new AbortController();
      const run = runAcpHarness({
        name: 'stuck',
        prompt: 'x',
        cwd: WORKSPACE,
        signal: controller.signal,
        connect: (hooks) => connectAcpAgent({ transport: clientSide, ...hooks }),
      });
      const settled = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      await promptSeen;
      controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await settled;
      expect(error).toBeInstanceOf(AcpError);
      expect((error as AcpError).kind).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('meters through a shared proxy by diffing its stats', async () => {
    const shared = createMeterProxy(meter());
    await shared.listen();
    try {
      const result = await runHarness({
        harness: fake,
        cwd: WORKSPACE,
        prompt: script({ calls: 1 }),
        meter: shared,
        stderr: 'ignore',
      });
      expect(result.cost.measured).toMatchObject({ exact: false, requests: 1, receipts: [] });
      expect(result.cost.measured!.usd).toBeCloseTo(MEASURED_USD, 10);
    } finally {
      await shared.close();
    }
  });
});

describe('harnessTool', () => {
  it('lets a generateText agent delegate to a harness, deciding its permissions with the parent approver', async () => {
    const approveToolCall = vi.fn(async () => true);
    const results: unknown[] = [];
    const model = createMockModel({
      responses: [
        {
          toolCalls: [
            {
              toolName: 'coder',
              args: { prompt: script({ edits: ['src/x.ts'], calls: 1, declare: MEASURED_USD }) },
            },
          ],
        },
        { text: 'delegated' },
      ],
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'fix it' }],
      tools: {
        coder: harnessTool({
          harness: fake,
          cwd: WORKSPACE,
          meter: meter(),
          stderr: 'ignore',
          onResult: (result) => void results.push(result),
        }),
      },
      approveToolCall,
      maxSteps: 3,
    });
    expect(res.text).toBe('delegated');
    expect(approveToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'fake.edit', toolCallId: 'edit-1' }),
      expect.objectContaining({ messages: expect.any(Array) }),
    );
    const output = res.toolResults?.find((entry) => entry.toolName === 'coder')?.result as Record<
      string,
      unknown
    >;
    expect(output).toMatchObject({
      text: 'patched',
      stopReason: 'end_turn',
      costStatus: 'consistent',
      budgetExhausted: false,
    });
    expect(output.measuredUsd as number).toBeCloseTo(MEASURED_USD, 10);
    expect(output.toolCalls).toMatchObject({ decided: 1, allowed: 1 });
    expect(results).toHaveLength(1);
  });
});

describe('spawnAcpAgent against real child processes', () => {
  it('rejects the run with a closed AcpError when the harness dies mid-turn', async () => {
    const run = runHarness({
      harness: fake,
      cwd: WORKSPACE,
      prompt: script({ crash: true }),
      meter: meter(),
      stderr: 'ignore',
    });
    await expect(run).rejects.toBeInstanceOf(AcpError);
    await expect(run).rejects.toMatchObject({ kind: 'closed' });
  });

  it('rejects with a closed AcpError when the child exits before initialize or cannot start', async () => {
    const exits = spawnAcpAgent({
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      stderr: 'ignore',
    });
    await expect(exits).rejects.toMatchObject({ kind: 'closed' });
    await expect(exits).rejects.toBeInstanceOf(AcpError);
    await expect(
      spawnAcpAgent({ command: join(WORKSPACE, 'no-such-harness-binary'), stderr: 'ignore' }),
    ).rejects.toMatchObject({ kind: 'closed' });
  });
});

describe('policy, comparison and presets', () => {
  it('matches paths, compares cost and describes every preset honestly', () => {
    expect(matchHarnessPath('C:\\repo\\src\\a.ts', '**', 'C:/repo')).toBe(true);
    expect(matchHarnessPath('c:/REPO/src/a.ts', 'src/*.ts', 'C:\\repo')).toBe(true);
    expect(matchHarnessPath('/repo/src/../../etc/passwd', '**', '/repo')).toBe(false);
    expect(matchHarnessPath('/repo/a/b/.env', '**/.env', '/repo')).toBe(true);
    // Windows names for the same file, a drive-relative path and a POSIX case variant
    // must not slip past a deny rule into an allow rule.
    const guarded = {
      rules: [
        { decision: 'deny' as const, paths: ['**/.env'] },
        { decision: 'allow' as const, paths: ['**'] },
      ],
    };
    for (const path of [
      'C:/repo/.env::$DATA',
      'C:\\repo\\.env.',
      'C:/repo/.env ',
      '\\\\?\\C:\\repo\\.env',
    ]) {
      expect(
        evaluateHarnessPolicy(guarded, { kind: 'read', paths: [path] }, 'C:\\repo')?.decision,
      ).toBe('deny');
    }
    expect(
      evaluateHarnessPolicy(guarded, { kind: 'read', paths: ['D:secret.txt'] }, 'C:\\repo'),
    ).toBeUndefined();
    expect(
      evaluateHarnessPolicy(guarded, { kind: 'read', paths: ['/repo/.ENV'] }, '/repo')?.decision,
    ).toBe('deny');
    expect(
      evaluateHarnessPolicy(
        { rules: [{ decision: 'allow', kinds: 'read' }] },
        { kind: 'edit', paths: [] },
      ),
    ).toBeUndefined();
    expect(evaluateHarnessPolicy({ default: 'deny' }, { paths: [] })).toEqual({ decision: 'deny' });
    // An allow rule with paths never matches a call that names no location.
    expect(
      evaluateHarnessPolicy(
        { rules: [{ decision: 'allow', paths: ['**'] }] },
        { kind: 'execute', paths: [] },
        '/repo',
      ),
    ).toBeUndefined();

    expect(compareHarnessCost(1, 1.05).status).toBe('consistent');
    expect(compareHarnessCost(1, 2)).toMatchObject({
      status: 'diverged',
      diverged: true,
      deltaUsd: -1,
    });
    expect(compareHarnessCost(0.0001, 0.0005).status).toBe('consistent'); // under the absolute floor
    expect(compareHarnessCost(undefined, 1).status).toBe('unmeasured');

    for (const preset of Object.values(HARNESS_PRESETS)) {
      expect(typeof preset.verification.verifiedLive).toBe('boolean');
      expect(preset.verification.sources.length).toBeGreaterThan(0);
    }
    // Run live end to end; codex ran live but its metering is unconfirmed.
    expect(HARNESS_PRESETS['claude-code'].verification.verifiedLive).toBe(true);
    expect(HARNESS_PRESETS.codex.verification.verifiedLive).toBe(false);
    expect(HARNESS_PRESETS['claude-code']).toMatchObject({
      sessionMode: 'default',
      sessionMeta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
      unmeteredEnv: CLAUDE_CODE_PROVIDER_SWITCHES,
    });
    expect(CLAUDE_CODE_PROVIDER_SWITCHES).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']),
    );
    expect(HARNESS_PRESETS['claude-code'].env('http://127.0.0.1:9')).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    });
    expect(HARNESS_PRESETS.codex.env('http://127.0.0.1:9').OPENAI_BASE_URL).toBe(
      'http://127.0.0.1:9/v1',
    );
    expect(HARNESS_PRESETS['gemini-cli']).toMatchObject({
      meterable: 'none',
      verification: { baseUrl: 'unsupported' },
    });
    expect(JSON.parse(HARNESS_PRESETS.opencode.env('http://h:1').OPENCODE_CONFIG_CONTENT!)).toEqual(
      {
        provider: {
          anthropic: { options: { baseURL: 'http://h:1/v1' } },
          openai: { options: { baseURL: 'http://h:1/v1' } },
        },
      },
    );
  });

  it('refuses a budget it cannot enforce for an unmeterable harness', async () => {
    await expect(
      runHarness({
        harness: 'gemini-cli',
        prompt: 'x',
        budget: { store: createInMemoryBudgetStore(), scopes: [{ key: 'k', limits: { usd: 1 } }] },
      }),
    ).rejects.toThrow(/cannot measure 'gemini-cli'/);
  });
});

describe('provider switches that route around the meter', () => {
  const budget = () => ({
    store: createInMemoryBudgetStore(),
    scopes: [{ key: 'k', limits: { usd: 1 } }],
  });

  it('refuses a budgeted Claude Code run while a switch is set, naming it but never its value', async () => {
    const run = runHarness({
      harness: 'claude-code',
      prompt: 'x',
      budget: budget(),
      env: { CLAUDE_CODE_USE_BEDROCK: 'value-must-not-leak', CLAUDE_CODE_USE_VERTEX: '1' },
    });
    const error = (await run.catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toMatch(
      /CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX are set, which sends 'claude-code' model traffic/,
    );
    expect(error.message).not.toContain('value-must-not-leak');
  });

  it('reads the parent environment, lets env unset it, ignores off values and honours allowUnmetered', async () => {
    const previous = process.env.CLAUDE_CODE_USE_FOUNDRY;
    process.env.CLAUDE_CODE_USE_FOUNDRY = 'true';
    try {
      // A spec gets Claude Code's switches by default.
      await expect(
        runHarness({ harness: fake, cwd: WORKSPACE, prompt: 'x', budget: budget() }),
      ).rejects.toThrow(/CLAUDE_CODE_USE_FOUNDRY is set/);
      const ok = (env: Record<string, string | undefined>, extra: object = {}) =>
        runHarness({
          harness: fake,
          cwd: WORKSPACE,
          prompt: script({ calls: 1 }),
          budget: budget(),
          meter: meter(),
          env,
          stderr: 'ignore',
          ...extra,
        });
      expect((await ok({ CLAUDE_CODE_USE_FOUNDRY: undefined })).stopReason).toBe('end_turn');
      expect((await ok({ CLAUDE_CODE_USE_FOUNDRY: '0' })).stopReason).toBe('end_turn');
      expect((await ok({}, { allowUnmetered: true })).stopReason).toBe('end_turn');
      // A spec that names its own switches (none) is not checked against Claude Code's.
      expect((await ok({}, { harness: { ...fake, unmeteredEnv: [] } })).stopReason).toBe(
        'end_turn',
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY;
      else process.env.CLAUDE_CODE_USE_FOUNDRY = previous;
    }
  });
});

describe('session mode', () => {
  it("opens the session with the preset's _meta and switches it to its mode before the prompt", async () => {
    const result = await runHarness({
      harness: {
        ...fake,
        sessionMode: claudeCodeHarness.sessionMode!,
        sessionMeta: claudeCodeHarness.sessionMeta!,
      },
      cwd: WORKSPACE,
      prompt: script({ echoMeta: true }),
      meter: false,
      stderr: 'ignore',
    });
    expect(JSON.parse(result.text)).toEqual({
      meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
      mode: 'default',
    });
    expect(result.sessionMode).toBe('default');
  });

  it('reports a mode the harness switched to during the turn', async () => {
    const result = await runHarness({
      harness: { ...fake, sessionMode: 'default' },
      cwd: WORKSPACE,
      prompt: script({ switchMode: 'bypassPermissions' }),
      meter: false,
      stderr: 'ignore',
    });
    expect(result.sessionMode).toBe('bypassPermissions');
    const plain = await runHarness({
      harness: fake,
      cwd: WORKSPACE,
      prompt: script({}),
      meter: false,
      stderr: 'ignore',
    });
    expect(plain.sessionMode).toBeUndefined();
  });

  it('fails closed, sending no prompt, when the harness refuses the mode', async () => {
    const before = upstreamCalls;
    const run = runHarness({
      harness: { ...fake, sessionMode: 'nope' },
      cwd: WORKSPACE,
      prompt: script({ calls: 1 }),
      meter: meter(),
      stderr: 'ignore',
    });
    await expect(run).rejects.toBeInstanceOf(AcpError);
    await expect(run).rejects.toThrow(/did not switch the session to mode 'nope'/);
    expect(upstreamCalls).toBe(before);
  });
});

describe('permission paths resolved to their real paths', () => {
  // The real path of the temp root, so a short (8.3) temp dir (CI runners) does not skew the globs.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deuz-harness-links-')));
  const workspace = join(root, 'workspace');
  const secret = join(root, 'secret');
  const slash = (path: string) => path.replace(/\\/g, '/');
  mkdirSync(workspace);
  mkdirSync(secret);
  writeFileSync(join(secret, 'creds.txt'), 'x');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Deny the secret directory by its real location; allow edits in the workspace.
  const policy = (secretGlob: string) => ({
    rules: [
      { name: 'no-secret', decision: 'deny' as const, paths: [secretGlob] },
      { name: 'workspace', decision: 'allow' as const, kinds: 'edit' as const, paths: ['**'] },
    ],
    default: 'deny' as const,
  });
  const decide = (edits: string[], extra: object = {}, secretGlob = `${slash(secret)}/**`) =>
    runHarness({
      harness: fake,
      cwd: workspace,
      prompt: script({ edits }),
      meter: false,
      policy: policy(secretGlob),
      stderr: 'ignore',
      ...extra,
    });

  it('denies a directory link (a junction on Windows) into a denied directory, for existing and new files', async () => {
    symlinkSync(secret, join(workspace, 'linkdir'), 'junction');
    // Dangling: its target does not exist yet; writing through it would create it.
    symlinkSync(join(secret, 'later'), join(workspace, 'dangling-dir'), 'junction');
    const result = await decide([
      'linkdir/creds.txt',
      'linkdir/new/file.txt',
      'dangling-dir/x.txt',
      'src/ok.ts',
    ]);
    expect(result.decisions.map((d) => [d.decision, d.rule])).toEqual([
      ['deny', 'no-secret'],
      ['deny', 'no-secret'],
      ['deny', 'no-secret'],
      ['allow', 'workspace'],
    ]);
    expect(slash(result.decisions[0]!.resolvedPaths![0]!)).toBe(`${slash(secret)}/creds.txt`);
    // The documented limit, with resolution turned off: the link is allowed by its name.
    const off = await decide(['linkdir/creds.txt'], { resolvePath: false });
    expect(off.decisions[0]).toMatchObject({ decision: 'allow', rule: 'workspace' });
    expect(off.decisions[0]!.resolvedPaths).toBeUndefined();
  });

  it('denies a file symlink and a dangling symlink whose target is denied', async (context) => {
    try {
      symlinkSync(join(secret, 'creds.txt'), join(workspace, 'file-link'), 'file');
      symlinkSync(join(secret, 'not-yet.txt'), join(workspace, 'dangling-link'), 'file');
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Windows without Developer Mode or admin rights cannot create file symlinks.
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
      context.skip(
        `file symlinks are not permitted here (${code}); the junction test covers links`,
      );
    }
    const result = await decide(['file-link', 'dangling-link']);
    expect(result.decisions.map((d) => [d.decision, d.rule])).toEqual([
      ['deny', 'no-secret'],
      ['deny', 'no-secret'],
    ]);
  });

  it('denies a Windows short (8.3) name of a denied directory', async (context) => {
    if (process.platform !== 'win32') context.skip('8.3 short names exist only on Windows');
    const longDir = join(workspace, 'a-very-long-directory-name-for-secrets');
    mkdirSync(longDir);
    const short = spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', `"for %I in ("${longDir}") do @echo %~sI"`],
      {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    ).stdout.trim();
    if (!short || short.toLowerCase() === longDir.toLowerCase()) {
      context.skip('8.3 short names are disabled on this volume');
    }
    // Only the last segment short, so the path stays inside the workspace by name.
    const edits = [join(workspace, basename(short), 'creds.txt')];
    const glob = 'a-very-long-directory-name-for-secrets/**';
    const result = await decide(edits, {}, glob);
    expect(result.decisions[0]).toMatchObject({ decision: 'deny', rule: 'no-secret' });
    // Without resolution the short name slips past the deny rule into the allow rule.
    const off = await decide(edits, { resolvePath: false }, glob);
    expect(off.decisions[0]).toMatchObject({ decision: 'allow', rule: 'workspace' });
  });

  it('evaluates both forms: a deny on either denies, an allow needs the real path', () => {
    const rules = policy('/secret/**');
    const at = (paths: string[], resolvedPaths: (string | null)[]) =>
      evaluateHarnessPolicy(
        rules,
        { kind: 'edit', paths, resolvedPaths, resolvedCwd: '/real/ws' },
        '/ws',
      );
    expect(at(['/ws/link'], ['/secret/x'])).toEqual({ decision: 'deny', rule: 'no-secret' });
    expect(at(['/secret/x'], ['/elsewhere/x'])).toEqual({ decision: 'deny', rule: 'no-secret' });
    // The workspace reached through a linked cwd: allowed on the real path.
    expect(at(['/ws/a.ts'], ['/real/ws/a.ts'])).toEqual({ decision: 'allow', rule: 'workspace' });
    // A link out of the workspace, or a path that could not be resolved: the default.
    expect(at(['/ws/out'], ['/tmp/out'])).toEqual({ decision: 'deny' });
    expect(at(['/ws/a.ts'], [null])).toEqual({ decision: 'deny' });
  });
});
