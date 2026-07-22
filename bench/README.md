# bench/

Two independent benchmarks, both reproducible end-to-end:

| benchmark | data | chart | script |
| --- | --- | --- | --- |
| **100-point ranking** — 16 SDKs × 5 scenarios, self-assessed | [`scores.json`](./scores.json) | `assets/benchmark.png` / `-dark.png` | [`chart.py`](./chart.py) |
| **Install footprint** — disk size + cold-import time, measured | [`results.json`](./results.json) | `assets/footprint.png` / `-dark.png` | [`measure.py`](./measure.py) |

Turkish deep-dive for the 1.8 panel: [`research-1.8.0.md`](./research-1.8.0.md).

## The 100-point ranking

**Panel (16):** Vercel AI SDK, OpenAI SDK + Agents, Anthropic SDK + Agent SDK, LangChain + LangGraph, Claude Code, OpenAI Codex CLI, Mastra, Google Gemini CLI, **Deuz SDK** (self), Google Gemini SDK, LlamaIndex, Moonshot Kimi, CrewAI, Alibaba Qwen, DeepSeek, Zhipu GLM.

**Scenarios (5), scored /100 each, headline = unweighted mean:**

- **Chatbot** — production chat UI (streaming, persistence, resume, cost, memory, hooks/components).
- **CLI** — installable agent CLIs. Libraries are scored on suitability for *building* one.
- **Coding agent** — fs/shell/git toolsets, sandboxing, patch flow.
- **ASI** — long-horizon autonomy: checkpoint/resume, memory, guardrails, plan→verify, observability.
- **AGI** — general flexibility: provider breadth, modalities, ecosystem.

**Criteria per scenario (weighted):** features 25% · DX 20% · performance 15% · community 15% · flexibility 15% · price 10%.

**Anchors:** 90–100 market leader · 70–89 strong/production-ready · 50–69 usable but gappy · 30–49 weak/indirect · 0–29 unsupported. Community is log-scale: ~16M npm downloads/week → 95, 100k → 70, 1k → 35, &lt;500 → 15–25.

**Provenance (2026-07-22 / 1.8.0 panel).** Deuz re-scored from scratch against the local 1.8.0 autonomy surface (workspace, CodeAct, `planTasks`/`verifyStep`, runtime, browser, `./providers`, `./testing`, azure/bedrock). Mastra and Vercel AI SDK adjusted for material product changes (Workspace/AgentBrowser/CodeMode; harnesses/`experimental_sandbox`/WorkflowAgent). Other competitors carried from 2026-07-20 with refreshed community numbers. Community fetched live 2026-07-22.

**This is self-assessed by the Deuz maintainers.** Rubric, per-scenario criterion breakdowns (`scores.json` → `criteria`), live community numbers (`communityLive`), and source notes are published. Re-derive any score from the anchors and tell us where we're wrong.

Current result: **Deuz 74.0 — 9/16 overall** (was 69.6 / 14th on 1.7.0). Community criterion is a flat **23** in every scenario (393 npm downloads/week + 2 GitHub stars). Biggest jump: **coding 61 → 71**.

## Install footprint

`measure.py` (stdlib-only Python) npm-installs each package into a clean temp dir, measures `node_modules` size / package count / file count, then times a cold ESM import (median of 5 runs after 1 warmup).

For a pre-release Deuz tree, pack locally first:

```sh
npm run build -w @deuz-sdk/core
npm pack -w @deuz-sdk/core --pack-destination .
# then:
set DEUZ_TARBALL=deuz-sdk-core-1.7.1.tgz   # Windows
python bench/measure.py
```

## Regenerating

```sh
python bench/measure.py   # → bench/results.json
python bench/chart.py     # → assets/*.png  (needs: pip install matplotlib)
```

`chart.py` reads `scores.json` + `results.json` only — edit the JSON, re-run, commit.
