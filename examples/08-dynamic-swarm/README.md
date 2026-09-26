# 08 — Dynamic swarm

**Shows:** the 2.2 swarm growing at run time. A planner agent returns a validated list of leads, and its binding's `spawn(output)` turns them into one scout task per lead (`plan/scout1`, `plan/scout2`) plus a digest that waits for them with `after`; the children commit atomically with the planner's result. The scouts share the `leads` group's blackboard through the `blackboard_post` / `blackboard_read` tools, and the digest reducer pages the same channel with `context.readChannel`. The second run uses `createRounds`: one explorer, then a consolidator that decides at run time to send two agents into a `deep` round, then stops.

**Run:** from the repo root, `npm install && npm run build`, then `npm run dev -w @deuz-examples/08-dynamic-swarm`. No API key needed; Node ≥ 22.6 for the type stripping.

**Real provider:** each agent is built on `createMockModel` from `@deuz-sdk/core/testing`, scripted one reply per call. Give each `createAgent` a real model instead, such as `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8')` from `@deuz-sdk/core/anthropic` (see the `REAL PROVIDER` comment in `index.ts`). `concurrency: 1` only keeps the scripted replies in order; with a real model, drop it and a group's agents run in parallel.

**Look at:** the journal printed while each run executes. `task.spawned` events carry the parent's ID, and `channel.posted` events carry the channel. `plan/scout2` reads the note `plan/scout1` posted before it adds its own. Spawn keys are built from the lead's index rather than the model's text, because a key may only use letters, digits and `._:-`. Runtime spawning needs `dynamic` limits on `createSwarm`, and `createRounds` needs `maxSpawnDepth` of at least `maxRounds`.
