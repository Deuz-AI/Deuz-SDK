# Benchmark: `@deuz-sdk/core` v1.3.0 vs Vercel AI SDK 7

> Tarih: 2026-07-04 · Yöntem: kod tabanı taraması (32 test dosyası / 309 test, canlı çalıştırma ile teyit) + AI SDK 7 resmî docs/changelog web doğrulaması (`ai@7.0.14`, 2026-07-02).
> Hedef soru: **chatbot uygulamaları** ve **Codex/Claude Code tarzı CLI otonom ajanlar** için AI SDK'dan 1.5x–2x daha iyi bir SDK olmak — nerede öndeyiz, nerede açık var, açığı nasıl kapatıp geçeriz?

---

## Faz 1 — Keşif: deuz-sdk'nın mevcut durumu

### Mimari özet

- **Sıfır runtime bağımlılık**, ESM+CJS dual build, Node ≥ 22, `sideEffects: false`, 24 subpath export.
- **Edge-safe çekirdek lint ile zorlanıyor**: 17 node builtin + `Date.now`/`Math.random`/`crypto.randomUUID`/`console.*` yasak; her yan etki tek `Dependencies` seam'inden enjekte (9 bağımlılık: fetch, clock, logger, tracer, breakerStore, keyProvider, priceProvider, generateId, onUsage/onFinish).
- **Kanonik hat**: 4 wire adapter (`anthropic`, `chat_completions`, `responses`, `native`) → tek `StreamPart` delta akışı (11 üye, açık union) → orkestrasyon → tüketici + versiyonlu Deuz UI wire (`x-deuz-stream: v1`, 15 UI part).
- **G2 sözleşmesi**: `streamChat`/`streamObject` senkron döner, asla throw etmez; pump lazy başlar; broadcaster çoklu tüketiciyi kayıpsız besler.
- **Resilience**: pre-first-byte retry (default 2, full-jitter — jitter bile deterministik: `generateId`→FNV-1a), `Retry-After` saygısı, 429/529 ayrımı, 3 katmanlı timeout (TTFT 60s / total 300s, injected clock).
- **Tool loop**: paralel yürütme (cap 5), `MAX_SAME_TOOL_ERRORS=3` runaway koruması, Gemini stop-bug koruması, immutable history, her `tool_use`'a garanti `tool_result` (Anthropic 400 koruması), self-healing (`is_error` geri besleme).
- **Onay akışı (HITL)**: `needsApproval` + server modu (`approveToolCall`) + client modu (`pendingApprovals` → `approvalResponses` ile settle-on-resume, **deny-by-default**); reddedilenler runaway sayacına girmez.
- **Registry**: 17 alanlı yetenek matrisi + quirk bayrakları (`usagePerChunk`, `toolIndexAllZero`, `effortWire`, `samplingRestrictions`); bilinmeyen slug throw etmez, muhafazakâr default'a düşer.
- **Özellik modülleri**: memory (mem0 pipeline + markdown vault), RAG (magic-byte sniff, token-aware chunker'lar, BM25 + RRF hibrit), skills (SKILL.md + progressive disclosure), MCP (tools + resources + prompts + elicitation form/url + structuredContent), middleware, pricing (2026 fiyat tablosu → maliyet metering), image/Midjourney/Yunwu.
- **Kalite kapısı**: `npm run check` = format + edge-safety lint + tsc + 309 test + type-surface kilidi (`surface.test-d.ts`, append-only) + build + publint + attw.

### Güçlü yönler (rakibe karşı ayrışma)

1. **Determinizm ve test edilebilirlik** — saat/rastgelelik/HTTP dahil her şey enjekte; golden-replay testler gerçek ağ olmadan tüm adapter quirk'lerini kilitliyor. AI SDK'da ambient time/random var.
2. **Boyut/bağımlılık** — 0 runtime dep, ~2.0 MB tek paket; AI SDK tipik kurulumda ~11–12 MB + zorunlu `zod` peer, ESM-only (CJS yok).
3. **Kanıtlanmış edge-safety** — lint ile *garanti*; AI SDK edge'de çalışır ama saflık garantisi yok, `WorkflowAgent` edge'e hiç uymuyor.
4. **Quirk registry** — Gemini'nin `index=0` fragmanları, chunk-başı usage, stop-bug'ı; Anthropic 400 koruması; `effortWire` ayrımı — tek kaynaktan, test kilitli. AI SDK'da bu bilgi provider paketlerine dağılmış durumda.
5. **Maliyet görünürlüğü** — `pricing` + `priceProvider` + `onUsage` ile token→USD yerleşik; AI SDK çekirdeğinde yok (Gateway'e itilmiş).
6. **Onay akışı loop'un içinde** — AI SDK 7'de `toolApproval` subagent'larla **birlikte çalışmıyor** (dokümante kısıt); bizde approval + loop + settle tek gövdede.
7. **Prompt caching birinci sınıf** — `promptCaching: 'auto' | 'auto-1h'` top-level; KV-cache isabeti otonom ajanlarda 1 numaralı maliyet metriği. AI SDK'da manuel `providerOptions`.
8. **Yerleşik memory/RAG/skills** — AI SDK bunları "pattern" olarak dokümante eder, kod vermez.

### Zayıf yönler (grep ile doğrulanmış açıklar)

| Açık | Kanıt |
| --- | --- |
| **Telemetry fiilen yok** | `tracer` seam'i tanımlı ama `tracer.startSpan` kod tabanında **hiç çağrılmıyor** (tek hit: no-op default). OTel adapter'ı yok. |
| **Durable execution / checkpoint yok** | `checkpoint` grep = 0; loop state süreç-yerel, crash sonrası devam yok. |
| **Compaction / context yönetimi yok** | Özetleme, pruning, pencere yönetimi yok; `prepareStep` benzeri kanca da yok. |
| **Gerçek token sayımı yok** | `countTokens` yalnız RAG chunker seam'i (heuristik); pre-flight bütçe, token/maliyet tabanlı `stopWhen` yok (yerleşik stop koşulu sadece 2: `stepCountIs`, `hasToolCall`). |
| **Agent sınıfı / subagent yok** | Loop free-function; `prepareStep`/`activeTools`/agent-as-tool/handoff yok. |
| **Provider genişliği dar** | 6 sağlayıcı ailesi (~26 pinli chat satırı); AI SDK 24 birinci parti + ~30 community. Groq/Mistral/DeepSeek/Together/OpenRouter gibi OpenAI-uyumlular kayıtsız (adapter hazır, registry satırı yok). |
| **UI tek framework** | Sadece React (`useChat`/`useObject`); Vue/Svelte/Angular, resumable stream (sayfa yenilemede in-flight kaybolur), generative UI yok. |
| **Ses yok** | TTS/STT (`generateSpeech`/`transcribe`) yok. |
| **Rerank implementasyonu yok** | `identityReranker` placeholder (bilinçli erteleme — 1.3.0 kararı). |
| **MCP eksikleri** | OAuth (PKCE), sampling, roots yok. |
| **Küçük borçlar** | `breakerStore` oluşturuluyor ama istek yolunda **hiç okunmuyor** (G11 seam bağlanmamış); `createClient` `streamObject`/`embed`/`embedMany` sunmuyor; batch API yok; mid-stream resume yok (retry pre-first-byte). |

---

## Faz 2 — Vercel AI SDK 7 özellik seti (web'den doğrulandı, 2026-07-04)

Sürüm: **`ai@7.0.14`** (2026-07-02), `@ai-sdk/workflow@1.0.14`. AI SDK 7 GA.

- **Core**: `generateText`/`streamText`/`generateObject`/`streamObject` + image + embedding + **reranking** + **transcription** (7.0.14'te deneysel streaming STT) + **speech**.
- **Agent katmanı**: `ToolLoopAgent` (stopWhen, `prepareStep`, `activeTools`, `runtimeContext`/`toolsContext` typed context, lifecycle callback'ler, timeout `{totalMs, stepMs, chunkMs}`); **subagent** (agent-as-tool, hiyerarşik — ama `toolApproval` ile birlikte kullanılamıyor); `HarnessAgent` (Claude Code / Codex / Pi sarmalayıcı); `@ai-sdk/tui` terminal UI.
- **`WorkflowAgent` (durable)**: her tool çağrısı durable step, otomatik retry (default 3), `needsApproval` ile suspend→resume, restart'a dayanıklı. **Bedeli**: Vercel Workflow DevKit runtime'ı şart (`'use workflow'` direktifleri), yalnız `stream()`, context serileştirilebilir olmalı, edge/serverless-only ortama uymaz → **vendor bağı**.
- **Context yönetimi**: otomatik compaction **yok** — `prepareStep` içinde `pruneMessages` helper'ı ile manuel; OpenAI server-side compaction desteği hâlâ açık feature request (vercel/ai#12486).
- **Tool approval**: 4 durum + `experimental_toolApprovalSecret` (HMAC imzalı onay).
- **UI**: `useChat` (4 status, parts, 3 transport, `setMessages`, dosya ekleri, `experimental_throttle`), resumable stream (resumable-stream + Redis), generative UI/RSC (deneysel); React/Next, Vue/Nuxt, Svelte, Angular, Expo, TanStack Start.
- **Telemetry**: `@ai-sdk/otel` — GenAI semconv, `invoke_agent`/`chat`/`execute_tool` span hiyerarşisi, `enrichSpan`, DevTools.
- **Provider**: 24 birinci parti (ElevenLabs/Deepgram/AssemblyAI gibi ses sağlayıcıları dahil) + 2 OpenAI-compat + ~30 community ≈ 48+; `createProviderRegistry` string-lookup + Gateway.
- **Paket gerçekleri**: ESM-only (CJS düştü), `zod` zorunlu peer, tipik kurulum ~11–12 MB.

---

## Faz 3 — Özellik karşılaştırma tablosu

Durum: ✅ var · 🟡 kısmi · ❌ yok. Önem: **K**ritik / **O**rta / **D**üşük — senaryo başına ayrı.

### 3a. Çekirdek + güvenilirlik

| Özellik | deuz | AI SDK 7 | Chatbot | CLI ajan |
| --- | --- | --- | --- | --- |
| Streaming text/object + tool loop çekirdeği | ✅ | ✅ | K | K |
| Sync-dönüş, asla-throw-etmeyen stream sözleşmesi (G2) | ✅ | 🟡 (onError callback, sözleşme gevşek) | O | O |
| Retry (jitter, Retry-After, 429/529 ayrımı) | ✅ deterministik | 🟡 temel maxRetries | O | K |
| Katmanlı timeout (TTFT/total/step) | ✅ TTFT+total | ✅ total/step/chunk | O | K |
| Sıfır bağımlılık / bundle boyutu (2 MB vs ~12 MB) | ✅ | ❌ | O | O |
| Lint ile garantili edge-safety | ✅ | 🟡 | O | D |
| CJS + ESM dual | ✅ | ❌ ESM-only | D | O |
| Determinizm (clock/random/id enjeksiyonu) | ✅ | 🟡 | D | O |
| Circuit breaker | 🟡 seam var, **bağlı değil** | ❌ | D | D |
| Mid-stream resume / devralma | ❌ | 🟡 (UI resumable stream; model çağrısı değil) | O | D |
| Maliyet takibi (token→USD, fiyat tablosu) | ✅ | ❌ (Gateway'e itilmiş) | O | K |
| Prompt caching birinci sınıf kontrol | ✅ | 🟡 providerOptions ile manuel | O | **K** |

### 3b. Agent katmanı

| Özellik | deuz | AI SDK 7 | Chatbot | CLI ajan |
| --- | --- | --- | --- | --- |
| Tool onayı (HITL) — server + client + resume | ✅ deny-by-default settle | ✅ 4-durum + HMAC | O | K |
| Onay + subagent birlikte | ✅ (loop tek gövde) | ❌ (dokümante kısıt) | D | O |
| Runaway korumaları (same-tool-error, Gemini stop) | ✅ | 🟡 | D | O |
| Agent sınıfı / `prepareStep` / `activeTools` | ❌ | ✅ ToolLoopAgent | O | **K** |
| Subagent / agent-as-tool | ❌ | ✅ | D | **K** |
| Durable execution (crash→resume) | ❌ | ✅ WorkflowAgent (vendor-bağlı) | O | **K** |
| Context compaction / pruning | ❌ | 🟡 manuel (pruneMessages) | O | **K** |
| Token sayımı + bütçe stop koşulları | ❌ | 🟡 (usage var, budget stop yok) | D | **K** |
| Harness sarmalayıcı (Claude Code/Codex) | ❌ | ✅ HarnessAgent | D | D* |
| Terminal UI | ❌ | ✅ @ai-sdk/tui | D | O |

\* Kendi harness'ini sıfırdan yazan için HarnessAgent alakasız; hazır harness saranlar için kritik.

### 3c. Providers + modaliteler

| Özellik | deuz | AI SDK 7 | Chatbot | CLI ajan |
| --- | --- | --- | --- | --- |
| Frontier chat (Anthropic/OpenAI/Google/xAI) | ✅ quirk-kilitli | ✅ | K | K |
| Geniş provider yelpazesi (Groq/Mistral/DeepSeek/Bedrock/Azure…) | ❌ (~6 aile) | ✅ (24+~30) | O | O |
| Provider registry string-lookup / router | ❌ | ✅ | O | D |
| Yetenek/quirk matrisi tek kaynak | ✅ | 🟡 dağınık | D | O |
| Embeddings | ✅ 3 sağlayıcı | ✅ | O | O |
| Image gen | ✅ (+Midjourney async) | ✅ | O | D |
| Speech / Transcription | ❌ | ✅ (streaming STT dahil) | O | D |
| Reranking | 🟡 seam-only | ✅ | D | D |
| Batch API (50% indirimli async) | ❌ | ❌ | D | D |

### 3d. UI + ekosistem

| Özellik | deuz | AI SDK 7 | Chatbot | CLI ajan |
| --- | --- | --- | --- | --- |
| useChat/useObject (React) | ✅ approval-aware | ✅ daha zengin (transport, attachment, throttle) | **K** | D |
| Çoklu framework (Vue/Svelte/Angular/Expo) | ❌ | ✅ | O | D |
| Resumable UI stream (reload dayanımı) | ❌ | ✅ (Redis) | O | D |
| Generative UI / RSC | ❌ | 🟡 deneysel | D | D |
| OTel telemetry + DevTools | ❌ (boş seam) | ✅ GenAI semconv | O | **K** |
| MCP client | ✅ tools+resources+prompts+elicitation | ✅ +OAuth (prompts deneysel) | O | K |
| Yerleşik memory | ✅ mem0 + markdown vault | ❌ pattern-only | O | O |
| Yerleşik RAG (BM25+RRF hibrit) | ✅ | ❌ pattern-only | O | O |
| Skills (SKILL.md, progressive disclosure) | ✅ | ❌ | D | O |
| Middleware | ✅ 4 bundled | ✅ | O | O |

### 3e. Senaryo puanları

Ağırlık: K=3, O=2, D=1 · Puan: ✅=1, 🟡=0.5, ❌=0 · İlgili senaryonun önem sütunuyla ağırlıklı ortalama.

| Senaryo | deuz-sdk 1.3 | AI SDK 7 | Yorum |
| --- | --- | --- | --- |
| **(a) Chatbot app** | **%72** | **%85** | Çekirdek + hooks + onay akışı denk; farkı **framework genişliği, resumable stream, ses, provider yelpazesi, telemetry** açıyor. React+frontier-model stack'inde fark pratikte küçülüyor (~%78 vs %82). |
| **(b) CLI otonom ajan** | **%58** | **%78** | Zemin (retry/determinizm/caching/maliyet/quirk) bizde daha sağlam; ama **kritik ağırlıklı 5 kalem** (agent sınıfı, subagent, durable, compaction, token bütçesi + telemetry) sıfır puan alıyor. Bu 5 kalem kapanmadan CLI ajan senaryosunda geçemeyiz. |

Okuma: chatbot'ta "yakın ikinci", CLI ajanda "sağlam temelli ama üst katı eksik bina". İyi haber: eksik olan üst kat, mevcut değişmezlerimizin (immutable history, adım sınırları, deterministik seam'ler) üstüne **doğal oturuyor** — AI SDK'nın tersine vendor runtime'a ihtiyaç duymadan yapılabilir.

---

## Faz 4 — Gap analizi ve 2x planı

Sıralama = öncelik. Efor: S (≤2 gün), M (≤1 hafta), L (>1 hafta). Hepsi additive — `surface.test-d.ts` kilidi korunur.

### P1 — Durable agent runtime: `SessionStore` + checkpoint/resume (L)

- **Neden**: CLI ajan senaryosundaki en büyük tekil açık. AI SDK'nın cevabı `WorkflowAgent` vendor runtime'a bağlı; **runtime'sız, storage-seam'li durable** bizi doğrudan farklılaştırır (Supabase/SQLite/dosya — kullanıcı seçer).
- **Nereye**: `src/inference/checkpoint.ts` + `src/types/session.ts`; `tool-loop.ts`/`stream-tool-loop.ts` içine adım-sınırı kancası.
- **Avantaj**: "Durable ama vendorsuz" — Next.js+Supabase (Deuz platformu) ve CLI (dosya/SQLite) aynı seam'i kullanır.

### P2 — Context yönetimi: `countTokens` + bütçe stop'ları + katmanlı compaction (M)

- **Neden**: Uzun otonom koşularda context patlaması kaçınılmaz; AI SDK'da da otomatik çözüm yok (manuel pruneMessages) → burada **öne geçme** fırsatı, parite değil.
- **Nereye**: `src/core/tokens.ts` (heuristik + provider `count_tokens` köprüsü), `src/inference/stop.ts` (`totalTokensExceed`, `costExceeds`), `src/inference/compaction.ts` + loop kancası, yeni `compaction` StreamPart.
- **Avantaj**: Claude Code'un ~%92 eşikli katmanlı compaction'ının SDK'laştırılmış hali; kimsede yerleşik yok.

### P3 — Subagent + loop kontrol kancaları: `agentTool` + `prepareStep`/`activeTools` (M)

- **Neden**: CLI ajan mimarisinin temel deseni (orchestrator→worker). AI SDK'da subagent onay akışıyla birlikte çalışmıyor; bizde loop tek gövde olduğundan **approval+subagent birlikte** çalışır — dokümante edilebilir üstünlük.
- **Nereye**: `src/inference/agent-tool.ts` (`maxDepth` default 2, usage `agentPath` ile toplanır, `sub-agent-step` StreamPart); `CommonCallOptions.prepareStep?`/`activeTools?` → `loop-shared.ts`.
- **Avantaj**: Agent sınıfı zorunlu kılmadan (free-function felsefesi korunur) AI SDK'nın ToolLoopAgent yüzeyiyle parite + onay entegrasyonunda üstünlük.

### P4 — Provider genişliği: OpenAI-uyumlu aileler için registry satırları (S)

- **Neden**: En ucuz kapanan açık — `chat_completions` adapter'ı hazır; Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras, Fireworks için factory (`createGroq` vb. = baseURL + default header) + registry satırları yeter. Bilinmeyen-slug fallback'i zaten çalışıyor.
- **Nereye**: `src/providers-compat.ts` (tek dosya, çok factory) veya sağlayıcı başına küçük dosyalar + `core/registry.ts` satırları + pricing satırları.
- **Avantaj**: "6 aile" itirazını kapatır; quirk matrisi bu sağlayıcılarda da tek kaynak olur (ör. Groq'un usage davranışı).

### P5 — OTel telemetry: `./otel` subpath + span'ların pump'a bağlanması (M)

- **Neden**: `tracer` seam'i bugün **hiç çağrılmıyor** — önce çekirdek span'ları (`invoke`, `step`, `execute_tool`) pump/loop'a işle, sonra `createOtelTracer` adapter'ı ekle (GenAI semconv). Redaction değişmezi span attribute'larına da uygulanır.
- **Nereye**: `src/core/inference.ts` + `loop-shared.ts` (seam çağrıları, core'a bağımlılık eklemeden); `src/otel.ts` (opsiyonel peer `@opentelemetry/api`).
- **Avantaj**: Production ajan işletiminin önkoşulu; seam sayesinde vendor-lock'suz.

### P6 — Resumable UI stream (M)

- **Neden**: Chatbot senaryosunun en görünür açığı: sayfa yenilenince in-flight yanıt kaybolur. Wire zaten versiyonlu ve bizim — part'lara monoton `seq` ekle + `StreamBuffer` seam (Redis/Supabase/memory) + `Last-Event-ID` ile devam.
- **Nereye**: `src/ui.ts` (+`seq`), `src/ui-resume.ts`, `useChat`'e otomatik reconnect.
- **Avantaj**: AI SDK'nın Redis-bağımlı çözümüne karşı storage-agnostik seam.

### P7 — HMAC imzalı onaylar (S)

- **Neden**: `approvalId` alanı 1.3.0'da bilinçli olarak ayrı tutuldu (tasarım notu: "ileride imzalı onay"). WebCrypto HMAC ile client'tan dönen verdict'in sunucuda doğrulanması — AI SDK'nın `experimental_toolApprovalSecret`'ına parite, edge-safe.
- **Nereye**: `src/internal/approval-sign.ts` + `loop-shared.ts:settlePendingApprovals` doğrulama; opsiyonel `approvalSecret` seçeneği.

### P8 — Küçük borçlar paketi (S)

- `createClient`'a `streamObject`/`embed`/`embedMany` eklenmesi (additive).
- `breakerStore`'un istek yoluna gerçekten bağlanması ya da seam'in "reserved" olarak dokümante edilmesi (bugünkü hali yanıltıcı).
- `stop.ts`'e `durationExceeds(ms)` (injected clock ile).

### Bilinçli olarak yapılmayacaklar

- **Rerank sağlayıcısı** (Cohere vb.) — 1.3.0'da kullanıcı kararıyla düşürüldü; seam duruyor, isteyen takar.
- **Speech/STT** — iki hedef senaryoda da düşük önem; ses sağlayıcısı yelpazesi (ElevenLabs/Deepgram) apayrı bir bakım yükü. İzleme listesinde.
- **HarnessAgent muadili** — hedefimiz harness'i *saran* değil, harness'in *üzerine inşa edildiği* SDK olmak.
- **Vue/Svelte** — React + Deuz platformu önceliği; wire protokolü framework-bağımsız olduğundan sonradan eklemek ucuz.

### 2x iddiasının matematiği

P1–P5 sonrası CLI-ajan puanı **%58 → ~%88**'e çıkar (5 kritik kalem ✅/🟡→✅); AI SDK 7 aynı dönemde ~%78–80 bandında (durable'ı vendor-bağlı, compaction'ı manuel kaldıkça). Chatbot'ta P6 ile ~%80'e geliriz — framework genişliği hariç parite. Üstüne mevcut yapısal avantajlar (0 dep / 2 MB, CJS+ESM, deterministik test, quirk registry, maliyet takibi, cache kontrolü, approval+subagent birlikteliği) binince "CLI otonom ajan altyapısı için 1.5–2x daha iyi" iddiası savunulabilir hale gelir; chatbot'ta iddia "denk + daha hafif + daha ucuz işletim" olur.

---

## Faz 5 — İlk 3 öncelik: implementasyon taslakları

### P1 taslağı — `SessionStore` + checkpoint/resume

```ts
// src/types/session.ts (yeni, additive)
export interface AgentCheckpoint {
  version: 1;                    // şema evrimi için
  sessionId: string;
  step: number;                  // tamamlanan son adım
  messages: Message[];           // immutable history — zaten serileştirilebilir
  usage: Usage;                  // kümülatif
  pendingApprovals?: ToolApprovalRequest[];
  createdAt: number;             // deps.clock.now()
}

export interface SessionStore {
  save(checkpoint: AgentCheckpoint): Promise<void>;
  load(sessionId: string): Promise<AgentCheckpoint | undefined>;
  delete?(sessionId: string): Promise<void>;
}
```

- Kanca noktası: `tool-loop.ts` / `stream-tool-loop.ts`'te **adım sınırı** — tool sonuçları history'ye eklendikten sonra, bir sonraki model çağrısından önce `store.save(...)`. Adım-ortası durable'lık iddia edilmez (dürüst sınır: model çağrısı sırasında crash → o adım baştan).
- Opsiyonlar: `CommonCallOptions.session?: { id: string; store: SessionStore }`; `resumeFromCheckpoint(store, id, options)` free function — checkpoint'i yükler, `messages` + `approvalResponses` ile normal loop'u başlatır (mevcut settle-on-resume mekanizması **aynen** yeniden kullanılır; bu yüzden L değil M'ye yakın).
- Tool'lar zaten idempotent olmak zorunda değil → dokümantasyona "resume, tamamlanmamış adımın tool'larını yeniden çalıştırır" uyarısı + `toolCallId` deterministik kalır (dedupe kullanıcı seam'inde mümkün).
- Referans impl: `createInMemorySessionStore` (test + default); Deuz platformu için ayrı repo'da Supabase impl.
- Testler: crash-at-step-N simülasyonu (mockFetchSequence yarıda kes → resume → kaldığı body ile devam), approval-pending checkpoint round-trip, usage toplamının korunması.

### P2 taslağı — token bütçesi + katmanlı compaction

```ts
// src/inference/stop.ts — yeni stop koşulları (additive)
export function totalTokensExceed(n: number): StopCondition; // kümülatif usage.total
export function costExceeds(usd: number): StopCondition;     // deps.priceProvider şart

// src/inference/compaction.ts (yeni)
export interface CompactionPolicy {
  threshold?: number;            // contextWindow doluluk oranı, default 0.92
  layers?: CompactionLayer[];    // sırayla, yeterince yer açılınca durur
}
// Katmanlar (default sıra):
// 1. prune-tool-results  — eski tool_result gövdeleri → '[pruned]' (restorable: id kalır)
// 2. prune-reasoning     — eski adımların reasoning part'ları düşer
// 3. summarize           — en eski dilim tek assistant özet mesajına indirgenir
//                          (aynı model + deps ile bir generateText çağrısı)
```

- Tetikleme: loop'ta her adım öncesi `estimateTokens(messages)` (registry `contextWindow` satırıyla karşılaştır). Tokenizer yok → kalibre edilmiş heuristik (chars/3.6 + görsel sabitleri) + mümkünse provider `count_tokens` köprüsü (Anthropic ücretsiz endpoint) — ikisi de `deps` üstünden, edge-safe.
- Görünürlük: yeni `{ type: 'compaction', layer, tokensBefore, tokensAfter }` StreamPart (açık union — mevcut tüketiciler etkilenmez) + UI wire karşılığı.
- Değişmezler: compaction **yeni** history array'i üretir (immutability korunur); cache-kırılmasını sınırlamak için özetleme her zaman en eski dilimden yapılır (prefix stabil kalır → KV-cache avantajı korunur).
- Bütçe aşımı `finishReason`'ı DEĞİŞTİRMEZ (`FinishReason` type-lock'lu) → `providerMetadata.deuz.budgetExceeded: true` ile işaretlenir.
- Testler: eşik tetikleme, katman sırası, özet çağrısının fetch sayısı, prefix stabilitesi, budget stop'un `stopWhen` OR zincirine katılımı.

### P3 taslağı — `agentTool` + `prepareStep`/`activeTools`

```ts
// src/inference/agent-tool.ts (yeni)
export function agentTool(def: {
  description: string;
  model: LanguageModel;
  tools?: ToolSet;
  system?: string;
  maxSteps?: number;
  maxDepth?: number;             // default 2 — agentTool içinde agentTool sınırı
  needsApproval?: Tool['needsApproval'];  // subagent + approval BİRLİKTE çalışır
}): Tool<{ prompt: string }, string>;
```

- İmplementasyon: `execute` içinde `generateText` çağıran bir `Tool` fabrikası — **yeni runtime kavramı yok**, mevcut loop'un rekürsif kullanımı. Derinlik `ToolExecuteContext`'e eklenen `agentPath: string[]` ile takip edilir; `maxDepth` aşımı `is_error` sonucu (self-healing yoluna düşer).
- Usage toplama: subagent'ın kümülatif usage'ı parent'ın `onUsage`'ına `meta.agentPath` ile raporlanır; streaming'de `{ type: 'sub-agent-step', agentPath, ... }` part'ı (açık union).
- Loop kancaları: `CommonCallOptions.prepareStep?: (ctx: { step, messages, usage }) => { messages?; activeTools?; system? } | undefined` — `loop-shared.ts`'te model çağrısından hemen önce uygulanır; `activeTools` yalnız wire'a giden tool listesini filtreler (ToolSet değişmez). `prepareStep`'in yeni `messages` dönmesi P2 compaction'ın da kullanıcı-tanımlı kapısıdır (AI SDK ile kavramsal parite).
- Testler: 2-seviye orchestrator→worker senaryosu (deterministik mock model), maxDepth guard, approval'lı subagent (AI SDK'nın yapamadığı vaka — regresyon testi olarak altın değerinde), usage toplama, `activeTools` filtresinin body assert'i.

---

## Sonuç

- **Bugün**: chatbot'ta yakın ikinci (%72 vs %85), CLI otonom ajanda temel katmanda önde ama agent üst-katmanı eksik (%58 vs %78).
- **Yapısal avantajlar kalıcı**: 0 bağımlılık/2 MB, garantili edge-safety, deterministik test altyapısı, quirk registry, yerleşik maliyet+caching kontrolü, approval akışının loop'la bütünlüğü, memory/RAG/skills'in kod olarak var olması.
- **Yol**: P1–P3 (durable + compaction + subagent — kullanıcının 1.4 direktifiyle birebir örtüşüyor) + P4 (ucuz genişlik) + P5 (telemetry). Bu beşi kapandığında CLI-ajan senaryosunda AI SDK'nın önüne geçilir ve fark *vendor'suz durable + otomatik compaction* gibi AI SDK'nın yapısal olarak zor kopyalayacağı kalemlerden gelir.
