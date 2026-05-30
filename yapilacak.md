# Deuz SDK (`@deuz/core`) — Yapılacaklar

Kurum-içi, TypeScript, yayınlanabilir çok-sağlayıcılı AI SDK. Deuz SaaS'ını (Next.js 16 + Supabase) çalıştırır, sonra npm'de yayınlanır.
Detaylı mimari: ana repo'daki `plan.md` (Deuz uygulaması). Bu dosya = aksiyon listesi.

> **Revizyon notu (2026-05-30):** Bu liste 6 uzman incelemesi (rakip-landscape, provider-wire, paketleme/DX, agentic/tools/RAG, reliability/observability/security, context/tokenizer/multimodal) + sentez sonucunda yeniden yapılandırıldı. Faz 0–6 omurgası **korundu**; eksikler doğru fazlara dağıtıldı. Eski sürüm: `yapilacak.v1.bak.md`.

---

## Önceliklendirme & Notasyon

- **(P0)** = 1.0 public yüzeyini geriye dönük etkiler; **şimdi** kararlaştırılmazsa sonradan eklemek **breaking**. MVP'de en azından **imza/tip** olarak var olmalı.
- **(P1)** = MVP'yi tamamlayan, kademeli doldurulabilir.
- **(P2)** = değerli ama ertelenebilir.
- **`[seam]`** = sadece arayüz/imza + no-op veya in-memory default; gerçek implementasyon sonraki fazda.
- **`[impl]`** = gerçek implementasyon bu fazda.
- **ALTIN KURAL gereği:** state tutan her mekanizma (`breaker`, `rate-limit`, `price`, `memory`) bir **seam** arkasında; core saf kalır.

---

## Sabit Kararlar (değişmez)

- **Resmi API-first** — 4 sağlayıcı: **Anthropic** (`/v1/messages`), **OpenAI**, **xAI Grok** (OpenAI-uyumlu), **Google Gemini**.
- **DÜZELTME — "3 wire" değil 4 wire:** kanonik hat şu dört tel formatını normalize etmeli:
  1. **Anthropic Messages** (`content_block_*` SSE),
  2. **OpenAI Chat Completions** (`choices[].delta`),
  3. **OpenAI Responses API** (tipli `response.*` event'leri — GPT-5.x reasoning+tool için zorunlu),
  4. **Gemini OpenAI-compat** (`…/v1beta/openai/`). **xAI = OpenAI-CC ile aynı tel.**
- **Gemini compat = "sınırlı yetenek" surface.** Compat endpoint reasoning/`thoughtSignature`/explicit-cache/native-PDF/audio'yu **sessizce kaybeder** ve usage'ı her chunk'ta döndürür (spec ihlali). Bu yüzden **native `providers/google.ts` (generateContent) Faz 5'ten → Faz 3'e çekildi.** Router, model→surface seçimini capability matrisinden yapar.
- **Aggregator (Yunwu) + DeepSeek + Kimi → DEFERRED** (Faz 5, opsiyonel fallback route).
- **ALTIN KURAL:** `@deuz/core` Supabase/kredi'den **arınmış (pure)**. State/yan-etki **tek bir `Dependencies` nesnesi** ile enjekte edilir (aşağıda Faz 0).
- **Seam-first / API-lock:** 1.0 public yüzeyi (`createClient`, `streamChat`, `Message`/`Part`, `Usage`, `DeuzError`) **şimdi** kilitlenir; implementasyon kademeli dolar. Opsiyonel alanı (`signal`, `maxRetries`, cache token, reasoning part) sonradan eklemek 0.x'te bile breaking.
- **Web-first / edge-safe:** sadece global `fetch`, Web Streams, `TextDecoder/Encoder`, `WebCrypto`. **`node:*`/`Buffer`/`eventsource` yok** (stdio-MCP gibi Node-only parçalar ayrı export). Hedef: Node ≥18.17 + Deno + Bun + Vercel/Cloudflare Edge.
- **Strateji:** internal-first → publish-later.
- **Dağıtım:** npm paketi `@deuz/core`, `tsup` ile ESM+CJS+`.d.ts` dual build, `exports` alt-yolları.
- **Lisans: MIT** ("insanlar yararlansın" hedefiyle uyumlu; lisanssız npm = "tüm haklar saklı" = kimse kullanamaz).
- **Test modları:** (1) `pnpm link` günlük, (2) `npm install github:U-C4N/deuz-sdk` (prepare build), (3) `npm publish`.

---

## Mimari Omurga (kanonik hat) — değişmez akış

```
İstek:  kanonik Message[]/Part[]  →  adapter (4 wire'dan biri)  →  upstream fetch
Yanıt:  upstream SSE  →  robust parser  →  KANONİK DELTA STREAM
        (text_delta | reasoning_delta | tool_call_delta | citation | usage | finish)
        →  inference orkestrasyon (router/retry/tool-loop)
        →  (a) tüketiciye kanonik stream  (b) UI'a versiyonlu Deuz wire (toUIMessageStreamResponse)
```

> **KRİTİK karar:** `inference.ts` ham provider SSE'sini istemciye **proxy'lemez**. Her zaman kanonik delta stream'e çevrilir; yoksa abort, retry-after-first-byte, multi-wire birleştirme ve tipli UI event'leri **imkânsız** olur. Ham byte yalnız `debug` modunda.

---

## Faz 0 — İskele, Seam Standardı & Yayınlama Hijyeni
- [x] `deuz-sdk` klasörü oluştur
- [x] `yapilacak.md`
- [ ] **(P0)** `createClient` imzasına **tek `Dependencies` seam** koy: `{ fetch?, clock?, logger?, tracer?, breakerStore?, keyProvider?, priceProvider?, onUsage?, onFinish? }` — hepsi no-op/in-memory default. Core'da **`Date.now`/`Math.random`/`console`/`process.env` doğrudan kullanma** (deterministik test için enjekte et). Sonradan eklemek breaking; şimdi bedava.
- [ ] **(P0)** `package.json` — `name:@deuz/core`, `exports` alt-yolları **dört sağlayıcı + edge + react için**: `.`, `./anthropic`, `./openai`, `./xai`, `./google`, `./mcp`, `./mcp/stdio`, `./edge`, `./react`. Her alt-yolda **koşul sırası: `types` İLK → `import` → `require` (.cjs) → `default` SON** (yanlış sıra = "types not resolved").
- [ ] **(P0)** `package.json` hijyen: `"type":"module"`, `"sideEffects":false` (tree-shaking — kullanılmayan provider bundle'a girmesin), `engines.node>=18.17`, `files:["dist"]`, `prepare:"tsup"`, `publishConfig:{access:"public", provenance:true}` (scoped paket → access yoksa publish 403).
- [ ] **(P0)** `peerDependencies` ayrımı: `zod` (validation, opsiyonel peer), `@modelcontextprotocol/sdk` (opsiyonel peer). Çekirdek **fetch-based, sıfır-runtime-dependency** hedefi.
- [ ] **(P0)** Release-gate: `prepublishOnly` → `publint` + `@arethetypeswrong/cli` (attw) + `npm pack` smoke (pack → temiz dizin → hem `import` hem `require` çalışsın). Exports map'in tek kanıtı budur.
- [ ] `tsconfig.json` (`moduleResolution:"bundler"`, strict) + `tsup.config.ts` (format esm,cjs + dts + `target:"es2022"`).
- [ ] `src/index.ts` — public yüzey: `createClient`, `streamChat`, `generateText`, `generateObject`, tipler, `DeuzError` ailesi.
- [ ] `README.md` (kullanım + quickstart) + `.gitignore` + **`LICENSE` (MIT)** + `CHANGELOG.md`.
- [ ] `git init` → (hazır olunca) `gh repo create U-C4N/deuz-sdk --private` → push.
- [ ] `changesets` kurulumu (semver + changelog).
- [ ] **`[seam]`** "no `node:` import" lint kuralı + edge smoke (web-first sözünü Faz 0'da garanti et → Faz 6'da yeniden yazmaktan ucuz).

## Faz 1 — Chat çekirdeği (MVP)

### 1.A — Çekirdek Tipler & Hata Modeli (P0 — önce bu)
- [ ] **(P0)** `errors.ts` — tipli `DeuzError` hiyerarşisi: `APICallError(statusCode, isRetryable, retryAfterMs)`, `RateLimitError`, `OverloadedError` (**529, 429'dan AYRI**), `AuthenticationError`, `InvalidRequestError`, `ModelNotFoundError`, `ContextOverflowError`, `TimeoutError`, `AbortError`, `NoObjectGeneratedError`, `ToolExecutionError`. Her adapter ham hatayı (Anthropic `error.type` vs OpenAI `error.code` vs Gemini) bu taksonomiye **map** etsin. Retry/fallback/breaker kararlarının **hepsi** `isRetryable`/kind'e bağlı.
- [ ] **(P0)** `normalize.ts` — kanonik `Message`/`Part`: `text` / `image` / `tool_use` / `tool_result` **+ `reasoning`** `{ type:'reasoning', text, signature?, encrypted?, redacted? }`. Reasoning agentic döngüde **geri gönderilmek zorunda** (Anthropic `thinking`+`signature` yoksa 400; Gemini `thoughtSignature`; OpenAI Responses encrypted reasoning). Anthropic kuralı: reasoning **ilk sırada** serialize edilir.
- [ ] **(P0)** `registry.ts` — **model capabilities matrisi (tek kaynak):** her slug için `{ vision, tools, structuredOutput, reasoning, caching, nativePdf, audio, contextWindow, maxOutput, surface: 'chat_completions'|'responses'|'native', price? }`. "Kalan context", token gösterimi, structured-output guard, base64-vs-URL, slug pinleme **hepsi** buna bağlı. **Gemini-compat satırı:** `reasoning:false, nativePdf:false, explicitCache:false, usagePerChunk:true`.

### 1.B — Sağlayıcı Adapter'leri & Inference (P0)
- [ ] **(P0)** `providers/anthropic.ts` — `/v1/messages` adapter + SSE (`message_start`/`content_block_delta`/`message_delta`/`ping`). System prompt **ayrı top-level slot** (mesaj listesinden çıkar, yoksa 400). `max_tokens>21333` → streaming zorunlu.
- [ ] **(P0)** `providers/openai-compatible.ts` — OpenAI Chat Completions + xAI + Gemini-compat. **Uyarı:** reasoning modelleri `max_tokens` **reddeder** → `max_completion_tokens`; system → bazı modelde `developer` rolü.
- [ ] **(P1)** `providers/openai-responses.ts` — **Responses API** adapter (tipli `response.*` event'leri). GPT-5.x reasoning+tool burada; Chat Completions'ta yok. Delta stream'i **event-agnostik** tasarla ki en iyi OpenAI modelleri kaybolmasın.
- [ ] **(P0)** `inference.ts` — kanonik delta stream orkestrasyonu (SSE **proxy değil**). Upstream SSE → robust parser → kanonik delta (`text_delta`/`reasoning_delta`/`tool_call_delta`/`citation`/`usage`/`finish`).
- [ ] **(P0)** `stream-parser.ts` — robust SSE parser: `TextDecoder({stream:true})` (UTF-8 chunk-sınırı bölünmesi), `ping`/keep-alive atla, `[DONE]` opsiyonel, **stream-ortası hata** yakala.
- [ ] **(P1)** `generate-text.ts` — non-streaming buffered çağrı: tek `await` → `{ text, toolCalls, usage, finishReason, steps, response }`. Tool loop / memory extract / başlık üretimi stream istemez. `streamChat` ile **aynı** normalize/router/metering hattını paylaşsın.
- [ ] **(P1)** `generate-object.ts` — structured output: `schema: Zod|JSONSchema`, `mode:'auto'|'json'|'tool'`. Anthropic GA `output_config.format` + strict tool use; OpenAI/xAI/Gemini `response_format` `json_schema` `strict:true`; desteklemeyen model → tool-call fallback + **tek seferlik repair retry**. `streamObject` (partial object) → P2.

### 1.C — Dayanıklılık & İptal (P0)
- [ ] **(P0)** `resilience.ts` — `maxRetries` (default 2), **exponential backoff + full jitter** (base 500ms, cap 30s), `Retry-After` saygısı. Retriable whitelist: `408/409/429/5xx/529/ECONNRESET/ETIMEDOUT`. No-retry: `400/401/403/404/422/content_policy`. **529/overload AYRI backoff** (429 sayacından ayrı). Retry **yalnız pre-first-byte**.
- [ ] **(P0)** `AbortSignal` — tüm public API'lerde opsiyonel `{ signal? }`. Timeout `AbortController`'ı kullanıcı signal'i ile `AbortSignal.any` birleştir. `AbortError` → **no-retry/no-fallback**; iptalde o ana kadarki token'ları `onUsage`'a `reason:'aborted'` ile geçir.
- [ ] **(P0)** 3-katmanlı timeout: `connect` (~10s), `ttft` (~30–60s, ilk content delta yoksa abort), `total` (~300s) + idle.
- [ ] **(P0)** `router.ts` — `modelId→Route[]`. Pre-first-byte fallback **yalnız `429/503/529`'da** (4xx'te değil). `parseRateLimit(headers)` → cooldown'u besle. **`[seam]`** `BreakerStore` (default InMemory; app Redis/Supabase enjekte eder — serverless cold-start'ta naif in-memory sıfırlanır). **`[seam]`** mid-stream `streamFallback` ayrımı (connectFallback'ten ayrı).
- [ ] **`[seam]`** rate limiter (token-bucket RPM/TPM): imza Faz 1'de, **tam impl Faz 2** (gerçek 429-fırtınası görülünce).

### 1.D — Token, Usage & Metering (P0)
- [ ] **(P0)** `metering.ts` — **zengin kanonik Usage** (4 wire): `{ inputTokens, outputTokens, reasoningTokens, cachedReadTokens, cacheWriteTokens, cacheWrite1hTokens, audioTokens?, totalTokens }`. Wire haritası: Anthropic `cache_creation`/`cache_read_input_tokens`; OpenAI `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens`; Gemini `cachedContentTokenCount`/`thoughtsTokenCount`. **KRİTİK:** Gemini-compat usage'ı her chunk'ta döner → **sadece SON usage**'ı kullan. `onUsage`/`onFinish` hook + TTFT + tok/s.
- [ ] **`[seam]`** `pricing.ts` — opsiyonel `PriceProvider` (token kırılımı → $ ). Core token **kırılımını** verir; cost hesabını app'e bırakmak da kabul (altın kural). `cache_read ~%10`, `cache_write_1h 2x`, `reasoning` output olarak faturalanır.
- [ ] **(P1)** `tokens.ts` — **gönderim-öncesi (pre-flight) tahmin**: Anthropic resmi `count_tokens` (exact), OpenAI/xAI `o200k_base` (js-tiktoken, estimate), Gemini heuristik. **`accuracy: 'exact'|'estimate'|'heuristic'`** etiketi zorunlu → UI'da "≈ yaklaşık" rozeti. Image-cost (OpenAI tile 170+85, Anthropic alan/750, Gemini tile) — görüntü 0 sayılırsa context ciddi sapar.
- [ ] **(P1)** `budgeter.ts` — `kalan = contextWindow − reservedOutput − %5 margin`. **`[seam]`** aşım politikası: `error` (default) | `truncate-oldest` | `summarize` (app callback). `onUsage` ile tahmini kalibre et.

### 1.E — Prompt, Caching & Test (P0)
- [ ] **(P1)** `prompts.ts` — mod şablonları (chat/plan/full-autonomous) + **sağlayıcı-asimetrik caching**: Anthropic explicit breakpoint (max 4, ttl 5dk/1sa); OpenAI/xAI otomatik (parametre **yok** — gönderirsen no-op/hata); Gemini-compat explicit yok. "Caching strategy per provider". Kanonik **`effort` (none/low/medium/high)** → her adapter kendi birimine çevirir (Anthropic `budget_tokens`, OpenAI `reasoning_effort`, Gemini `thinking`).
- [ ] **(P0)** `test/` altyapısı — **vitest + coverage(v8) + MSW**. Her sağlayıcının gerçek SSE yanıtını **fixture'dan golden-replay** (text, reasoning, tool-fragment, paralel-tool, error-in-stream, ping). Deterministik `MockLanguageModel` ile tool-loop'u LLM'siz test et. `tsd`/`expectTypeOf` ile tip kontratını kilitle. → 4-wire quirk'leri (Gemini index=0, usage-her-chunk, finish=stop-yerine-tool) ancak böyle korunur.

> **Faz 1 kapsam-şişme uyarısı:** Yukarıdaki ~30 maddenin çoğu MVP'de **`[seam]`/tip/imza** olarak var olur; gerçek doldurma sonraki fazlara yayılır. Kural: **public yüzey/tip şimdi kilitlensin, implementasyon kademeli.**

## Faz 2 — Tool calling + Vision + MCP + UI Wire
- [ ] **(P0)** `tools/accumulator.ts` — **4-wire strateji-bazlı** streaming tool-call reducer: (a) OpenAI-CC `id/name` ilk delta'da, `arguments` index'e göre birikir (name geç gelebilir → defensive); (b) Gemini-compat hepsi `index=0` → sıra-bazlı yeni slot; (c) Responses `item_id/output_index`; (d) Anthropic `content_block` + `input_json_delta`. **Argümanları STRING biriktir, blok bitince BİR KEZ `JSON.parse`** (delta başına parse etme).
- [ ] **(P1)** `tools/loop.ts` — agentic döngü: `StepResult{ stepType, text, toolCalls, toolResults, finishReason, usage, response.messages }` + `onStepFinish` + `LoopResult{ steps, totalUsage, stopReason }`. **Paralel tool** (`Promise.all` + `maxConcurrency` default 5); **her `tool_use_id`'ye cevap şart** (eksik → Anthropic 400). `ToolExecutionError` → `is_error`'lı `tool_result` olarak modele geri besle (self-healing) + ardışık-aynı-araç hata sayacı → güvenli kes. **Immutable history** (loop yeni `messages` üretsin; mutate edersen React state + `cache_control` cache-hit çöker). `stopWhen`/`maxSteps` runaway guard. **Durdurma kararı `finish_reason`'a DEĞİL "biriken tool_call var mı"ya göre** (Gemini stop-bug guard).
- [ ] **(P1)** tool normalize — `tool_use`↔`tool_calls`, string↔object köprüsü; validation (zod/ajv) + **`needsApproval`** (human-in-the-loop, streaming ile entegre).
- [ ] **(P1)** Vision — `toImagePart` (Anthropic image block / OpenAI `image_url` / Gemini `inlineData`); base64-vs-URL kararı registry'den; boyut/format normalize + token-maliyeti.
- [ ] **(P1)** `ui-stream.ts` — `toUIMessageStreamResponse`: kanonik part'ları **versiyonlu** SSE event'lerine çevir (`text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `step-start`, `step-finish`, `tool-approval-request`, `source/citation`, `finish`, `error`). Deuz Next.js front-end bunu tüketir.
- [ ] **(P1)** `mcp.ts` — `@modelcontextprotocol/sdk` client. **Transport discriminated union** `{ type:'stdio'|'http'|'sse' }`; **stdio Node-only → `./mcp/stdio` ayrı export** (edge tree-shake). Tool/resource/prompt ayrımı + namespacing + dynamic discovery.

## Faz 3 — Skills + Memory + RAG + Native Gemini
- [ ] **(P1)** `providers/google.ts` — **native `generateContent`** (Faz 5'ten çekildi): reasoning-token, `thoughtSignature`, explicit caching, native PDF/audio, grounding. Router compat→native surface seçimi.
- [ ] **(P1)** `embed.ts` — `embed({model,value})` / `embedMany({model,values})` → `{ embeddings, usage }`. `dimensions`/`encoding_format`/batch limit + otomatik chunk-batch + paralellik sınırı. `metering.ts` embedding-usage'ı da normalize etsin; registry'de `embedding` bayrağı. **memory/rag bunu enjekte eder** (altın kural).
- [ ] **(P1)** `skills.ts` — `SKILL.md` manifest, progressive disclosure, **`[seam]`** `SkillMatcher`.
- [ ] **(P1)** `memory.ts` — **`[seam]`** extract/embed/store/retrieve; `writePolicy` (her tur/oturum sonu) + upsert/contradiction çözümü (yeni gerçek eskisini supersede) + TTL. **Consolidation/decay tam impl → ERTELE.**
- [ ] **(P1)** `rag.ts` — küçük=native document (~<8K token) / büyük=pgvector seam. **Dosya parse registry:** `pdf:unpdf`, `docx:mammoth` (**`.doc` → net hata mesajı**, mammoth yalnız `.docx`), `xlsx`/`csv`; **MIME magic-byte sniff** (uzantıya güvenme). Chunking (boyut/overlap/yapı-aware). **`[seam]`** `retrieve(topK)→rerank(topN)`; hibrit arama (BM25+RRF) ve reranking tam impl → **ERTELE**.

## Faz 4 — Görsel üretim + Throughput
- [ ] **(P1)** `image.ts` — Midjourney submit/poll/webhook + Grok sync.
- [ ] **(P1)** `tasks` tablosu (app tarafı) + `tasks-section.tsx` bağlama.
- [ ] **(P2)** Throughput dashboard (app tarafı).

## Faz 5 (opsiyonel) — Aggregator + İleri Yetenekler
- [ ] **(P2)** Proxy API fallback route (her `ModelRoute`'un 2. slotu). **Uyarı:** proxy base-url/model-id/uyumluluk drift'ine dikkat; aşırı hızlı kullanma.
- [ ] **(P2)** DeepSeek + Kimi catalog'a (strict quirk'leri ile).
- [ ] **(P2)** Batch API (Anthropic/OpenAI Batch) + Speech/transcription + auto-continuation (registry'de modality seam yeter).
- [ ] **(P2)** Rate limiter tam impl (token-bucket + adaptive header) — Faz 1.C seam'inin doldurulması.

## Faz 6 — Yayınlama
- [ ] API stabilize → **`1.0.0`** (public yüzey + tüm `[seam]` imzaları kilitli).
- [ ] **(P2)** `@deuz/react` alt-paketi (`useChat`/`useObject` minimal hook, transport seam) — UI wire Faz 2'de hazır; hook'lar publish civarı değer kazanır.
- [ ] `npm publish` (CI, git tag → GitHub Actions, `provenance:true`).
- [ ] Docs + örnekler + semver/deprecation politikası.

---

## Gözlemlenebilirlik & Güvenlik (yatay — seam-first)
- [ ] **(P0)** **Secret redaction** — tüm log/error/span path'lerinde `Authorization`/`x-api-key` + `sk-`/`sk-ant-`/`AIza`/`Bearer` maskele (son 4 hane). `DeuzError` default request body/header taşımasın. **"key asla loglanmaz" regression testi.**
- [ ] **`[seam]`** `middleware.ts` — `wrapModel(model, middleware[])` (`transformParams`/`wrapGenerate`/`wrapStream`). Hazır: `logging`, `simple-cache`, `redact-pii`, `prompt-injection-guard`. Cross-cutting ihtiyaçları core'a sokmadan takılabilir kılar.
- [ ] **`[seam]`** OpenTelemetry — `gen_ai.*` attribute isimleri + no-op `Tracer` seam sabit; gerçek span/Langfuse → **ERTELE** (MVP'de `onUsage` + redaction yeter).
- [ ] **`[seam]`** PII detector (Luhn/JWT/e-posta) → no-op default; yerleşik detector **ERTELE** (KVKK-PII app'in enjekte ettiği kurala).
- [ ] **`[seam]`** prompt-injection spotlighting + input boyut limitleri → no-op default.

---

## Açık Sorular
- [ ] Repo: **private** seçildi — henüz açılmadı (hazır olunca `gh`).
- [ ] **Lisans MIT önerildi** — onayla (yayın hedefiyle uyumlu).
- [ ] Model slug'ları launch öncesi pinlenecek **+ her slug'ın yetenekleri de `registry.ts`'e pinlensin** (yoksa guard'lar çalışmaz): `claude-opus-4-7` vs `-4-8`, `grok-4.2` vs GA, Gemini `3.x`.
- [ ] Cost hesabı: core token-**kırılımı** verir; `$` çevirimi `priceProvider` seam'inde app'te mi, SDK'de fiyat tablosu mu? (öneri: app'te)
- [ ] Gemini: compat MVP'de kalsın (hızlı chat), native Faz 3 — geçiş eşiği (hangi feature native'i tetikler?) netleşsin.
- [ ] Free trial / ekstra kredi paketi (`logic.md`'de tanımsız).

---

## Riskler (sentezden)
1. **Faz 1 kapsam şişmesi** (en büyük) → mitigasyon: seam/tip/imza şimdi, impl kademeli.
2. **Pure-core vs state** gerilimi → tek `Dependencies` seam standardı.
3. **Gemini compat'a aşırı güven** → capability matrisi + native Faz 3.
4. **4-wire kırılganlığı** → golden-replay fixture (Faz 1.E, P0).
5. **Responses API atlanması** → delta stream event-agnostik.
6. **Aşırı mühendislik** → OTel/PII/hibrit-arama/rate-limiter seam veya Faz 5.
7. **1.0 API kilidi** → imza-öncesi quick-win'leri Faz 0/1.A'da topla + `tsd` kilit.
