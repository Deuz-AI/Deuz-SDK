/**
 * 01 — Basic stream.
 *
 * `streamChat` returns SYNCHRONOUSLY and never throws (the G2 rule): the network
 * pump starts lazily on the first access of an output, and a failure arrives as
 * an `error` part on `fullStream` plus rejected `usage`/`finishReason` promises.
 * So there is no try/catch around the CALL — only around the iteration.
 */
import { streamChat } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

// The APP reads the environment — core never does. The key is passed
// explicitly into the factory, which is the documented Deuz idiom (and the
// middle tier of the G1 precedence: deps.keyProvider > factory > createClient).
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in your environment first.');
  process.exit(1);
}

const anthropic = createAnthropic({ apiKey });
const question = process.argv.slice(2).join(' ') || 'Explain a Merkle tree in three sentences.';

const result = streamChat({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: question }],
  maxOutputTokens: 400,
});

for await (const chunk of result.textStream) process.stdout.write(chunk);

// Resolves when the run reaches its terminal boundary. `usage` is the REAL
// provider-reported breakdown, not an estimate.
const usage = await result.usage;
const finishReason = await result.finishReason;
console.log(
  `\n\n[${finishReason}] ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.totalTokens} total`,
);
