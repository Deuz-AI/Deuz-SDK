/**
 * Context package blobs (2.4, spec §4.4): a compiled package is stored once
 * by the digest of its blocks' canonical JSON, indexed by the memory record
 * revisions it holds, and a checkpointed step reads back the identical
 * package, or learns that a forget redacted it.
 */
import { describe, expect, it } from 'vitest';
import {
  assertBlobInput,
  assertForgetEvent,
  contextPackageBlob,
  forgetTombstones,
  isForgotten,
  readContextPackage,
} from '../src/agent-run-v3-context';
import { canonicalJson, sha256Digest } from '../src/internal/digest';
import type { ContextBlobRead } from '../src/types/agent-run-v3';
import { contextPackage } from './fixtures/agent-run-v3';

const store = (read: ContextBlobRead) => ({ getBlob: async () => read });

describe('contextPackageBlob', () => {
  it('addresses the package by the sha256 of its blocks in canonical JSON', async () => {
    const pkg = contextPackage(0);
    const blob = await contextPackageBlob(pkg);
    expect(blob.content).toBe(canonicalJson(pkg.blocks));
    expect(blob.digest).toBe(await sha256Digest(canonicalJson(pkg.blocks)));
    expect(blob.bytes).toBe(new TextEncoder().encode(blob.content).length);
  });

  it('gives an unchanged package the same digest and a changed one another', async () => {
    const first = await contextPackageBlob(contextPackage(0));
    // Another step, same blocks: the manifest is not part of the blob.
    expect((await contextPackageBlob(contextPackage(3))).digest).toBe(first.digest);
    expect((await contextPackageBlob(contextPackage(0, 'y'))).digest).not.toBe(first.digest);
  });

  it('indexes the memory records the blocks placed, never other sources or left-out entries', async () => {
    const blob = await contextPackageBlob(contextPackage(0));
    expect(blob.records).toEqual([
      { recordId: 'mem-a', revision: 2 },
      { recordId: 'mem-b', revision: 1 },
    ]);
  });
});

describe('readContextPackage', () => {
  it('reads the identical package back for a checkpointed step', async () => {
    const pkg = contextPackage(1);
    const blob = await contextPackageBlob(pkg);
    const step = {
      step: 1,
      manifest: pkg.manifest,
      blob: { digest: blob.digest, bytes: blob.bytes },
    };
    const read = await readContextPackage(store({ status: 'found', content: blob.content }), step);
    expect(read.status).toBe('found');
    if (read.status !== 'found') return;
    expect(read.package).toEqual(pkg);
    expect(canonicalJson(read.package.blocks)).toBe(blob.content);
  });

  it('reports a redacted or a missing blob', async () => {
    const pkg = contextPackage(1);
    const blob = await contextPackageBlob(pkg);
    const step = {
      step: 1,
      manifest: pkg.manifest,
      blob: { digest: blob.digest, bytes: blob.bytes },
    };
    expect(await readContextPackage(store({ status: 'redacted' }), step)).toEqual({
      status: 'redacted',
    });
    expect(await readContextPackage(store({ status: 'missing' }), step)).toEqual({
      status: 'missing',
    });
  });

  it('refuses content that does not match the digest it was stored under', async () => {
    const pkg = contextPackage(1);
    const blob = await contextPackageBlob(pkg);
    const step = {
      step: 1,
      manifest: pkg.manifest,
      blob: { digest: blob.digest, bytes: blob.bytes },
    };
    const tampered = blob.content.replace('eu-west', 'us-east');
    await expect(
      readContextPackage(store({ status: 'found', content: tampered }), step),
    ).rejects.toThrow(/digest/);
  });
});

describe('blob input and forget events', () => {
  it('takes a blob whose content matches its digest', async () => {
    const blob = await contextPackageBlob(contextPackage(0));
    await expect(assertBlobInput(blob)).resolves.toBeUndefined();
  });

  it('refuses a malformed blob or content under another digest', async () => {
    const blob = await contextPackageBlob(contextPackage(0));
    const cases: unknown[] = [
      null,
      { ...blob, digest: 'sha256:xyz' },
      { ...blob, content: 7 },
      { ...blob, records: {} },
      { ...blob, records: [{ recordId: '' }] },
      { ...blob, records: [{ recordId: 'a', revision: -1 }] },
      { ...blob, content: `${blob.content} ` },
    ];
    for (const value of cases) await expect(assertBlobInput(value)).rejects.toThrow(TypeError);
  });

  it('checks a forget event', () => {
    const event = {
      scope: { userId: 'u' },
      recordId: 'mem-a',
      revisions: [1, 2],
      operationId: 'f',
    };
    expect(() => assertForgetEvent(event)).not.toThrow();
    for (const value of [
      null,
      { ...event, recordId: '' },
      { ...event, revisions: 'all' },
      { ...event, revisions: [1.5] },
    ])
      expect(() => assertForgetEvent(value)).toThrow(TypeError);
  });

  it('matches a forgotten revision, a record placed without revision, and a forget of every revision', () => {
    const tombstones = forgetTombstones({
      scope: {},
      recordId: 'mem-a',
      revisions: [1, 2],
      operationId: 'f',
    });
    expect(tombstones).toEqual([
      { recordId: 'mem-a', revision: 1 },
      { recordId: 'mem-a', revision: 2 },
    ]);
    const forgotten = (record: { recordId: string; revision?: number }) =>
      tombstones.some((tombstone) => isForgotten(record, tombstone));
    expect(forgotten({ recordId: 'mem-a', revision: 2 })).toBe(true);
    expect(forgotten({ recordId: 'mem-a', revision: 3 })).toBe(false);
    expect(forgotten({ recordId: 'mem-a' })).toBe(true);
    expect(forgotten({ recordId: 'mem-b', revision: 1 })).toBe(false);
    const every = forgetTombstones({
      scope: {},
      recordId: 'mem-z',
      revisions: [],
      operationId: 'g',
    });
    expect(every).toEqual([{ recordId: 'mem-z' }]);
    expect(isForgotten({ recordId: 'mem-z', revision: 9 }, every[0]!)).toBe(true);
  });
});
