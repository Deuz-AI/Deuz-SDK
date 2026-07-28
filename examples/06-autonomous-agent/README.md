# 06 — Autonomous agent (Manus-style)

**Shows:** `planTasks` → an `agentTool` executor with workspace + CodeAct + shell tools → `verifyStep` re-driving until the answer holds, all bounded by `compaction`, `budget` and `stopWhen`, with a **working** live plan/activity feed.

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/06-autonomous-agent -- "your goal"`. Files land in `examples/06-autonomous-agent/.agent-workspace/`. `createNodeSandbox` spawns child processes of *this* process — a reference host, not production isolation.

**Look at:** `withActivity()` and the `completeTask` tool. `emitPlanUpdate`/`emitActivity` need a `PartEmitter`, and the only one that exists is `ctx.emitPart` inside a tool's `execute`, populated by the **streaming** loop — which is why the orchestrator uses `streamChat` and not `generateText`. (The pre-1.9 version of this example passed `undefined` and the live view silently did nothing.)
