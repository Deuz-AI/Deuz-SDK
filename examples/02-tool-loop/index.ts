/**
 * 02 — Tool loop: parallel tools, a budget guardrail, and self-healing errors.
 *
 * The question deliberately names one real city and one that does not exist, so
 * the tool THROWS on the second call. That is not a failed run: the loop turns
 * the throw into an `is_error` tool_result and feeds it back, so every
 * `tool_use_id` still gets a result and the model can correct itself.
 */
import { generateText } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createPriceProvider } from '@deuz-sdk/core/pricing';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in your environment first.');
  process.exit(1);
}
const anthropic = createAnthropic({ apiKey }); // app layer owns the key

const TEMPERATURES: Record<string, number> = { Paris: 21, Tokyo: 27, Reykjavik: 6 };

const result = await generateText({
  model: anthropic('claude-opus-4-8'),
  messages: [
    { role: 'user', content: 'Compare the weather in Paris and in Atlantis, then conclude.' },
  ],
  // Without `maxSteps` a call is single-turn: the model would emit tool calls
  // and stop. 6 turns is the hard bound; `budget` can stop it sooner.
  maxSteps: 6,
  tools: {
    getWeather: {
      description: 'Current temperature in Celsius for a city.',
      // Raw JSON Schema — the zero-dependency path. `args` is `unknown`, so
      // narrow it yourself (a Standard Schema like zod validates for you).
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { city } = args as { city: string };
        const tempC = TEMPERATURES[city];
        // SELF-HEAL: this throw becomes an is_error tool_result, never a
        // rejected run. Runaway protection still applies — the same tool
        // failing 3 times in a row hard-stops the loop.
        if (tempC === undefined) throw new Error(`No weather station for '${city}'.`);
        return { city, tempC };
      },
    },
  },
  // Budget guardrail: hard-stop once cumulative REAL cost reaches $0.25.
  // Needs a priceProvider; it is sugar over `costExceeds` from '@deuz-sdk/core'
  // and marks `stoppedBy` as 'budget.usd'. Checked at step boundaries.
  budget: { usd: 0.25 },
  deps: { priceProvider: createPriceProvider() },
  onStepFinish: (step) => {
    for (const call of step.toolCalls) {
      console.log(`  -> ${call.toolName}(${JSON.stringify(call.args)})`);
    }
    for (const res of step.toolResults) {
      console.log(`  <- ${res.isError ? 'ERROR' : 'ok'}: ${JSON.stringify(res.result)}`);
    }
  },
});

console.log(`\n${result.text}`);
console.log(
  `\nsteps=${result.steps?.length ?? 1} tokens=${result.usage.totalTokens} stoppedBy=${
    result.providerMetadata?.deuz?.stoppedBy ?? '(natural completion)'
  }`,
);
