---
'@deuz-sdk/core': minor
---

Swarm agents can work together. Tasks take a `group`, and agent bindings with `blackboard` get idempotent `blackboard_post` / `blackboard_read` tools over durable, ordered group channels (stores need the new `'channels'` capability; memory and SQLite have it); reducers page channels through `context.readChannel`. Soft dependencies (`after`) wait for tasks to settle in any state and pass only completed results, with statuses in `context.settled`. `createRounds` builds rounds of group-parallel agents with a consolidator that reallocates agents and prompts between rounds.
