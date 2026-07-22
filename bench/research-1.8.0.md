# 1.8.0 Benchmark Araştırması — 2026-07-22

Kod-doğrulanmış panel. Eski 1.7.0 bench (2026-07-20, Deuz **69.6 → 14/16**) üzerine; 1.8.0 otonomi yüzeyi + rakip ürün değişiklikleri yeniden skorlandı.

## Ne ölçülüyor?

Aynı 100 puanlık metodoloji (`scores.json` → `methodology`):

| Senaryo | Soru |
| --- | --- |
| **Chatbot** | Üretim chat UI: stream, persist, resume, maliyet, bellek, hook/component |
| **CLI** | Kurulabilir ajan CLI — kütüphaneler *inşa edilebilirlik* üzerinden |
| **Coding agent** | fs/shell/git, sandbox, patch akışı |
| **ASI** | Uzun ufuk: checkpoint/resume, bellek, guardrail, gözlem, plan→verify |
| **AGI** | Sağlayıcı genişliği, modalite, ekosistem |

Kriter ağırlıkları: features 25 · DX 20 · performance 15 · community 15 · flexibility 15 · price 10.

Community log-ölçek: ~16M npm/hafta → 95 · 100k → 70 · 1k → 35 · &lt;500 → 15–25.

## 1.8.0’da Deuz’ta ne değişti? (kod)

Paket sürümü hâlâ `1.7.1`; skor **yerel 1.8 yüzeyine** göre (changeset + `src/` + exports).

| Yüzey | Edge | Node referans | Test |
| --- | --- | --- | --- |
| `./autonomy` — `planTasks`, `bestOfN`, `selfConsistency`, `parallelAgents` | ✓ | — | `autonomy.test.ts` |
| `verifyStep` / `maxVerifyAttempts` (her iki loop) | ✓ | — | `verify-step.test.ts` |
| `./workspace` + tools | ✓ | `createFileWorkspace` | in-memory only |
| `./compute` CodeAct + shell | ✓ | `createNodeSandbox` | ✓ |
| `./browser` tools | ✓ | Playwright (lazy peer) | mock only |
| `./runtime` RunManager, plan/activity emit, steering | ✓ | JSONL + `pollStaleRuns` | ✓ |
| `./providers` + registry | ✓ | — | factories; registry zayıf |
| `./testing` mock + `runEval` | ✓ | — | ✓ |
| `./azure`, `./bedrock` | ✓ | Bedrock = Mantle Bearer | ✓ |

**Bilinçli boşluklar (skora yazıldı):** Docker/E2B sandbox yok; steering loop’a otomatik bağlı değil; `plan.json` otomatik workspace yazımı yok; Bedrock SigV4/Converse yok; CLI ürünü yok.

## Rakip hareket (2026-07-20 → 22)

### Vercel AI SDK 7
- `ToolLoopAgent` + `experimental_sandbox`
- `@ai-sdk/workflow` → `WorkflowAgent` (dayanıklı adım, `needsApproval`)
- Harness paketleri (Claude Code / Codex / Pi / …)
- Skor: **85.2 → 86.2** (coding/ASI)

### Mastra
- **Workspace** (fs + sandbox + LSP + search + skills)
- **AgentBrowser** (a11y ref `@e1`, Playwright)
- **CodeMode** + E2B / Daytona / Blaxel uzak sandbox
- Skor: **73.0 → 75.8** (coding/ASI asıl sıçrama)
- Deuz’a göre üretim izolasyonunda hâlâ önde; Deuz sıfır-dep + edge seam + `verifyStep` ile ayrışıyor

### Diğerleri
OpenAI Agents, Anthropic Agent SDK, LangGraph, CLI ürünleri (Claude Code / Codex / Gemini CLI): senaryo skorları taşındı; community sayıları yenilendi.

## Canlı community (2026-07-22)

| Paket | npm / hafta | GitHub ★ |
| --- | --- | --- |
| `@deuz-sdk/core` | **393** | **2** |
| `ai` | 17.98M | 25.7k |
| `@mastra/core` | 1.20M | 26.4k |
| `@openai/agents` | 1.48M | 3.4k |
| `@anthropic-ai/claude-code` | 11.5M | 138.7k |

Deuz community kriteri her senaryoda **23** (önceki panelde 22; 336 → 393 indirme).

## Deuz kriter kırılımı (1.8)

| Senaryo | F | D | P | C | E | $ | → | Δ vs 1.7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chatbot | 90 | 78 | 86 | 23 | 88 | 92 | **77** | +1 |
| CLI | 78 | 74 | 84 | 23 | 86 | 90 | **72** | +4 |
| Coding | 78 | 72 | 84 | 23 | 80 | 88 | **71** | **+10** |
| ASI | 94 | 74 | 85 | 23 | 92 | 86 | **77** | +3 |
| AGI | 78 | 74 | 86 | 23 | 90 | 90 | **73** | +4 |
| **Ort.** | | | | | | | **74.0** | **+4.4** |

**Sıra: 14/16 → 9/16.** Community cezası aynı; sıçrama özellik (özellikle coding + ASI).

## Dürüstlük kontrolü

1. Mastra’nın uzak sandbox’ı Deuz `createNodeSandbox`’tan üretim için daha güçlü — coding’de Mastra 76 &gt; Deuz 71.
2. Vercel ekosistemi + WorkflowAgent hâlâ ASI/chatbot lideri.
3. Deuz’un iddiası “Manus-tarzı tam otonomi ürünü” değil; **bileşik primitifler** (plan → CodeAct → verify → runtime) — Agent tanrı-sınıfı yok.
4. npm’de 1.8.0 yokken skorlamak: panel “kod gerçeği” için; yayın sonrası `measure.py` tekrarlanmalı.

## Install footprint (ölçüldü 2026-07-22)

Yerel `npm pack` (1.8 yüzeyi, sürüm etiketi hâlâ 1.7.1) + rakipler npm’den:

| Paket | MB | paket # | cold import |
| --- | ---: | ---: | ---: |
| **@deuz-sdk/core** (local 1.8) | **4.09** | **1** | **40.3 ms** |
| ai 7.0.34 | 13.3 | 10 | 132 ms |
| @openai/agents | 45.7 | 101 | 447 ms |
| llamaindex | 43.9 | 42 | 546 ms |
| langchain | 51.1 | 21 | 765 ms |
| @mastra/core | 116.4 | 228 | 678 ms |

1.7.0 → 1.8 local: 3.53 → 4.09 MB (+%16), import 26.7 → 40.3 ms (yeni subpath’ler). Hâlâ tek paket, sıfır runtime dep; Mastra’nın ~28× disk maliyeti.

## Yeniden üret

```sh
npm run build -w @deuz-sdk/core
npm pack -w @deuz-sdk/core --pack-destination .
set DEUZ_TARBALL=deuz-sdk-core-1.7.1.tgz
python bench/measure.py
python bench/chart.py
```

Detaylı skorlar: [`scores.json`](./scores.json). Özet: repo kökü `README.md` → “Where we actually are”.
