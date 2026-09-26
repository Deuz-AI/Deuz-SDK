# bench/

Two independent benchmarks, both reproducible end-to-end:

| benchmark | data | chart | script |
| --- | --- | --- | --- |
| **100-point ranking** — 16 SDKs × 5 scenarios, self-assessed | [`scores.json`](./scores.json) | `assets/benchmark.png` / `-dark.png` | [`chart.py`](./chart.py) |
| **Install footprint** — disk size + cold-import time, measured | [`results.json`](./results.json) | `assets/footprint.png` / `-dark.png` | [`measure.py`](./measure.py) |

## The 100-point ranking

**Panel (16):** Vercel AI SDK, OpenAI SDK + Agents, Anthropic SDK + Agent SDK, LangChain + LangGraph, Claude Code, OpenAI Codex CLI, Mastra, Google Gemini CLI, **Deuz SDK** (self), Google Gemini SDK, LlamaIndex, Moonshot Kimi, CrewAI, Alibaba Qwen, DeepSeek, Zhipu GLM.

**Scenarios (5), scored /100 each, headline = unweighted mean:**

- **Chatbot** — production chat UI (streaming, persistence, resume, cost, memory, hooks/components).
- **CLI** — installable agent CLIs. Libraries are scored on suitability for *building* one.
- **Coding agent** — fs/shell/git toolsets, sandboxing, patch flow.
- **ASI** — long-horizon autonomy: checkpoint/resume, memory, guardrails, plan→verify, observability.
- **AGI** — general flexibility: provider breadth, modalities, ecosystem.

**Criteria per scenario (weighted):** features 25% · DX 20% · performance 15% · community 15% · flexibility 15% · price 10%. A scenario score is the weighted sum rounded half up; the rank orders the headline the way `chart.py` sorts it.

**Anchors:** 90–100 market leader · 70–89 strong/production-ready · 50–69 usable but gappy · 30–49 weak/indirect · 0–29 unsupported. Community is log-scale: ~16M npm downloads/week → 95, 100k → 70, 1k → 35, &lt;500 → 15–25.

**Community between panels (method note, 2.2.0 panel).** A community criterion moves on that scale: ΔC = slope × log10(new ÷ old weekly npm downloads), with the slope of the anchor segment the package sits in (25 ÷ log10 160 ≈ 11.34 per decade from 100k to ~16M, 17.5 per decade below 100k), held at 95 at or above ~16M. GitHub stars are recorded next to the downloads but not scored. A score without a published criterion breakdown moves by 0.15 × ΔC, rounded half up. This writes the rule down; the anchors and weights are unchanged. It reproduces the 1.8.0 panel's own Deuz move: 336 → 393/week gives 22 + 17.5 × log10(393 ÷ 336) = 23.2, scored 23.

**Provenance (2026-09-26 / 2.2.0 panel).**

- **Deuz** re-scored against the 2.2.0 release commit (`40a6f3e`, tag `v2.2.0`; npm still served 2.1.0 on 2026-09-26). The last panel scored 1.8.0, so the notes in `scores.json` → `criteria` justify every changed criterion from what 1.9, 2.0, 2.1 and 2.2 shipped (`packages/core/CHANGELOG.md`, `docs/content/docs/reference/whats-new-*.mdx`). Features rise in every scenario (chatbot +2, CLI +2, coding +1, ASI +2, AGI +4). DX rises +1 or +2, except ASI, where two agent engines offset the ergonomics work. Flexibility rises +1 or +2, except coding. Performance and price are held. The gaps that remain are written into the notes: no CLI product, no git toolset, a child-process reference sandbox, no Vue/Svelte bindings, no realtime voice.
- **Competitors:** the repo documents no material product change since the 2026-07-22 panel, so every competitor's non-community criteria are carried from it. Only Mastra's community move changes a rounded score: its breakdown is published, and C 80 → 82 (@mastra/core 1.20M → 1.88M npm/week) takes chatbot 75 → 76 and coding 76 → 77. Every other npm-scored move is at most 0.36 of a scenario point (@anthropic-ai/sdk, even ignoring the hold at 95), so those integer scores stand. Entries with no earlier npm figure to move from (Moonshot Kimi, CrewAI, Alibaba Qwen, DeepSeek, Zhipu GLM) are carried whole; stars are not scored.
- **Community** fetched live 2026-09-26 for every panel entry that has a source: npm downloads API (`last-week` = 2026-09-18..2026-09-24) and GitHub stars (`gh api repos/<owner>/<repo>`), each with its repo recorded in `communityLive`. Qwen (Qwen-Agent and Qwen Code stars, Qwen Code's npm downloads) and DeepSeek (the DeepSeek-V3 repo; there is no official SDK) have sources again, as on the 2026-07-20 panel. Zhipu has none: PyPI `zhipuai` declares no repository and the npm Node SDK is community-maintained.
- **Flagged for the next full panel, not re-scored:** `MoonshotAI/kimi-cli` is archived in favour of Kimi Code CLI (`MoonshotAI/kimi-code`). `run-llama/LlamaIndexTS` is archived (last push 2026-03-11). Vercel's published coding breakdown computes to 81.65 against its published score of 79. All three are carried as published.

Earlier panels: 2026-07-22 / 1.8.0 (Deuz re-scored against the 1.8.0 autonomy surface; Mastra and Vercel AI SDK adjusted for Workspace/AgentBrowser/CodeMode and harnesses/`experimental_sandbox`/WorkflowAgent) and 2026-07-20 / 1.7.0.

**This is self-assessed by the Deuz maintainers.** Rubric, per-scenario criterion breakdowns (`scores.json` → `criteria`), live community numbers (`communityLive`), and source notes are published. Re-derive any score from the anchors and tell us where we're wrong.

Current result: **Deuz 73.6 — 9/16 overall** (74.0 / 9th on 1.8.0). Scenarios: chatbot 77, CLI 72, coding 70, ASI 76, AGI 73. Features rose in every scenario, but the community criterion fell to a flat **15** in every scenario: 141 npm downloads/week, down from 393, gives 23 + 17.5 × log10(141 ÷ 393) = 15.2. The 697 GitHub stars (2 on the last panel) are recorded, not scored. Community takes back more than the features add.

## Install footprint

`measure.py` (stdlib-only Python) npm-installs each package into a clean temp dir, measures `node_modules` size / package count / file count, then times a cold ESM import (median of 5 runs after 1 warmup).

Current results (2026-09-26, Node 24.19.0, npm 12.0.2 with default settings):

| package | installed | packages | cold import |
| --- | ---: | ---: | ---: |
| **@deuz-sdk/core 2.2.0** (local pack) | **10.00 MB** | **1** | **21.9 ms** |
| ai 7.0.116 | 18.51 MB | 11 | 71.5 ms |
| llamaindex 0.12.1 | 45.53 MB | 42 | 267.1 ms |
| langchain 1.5.12 | 53.36 MB | 21 | 323.1 ms |
| @openai/agents 0.18.0 | 63.18 MB | 26 | 271.9 ms |
| @mastra/core 1.71.0 | 106.74 MB | 149 | 358.5 ms |

@deuz-sdk/core grew 2.44× on disk since the 1.8.0 local pack (4.09 MB) and still installs as one package with no runtime dependencies. Compare import times within one run only: llamaindex 0.12.1, the same version as on 2026-07-22, went from 546.3 ms to 267.1 ms on today's Node and npm. An earlier run the same day gave the same sizes, with import medians 1–14% (1.4–25.3 ms) apart.

npm 12 blocks dependency install scripts unless they are allow-listed. `results.json` lists what it skipped for each package (`blockedInstallScripts`): `tree-sitter`'s `install` under llamaindex, and the Deuz tarball's own `prepare` build step, which npm never runs for a registry install.

For a pre-release Deuz tree, pack locally first:

```sh
npm run build -w @deuz-sdk/core
npm pack -w @deuz-sdk/core --pack-destination .
# then:
set DEUZ_TARBALL=deuz-sdk-core-2.2.0.tgz   # Windows
python bench/measure.py
```

## Regenerating

```sh
python bench/measure.py   # → bench/results.json
python bench/chart.py     # → assets/*.png  (needs: pip install matplotlib)
```

`chart.py` reads `scores.json` + `results.json` only — edit the JSON, re-run, commit. Chart titles, the Deuz headline and rank, and the version labels come from the JSON.

The facts chip in `assets/banner-light.svg` / `-dark.svg` (0 runtime deps · 10.0 MB · 21.9 ms cold import) is copied by hand from `results.json`. Update it whenever you re-measure.
