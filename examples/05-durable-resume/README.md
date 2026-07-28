# 05 — Durable resume

**Shows:** a fifteen-line file-backed `SessionStore`, `session: { store, runId }` checkpointing at every step boundary, and `resumeFromCheckpoint` continuing the same run in a **new process** after a hard `process.exit(1)` mid-step.

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/05-durable-resume` — **twice**. The first run crashes on purpose; the second one finishes it. Checkpoints land in `examples/05-durable-resume/.runs/`.

**Look at:** `resumeFromCheckpoint(store, runId, options)` takes everything *except* `messages` and `session` — the checkpoint's stored history is the messages, and usage and step indices keep counting across legs.
