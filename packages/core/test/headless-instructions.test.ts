/**
 * Project instructions (AGENTS.md / CLAUDE.md) and skills for headless runs
 * (2.3 preview, 23.8), discovered in temporary directories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryAgentRunStore } from '../src/agent-run';
import { createMockModel } from '../src/testing';
import {
  inspectRun,
  loadProjectInstructions,
  resumeHeadless,
  runHeadless,
} from '../src/node/headless';
import type { Message } from '../src/types/message';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'deuz-headless-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
}

function systemText(messages: readonly Message[]): string {
  const first = messages[0];
  if (first?.role !== 'system' || typeof first.content !== 'string')
    throw new Error('expected a leading system message');
  return first.content;
}

describe('loadProjectInstructions', () => {
  it('reads AGENTS.md and CLAUDE.md from the git root down to dir, outermost first', async () => {
    await put('repo/.git/HEAD', 'ref: refs/heads/main\n');
    await put('AGENTS.md', 'OUTSIDE THE REPOSITORY');
    await put('repo/AGENTS.md', 'Run npm test before you finish.');
    await put('repo/packages/app/AGENTS.md', 'App: use the app logger.');
    await put('repo/packages/app/CLAUDE.md', 'App: never edit generated files.');
    await put('repo/packages/app/src/AGENTS.md', 'BELOW THE WORKING DIRECTORY');

    const loaded = await loadProjectInstructions(join(base, 'repo/packages/app'));
    expect(loaded.files.map((file) => file.relativePath)).toEqual([
      'AGENTS.md',
      'packages/app/AGENTS.md',
      'packages/app/CLAUDE.md',
    ]);
    expect(loaded.files.every((file) => !file.truncated)).toBe(true);
    const text = loaded.message!.content;
    expect(loaded.message!.role).toBe('system');
    expect(text.indexOf('Run npm test')).toBeLessThan(text.indexOf('use the app logger'));
    expect(text.indexOf('use the app logger')).toBeLessThan(text.indexOf('never edit generated'));
    expect(text).toContain('<project_instructions path="packages/app/CLAUDE.md">');
    expect(text).not.toContain('OUTSIDE THE REPOSITORY');
    expect(text).not.toContain('BELOW THE WORKING DIRECTORY');
  });

  it('reads only dir itself outside a git repository, or up to an explicit root', async () => {
    await put('work/AGENTS.md', 'Top.');
    await put('work/sub/CLAUDE.md', 'Sub.');
    const alone = await loadProjectInstructions(join(base, 'work/sub'));
    expect(alone.files.map((file) => file.relativePath)).toEqual(['CLAUDE.md']);

    const rooted = await loadProjectInstructions(join(base, 'work/sub'), {
      root: join(base, 'work'),
    });
    expect(rooted.files.map((file) => file.relativePath)).toEqual(['AGENTS.md', 'sub/CLAUDE.md']);
    await expect(
      loadProjectInstructions(join(base, 'work'), { root: join(base, 'work/sub') }),
    ).rejects.toThrow(TypeError);
  });

  it('includes the same text once when CLAUDE.md repeats AGENTS.md', async () => {
    await put('p/AGENTS.md', 'Shared rules.\n');
    await put('p/CLAUDE.md', '﻿Shared rules.');
    const loaded = await loadProjectInstructions(join(base, 'p'));
    expect(loaded.files.map((file) => file.relativePath)).toEqual(['AGENTS.md']);
    expect(loaded.message!.content.match(/Shared rules\./g)).toHaveLength(1);
  });

  it('caps the text, keeping the files nearest dir whole', async () => {
    await put('r/.git/HEAD', 'x');
    await put('r/AGENTS.md', 'o'.repeat(300));
    await put('r/inner/AGENTS.md', 'i'.repeat(150));
    const loaded = await loadProjectInstructions(join(base, 'r/inner'), { maxBytes: 200 });
    expect(loaded.files).toEqual([
      expect.objectContaining({
        relativePath: 'AGENTS.md',
        bytes: 300,
        includedBytes: 50,
        truncated: true,
      }),
      expect.objectContaining({
        relativePath: 'inner/AGENTS.md',
        bytes: 150,
        includedBytes: 150,
        truncated: false,
      }),
    ]);
    const text = loaded.message!.content;
    expect(text).toContain('i'.repeat(150));
    expect(text).toContain(`${'o'.repeat(50)}\n[truncated: 250 more bytes not loaded]`);
    expect(text).not.toContain('o'.repeat(51));
  });

  it('never cuts a multi-byte character in half', async () => {
    await put('u/AGENTS.md', 'é'.repeat(10)); // 2 bytes each
    const loaded = await loadProjectInstructions(join(base, 'u'), { maxBytes: 5 });
    expect(loaded.files[0]).toMatchObject({ includedBytes: 4, truncated: true });
    expect(loaded.message!.content).toContain('éé\n[truncated: 16 more bytes not loaded]');
    expect(loaded.message!.content).not.toContain('�');
  });

  it('returns no message when no instruction file exists', async () => {
    await mkdir(join(base, 'empty'));
    const loaded = await loadProjectInstructions(join(base, 'empty'));
    expect(loaded).toMatchObject({ files: [] });
    expect(loaded.message).toBeUndefined();
  });

  it('rejects a directory that does not exist, instead of reading its ancestors', async () => {
    await put('repo/.git/HEAD', 'x');
    await put('repo/AGENTS.md', 'Root rules.');
    await expect(loadProjectInstructions(join(base, 'repo/typo'))).rejects.toThrow(TypeError);
    await expect(loadProjectInstructions(join(base, 'repo/AGENTS.md'))).rejects.toThrow(TypeError);
  });
});

describe('runHeadless with project instructions and skills', () => {
  it('puts the caller instructions, then the project instructions, in the leading system message', async () => {
    await put('proj/AGENTS.md', 'Answer in one sentence.');
    const store = createInMemoryAgentRunStore();
    const report = await runHeadless({
      model: createMockModel({ responses: [{ text: 'ok' }] }),
      instructions: 'You are a release bot.',
      prompt: 'Ship it.',
      projectDir: join(base, 'proj'),
      store,
      runId: 'with-project',
    });
    expect(report.outcome).toBe('completed');
    const text = systemText((await store.load('with-project'))!.messages);
    expect(text.startsWith('You are a release bot.')).toBe(true);
    expect(text).toContain('Answer in one sentence.');
  });

  it('offers the skill catalog and loads a skill body on demand, across a resume', async () => {
    await put(
      'skills/release-notes/SKILL.md',
      '---\nname: release-notes\ndescription: Write release notes from a changelog.\n---\n\nGroup changes by package.',
    );
    await put('skills/release-notes/template.md', '## {package}');
    const skills = [join(base, 'skills')];
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({
      responses: [
        {
          toolCalls: [
            { toolName: 'load_skill', args: { id: 'release-notes' } },
            { toolName: 'read_skill_resource', args: { id: 'release-notes', path: 'template.md' } },
            { toolName: 'publish', args: {} },
          ],
        },
        { text: 'Notes written.' },
      ],
    });
    const tools = {
      publish: {
        description: 'Publish the notes.',
        parameters: { type: 'object' },
        needsApproval: true,
        execute: () => 'published',
      },
    };
    const first = await runHeadless({
      model,
      prompt: 'Write the notes.',
      tools,
      skills,
      store,
      runId: 'skills-1',
    });
    expect(first.outcome).toBe('pending');
    const saved = (await store.load('skills-1'))!;
    expect(systemText(saved.messages)).toContain(
      '- release-notes (release-notes): Write release notes from a changelog.',
    );

    // The step's calls run once its approval arrives, so the resume must offer
    // the same skill tools (they are part of the run's binding).
    const approval = first.pending[0]!;
    if (approval.kind !== 'approval') throw new Error('expected an approval');
    const done = await resumeHeadless({
      model,
      tools,
      skills,
      store,
      runId: 'skills-1',
      approvalResponses: [{ approvalId: approval.approvalId, approved: true }],
    });
    expect(done).toMatchObject({ outcome: 'completed', output: 'Notes written.' });
    const transcript = JSON.stringify((await store.load('skills-1'))!.messages);
    expect(transcript).toContain('Group changes by package.');
    expect(transcript).toContain('## {package}');
  });

  it('cannot resume a run that had skills without them', async () => {
    await put('skills/a/SKILL.md', '---\nname: a\ndescription: A.\n---\nA body.');
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'publish', args: {} }] }, { text: 'done' }],
    });
    const tools = {
      publish: {
        description: 'Publish.',
        parameters: { type: 'object' },
        needsApproval: true,
        execute: () => 'ok',
      },
    };
    const first = await runHeadless({
      model,
      prompt: 'go',
      tools,
      skills: [join(base, 'skills')],
      store,
      runId: 'bound',
    });
    const approval = first.pending[0]!;
    if (approval.kind !== 'approval') throw new Error('expected an approval');
    const resumed = await resumeHeadless({
      model,
      tools,
      store,
      runId: 'bound',
      approvalResponses: [{ approvalId: approval.approvalId, approved: true }],
    });
    expect(resumed.outcome).toBe('failed');
    expect(resumed.error?.message).toMatch(/binding changed/);
    // The stored run is untouched, still waiting for the approval.
    expect(resumed.phase).toBe('running');
    expect((await inspectRun(store, 'bound')).outcome).toBe('pending');
  });

  it('refuses a skill outside the catalog, so an id cannot reach another folder', async () => {
    await put('skills/a/SKILL.md', '---\nname: a\ndescription: A.\n---\nA body.');
    await put('secret/SKILL.md', '---\nname: secret\ndescription: S.\n---\nSECRET BODY');
    const store = createInMemoryAgentRunStore();
    const report = await runHeadless({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'load_skill', args: { id: '../secret' } }] },
          { text: 'done' },
        ],
      }),
      prompt: 'go',
      skills: [join(base, 'skills')],
      store,
      runId: 'escape',
    });
    expect(report.outcome).toBe('completed');
    const transcript = JSON.stringify((await store.load('escape'))!.messages);
    expect(transcript).not.toContain('SECRET BODY');
    expect(transcript).toContain('Unknown skill');
  });

  it('rejects a tool that takes a skill tool name', async () => {
    await expect(
      runHeadless({
        model: createMockModel({ responses: [{ text: 'ok' }] }),
        prompt: 'go',
        skills: [join(base, 'skills')],
        tools: { load_skill: { description: 'mine', parameters: { type: 'object' } } },
        store: createInMemoryAgentRunStore(),
      }),
    ).rejects.toThrow(TypeError);
  });
});
