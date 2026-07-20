# bench/

Two independent benchmarks, both reproducible end-to-end:

| benchmark | data | chart | script |
| --- | --- | --- | --- |
| **100-point ranking** — 16 SDKs × 5 scenarios, self-assessed | [`scores.json`](./scores.json) | `assets/benchmark.png` / `-dark.png` | [`chart.py`](./chart.py) |
| **Install footprint** — disk size + cold-import time, measured | [`results.json`](./results.json) | `assets/footprint.png` / `-dark.png` | [`measure.py`](./measure.py) |

## The 100-point ranking

**Panel (16):** Vercel AI SDK, OpenAI SDK + Agents, Anthropic SDK + Agent SDK, LangChain + LangGraph, Claude Code, OpenAI Codex CLI, Google Gemini CLI, Mastra, Google Gemini SDK, LlamaIndex, Moonshot Kimi, CrewAI, Alibaba Qwen, **Deuz SDK** (self), DeepSeek, Zhipu GLM.

**Scenarios (5), scored /100 each, headline = unweighted mean:**

- **Chatbot** — building a production chat UI (streaming, persistence, resume, cost, memory, hooks/components).
- **CLI** — installable agent CLIs. Libraries are scored on suitability for *building* one.
- **Coding agent** — fs/shell/git toolsets, sandboxing, patch flow.
- **ASI** — long-horizon autonomy: checkpoint/resume, memory, guardrails, observability.
- **AGI** — general flexibility: provider breadth, modalities, ecosystem.

**Criteria per scenario (weighted):** features 25% · DX 20% · performance 15% · community 15% · flexibility 15% · price 10%.

**Anchors:** 90–100 market leader · 70–89 strong/production-ready · 50–69 usable but gappy · 30–49 weak/indirect · 0–29 unsupported. Community is log-scale: ~16M npm downloads/week → 95, 100k → 70, 1k → 35, <500 → 15–25.

**Provenance.** Competitor criterion scores carried from the 2026-07-14 source-verified sweep (source list in `p.md`); Mastra scored fresh 2026-07-20 (new to the panel); Deuz re-scored from scratch against the shipped 1.7.0 code. Community numbers fetched live 2026-07-20 (npm downloads API, GitHub API, PyPI — a few PyPI values are from 2026-07-14 and flagged as such in `scores.json`).

**This is self-assessed by the Deuz maintainers.** That's why everything is published: the rubric above, per-scenario criterion breakdowns (`scores.json` → `criteria`), live community numbers (`communityLive`), and the source list (`notes`). Re-derive any score from the anchors and tell us where we're wrong.

Current result: **Deuz 69.6 — 14/16 overall, chatbot 76 (tie for 5th)**. The community criterion is a flat 22 in every scenario (336 npm downloads/week + 2 GitHub stars, fetched live — the anchor is merciless by design).

## Install footprint

`measure.py` (stdlib-only Python) npm-installs each package into a clean temp dir, measures `node_modules` size / package count / file count, then times a cold ESM import (median of 5 runs after 1 warmup). Same machine, same procedure for every row. Measured 2026-07-20: **@deuz-sdk/core 1.7.0 — 3.53 MB, 1 package, 26.7 ms.**

## Regenerating

```sh
python bench/measure.py   # re-measure footprint → bench/results.json (a few minutes)
python bench/chart.py     # re-render all four PNGs into assets/ (needs: pip install matplotlib)
```

`chart.py` reads `scores.json` + `results.json` and nothing else — edit the JSON, re-run, commit.
