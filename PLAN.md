# PLAN.md — Deuz SDK 1.5.0 Sonrası Release Yol Haritası (2026 H2)

> Oluşturulma: 2026-07-06 · Son doğrulama turu: **2026-07-07** (bkz. "Doğrulama Turu" bölümü) · Kaynaklar: `docs/rakip-analizi-2026.md` (Faz A–G), `docs/arastirma-yol-haritasi-2026.md` (M1–M12), `docs/benchmark-ai-sdk.md` (rubrik), kod tabanı taraması (v1.4.0 yayında + 1.5.0 in-flight), web doğrulaması (AI SDK `ai@7.0.15`, 2026-07-04).
> Hedef: **v2.0.0'da kategorik liderlik** — chatbot +20, CLI otonom ajan +15, uzun-ufuk otonom ("AGI-track") +18 puan. CLI ve GUI birinci sınıf teslimat.
> Tahmini karmaşıklık: **Yüksek** (8 faz, 6 core release + 2 yeni paket). Efor etiketi: S ≤2 gün · M ≤1 hafta · L >1 hafta.

---

## Genel Bakış

İki araştırma dokümanının sentezi tek cümlede: **kazanan SDK, bağlamı öğrenen (playbook/bellek/skill), ürettiğini doğrulatan (verifier) ve güvenilmeyen içeriği yapısal olarak zapt eden (taint/policy) SDK olacak** — ve bu üç yetenek ailesinin hiçbiri bugün hiçbir TypeScript SDK'sında primitif olarak yok. Deuz'un mevcut değişmezleri (deterministik seam'ler, immutable history, golden-replay test, kanonik akış hattı, edge-safe saf çekirdek) bu mekanizmaların tam ön-gereksinimi.

Plan üç katmanda ilerler:

1. **Zemin** (Faz 1–2): rakip-analizi Faz A–D'nin kalanı — provider genişliği, OTel, `./testing`, resumable UI. Bunlar hem puan kapatır hem sonraki fazların ölçüm/gözlem altyapısıdır.
2. **Fark** (Faz 4–6): arastirma-yol-haritasi M1–M12 — playbook, evrilen bellek, öğrenen skills, doğrulanmış üretim, yapısal güvenlik. "+20/+15/+18" bu katmandan gelir.
3. **Vitrin** (Faz 3, 7): **CLI** (`@deuz-sdk/cli`) ve **GUI** (`@deuz-sdk/devtools`) — SDK primitiflerini kanıtlayan, dogfooding yapan ve AI SDK'nın `@ai-sdk/tui` + DevTools ikilisine asimetrik cevap veren iki yeni paket.

### Release treni (özet tablo)

| Faz | Release | Kod adı | İçerik özü | Efor | Rubrik etkisi |
| --- | --- | --- | --- | --- | --- |
| 0 | **v1.5.0** (✅ tamamlandı 2026-07-07 — impl + docs + check yeşil + canlı smoke) | Durable | `SessionStore` + checkpoint/resume + HMAC onay | M | CLI-ajan ~%74→~%80 |
| 1 | **v1.6.0** | Genişlik + Gözlem | compat provider'lar, string registry + router, OTel span'ları, `./testing` | M | CLI ~%80→~%84 |
| 2 | **v1.7.0** | Kesintisiz UI + Tanılama | resumable UI stream, MAST diagnostics, lessons havuzu | M | Chatbot ~%74→~%81 |
| 3 | **`@deuz-sdk/cli` v0.1** | deuz CLI (alpha) | monorepo geçişi + Ink TUI referans ajan | M–L | Dogfooding + görünürlük |
| 4 | **v1.8.0** | Evrilen Bağlam | playbook (ACE), memory EVOLVE, write-gating, identity scope | M | AGI-track ~%60→~%70 |
| 5 | **v1.9.0** | Öğrenen Ajan | skills write-path + validation gate, curator, maintenance, searchSessions | M–L | CLI ~%84→~%89 |
| 6 | **v2.0.0** ⭐ | Doğrulama + Güvenlik | bestOfN/verifyStep, provenance/taint/ToolPolicy, trifecta linter + **CLI 1.0 GA** | L | **Hedef: chatbot ~%93 · CLI ~%92 · AGI ~%86** |
| 7 | **`@deuz-sdk/devtools` v0.1→1.0** | deuz DevTools (GUI) | local-first ajan debugger: trace + checkpoint time-travel + replay + maliyet | L | İşletim/DX farkı |
| 8 | **v2.1.0** | Evrim + Kanıt | `./evolve` harness, speech/rerank/batch, benchmark koşuları + sayılarla iddia | M–L | Kalan 🟡/❌ kapanır |

**"En iyi olacağımız release" = v2.0.0** (Faz 6): doğrulanmış üretim + yapısal güvenlik + öğrenen ajan primitifleri + vendorsuz durable + CLI GA aynı gövdede — 2026 rubriğinde üç senaryoda da AI SDK'nın öngörülen ilerlemesinin üstü. GUI (Faz 7) bu iddianın *görünür kanıtı* olarak hemen ardından gelir.

### Bağımlılık grafiği

```
v1.5.0 (durable) ──► Faz 3 (CLI, runs/resume) ──► Faz 6 (CLI GA)
Faz 1 (./testing M12) ──► Faz 5 (M5 validation gate) ──► Faz 6 (M7 verifier eval)
Faz 1 (OTel) ──► Faz 7 (DevTools ingest)
Faz 2 (resumable wire + seq) ──► Faz 7 (DevTools replay/live)
Faz 4 (M2/M3 bellek) ──► Faz 5 (M4 maintenance)
Faz 6 (M9 provenance) ── bağımsız, tek koşul: types additive
Faz 8 (M10 evolve) ──► Faz 5'in skill write-path'ine dayanır
```

**Sıralama kuralı (implementer için):** Faz 3 (monorepo + CLI) yalnızca **v1.7.0 yayınlandıktan sonra** başlar — Faz 1 (string registry) ve Faz 2 (resumable UI) CLI'nın `deuz models` ve demo akışı için zorunlu. Faz 4–8'deki `src/` yolları monorepo sonrası `packages/core/src/` anlamına gelir.

### Rubrik notu

Kapanış tablosundaki "Bugün ~%62" rakamları **2026 güncellenmiş rubrik**tir (`arastirma-yol-haritasi-2026.md` Faz 3 — yapısal güvenlik, doğrulanmış üretim, evrilen bellek K/O satırları eklenmiş). `rakip-analizi-2026.md` ve `benchmark-ai-sdk.md`'deki v1.4 ~%74 chatbot puanı **eski rubrik**tir; ikisi çelişmiyor, ölçüm seti farklı. v2.0.0 hedefleri yalnızca 2026 rubriğinde doğrulanır.

---

## Önkoşullar (Faz 0 — v1.5.0'ı bitir)

~~Çalışma ağacında 1.5.0 yarım~~ → **2026-07-07: Faz 0 tamamlandı.** Tüm kalemler yeşil; 405 test + tam gate + Gemini'ye karşı canlı smoke (suspend→HMAC onay→resume, streaming resume, verdict'siz default-deny) geçti.

- [x] `src/durable.ts`: `createInMemorySessionStore`, `resumeFromCheckpoint`, `resumeStreamFromCheckpoint`, `serializeCheckpoint`/`deserializeCheckpoint` (binary-part-safe codec), `CheckpointNotFoundError`, `createApprovalSigner` (WebCrypto HMAC-SHA256).
- [x] Loop kancası: `loop-shared.ts` — her adım sınırında `store.save()` (throw eden store `logger.error` + devam); `agentTool` → `ToolExecuteContext.session` ile iç içe checkpoint; suspended sub-agent onayları `agentPath` ile geri yönlendirme (`SubAgentSuspension` sinyali, child key `${runId}::${name}`).
- [x] Üçlü kilit adım: `package.json` exports + `tsup.config.ts` entry + `src/edge.ts` (`./durable` edge-safe).
- [x] Docs (`/docs/agents/durable-runtime` + subagents/client-tools/comparison güncellemeleri) + CHANGELOG + `npm run check` yeşil → **npm publish v1.5.0**.

Plan bundan sonrasını kapsar. 1.5.0'ın kendisi bu planın konusu değil.

### Faz 0'a paralel ev ödevi (implementer ajanı beklemeyen işler)

- [x] **Working tree ayrıştırması (P1):** docs-i18n taşıması (`docs/app/[lang]/`, `docs/lib/i18n.ts`, `docs/lib/translations.ts`, silinen eski `docs/app/(home)`/layout dosyaları) durable işinden ayrı commit'e alındı (2026-07-07).
- [x] **Docs i18n build doğrulaması:** `cd docs && npm run build` → exit 0 (2026-07-07, ~3 dk, 117+ sayfa + sitemap/robots/llms/OG üretildi). `proxy.ts` hidden default-locale rewrite kullanıyor; eski `/docs/...` URL'leri locale öneksiz çalışmaya devam ediyor, `api/og/llms.*/sitemap/robots/icon` sistem yolları locale dışı. Kalan: deploy preview'da eski URL smoke turu (opsiyonel).

---

## Faz 1 — v1.6.0 "Genişlik + Gözlemlenebilirlik" (M)

**Kaynak:** rakip-analizi Faz A + Faz B; arastirma M12.
**Hedef:** "6 provider ailesi" ve "telemetry fiilen yok" itirazlarını kapatmak; sonraki tüm fazların ölçüm altyapısını (`./testing`) dışa açmak.
**Demo/Doğrulama:** `deuz` string-lookup ile Groq'a istek atan örnek; Jaeger'da `invoke → step → execute_tool` span ağacı; `./testing` ile kullanıcı-tarafı deterministik ajan testi örneği.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 1.1 | Compat provider factory'leri: Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras, Fireworks, Moonshot/Kimi, Qwen, GLM, MiniMax (hepsi `chat_completions` surface) | `src/providers-compat.ts` (tek dosya) + `core/registry.ts` satırları + `pricing.ts` satırları | — | Her factory için golden-replay smoke testi; bilinmeyen slug muhafazakâr default'a düşer (mevcut kural); quirk'ler yalnız registry'de |
| 1.2 | String-lookup registry + fallback router: `createProviderRegistry({ groq, openai, ... })` → `registry.model('groq:llama-4-70b')`; `models: [primary, ...fallback]` pre-first-byte failover | `src/registry-lookup.ts` (yeni) + `core/inference.ts` router kancası | 1.1 | Router yalnız **ilk byte öncesi** hata sınıflarında (401/403/404/429/5xx) failover eder; mid-stream asla; deterministik test |
| 1.3 | `breakerStore`'u istek yoluna bağla (G11) **veya** "reserved" kararını dokümante et | `core/resilience.ts` + `internal/resolve-call.ts` | — | Karar tek yerde; bağlanırsa per-client breaker testi, bağlanmazsa docs + kod yorumu |
| 1.4 | `createClient` paritesi: `streamObject` / `embed` / `embedMany` | `src/client.ts` | — | Surface pinleri append-only; client-context key precedence (G1) korunur |
| 1.5 | `durationExceeds(ms)` stop koşulu | `src/inference/stop.ts` | — | Injected `clock` ile deterministik test; `stoppedBy` raporlanır |
| 1.6 | OTel span'ları gerçekten at: `invoke` → `step` → `execute_tool` hiyerarşisi, seam üstünden (core'a bağımlılık yok) | `core/inference.ts` + `inference/loop-shared.ts` | — | No-op tracer'da sıfır maliyet; span attribute'larında **redaction P0 regression testi** (anahtar asla sızmaz) |
| 1.7 | `./otel` subpath: `@opentelemetry/api` opsiyonel peer, GenAI semconv attribute eşlemesi | `src/otel.ts` (yeni subpath ×3 kilit adım) | 1.6 | `attw` + `publint` yeşil; peer yüklü değilken import eden çekirdek yok (lazy) |
| 1.8 | **M12** `./testing` subpath: `sseResponse`/`sseEvents`/`mockFetch`/`mockFetchSequence` + deterministik mock model + basit senaryo koşucusu (`runEval(fixtures, agent)` → skor) | `src/testing.ts` (yeni; `test/fixtures/sse.ts`'den taşı, test'ler yeni konumdan import etsin) | — | Faz 5'in validation gate'i ve Faz 6'nın verifier eval'i bunun üstüne kurulacak; README'de kullanıcı-tarafı örnek |

**Faz kapanışı:** `npm run check` + yeni subpath'ler için üçlü kilit + CHANGELOG → **npm publish v1.6.0**.

---

## Faz 2 — v1.7.0 "Kesintisiz UI + Tanılama" (M)

**Kaynak:** rakip-analizi Faz D; arastirma M8 + M6.
**Hedef:** Sayfa yenilemede in-flight stream kaybolmasın (chatbot K kalemi); loop'a MAST hata-modu enstrümantasyonu; ilk "öğrenme" primitifi (lessons).
**Demo/Doğrulama:** Chat demo'da stream ortasında sayfayı yenile → kaldığı yerden devam; kasıtlı sonsuz-döngü ajanında `mastReport()` adım-tekrarını yakalar.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 2.1 | Wire part'larına monoton `seq` alanı (additive) | `src/ui.ts` + `types/stream.ts` | — | v1 wire geriye uyumlu; eski client `seq`'i yok sayar |
| 2.2 | `StreamBuffer` seam + in-memory referans impl: pump çıktısını `seq`'li tamponla | `src/ui.ts` (seam tipi `types/`) | 2.1 | Storage-agnostik (Redis/Supabase impl'leri platform repo'suna); bellek sınırı (maxParts) var |
| 2.3 | `Last-Event-ID` reconnect: `toDeuzStreamResponse` SSE id'leri yazar; `readDeuzStream` kopunca `Last-Event-ID` ile yeniden bağlanır; `useChat` auto-resume | `src/ui.ts` + `src/react.ts` | 2.2 | Golden test: stream'i N. part'ta kes → resume → part kaybı yok, duplicate yok |
| 2.4 | **M8** MAST diagnostics v1: adım-tekrar dedektörü (aynı tool+args imzası ≥3), sonlanma-kriteri-yok uyarısı (`stopWhen`/`maxSteps` default'ta ve >8 adım), doğrulamasız-bitiş bayrağı (son adımda hiç tool_result yokken `finish: stop`) | `inference/loop-shared.ts` + `providerMetadata.deuz.mast` + `mastReport(result)` helper | — | Mevcut tool-loop fixture'larıyla deterministik; false-positive oranına dikkat: bayraklar **bilgi**, asla loop'u kesmez |
| 2.5 | **M6** Lessons havuzu: `extractLessons(trajectory)` (LLM'li, `generateObject` seam) + `recallLessons(task, k)` (BM25 mevcut) + `LessonStore` seam | `src/lessons.ts` (yeni subpath ×3) | — | Extract deterministik mock-model testli; recall saf/deterministik; ERL deseni: hafif, tek-deneme dersleri |
| 2.6 | `useChat` parite kalemleri: `throttle`, attachment ergonomisi | `src/react.ts` | — | React test (jsdom) mevcut kalıpla |
| 2.7 | Kalıcı `PermissionPolicy` seam + audit event stream (WrongStack dersi): `PolicyStore` (allow/deny hatırlama, tool+arg imzası bazlı); approval akışının üstüne oturur, mevcut `needsApproval`/`approveToolCall` davranışını değiştirmez | `src/types/tool.ts` (additive) + `src/policy.ts` (yeni subpath ×3) + `loop-shared.ts` kancası | — | Policy ihlali → mevcut onay akışına düşer; audit event'leri `logger` + opsiyonel `onAudit` callback; redaction P0 |

**Faz kapanışı:** `npm run check` → **npm publish v1.7.0**.

---

## Faz 3 — `@deuz-sdk/cli` v0.1 "deuz CLI" (M–L)

**Kaynak:** rakip-analizi Faz G (referans CLI ajanı) + kullanıcı direktifi (CLI birinci sınıf teslimat).
**Hedef:** SDK primitiflerini uçtan uca kanıtlayan, dogfooding yapan, yayınlanabilir bir terminal ajanı. AI SDK'nın `@ai-sdk/tui`'sine ve WrongStack'in TUI'sine cevap — ama bizim farkımızla: **durable + approval + compaction + maliyet tek gövdede**.
**Demo/Doğrulama:** `npx @deuz-sdk/cli` → interaktif ajan; süreç öldür → `deuz runs resume <runId>` kaldığı adımdan devam eder; tehlikeli tool çağrısında onay sorusu; oturum sonunda USD maliyet.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 3.1 | **Monorepo geçişi**: npm workspaces — `packages/core` (mevcut src+test taşınır), `packages/cli`; kök `package.json` workspaces; changesets multi-paket; CI matrisi | kök + `packages/` | — | `npm run check` core'da aynen yeşil; `@deuz-sdk/core` publish yolu değişmez (`files`, exports, provenance korunur); git geçmişi `git mv` ile korunur |
| 3.2 | JSONL dosya `SessionStore` referans impl (WrongStack deseni: append-only) | `packages/core/src/node/session-file.ts` → `./durable/node` subpathi | v1.5.0 | Node-only lint muafiyeti; crash-yeniden-başlatma testi (yarım satır toleransı) |
| 3.3 | CLI çekirdeği: Ink (React zaten opsiyonel peer; Node 22 uyumlu — OpenTUI Bun istediği için v1'de değil) + komutlar: `deuz chat`, `deuz run "<görev>"`, `deuz runs list|resume|delete`, `deuz models` | `packages/cli/src/` | 3.1, 3.2 | TUI: streaming metin + tool çağrı kartları + onay promptu (y/n → `approvalResponses`) + maliyet footer'ı (`onUsage`+pricing) |
| 3.4 | Tool seti: `fs` (read/write/glob), `shell` (onay zorunlu), `fetch` — hepsi `needsApproval` örüntüsüyle | `packages/cli/src/tools/` | 3.3 | Shell tool'u default deny; approval akışı SDK'nın client-mode'unu kullanır (CLI = canlı HITL örneği) |
| 3.5 | Entegrasyonlar: `--model provider:slug` (Faz 1 string registry), `deuz mcp add <url>` (MCP client), `SKILL.md` yükleme (skills modülü), `compaction: 'auto'` default açık | `packages/cli/src/` | Faz 1 | Her entegrasyon SDK'nın public API'siyle — CLI'da özel dal yok (dogfooding ilkesi) |
| 3.6 | E2E smoke: mock provider ile deterministik CLI koşusu (PTY test) | `packages/cli/test/` | 3.3 | CI'da headless çalışır; `./testing` subpath'ini kullanır (kendi ürünümüzle test) |

**Faz kapanışı:** `@deuz-sdk/cli@0.1.0` npm publish (bağımsız sürümleme; core'a `peerDependencies: "@deuz-sdk/core": "^1.7.0"`). Monorepo geçişi ayrı PR; merge öncesi `npm pack @deuz-sdk/core` çıktısı mevcut yapıyla byte-diff karşılaştırılır. Core'a dokunan düzeltmeler 1.7.x patch olarak akar.

---

## Faz 4 — v1.8.0 "Evrilen Bağlam" (M)

**Kaynak:** arastirma M1 + M2 + M3 + M11.
**Hedef:** Pasif bellekten evrilen bellek + playbook'a geçiş — AGI-track rubriğinin K satırları.
**Demo/Doğrulama:** 20 görevlik senaryoda playbook bullet'larının helpful sayaçlarıyla biriktiği, çökmediği (ACE context-collapse testi) gösterilir; vault'ta yeni anının eski notun frontmatter'ını güncellediği görülür.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 4.1 | **M1** Playbook modülü: `PlaybookItem {id, content, helpful, harmful}`; `mergeDelta(playbook, delta)` **deterministik saf fonksiyon** (LLM'siz); `reflect()`/`curate()` `generateObject` seam'li; `toPrepareStep(playbook)` enjeksiyon helper'ı | `src/playbook.ts` (yeni subpath ×3, edge-safe) | — | Merge: property-test (idempotent, sıra-bağımsız delta'lar, çakışan id çözümü); brevity-bias testi: 100 merge sonrası içerik kaybı yok |
| 4.2 | **M2** Memory EVOLVE operasyonu: reconcile çıktısına `EVOLVE` (eski anının attribute/link güncellemesi); markdown vault `[[wikilinks]]` link grafiği API'si (`getLinks`/`backlinks`) | `src/memory.ts` + `src/memory-markdown.ts` | — | Temp-integer-id kuralı korunur (UUID halüsinasyon koruması); vault'ta `.md` insan-okur kalır |
| 4.3 | **M3** Write-gating + bounded store: `remember()` önüne `gate` seam'i (salience skoru; default LLM'siz heuristik + opsiyonel LLM'li); `MemoryStore`'a `budget` (kayıt sayısı) + taşınca konsolidasyon tetiği | `src/memory.ts` | — | Gate reddi sessiz değil: `logger.debug`; budget aşımında en düşük skorlu kayıt konsolide edilir (silinmez) |
| 4.4 | **M11** Self/user-model scope: `memory` scope'una `agentIdentity` katmanı (Hermes `SOUL.md`/`user.md` karşılığı; vault'ta ayrı dosyalar) | `src/memory.ts` + `memory-markdown.ts` | 4.2 | Scope zorunluluğu korunur; identity kayıtları gate'ten muaf (kalıcı katman) |

**Faz kapanışı:** `npm run check` → **npm publish v1.8.0**.

---

## Faz 5 — v1.9.0 "Öğrenen Ajan" (M–L)

**Kaynak:** arastirma M5 + M4; rakip-analizi Faz E (Hermes dersleri).
**Hedef:** SKILL.md write-path + **held-out validation gate** — SkillOpt'un +19–25 puanlık mekanizmasının SDK'laşması. Kimsede yok; golden-replay determinizmimiz tam önkoşul.
**Demo/Doğrulama:** Ajan bir görevi çözer → `proposeSkillEdit` üretir → edit, kayıtlı eval setinde skoru düşürmediği için kabul edilir; düşüren mutasyon reddedilip rejected-buffer'a düşer. CLI'da `deuz skills curate` komutu.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 5.1 | **M5a** Skills write-path: `createSkill(def)` + `proposeSkillEdit(skill, ops)` — yalnız sınırlı `add/delete/replace` bölge edit'leri (SkillOpt deseni); SKILL.md emitter agentskills.io uyumlu | `src/skills.ts` + `skills/node.ts` (fs yazımı Node'da) | — | `normalizeResourcePath` traversal koruması yazma yolunda da; emit→parse round-trip testi |
| 5.2 | **M5b** Validation gate: `gateSkillEdit(edit, evalSet)` — edit ancak `./testing` koşucusunda **skor düşürmüyorsa** kabul; textual learning-rate (edit boyutu sınırı); rejected-edit buffer (tekrar önerilmez) | `src/skills.ts` (+ `./testing` entegrasyonu) | Faz 1 (M12) | Deterministik: aynı eval seti + aynı edit → aynı karar; kabul/red audit kaydı `logger.info` |
| 5.3 | **M5c** `SkillCurator`: kullanım sayacı, near-duplicate konsolidasyonu, `active → stale → archived` (asla silme, pin desteği) — Hermes Curator deseni, `generateObject` seam'li | `src/skills.ts` | 5.1 | Curator hiçbir koşulda dosya silmez; pin'li skill'e dokunmaz; testte arşiv döngüsü |
| 5.4 | **M4** `maintenance.ts`: `runMemoryMaintenance()` (epizodik→semantik konsolidasyon, decay) + `runSkillCuration()` — sleep-time compute; cron **dışarıda** (seam), iş mantığı içeride | `src/maintenance.ts` (yeni subpath ×3) | Faz 4 | İdempotent (üst üste iki koşu ikinci kez iş yapmaz); injected clock ile deterministik |
| 5.5 | `searchSessions(store, query)`: `SessionStore` üstünde BM25 lexical recall (kod hazır: `rag.ts` BM25); opsiyonel hibrit (embedder seam) | `src/durable.ts` veya `src/lessons.ts` yanına | v1.5.0 | `Chunk.index` kararlılık kuralı burada da; FTS5'e denk recall testi |

**Faz kapanışı:** `npm run check` → **npm publish v1.9.0**. CLI'ya `deuz skills` komutları eklenir (`@deuz-sdk/cli@0.2`).

---

## Faz 6 — v2.0.0 ⭐ "Doğrulanmış Üretim + Yapısal Güvenlik" (L) — EN İYİ OLACAĞIMIZ RELEASE

**Kaynak:** arastirma M7 + M9; MAV/PRM/AgentV-RL + CaMeL/lethal-trifecta literatürü.
**Hedef:** 2026 rubriğinin iki yeni K-ailesini SDK primitifi olarak ilk sunan olmak. Bu release ile üç senaryo hedefi (**chatbot ~%93, CLI ~%92, AGI-track ~%86**) doğrulanır ve **CLI 1.0 GA** aynı anda çıkar.
**Neden major:** Public surface additive kalsa da konumlama majör — "üreten SDK'dan doğrulayan ve zapt eden SDK'ya". Deprecated kalıntılar (varsa) burada temizlenir.
**Demo/Doğrulama:** AgentDojo-tarzı injection senaryosunda `ToolPolicy` untrusted-türevi argümanı exfiltration-yetenekli tool'a sokmaz; `bestOfN` matematik/kod evalinde tek-örneklemden ölçülebilir yüksek skor; benchmark ham çıktıları repo'da.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 6.1 | **M7a** `bestOfN(generate, verify, n)` + `selfConsistency(generate, n)`: broadcaster üstünde paralel N örnekleme, verifier seam'i (`Verifier = (candidate, ctx) => score`) | `src/inference/verify.ts` (yeni `./verify` subpath ×3) | Faz 1 (M12 eval) | Deterministik test: mock model N farklı aday + sabit verifier → seçim kararlı; maliyet `onUsage`'a N örneklem olarak düşer |
| 6.2 | **M7b** Çoklu-doğrulayıcı (MAV deseni: verifier sayısını ölçekle) + loop'a `verifyStep` kancası (`CommonCallOptions.verifyStep?` — adım-düzeyi PRM seam'i; reddedilen adım geri beslenir) | `verify.ts` + `loop-shared.ts` | 6.1 | `verifyStep` opt-in; reddedilen adım `is_error` tool_result gibi self-heal döngüsüne girer, loop'u kırmaz |
| 6.3 | **M9a** Provenance alanı: `Part`'lara opsiyonel `provenance?: 'user' | 'assistant' | 'tool-output' | 'untrusted'` (additive, `surface.test-d.ts` append-only); tool-result'tan dönen içerik default `untrusted` | `src/types/message.ts` + adapters | — | Tip kilidi append-only doğrulanır; eski mesajlar (alan yok) `user` sayılır — davranış değişmez |
| 6.4 | **M9b** Taint yayılımı + `ToolPolicy` motoru: "untrusted'dan türeyen argüman, exfiltration-yetenekli tool'a giremez" kuralı; policy ihlali onay akışına düşer (engelle→sor) | `src/security.ts` (yeni `./security` subpath ×3) + `loop-shared.ts` kancası | 6.3 | AgentDojo-tarzı yerel fixture setiyle test; **asla "provable security" iddiası yok** — sınırlar (text-to-text saldırılar kapsam dışı) dokümante |
| 6.5 | **M9c** Lethal-trifecta linter'ı: `analyzeToolSet(tools)` — *özel veri erişimi + untrusted içerik + dışa iletişim* üçü aynı anda açık mı? Statik analiz + uyarı | `src/security.ts` | 6.4 | Saf fonksiyon; CLI `deuz doctor` komutu bunu koşar |
| 6.6 | **CLI 1.0 GA**: policy + verify entegrasyonu (`deuz run --verify`, `deuz doctor`), kararlı komut yüzeyi, `npx` akışı cilalı | `packages/cli/` | 3.x, 6.4 | Semver taahhüdü başlar; README + docs sitesinde CLI sayfası |
| 6.7 | Benchmark + iddia: yerel GAIA2-tarzı senaryo seti + AgentDojo güvenlik seti + SkillsBench-tarzı skill eval — ham çıktılar `bench/` klasöründe, sayılar README + `docs/benchmark-ai-sdk.md` güncellemesinde | `bench/` (yeni) | 6.1–6.5 | Metodoloji `benchmark-ai-sdk.md` ile aynı; AI SDK'nın güncel sürümü yeniden doğrulanır (bugün `7.0.15`) |

**Faz kapanışı:** `npm run check` + benchmark koşuları → **npm publish v2.0.0** + `@deuz-sdk/cli@1.0.0`. Duyuru: "üreten değil, doğrulayan ve zapt eden SDK".

---

## Faz 7 — `@deuz-sdk/devtools` v0.1→1.0 "deuz DevTools" (GUI) (L)

**Kaynak:** rakip-analizi ("AI SDK DevTools'a asimetrik cevap: deterministik replay bizde") + web araştırması: local-first OTLP-ingest ajan debugger deseni 2026'da yerleşik (tracelet/tracebird/AgentLens/Beacon aynı kalıbı doğruluyor — OTLP ingest + yerel web UI, hesapsız, cloud'suz).
**Hedef:** `npx @deuz-sdk/devtools` → tarayıcıda yerel ajan debugger'ı. Bizim asimetrik farklarımız: (1) **checkpoint time-travel** — `SessionStore`'daki `AgentCheckpoint`'ler arasında gezinme (kimsede yok, durable altyapımızın ürünü), (2) **deterministik replay** — `./testing` fixture'ından koşuyu yeniden oynatma, (3) **yerleşik maliyet** — pricing tablosuyla USD dökümü, (4) Deuz UI wire'ını doğal konuşur.
**Demo/Doğrulama:** CLI'dan bir koşu → DevTools'ta canlı execution tree; süreç kes → checkpoint listesinden önceki adımın state'ine bak; "replay" düğmesi aynı koşuyu mock'tan yeniden oynatır; koşu başına USD.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 7.1 | Paket iskeleti: `packages/devtools` — Node CLI (`npx @deuz-sdk/devtools`) + Vite/React web UI; sıfır hesap, sıfır cloud; opsiyonel JSONL persist | `packages/devtools/` | Faz 3 (monorepo) | `npx` tek komutla açılır; core'a runtime bağımlılık yok (kendi paketi) |
| 7.2 | Ingest katmanı: (a) OTLP/HTTP alıcı (port 4318 konvansiyonu — Faz 1 `./otel` span'larını yer), (b) Deuz wire NDJSON/SSE import, (c) `SessionStore` adaptörü (JSONL dosyasını okur) | `packages/devtools/src/ingest/` | Faz 1 (OTel), v1.5.0 | Üç kaynaktan da aynı kanonik run modeline normalize (kanonik-hat felsefesi GUI'de de) |
| 7.3 | Execution tree + inspector: run listesi → `invoke/step/execute_tool` ağacı → prompt/completion/tool-args/token/maliyet/latency detayı | `packages/devtools/src/ui/` | 7.2 | 1000-span koşuda akıcı; canlı SSE güncellemesi |
| 7.4 | **Checkpoint time-travel**: adım kaydırıcısı — her `AgentCheckpoint`'te mesaj geçmişi + kümülatif usage + pending approvals görünümü; iki koşu diff'i | UI | 7.2 | Suspended koşuda pending approval görünür ve `resume` komut ipucu verilir |
| 7.5 | **Deterministik replay + playground**: fixture'dan koşuyu yeniden oynat; playground sekmesi `useChat` ile canlı deneme (BYO key, key'ler yalnız localStorage) | UI + `./testing` | Faz 1 (M12) | Replay ağ'sız çalışır; key'ler asla sunucu tarafına yazılmaz (redaction ilkesi GUI'de de) |
| 7.6 | Maliyet panosu: koşu/model/tool bazında USD, en pahalı prompt'lar, cache-hit oranı | UI + `./pricing` | 7.3 | Sayılar `priceUsage` ile birebir; over200k tier'ları doğru |

**Faz kapanışı:** `@deuz-sdk/devtools@0.1.0` → geri bildirimle 1.0. Docs sitesine "DevTools" bölümü + ekran görüntüleri.

---

## Faz 8 — v2.1.0 "Evrim + Modalite + Kanıt" (M–L)

**Kaynak:** arastirma M10; rakip-analizi Faz F + G.
**Hedef:** Öğrenme döngüsünü offline evrimle taçlandırmak; modalite tablosunda 🟡/❌ bırakmamak; iddiaları sayılarla sabitlemek.

### Görevler

| # | Görev | Konum | Bağımlılık | Kabul kriteri / doğrulama |
| --- | --- | --- | --- | --- |
| 8.1 | **M10** `./evolve` (Node subpath): koşu izlerinden GEPA-tarzı reflective prompt/tool-açıklaması/skill mutasyon önerileri; çıktı **insan-onaylı diff** (asla otomatik uygulanmaz) | `src/evolve-node.ts` | Faz 5 (M5) | Öneriler Faz 5 validation gate'inden geçmeden uygulanamaz; diff formatı `git apply` uyumlu |
| 8.2 | Speech seam: `./speech` — STT/TTS arayüzü + OpenAI + Deepgram/ElevenLabs'ten biri | `src/speech.ts` | — | Seam-first: edge-safe arayüz, provider impl'leri fetch üstünden; streaming STT ilk sürümde opsiyonel |
| 8.3 | Reranker impl: Cohere/Voyage/Jina'dan ikisi — mevcut `rerank` seam'ine takılır | `src/rag.ts` + provider dosyaları | — | `identityReranker` placeholder'ı kalkar; hybridRetrieve ile entegrasyon testi |
| 8.4 | Batch API: Anthropic/OpenAI %50 indirimli async batch (`submitBatch`/`pollBatch`) | `src/batch.ts` (yeni subpath) | — | Maliyet metering batch fiyatlarını tanır; poll injected clock'la |
| 8.5 | Benchmark yenileme + README/docs: bu plan + `benchmark-ai-sdk.md` + `rakip-analizi-2026.md` v2.1 durumuyla güncellenir; Vue/Svelte adapter'ları talep varsa | `docs/` | 6.7 | Her iddianın yanında ham koşu çıktısı linki |

**Faz kapanışı:** `npm run check` → **npm publish v2.1.0**. 2027 planlaması için yeni rakip analizi.

---

## Sürümleme ve Release Süreci

- **Semver disiplini:** Core 1.x boyunca tüm public-surface değişiklikleri **additive** (`test/surface.test-d.ts` append-only kuralı her fazda doğrulanır). v2.0.0 konumlama majörüdür; kırıcı değişiklik ancak deprecated temizliğiyle sınırlı tutulur.
- **Changesets akışı:** her faz = bir minor changeset (`npm run changeset` → `version` → `release`). CLI ve DevTools **bağımsız sürümlenir** (0.x → 1.0), core'a `peerDependencies` ile bağlanır.
- **Kalite kapısı (her release, istisnasız):** `npm run check` = format + edge-safety lint + tsc + testler + `test:types` + build + `publint --strict` + `attw`. Yeni subpath = **üçlü kilit** (package.json exports + tsup entry + edge.ts) — Faz 1'den itibaren her yeni modülün tanım gereği görev maddesi.
- **Monorepo sonrası (Faz 3+):** kök `npm run check` üç paketi de koşar; `@deuz-sdk/core` publish yolu ve npm provenance değişmeden kalır.
- **LLM'li her mekanizma** (Reflector/Curator/verifier/lesson-extractor/gate) **seam üstünden** çalışır — çekirdek saf, hepsi opt-in, maliyeti `onUsage`+pricing ile görünür.

## Test Stratejisi

- Golden-replay her yerde: yeni her adapter/quirk/mekanizma deterministik SSE fixture ile; gerçek ağ yok.
- Property-test iki kritik saf fonksiyonda: playbook `mergeDelta` (4.1) ve taint yayılımı (6.4).
- Faz 1'in `./testing` subpath'i çıktıktan sonra iç testler de onu tüketir (dogfooding); Faz 5 gate ve Faz 6 verifier eval'i aynı koşucuyu kullanır.
- CLI: PTY-tabanlı headless e2e (mock provider). DevTools: ingest→model normalizasyonu birim test; UI kritik akışları Playwright smoke.
- Redaction P0: her yeni yüzeyde (span attr, CLI log, DevTools persist, checkpoint serialize) anahtar-sızıntı regression testi zorunlu.

## Riskler ve Gotcha'lar

1. **Monorepo geçişi (Faz 3.1) en riskli tekil adım** — publish yolu, provenance, `files`, changesets, CI hepsi etkilenir. Tedbir: ayrı PR, `npm pack` çıktısı byte-diff ile eski yapıyla karşılaştırılır; geçiş öncesi 1.7.0 yayınlanmış olur (rollback noktası).
2. **Kapsam şişmesi** — 8 faz × çok görev. Tedbir: bağımlılık grafiği dışındaki her kalem bağımsız kesilebilir; her faz tek başına yayınlanabilir değer bırakır; faz içi görevler "kritik yol" ve "kesilebilir" diye işaretlenmeye uygun sıralandı (tablolarda üst sıralar kritik).
3. **LLM'li mekanizmaların maliyeti** — Reflector/Curator/verifier ekstra çağrı. Tedbir: hepsi opt-in; ACE'nin −%86.9 adaptasyon-gecikme bulgusu delta-merge'in ucuzluğunu destekler; maliyet DevTools panosunda görünür.
4. **Güvenlik iddiası hassas** — M9 asla "provable" diye pazarlanmaz; AgentDojo-tarzı setteki ölçüm + açık kapsam sınırlarıyla ("text-to-text saldırılar kapsam dışı") sunulur.
5. **Rubrik meşruiyeti** — "+20" bizim rubriğimizde. Tedbir: her kriterin yanında hakemli kaynak (ACE +10.6, SkillOpt +19–25, CaMeL %77, MAST κ=0.88); ham benchmark çıktıları repo'da; AI SDK sürümü her benchmark'ta yeniden doğrulanır.
6. **Ink performans tavanı** (32 FPS) — yoğun streaming'de CLI'da hissedilebilir. Tedbir: v1'de Ink (Node uyumu + olgunluk); OpenTUI (Bun) izlenir, TUI katmanı komut mantığından ayrı tutulur ki renderer değişimi lokal kalsın.
7. **AI SDK'nın kopyalama hızı** — playbook/lessons görece kopyalanabilir. Farkın çekirdeği yapısal olanlarda: validation-gated skill edit (determinizm ister), CaMeL-lite taint (kanonik hat ister), vendorsuz durable (seam ister), checkpoint time-travel GUI (SessionStore ister). Bunlar önceliklendirildi.
8. **`seq`/StreamBuffer bellek büyümesi** — uzun stream'lerde tampon sınırsız büyüyemez. Tedbir: `maxParts` + en-eski-düşer politikası 2.2'nin kabul kriterinde.
9. **`./testing` fixture taşıması (1.8)** — `test/fixtures/sse.ts` → `src/testing.ts` refactor'u tüm test import'larını kırar. Tedbir: önce `src/testing.ts` export eder, test'ler paralel import eder, sonra eski dosya silinir; tek PR'da yapma.
10. **Faz 6 benchmark erken, Faz 8 tekrar** — 6.7 ilk kanıt setini yayınlar, 8.5 tam yenileme yapar. Tedbir: `bench/` klasörü 6.7'de oluşturulur, 8.5 yalnızca genişletir (sil-yeniden-yazma değil).

## Plan İnceleme Notları (2026-07-06)

İnceleme sonrası plana işlenen düzeltmeler ve implementer uyarıları:

| # | Bulgu | Düzeltme |
| --- | --- | --- |
| 1 | Rubrik tabanı çelişkisi (~%62 vs ~%74) | "Rubrik notu" bölümü eklendi — 2026 vs legacy rubrik ayrımı |
| 2 | `PermissionPolicy` rakip-analizi Faz 4'te var, planda yoktu | Faz 2'ye görev 2.7 eklendi |
| 3 | CLI peer `^1.6` ama Faz 3, Faz 1–2 sonrası | `^1.7.0` olarak düzeltildi |
| 4 | Monorepo sonrası yol belirsizliği | Sıralama kuralı + `packages/core/src/` notu eklendi |
| 5 | HMAC onay Faz 0'da (1.5) — rakip D maddesi 5 | Faz 0 checklist'te zaten var; 1.5 kapanınca rakip D'nin yarısı tamamlanır |
| 6 | `bestOfN` G2 ile uyum | `verify.ts` fonksiyonları async dönebilir ama `streamChat` sync kuralı korunur — N-örnekleme buffered `generateText` veya lazy pump içinde |
| 7 | DevTools Faz 7, v2.0'dan sonra | Bilinçli: GUI kanıt vitrini; erken alpha Faz 3 monorepo sonrası paralel başlatılabilir ama GA v2.0+ |

**Kesilebilir kalemler** (zaman baskısında): 2.6 (useChat throttle), 8.2 (speech), 8.4 (batch), Vue/Svelte (8.5). **Asla kesme:** 1.8 (M12 testing), 5.2 (validation gate), 6.3–6.5 (M9 güvenlik), Faz 0 (1.5 durable).

## Doğrulama Turu (2026-07-07)

Plandaki iddiaların kod tabanına karşı ikinci doğrulaması (tümü komut/grep ile, `feat/plan-15-durable` @ `4d3c135` üzerinde):

| Kalem | Bugünkü durum | Kanıt | Plandaki yeri |
| --- | --- | --- | --- |
| `src/durable.ts` | ❌ Yok; testler kırmızı | `vitest run test/durable-*` → `Cannot find module '../src/durable'` (2 failed, 0 test); version `1.4.0`; exports'ta `./durable` yok; `agent-tool.ts:128` "wait for 1.5" stub'ı duruyor | Faz 0 (delege edildi) |
| Loop checkpoint kancası | ❌ Yok | `src/inference/` içinde checkpoint/sessionStore/resumeFrom grep'i: 0 eşleşme (yalnız 4 tip dosyasında var) | Faz 0 |
| Docs i18n build | ✅ Yeşil | `docs && npm run build` exit 0; `proxy.ts` hidden default-locale rewrite | Faz 0 ev ödevi (kapandı) |
| `./testing` (M12) | ❌ Yok | `src/testing.ts` yok; fixture'lar `test/fixtures/sse.ts`'te | 1.8 |
| OTel span emisyonu | ❌ Seam var, span yok | `tracer` yalnız `deps.ts`/`resolve-deps.ts` (noop); loop'larda 0 span | 1.6–1.7 |
| `breakerStore` kablosu (G11) | ❌ Store var, istek yolu okumuyor | `client.ts:29-38` per-client resolve ediyor; `core/`/`inference/` içinde get/set 0 | 1.3 (karar bekliyor) |
| `createClient` paritesi | ❌ 3/6 metod | `client.ts` yalnız `streamChat/generateText/generateObject`; `streamObject/embed/embedMany` ham export | 1.4 |
| M9 provenance/taint/ToolPolicy · M7 bestOfN/verifyStep | ❌ Yok | src'de 0 eşleşme | Faz 6 |

**Uyarı — yanıltıcı merge:** `origin/main`'deki "Merge pull request #1 from Deuz-AI/feat/plan-15-durable" **yalnız 24 docs dosyası** içerir (`src/` değişikliği sıfır); branch adına bakıp v1.5.0'ın merge edildiği sanılmamalı. Remote branch merge sonrası silindi; durable işi hâlâ hiçbir remote'ta yok.

## Rollback Planı

- Her faz additive ve opt-in → geri alma = yeni API'yi kullanmamak; hiçbir faz mevcut davranışı değiştirmez (tek istisna: Faz 3 monorepo — rollback'i git revert + eski kök yapı, bu yüzden ayrı PR + pack-diff şartı).
- npm'de yanlış yayın: `npm deprecate` + patch sürümle düzeltme (unpublish 72 saat kuralına güvenilmez).
- Surface kilidi: `surface.test-d.ts` append-only olduğundan yanlışlıkla kırıcı değişiklik CI'da yakalanır; kırıcı bir şey kaçarsa patch'te tip geri eklenir (runtime davranış additive olduğundan güvenli).

---

## Kapanış — hedefin doğrulanması

| Senaryo | Bugün (1.4/1.5) | Faz 2 sonrası | Faz 5 sonrası | **Faz 6 (v2.0.0) sonrası** | AI SDK 7 öngörüsü | Fark |
| --- | --- | --- | --- | --- | --- | --- |
| Chatbot | ~%62 | ~%75 | ~%84 | **~%93** | ~%72 | **+21** |
| CLI otonom ajan | ~%64–80 | ~%84 | ~%89 | **~%92** | ~%76 | **+16** |
| AGI-track (uzun-ufuk) | ~%48–55 | ~%62 | ~%78 | **~%86** | ~%64 | **+22** |

(2026 rubriği: `arastirma-yol-haritasi-2026.md` Faz 3 tablosunun faz-faz interpolasyonu; her satırın literatür dayanağı orada.)

v2.0.0 + CLI 1.0 + DevTools üçlüsü tamamlandığında konum cümlesi: **"Üreten değil — öğrenen, doğrulayan ve zapt eden SDK. Sıfır bağımlılık, her yerde, kanıtı repo'da."**
