# 02 — Tool loop

**Shows:** the agentic loop (`tools` + `maxSteps`), a `budget: { usd }` stop condition backed by `createPriceProvider()`, and self-healing tool errors — the `getWeather` throw for the made-up city comes back to the model as an `is_error` tool_result instead of killing the run.

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/02-tool-loop`.

**Look at:** the `execute` that throws, the `onStepFinish` trace showing `ERROR` followed by a corrected turn, and `providerMetadata.deuz.stoppedBy` in the summary line (`budget.usd` when the guardrail tripped).
