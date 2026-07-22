import { describe, it, expect } from 'vitest';
import { codeActTool, shellTool, codeActSystemPrompt } from '../src/compute';
import { createNodeSandbox } from '../src/node/compute';
import type { ComputeSandbox, CodeExecutionResult } from '../src/types/compute';
import type { ToolExecuteContext } from '../src/types/tool';

const ctx: ToolExecuteContext = { toolCallId: 'call_1', messages: [] };

describe('codeActTool (edge wrapper over the seam)', () => {
  it('drives runCode, returns stdout/stderr/exitCode and strips artifact bytes', async () => {
    let seen: unknown;
    const sandbox: ComputeSandbox = {
      async runCode(req) {
        seen = req;
        return {
          stdout: 'hello',
          stderr: '',
          exitCode: 0,
          durationMs: 12,
          artifacts: [{ path: 'out.png', bytes: new Uint8Array([1, 2]), mime: 'image/png' }],
        } satisfies CodeExecutionResult;
      },
    };
    const tools = codeActTool(sandbox, { name: 'runCode', timeoutMs: 5000 });
    const out = (await tools.runCode!.execute!({ language: 'python', code: 'print(1)' }, ctx)) as {
      stdout: string;
      exitCode: number;
      artifacts: { path: string; mime: string }[];
    };
    expect(seen).toMatchObject({ language: 'python', code: 'print(1)', timeoutMs: 5000 });
    expect(out.stdout).toBe('hello');
    expect(out.exitCode).toBe(0);
    expect(out.artifacts).toEqual([{ path: 'out.png', mime: 'image/png' }]); // bytes stripped
  });

  it('caps stdout/stderr to maxOutputChars with a truncation marker', async () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: 'x'.repeat(50), stderr: '', exitCode: 0 };
      },
    };
    const tools = codeActTool(sandbox, { maxOutputChars: 10 });
    const out = (await tools.runCode!.execute!({ language: 'js', code: '1' }, ctx)) as {
      stdout: string;
    };
    expect(out.stdout.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out.stdout).toContain('truncated');
  });

  it('offers the language enum when restricted', () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const tools = codeActTool(sandbox, { languages: ['python', 'bash'] });
    const params = tools.runCode!.parameters as {
      properties: { language: { enum?: string[] } };
    };
    expect(params.properties.language.enum).toEqual(['python', 'bash']);
    expect(codeActSystemPrompt()).toContain('writing');
  });
});

describe('shellTool', () => {
  it('throws (self-heals in the loop) when the sandbox has no runShell', async () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const tools = shellTool(sandbox);
    await expect(tools.runShell!.execute!({ command: 'ls' }, ctx)).rejects.toThrow(
      /does not support/,
    );
  });

  it('drives runShell when present', async () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async runShell(req) {
        return { stdout: `ran ${req.command}`, stderr: '', exitCode: 0 };
      },
    };
    const tools = shellTool(sandbox, { needsApproval: true });
    expect(tools.runShell!.needsApproval).toBe(true);
    const out = (await tools.runShell!.execute!({ command: 'echo hi' }, ctx)) as { stdout: string };
    expect(out.stdout).toBe('ran echo hi');
  });
});

describe('createNodeSandbox (reference; spawns real node)', () => {
  it('runs javascript and captures stdout + exit code', async () => {
    const sandbox = createNodeSandbox();
    const res = await sandbox.runCode({
      language: 'javascript',
      code: 'process.stdout.write("ok:" + (1 + 2))',
    });
    expect(res.stdout).toBe('ok:3');
    expect(res.exitCode).toBe(0);
  });

  it('rejects a disallowed language without spawning', async () => {
    const sandbox = createNodeSandbox({ allowedLanguages: ['javascript'] });
    const res = await sandbox.runCode({ language: 'python', code: 'print(1)' });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toContain('not allowed');
  });

  it('enforces the shell command allowlist', async () => {
    const sandbox = createNodeSandbox({ allowedCommands: ['echo'] });
    const res = await sandbox.runShell!({ command: 'rm -rf /' });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toContain('allowlist');
  });

  it('kills a run that exceeds the timeout', async () => {
    const sandbox = createNodeSandbox({ defaultTimeoutMs: 300 });
    const res = await sandbox.runCode({
      language: 'javascript',
      code: 'setTimeout(() => {}, 10000)',
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });
});
