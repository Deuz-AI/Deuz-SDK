# Deuz SDK (`@deuz/core`) — Yapılacaklar

Kurum-içi, TypeScript, yayınlanabilir çok-sağlayıcılı AI SDK. Deuz SaaS'ını (Next.js 16 + Supabase) çalıştırır, sonra npm'de yayınlanır.
Detaylı mimari: ana repo'daki `plan.md` (Deuz uygulaması). Bu dosya = aksiyon listesi.

---

## Sabit Kararlar (değişmez)

- **Resmi API-first** — 4 sağlayıcı: **Anthropic** (`/v1/messages`), **OpenAI**, **xAI Grok** (OpenAI-uyumlu), **Google Gemini** (şimdilik OpenAI-compat endpoint `…/v1beta/openai/`).
- **Aggregator (Yunwu) + DeepSeek + Kimi → DEFERRED** (sonra, opsiyonel fallback route).
- **ALTIN KURAL:** `@deuz/core` Supabase/kredi'den **arınmış (pure)**. Kredi/Supabase callback ile enjekte edilir (`onUsage`/`onFinish`).
- **Strateji:** internal-first → publish-later (önce kendi app'imizde piş, sonra `npm publish`).
- **Dağıtım:** npm paketi `@deuz/core`, `tsup` ile ESM+CJS+`.d.ts` dual build, `exports` alt-yolları.
- **Test modları:** (1) `pnpm link` günlük, (2) `npm install github:U-C4N/deuz-sdk` (prepare build), (3) `npm publish`.

---

## Faz 0 — İskele & Repo
- [x] `deuz-sdk` klasörü oluştur
- [x] `yapilacak.md`
- [ ] `package.json` — `name:@deuz/core`, `exports` (`.`/`./anthropic`/`./google`), `files:["dist"]`, `prepare:"tsup"`, `peerDependencies`
- [ ] `tsconfig.json` + `tsup.config.ts` (format esm,cjs + dts)
- [ ] `src/index.ts` — public yüzey: `createClient`, `streamChat`, tipler
- [ ] `README.md` + `.gitignore` + `LICENSE`
- [ ] `git init` → (hazır olunca) `gh repo create U-C4N/deuz-sdk --private` → push
- [ ] `changesets` kurulumu (semver + changelog)

## Faz 1 — Chat çekirdeği (MVP)
- [ ] `normalize.ts` — kanonik `Message`/`Part` tipleri (text/image/tool_use/tool_result)
- [ ] `providers/anthropic.ts` — `/v1/messages` adapter + SSE
- [ ] `providers/openai-compatible.ts` — OpenAI + xAI + Gemini-compat (Chat Completions)
- [ ] `router.ts` — `modelId→Route[]` (resmi primary, pre-first-byte fallback, cooldown)
- [ ] `inference.ts` — `streamChat` orkestrasyonu (SSE proxy)
- [ ] `metering.ts` — usage normalize (3 wire) + TTFT/tok-s + `onUsage`/`onFinish` hook
- [ ] `prompts.ts` — mod şablonları (chat/plan/full-autonomous) + `cache_control` yerleşimi
- sağlam hata loglama
- hız gösterme cevap
- output ve input token sayılarını gösterme
- image vision detaylı araştırma sdk koyma
- dosya yükleme txt doc docx vs gibi rag 
- kalan context hesaplama ! 

## Faz 2 — Tool calling + Vision + MCP
- [ ] `tools/loop.ts` — agentic döngü, `stopWhen`, `maxSteps` (runaway guard)
- [ ] `tools/accumulator.ts` — index-bazlı streaming tool-call (Gemini `index=0` fix)
- [ ] tool normalize — `tool_use`↔`tool_calls`, string↔object köprüsü
- [ ] Vision — `toImagePart` (Anthropic image block / OpenAI image_url / Gemini inlineData)
- [ ] `mcp.ts` — `@modelcontextprotocol/sdk` client, Streamable HTTP, namespacing
- [ ] Validation (zod/ajv) + `needsApproval` (human-in-the-loop)

## Faz 3 — Skills + Memory + RAG
- [ ] `skills.ts` — SKILL.md manifest, progressive disclosure, `SkillMatcher` seam
- [ ] `memory.ts` — extract/embed/store/retrieve seam (app pgvector enjekte eder)
- [ ] `rag.ts` — küçük=native document, büyük=pgvector; parse seam (unpdf/mammoth)

## Faz 4 — Görsel üretim + Throughput
- [ ] `image.ts` — Midjourney submit/poll/webhook + Grok sync
- [ ] `tasks` tablosu (app tarafı) + `tasks-section.tsx` bağlama
- [ ] Throughput dashboard (app tarafı)

## Faz 5 (opsiyonel) — Aggregator + native Gemini
- [ ] Proxy API fallback route (her `ModelRoute`'un 2. slotu)
- [ ] DeepSeek + Kimi catalog'a (strict quirk'leri ile)
- [ ] `providers/google.ts` — native `generateContent` (reasoning-token + native caching)
- [ ] Proxyapi base url , model id , complaine mi nedir türü bu kadar hızlı kullanma proxy apileri

## Faz 6 — Yayınlama
- [ ] API stabilize → `1.0.0`
- [ ] `npm publish` (CI, git tag → GitHub Actions)
- [ ] Docs + örnekler + semver/deprecation politikası

---

## Açık Sorular
- [ ] Repo: **private** seçildi — henüz açılmadı (hazır olunca `gh`).
- [ ] Model slug'ları launch öncesi pinlenecek (plan.md §7 "slug drift": `claude-opus-4-7` vs `-4-8`, `grok-4.2` vs GA, Gemini `3.x`).
- [ ] Free trial / ekstra kredi paketi (logic.md'de tanımsız).
