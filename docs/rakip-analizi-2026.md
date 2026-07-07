# Rakip Analizi 2026 — AI SDK 7 · Deuz SDK 1.4 · WrongStack · Hermes

> Tarih: 2026-07-06 · Yöntem: kod tabanı taraması (`@deuz-sdk/core` v1.4.0, 377 test) + `docs/benchmark-ai-sdk.md` (AI SDK 7.0.14, 2026-07-04 web-doğrulamalı) + WrongStack `ARCHITECTURE.md` (v0.61.0 haritası, site v0.276.2) + NousResearch `hermes-agent` docs/README + bağımsız teknik incelemeler.
> Hedef soru: **2026 sonunda "en iyi AI SDK" Deuz SDK olsun** — kim neyi iyi yapıyor, bizde ne eksik, hangi sırayla kapatılır?

---

## Faz 1 — Kategori netliği: dördü aynı ligde değil

En kritik tespit: bu dört isim iki farklı ürün kategorisine ait. Yanlış ligde kıyas, yanlış yol haritası üretir.

| | Kategori | Dil / Runtime | Ne satıyor? |
| --- | --- | --- | --- |
| **Vercel AI SDK 7** | Uygulama SDK'sı (kütüphane) | TS · ESM-only, edge çalışır ama saflık garantisiz | Uygulamana gömdüğün model-çağrı + agent + UI katmanı |
| **Deuz SDK 1.4** | Uygulama SDK'sı (kütüphane) | TS · ESM+CJS, **lint-garantili edge-safe**, 0 runtime dep | Aynı katman; determinizm + saflık + maliyet görünürlüğü iddiasıyla |
| **WrongStack 0.276** | Terminal coding-agent **ürünü** + gömülebilir kernel (`@wrongstack/core`) | TS/Node 22+, 15 paket monorepo | Claude Code benzeri otonom kodlama ajanı; REPL/TUI/WebUI/Desktop/HQ |
| **Hermes (NousResearch)** | Kişisel otonom ajan **ürünü** | Ağırlıkla Python; $5 VPS'te servis | Kendini geliştiren asistan: learning loop, 18 platform mesajlaşma, cron, voice |

- AI SDK ve Deuz **birbirinin doğrudan rakibi**.
- WrongStack ve Hermes ise SDK değil, **SDK'ların üstüne inşa edilen türden ürünler** — bizim ligimizde rakip değil, (a) özellik fikri kaynağı, (b) potansiyel *müşteri profili*: "WrongStack/Hermes benzeri bir ajanı Deuz SDK ile yazabilmelisin" doğru hedef cümlesi.
- Not: npm'de `hermes-agents-sdk` adlı ayrı bir paket daha var (ENS + 0G üzerinde şifreli ajan-mesajlaşma SDK'sı). Niş bir altyapı; bu rapordaki "Hermes" = NousResearch hermes-agent. İstenirse ayrı incelenir.

---

## Faz 2 — Dört ürünün doğrulanmış özeti

### 2a. Vercel AI SDK 7 (`ai@7.0.14`, GA 2026-07)

- Core: text/object stream, image, embedding, **reranking, transcription (deneysel streaming STT), speech**.
- Agent: `ToolLoopAgent` (stopWhen, prepareStep, activeTools, typed runtime/tools context), **subagent** (ama `toolApproval` ile birlikte çalışmıyor — dokümante kısıt), `WorkflowAgent` (durable; **Vercel Workflow runtime'ına bağımlı**, yalnız `stream()`), `HarnessAgent` (Claude Code/Codex sarmalayıcı), `@ai-sdk/tui`.
- UI: React/Vue/Svelte/Angular/Expo, resumable stream (Redis), generative UI (deneysel).
- Telemetry: `@ai-sdk/otel` GenAI semconv + DevTools.
- Provider: 24 birinci parti + ~30 community (~48+), Gateway, string-lookup registry.
- Bedel: ESM-only, zorunlu `zod` peer, ~11–12 MB kurulum, otomatik compaction yok (manuel `pruneMessages`), durable = vendor bağı.

### 2b. Deuz SDK (`@deuz-sdk/core` v1.4.0)

- Çekirdek: 4 wire → tek kanonik `StreamPart` hattı; G2 (sync dönüş, asla throw yok); deterministik retry/jitter/timeout; quirk registry; maliyet metering + fiyat tablosu; prompt caching top-level; secret redaction P0.
- Agent katmanı (1.4 ile büyüdü): tool loop (paralel, self-healing, runaway guard), **onay akışı loop'un içinde** (server+client+resume, deny-by-default), **`agentTool` subagent** (canlı stream forwarding + onay mirası — AI SDK'nın yapamadığı kombinasyon), **`compaction: 'auto'`** (katmanlı, cache-safe — AI SDK'da yok), **bütçe stop'ları** (`totalTokensExceed`/`costExceeds`), `prepareStep`/`activeTools`.
- Modüller: memory (mem0 + markdown vault), RAG (BM25+RRF hibrit), skills (SKILL.md + progressive disclosure), MCP (tools+resources+prompts+elicitation), middleware, image/Midjourney/Yunwu, React hooks, UI wire.
- Doğrulanmış eksikler (bu depoda grep ile): **durable/checkpoint yok** (`SessionStore` = 0 hit), **telemetry fiilen yok** (`tracer.startSpan` yalnız no-op default'ta), provider ~6 aile, resumable UI stream yok, ses yok, reranker seam-only, batch yok, `breakerStore` istek yoluna bağlı değil.

### 2c. WrongStack (v0.276.2, MIT)

- Ürün: terminal otonom kodlama ajanı; REPL + TUI + WebUI + Electron Desktop + cross-machine HQ; ACP; Telegram köprüsü.
- Mimari (bizim için ders niteliğinde): ~600 satırlık okunabilir kernel (`Container`/`Pipeline`/`EventBus`/`RunController`); her şey typed registry + interface ile değiştirilebilir; **~140 provider'ı models.dev'den canlı çekiyor — sıfır hardcode model/fiyat listesi**; 36 tool + 23 skill + 44 plugin; per-tool kalıcı **PermissionPolicy** + AES-256-GCM `SecretVault` + `SecretScrubber`; append-only **JSONL session store** + resumable sidecar'lar; **Director** çok-ajanlı orkestrasyon + **AutoPhase** (LLM'in fazlara böldüğü planı bağımlılık grafiğiyle paralel yürütme, `PhaseStore` ile kesintiden devam) + git worktree yöneticisi; observability: Prometheus + OTLP + OTelTracer + `/healthz`.
- SDK gözüyle sınırı: Node-only, coding-agent domain'ine bağlı, edge/browser hedefi yok, kütüphane yüzeyi (`@wrongstack/core`) genel amaçlı model-SDK'sı değil.

### 2d. Hermes — NousResearch hermes-agent (130k+ yıldız, MIT)

- Ürün: "kendini geliştiren" kişisel ajan; CLI + 18 platform mesajlaşma gateway'i (Telegram/Discord/Slack/WhatsApp…), cron otomasyonları, voice mode, subagent delegasyonu, 60+ tool, MCP.
- Asıl yenilik — **kapalı öğrenme döngüsü**: iş bitince tekrar kullanılabilir prosedürü **kendisi SKILL.md olarak yazar**; kullanım sırasında skill'i patch'ler; arka planda **Curator** skill kütüphanesini puanlar, near-duplicate'leri birleştirir, kullanılmayanı `active → stale → archived` döngüsüyle arşivler (asla silmez, pin'lenebilir); geçmiş oturumlar SQLite FTS5 ile aranır; `memory.md` (gerçekler) + `user.md` (kullanıcı modeli, Honcho dialectic) + `SOUL.md` (kimlik). Katmanlı bellek: L1 session → L2 kalıcı gerçekler → L3 FTS5 → L4 skills.
- Ayrı repo'da offline **self-evolution** (DSPy + GEPA): koşu izlerinden prompt/tool-açıklaması/skill mutasyonları üretir, insan onaylı PR ile girer.
- SDK gözüyle sınırı: Python ürünü; TS uygulamasına gömülemez; kütüphane API'si yok. Skill formatı **agentskills.io** açık standardı — bizim `skills` modülüyle zaten uyumlu zemin.

---

## Faz 3 — Karşılaştırma ve sıralama

### 3a. SDK ligi (bir TS uygulamasına gömülecek altyapı seçimi)

Puanlama `docs/benchmark-ai-sdk.md` metodolojisiyle (K=3/O=2/D=1 ağırlık; v1.4'ün kapattığı kalemler işlendi):

| Sıra | Ürün | Chatbot | CLI/otonom ajan | Bir cümlede |
| --- | --- | --- | --- | --- |
| 1 | **AI SDK 7** | ~%85 | ~%78 | Ekosistem genişliği (provider, framework, ses, OTel, DevTools) hâlâ toplamda lider. |
| 2 | **Deuz SDK 1.4** | ~%74 | ~%74 | Çekirdek kalite lideri (determinizm, 0 dep, edge, maliyet, caching, approval+subagent+auto-compaction tek gövdede — bu üçlü AI SDK'da yok); açığı ekosistem ve işletim kalemleri açıyor. |
| 3 | **WrongStack core** | — | ~%55* | Güçlü runtime deseni ama genel-amaçlı SDK değil; Node-only, domain'e bağlı. |
| 4 | **Hermes** | — | —* | SDK olarak kullanılamaz (Python ürün); bu ligde yarışmıyor. |

\* WrongStack/Hermes'i SDK liginde puanlamak kategorik olarak adaletsiz — sıralamaları "gömülebilirlik" üzerinden.

v1.3→1.4 farkı önemli: CLI-ajan puanımız ~%58'den ~%74'e çıktı (subagent + compaction + bütçe stop + prepareStep kapandı). Kalan fark artık 3 kalemde yoğunlaşıyor: **durable execution, telemetry, provider/modalite genişliği.**

### 3b. Otonom ajan ürünü ligi (bilgi amaçlı)

1. **Hermes** — learning loop + platform genişliği + topluluk ivmesi (130k yıldız) ile açık ara.
2. **WrongStack** — kodlama alanında daha derin (Director, AutoPhase, worktree, HQ), genel asistan olarak daha dar.
AI SDK ve Deuz bu ligde ürün değil, altyapı.

### 3c. Kim neyi bizden iyi yapıyor → bizde neye dönüşür?

| Kaynak | Onların özelliği | Deuz SDK'da karşılığı (seam felsefesiyle) |
| --- | --- | --- |
| AI SDK | `WorkflowAgent` durable | `SessionStore` + checkpoint/resume — **vendorsuz** durable (P1) |
| AI SDK | `@ai-sdk/otel` + DevTools | `tracer` seam'ini pump/loop'a işle + `./otel` adapter (P2) |
| AI SDK | 48+ provider, string registry | compat factory'ler + registry satırları + router (P3) |
| AI SDK | resumable UI stream (Redis) | `seq` + storage-agnostik `StreamBuffer` seam (P4) |
| AI SDK | speech/transcription, reranking | `./speech` seam + 2 sağlayıcı; reranker impl (P6) |
| WrongStack | models.dev canlı katalog | registry'ye opsiyonel **canlı katalog beslemesi** (pinned quirk'ler kalır, fiyat/context canlı güncellenir) (P3) |
| WrongStack | kalıcı PermissionPolicy + audit | approval'ın üstüne **policy store seam** (allow/deny hatırlama) + audit event (P5) |
| WrongStack | JSONL session + PhaseStore resume | `SessionStore` referans impl'leri: in-memory, dosya/JSONL (P1) |
| WrongStack | Prometheus/OTLP/healthz | OTel öncelikli; metrics sink seam'i zaten `onUsage` ile başlıyor (P2) |
| Hermes | ajan kendi skill'ini yazıyor | `skills` modülüne **write-path**: `createSkill`/`updateSkill` + SKILL.md emitter (P5) |
| Hermes | Curator (grade/consolidate/archive) | `SkillCurator` — LLM'li bakım geçişi, asla silmez (P5) |
| Hermes | FTS5 geçmiş-oturum araması | BM25 zaten var → `searchSessions` (SessionStore üstünde lexical recall) (P5) |
| Hermes | memory.md / user.md / SOUL.md katmanları | memory modülüne consolidation/decay + `agentIdentity` scope (P5, kısmen roadmap'te) |

---

## Faz 4 — Deuz SDK'ya eklenmesi gerekenler (tam liste, öncelikli)

**Kritik (CLI-ajan senaryosunu kilitleyen):**
1. Durable sessions — `SessionStore` seam + `AgentCheckpoint` + `resumeFromCheckpoint` (adım-sınırı checkpoint; approval-pending round-trip; in-memory + JSONL referans impl).
2. OTel telemetry — `invoke`/`step`/`execute_tool` span'larının gerçekten atılması + `./otel` subpath (GenAI semconv, redaction span'larda da).
3. Provider genişliği — Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras, Fireworks, Kimi/Moonshot, Qwen, GLM, MiniMax compat factory'leri + registry/pricing satırları; string-lookup registry + fallback router (roadmap Faz 5 kalemi); opsiyonel canlı katalog beslemesi.

**Yüksek (chatbot paritesi + güven):**
4. Resumable UI stream — part'lara `seq`, `StreamBuffer` seam (memory/Redis/Supabase), `Last-Event-ID` reconnect, `useChat` auto-resume.
5. HMAC imzalı onaylar (WebCrypto; `approvalId` alanı bunun için ayrılmıştı).
6. Kalıcı `PermissionPolicy` seam + audit event stream (WrongStack dersi; approval'ın hatırlanan hali).
7. `createClient` parite: `streamObject`/`embed`/`embedMany`; `breakerStore`'un gerçekten bağlanması ya da "reserved" dokümantasyonu.

**Farklılaştırıcı (2026'da "en iyi" iddiasını kuran):**
8. Learning-loop primitifleri — skills write-path + `SkillCurator` + `searchSessions` + memory consolidation/decay. (Hiçbir SDK'da yok; Hermes bunu ürün olarak kanıtladı, biz kütüphane olarak ilk oluruz.)
9. Eval/replay harness'ının dışa açılması — golden-replay fixture altyapımızı (`test/fixtures/sse.ts`) `./testing` subpath'i olarak yayınla: kullanıcılar ajanlarını deterministik test edebilsin. (AI SDK'nın DevTools'una asimetrik cevap.)

**Orta:**
10. Speech/STT seam + 2–3 sağlayıcı (2026'da voice-agent dalgası; Hermes voice mode, AI SDK streaming STT gemisini kaldırdı).
11. Reranker implementasyonu (Cohere/Voyage/Jina; seam hazır).
12. Batch API (%50 indirimli async — maliyet iddiamızın doğal uzantısı).
13. Vue/Svelte adapter'ları (wire framework-bağımsız; ucuz ama talep-güdümlü).
14. Image edit + video-gen helper (roadmap'te ertelenmişti; modalite tamamlama).

---

## Faz 5 — 2026 yol haritası: faz faz uygulama planı

Sıralama bağımlılığa göre; her faz `npm run check` yeşil + `surface.test-d.ts` append-only kuralıyla biter. Efor: S ≤2 gün, M ≤1 hafta, L >1 hafta.

### Faz A — Hijyen + ucuz genişlik (S–M, hemen)
- `breakerStore` bağla veya "reserved" dokümante et; `createClient`'a `streamObject`/`embed`/`embedMany`; `stop.ts`'e `durationExceeds(ms)`.
- Compat provider factory'leri (tek dosya `src/providers-compat.ts` + registry + pricing satırları). Quirk'ler registry'de tek kaynak kalır.
- String-lookup provider registry + basit fallback router (`aggregator fallback` roadmap kalemi).
- **Çıktı**: "6 aile" itirazı kapanır; CLI-ajan ~%74 → ~%78.

### Faz B — İşletilebilirlik: telemetry + görünürlük (M)
- `core/inference.ts` + `loop-shared.ts` içine `tracer.startSpan` çağrıları (`invoke`/`step`/`execute_tool` hiyerarşisi) — core'a bağımlılık eklemeden, seam üstünden.
- `src/otel.ts` (`@opentelemetry/api` opsiyonel peer) — GenAI semconv; redaction değişmezi span attribute'larında regression-testli.
- `./testing` subpath: `sseResponse`/`mockFetch`/deterministik mock model dışa açılır.
- **Çıktı**: production ajan işletiminin önkoşulu; DevTools'a asimetrik cevap (deterministik replay bizde).

### Faz C — Durable agent runtime (M–L, tekil en büyük hamle)
- `src/types/session.ts` (`AgentCheckpoint v1`, `SessionStore`) + `src/inference/checkpoint.ts` (`resumeFromCheckpoint`).
- Kanca: tool sonuçları history'ye yazıldıktan sonra, sonraki model çağrısından önce `store.save()`. Dürüst sınır: adım-ortası durable'lık iddia edilmez.
- Mevcut settle-on-resume onay mekanizması **aynen** yeniden kullanılır (approval-pending checkpoint round-trip).
- Referans impl: in-memory + JSONL dosya (WrongStack'in kanıtladığı desen); Supabase impl platform repo'sunda.
- **Çıktı**: "durable ama vendorsuz" — AI SDK'nın `WorkflowAgent` vendor bağına karşı yapısal üstünlük. CLI-ajan ~%78 → ~%85.

### Faz D — Chatbot paritesi (M)
- Resumable UI stream: `seq` + `StreamBuffer` seam + `Last-Event-ID`; `useChat` auto-reconnect.
- HMAC imzalı onaylar (`approvalSecret`, WebCrypto, edge-safe).
- `useChat` küçük parite kalemleri (throttle, attachment ergonomisi).
- **Çıktı**: chatbot ~%74 → ~%80+ ("denk + daha hafif + daha ucuz işletim" iddiası savunulabilir).

### Faz E — Öğrenen ajan primitifleri (M–L, kimsede yok)
- Skills write-path: `createSkill`/`updateSkill` + SKILL.md emitter (agentskills.io uyumlu — Hermes ekosistemiyle ortak format).
- `SkillCurator`: kullanım sayacı, near-duplicate konsolidasyonu, `active → stale → archived` (asla silme, pin desteği) — LLM geçişi `generateObject` ile, tamamı seam üstünden.
- `searchSessions`: `SessionStore` üstünde BM25 lexical recall (kod hazır: `rag.ts` BM25); istenirse hibrit (embedder seam).
- Memory consolidation/decay + `agentIdentity` scope (SOUL.md karşılığı).
- **Çıktı**: "ajanın kendi kendini geliştirmesi"nin SDK primitifleri — Hermes'in üründe kanıtladığını kütüphane olarak ilk biz veririz. Pazarlama cümlesi hazır: *"Build your own Hermes — on the edge."*

### Faz F — Modalite tamamlama (M)
- `./speech`: STT/TTS seam + OpenAI/Deepgram/ElevenLabs'ten 2'si.
- Reranker impl (Cohere/Voyage/Jina) — `rerank` seam'ine takılır.
- Batch API (Anthropic/OpenAI %50 indirim) — maliyet-lideri kimliğin uzantısı.
- **Çıktı**: modalite tablosunda 🟡/❌ kalmaz.

### Faz G — Kanıt + ekosistem (sürekli)
- Referans CLI ajanı (~500 satır): Deuz SDK ile WrongStack-tarzı mini kodlama ajanı — durable + subagent + compaction + policy'nin uçtan uca demosu; `examples/` altında.
- Benchmark yenileme: bu rapor + `benchmark-ai-sdk.md` her minor'da güncellenir; senaryo puanları README'ye işlenir.
- Vue/Svelte adapter'ları talebe göre.

### Hedef puan tablosu (2026 sonu)

| Senaryo | Bugün (1.4) | Faz A–D sonrası | Faz E–F sonrası | AI SDK 7 (öngörü) |
| --- | --- | --- | --- | --- |
| Chatbot | ~%74 | ~%81 | ~%84 | ~%85–87 |
| CLI/otonom ajan | ~%74 | ~%85 | ~%90+ | ~%78–82 |

CLI/otonom ajan altyapısında **net liderlik** (vendorsuz durable + auto-compaction + approval-entegre subagent + learning-loop primitifleri — dördü birden rakipte yok); chatbot'ta "denk, ama 6x küçük, 0 bağımlılık, CJS+ESM, deterministik test, yerleşik maliyet" konumu.

---

## Sonuç

1. **Sıralama (SDK ligi, bugün):** AI SDK 7 → **Deuz SDK 1.4** → WrongStack core → Hermes. Ürün liginde Hermes ve WrongStack kendi alanlarının lideri ama bizim rakibimiz değil — ilham ve hedef-müşteri profili.
2. **Deuz'un kalıcı avantajları** şimdiden benzersiz: 0 dep/2 MB, lint-garantili edge, deterministik her şey, quirk registry, maliyet+caching birinci sınıf, approval+subagent+auto-compaction tek gövdede.
3. **Kapanacak 3 kritik açık**: durable sessions, OTel, provider genişliği. Ardından **Faz E** (learning-loop primitifleri) 2026'da kimsenin kütüphane olarak sunmadığı katmanı ekleyip "en iyi" iddiasını kategorik farkla kurar.
