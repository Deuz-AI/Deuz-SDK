/**
 * 04 — Structured output, buffered and streamed, from ONE zod schema.
 *
 * `generateObject` validates and repairs once on a parse/validation failure.
 * `streamObject` cannot repair — emitted partials can't be un-streamed — so it
 * trades the retry for live partials. Both pick the `json` vs `tool` strategy
 * from the model's capability row; you never choose it by hand.
 */
import { generateObject, streamObject } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { z } from 'zod';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in your environment first.');
  process.exit(1);
}
const anthropic = createAnthropic({ apiKey }); // app layer owns the key
const model = anthropic('claude-opus-4-8');

// Any Standard Schema works (zod, valibot, arktype), passed as is: it is both
// the validator and the source of the result type. Converting it to the JSON
// Schema that goes on the wire uses the optional peer
// '@standard-community/standard-json' — pass a raw JSON Schema to skip both.
const Recipe = z.object({
  title: z.string(),
  minutes: z.number().int().positive(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
});

// --- buffered: one validated object -----------------------------------------
const { object, usage } = await generateObject({
  model,
  schema: Recipe,
  schemaName: 'Recipe',
  messages: [{ role: 'user', content: 'A 20-minute vegetarian pasta.' }],
});
console.log(`${object.title} — ${object.minutes} min, ${object.ingredients.length} ingredients`);
console.log(`(${usage.totalTokens} tokens)\n`);

// --- streamed: partials as the JSON arrives ---------------------------------
// Every property is optional at every depth until the object is complete, so a
// UI can render progressively without ever seeing an invalid shape.
const stream = streamObject({
  model,
  schema: Recipe,
  schemaName: 'Recipe',
  messages: [{ role: 'user', content: 'A 10-minute breakfast.' }],
});

for await (const partial of stream.partialObjectStream) {
  console.log(`… ${partial.title ?? '(title pending)'} — ${partial.steps?.length ?? 0} steps`);
}

// Rejects with NoObjectGeneratedError if the finished JSON fails validation.
const final = await stream.object;
console.log(`\n${final.title}:\n${final.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
