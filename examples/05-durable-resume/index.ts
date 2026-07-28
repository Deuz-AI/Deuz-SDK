/**
 * 05 — Durable execution: checkpoint, crash, continue.
 *
 * Run it twice. The first process hard-exits in the middle of a step; the
 * second finds the checkpoint on disk and finishes the SAME run. There is no
 * workflow vendor involved — `SessionStore` is a two-method seam, and the whole
 * backend below is fifteen lines of `node:fs`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from '@deuz-sdk/core';
import type { ToolSet } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import {
  deserializeCheckpoint,
  resumeFromCheckpoint,
  serializeCheckpoint,
} from '@deuz-sdk/core/durable';
import type { SessionStore } from '@deuz-sdk/core/durable';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in your environment first.');
  process.exit(1);
}
const anthropic = createAnthropic({ apiKey }); // app layer owns the key
const model = anthropic('claude-opus-4-8');

// --- the whole durability backend ------------------------------------------
const DIR = join(dirname(fileURLToPath(import.meta.url)), '.runs');
const fileFor = (runId: string): string => join(DIR, `${encodeURIComponent(runId)}.json`);

const store: SessionStore = {
  save(checkpoint) {
    mkdirSync(DIR, { recursive: true });
    // serializeCheckpoint/deserializeCheckpoint are the binary-safe JSON codec
    // (they tag Uint8Array parts), so image/file parts survive a round-trip.
    writeFileSync(fileFor(checkpoint.runId), serializeCheckpoint(checkpoint), 'utf8');
  },
  load(runId) {
    const path = fileFor(runId);
    return existsSync(path) ? deserializeCheckpoint(readFileSync(path, 'utf8')) : undefined;
  },
  delete(runId) {
    rmSync(fileFor(runId), { force: true });
  },
};

// --- the run ----------------------------------------------------------------
const RUN_ID = 'demo-run';
const existing = await store.load(RUN_ID);
const resuming = existing !== undefined;

let stepsDone = 0;
const tools: ToolSet = {
  add: {
    description: 'Add two numbers and return their sum.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    execute: (args) => {
      const { a, b } = args as { a: number; b: number };
      console.log(`  add(${a}, ${b}) = ${a + b}`);
      // The loop checkpoints at every STEP BOUNDARY, so once one step has
      // finished there is a recoverable snapshot on disk. Killing the process
      // here loses only the in-flight step, which the resume re-runs — one step
      // is the honest recovery unit.
      if (!resuming && stepsDone >= 1) {
        console.log('\n*** hard crash mid-step. Run the same command again. ***');
        process.exit(1);
      }
      return { sum: a + b };
    },
  },
};

const goal =
  'Compute ((3 + 8) + 14) + 5 using the add tool. Call it once per turn, feeding the ' +
  'previous result into the next call. Report only the final number.';

const result = resuming
  ? // The checkpoint's history IS the messages, so `resumeFromCheckpoint` takes
    // everything EXCEPT `messages` and `session`. Usage and step indices keep
    // counting across legs.
    await resumeFromCheckpoint(store, RUN_ID, {
      model,
      tools,
      maxSteps: 8,
      onStepFinish: () => {
        stepsDone += 1;
      },
    })
  : await generateText({
      model,
      messages: [{ role: 'user', content: goal }],
      tools,
      maxSteps: 8,
      // Opt in to durability. Reusing a fixed runId means "continue this run".
      session: { store, runId: RUN_ID },
      onStepFinish: () => {
        stepsDone += 1;
      },
    });

console.log(`\n${result.text}`);
console.log(
  `runId=${result.runId} steps=${result.steps?.length ?? 1} tokens=${result.usage.totalTokens}`,
);
await store.delete?.(RUN_ID); // demo cleanup so the next run starts fresh
