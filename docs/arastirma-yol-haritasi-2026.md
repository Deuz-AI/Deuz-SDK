# 2026 Araştırma Yol Haritası — "+20 / +15 / +18" Hedefinin Mantıkları

> Tarih: 2026-07-06 · Bu doküman `docs/rakip-analizi-2026.md`'nin devamıdır.
> Hedef: chatbot senaryosunda rakibe **+20 puan**, CLI otonom ajanda **+15**, uzun-ufuklu otonom genel ajan ("AGI-track") senaryosunda **en az +18** fark atmak.
> Yöntem: 2025–2026 akademik literatür taraması (NeurIPS 2025, ICLR 2026, ACL 2026, arXiv) → her makaleden **mekanizma** çıkar → Deuz SDK'nın seam mimarisine modül olarak eşle → yeni rubrikle puan doğrulaması.

---

## Faz 0 — Hedefin dürüst matematiği

Önce açık konuşalım: bugünkü rubrikte AI SDK 7 chatbot'ta ~%85. Tavan %100 iken "+20 çakmak" o rubrikte aritmetik olarak imkânsız. Fark şuradan açılır: **rubrik 2026'da değişiyor.** Aşağıdaki literatür, üç yeni kriter ailesinin ölçülebilir kazanç verdiğini kanıtlıyor — *öğrenen context/bellek*, *doğrulanmış üretim*, *yapısal güvenlik*. Bunlar 2026 sonunda "nice-to-have" değil, senaryo rubriklerinin K-ağırlıklı satırları olacak (kanıt: ICLR/NeurIPS ana kabulleri + AgentDojo/GAIA2/SkillsBench gibi benchmark'ların yükselişi). AI SDK'nın bu ailelerin **hiçbirinde** kütüphane-primitifi yok; WrongStack/Hermes'te ürün içi ama SDK olarak dışa verilmiyor. Fark buradan açılır ve yapısaldır: bu mekanizmaların hepsi bizim mevcut değişmezlerimize (deterministik seam'ler, immutable history, golden-replay test, edge-safe saf çekirdek) **doğal oturur**; AI SDK'da ise ya vendor runtime ister ya ambient yan-etki mimarisiyle çelişir.

---

## Faz 1 — Literatür taraması: altı damar, kanıtlarıyla

### 1a. Bellek: pasif depodan **evrilen belleğe**

| Makale | Mekanizma | Ölçülmüş kazanç |
| --- | --- | --- |
| **A-MEM** (NeurIPS 2025, arXiv:2502.12110) | Zettelkasten: her anı atomik not (bağlam + keyword + tag), yeni anı eskilerin **attribute'larını geriye dönük günceller** ("memory evolution"), dinamik link kurma | 6 foundation model üzerinde SOTA baseline'ları geçiyor (%35'e varan iyileşme) |
| **CraniMem** (arXiv:2603.15642) | **Attentional gating** (düşük-değer yazımlar bellek katmanına hiç girmez) + **bounded stores** + epizodik→semantik **konsolidasyon** (replay ile) | Sınırlı bellek bütçesinde uzun-ufuk tutarlılık; interference azalması |
| **Sleep-time compute** (Letta, 2025) | İkili ajan: primary konuşur, **sleep-time agent** boşta belleği yeniden örgütler (özetleme/temizlik konuşma sırasında değil arka planda) | Sorgu anı gecikme + token maliyeti düşer; bellek kalitesi sürekli artar |
| **Memory-R1** (2025–26) | Bellek yönetim *politikası* ~150 örnekten downstream reward ile **öğreniliyor** | El yazması bellek stratejilerinin sonunun sinyali |
| **HippoRAG** (2024, NeurIPS) | Hipokampal indeksleme: KG + kişiselleştirilmiş PageRank ile çok-adımlı hatırlama | Multi-hop recall'da dense retriever'ları geçer |

**Bize tercümesi:** mem0 pipeline'ımız (extract→reconcile→apply) zaten var ama **statik**. Eksik üç şey: (1) yazım kapısı (gating), (2) yeni anının eskiyi evriltmesi, (3) arka plan konsolidasyonu. Üçü de `MemoryStore` seam'inin üstüne additive eklenir; markdown vault'un `[[wikilinks]]`'i A-MEM'in link grafiğinin hazır taşıyıcısı.

### 1b. Context mühendisliği: özetleme değil, **playbook**

**ACE — Agentic Context Engineering** (ICLR 2026, arXiv:2510.04618): context'i tek metin bloğu olarak yeniden yazmak iki hastalık üretiyor — **brevity bias** (özet, alan bilgisini düşürür) ve **context collapse** (yinelemeli rewrite detayı eritir; makalede 18.282 token'ın bir rewrite'ta 122'ye çökmesi belgelenmiş). Çözüm: context = **yapılandırılmış bullet seti** (her biri: benzersiz id + helpful/harmful sayaçları + içerik). Üç rol — Generator (koşar), Reflector (dersleri çıkarır), Curator (delta üretir) — ve kritik numara: delta'lar **deterministik, LLM'siz bir merge** ile birleşir. Sonuç: ajanda **+10.6%**, finansta +8.6%, adaptasyon gecikmesinde **−86.9%**; AppWorld'de küçük açık modelle production-ajan liderine denklik. Ayrıca etiketli veri istemez — doğal yürütme geri-bildirimi yeter.

**Bize tercümesi:** bu bizim için biçilmiş kaftan — deterministik merge **saf fonksiyon** (edge-safe çekirdeğe girer), Reflector/Curator `generateObject` ile seam üstünden döner. Mevcut `compaction: 'auto'`'nun tamamlayıcısı: compaction *küçültür*, playbook *biriktirir*.

### 1c. Skill öğrenimi: ajan kendi prosedürünü yazar, **kapıyla**

| Makale | Mekanizma | Ölçülmüş kazanç |
| --- | --- | --- |
| **SkillOpt** (Microsoft, arXiv:2605.23904) | SKILL.md = frozen ajanın **eğitilebilir dış durumu**: scored rollout → optimizer modelin **sınırlı add/delete/replace edit'i** → edit yalnız **held-out validation'ı geçerse** kabul; textual learning-rate + rejected-edit buffer + slow update | GPT-5.5'te direct chat **+23.5 puan**, Codex loop'unda **+24.8**, Claude Code'da **+19.1**; 52/52 hücrede en iyi/berabere; skill artefaktı model/harness'ler arası **transfer ediyor** |
| **AutoSkill** (arXiv:2603.01145) | Skill'ler first-class artefakt: deneyimden çıkarım, sürümleme, birleştirme, dinamik enjeksiyon — yaşam döngüsü yönetimi | Model-agnostik lifelong learning |
| **ERL** (arXiv:2603.24639) | Ağır skill yerine hafif **heuristik havuzu**: tek denemelik trajectory'lerden ders çıkar, göreve göre top-k enjekte et | GAIA2'de ReAct'e **+7.8** (56.1%), ExpeL/AutoGuide'ı geçer |
| **GEPA** (ICLR 2026, arXiv:2507.19457) | Reflective prompt evolution — doğal dil yansıması ile prompt mutasyonu, **RL'den iyi** sonuç | Hermes'in offline self-evolution'ının akademik temeli |
| **Voyager / Reflexion** (2023, klasikler) | Kompozisyonel skill kütüphanesi; sözel geri-bildirimle kendini düzeltme | Alanın kurucu kanıtları |

**Bize tercümesi:** `skills` modülümüz bugün **read-only** (parse + progressive disclosure). Literatürün açık mesajı: değer, **write-path + doğrulama kapısında**. SkillOpt'un held-out gate'i bizim golden-replay altyapımızla birebir örtüşüyor — "skill edit'i ancak kayıtlı eval setinde puanı düşürmüyorsa kabul et" mantığını **deterministik** kurabilen tek SDK biziz.

### 1d. Çok-ajanlı sistemler: neden başarısız oluyorlar — **MAST**

**Why Do Multi-Agent LLM Systems Fail?** (NeurIPS 2025 D&B, arXiv:2503.13657): 7 framework, 1600+ trace, uzman anotasyon (κ=0.88) → **14 hata modu, 3 kategori**: (i) spesifikasyon/sistem tasarımı (rol ihlali, adım tekrarı, sonlanma kriteri yokluğu), (ii) ajanlar-arası hizasızlık (bilgi saklama, görev raydan çıkması, reasoning-action uyumsuzluğu), (iii) **görev doğrulama** (erken bitirme, eksik/yanlış doğrulama). Kritik bulgu: hataların çoğu LLM'den değil **orkestrasyon tasarımından**; yüzeysel prompt yaması yetmiyor (ChatDev'e müdahale +15.6% verdi ama hâlâ yetersiz).

**Bize tercümesi:** subagent'ımız (`agentTool`) var ama hata-modu **enstrümantasyonu** kimsede yok. 14 modun ~9'u loop seviyesinde **sinyalle tespit edilebilir** (adım tekrarı, sonlanma kriteri yok, erken bitiş, doğrulamasız bitiş…). "MAST-aware loop diagnostics" SDK-first bir özellik olur.

### 1e. Test-time compute: **doğrulanmış üretim**

- **Best-of-N + verifier** ana desen; **MAV** (arXiv:2502.20379) örnek sayısı yerine **doğrulayıcı sayısını** ölçekler (BoN-MAV > self-consistency ve reward-model, çoğu alanda).
- **PRM survey** (arXiv:2510.08049): süreç-düzeyi ödül (adım başına) outcome'dan üstün; generative verifier'lar (GenPRM) yükselişte.
- **AgentV-RL** (ACL 2026): doğrulama çok-turlu, **araç-kullanan** bir sürece dönüşüyor; 4B'lik agentic verifier SOTA ORM'leri **+25.2%** geçiyor.

**Bize tercümesi:** SDK'ların hepsi *üretir*, hiçbiri **doğrulatmaz**. `bestOfN`/`selfConsistency`/`verifyStep` primitifleri + MAST'ın "task verification" kategorisini kapatan loop kancası = ölçülebilir kalite kolu. Broadcaster'ımız zaten tek pump'ı çoklu tüketiciye dağıtıyor; N-örnekleme deterministik test edilebilir.

### 1f. Güvenlik: heuristikten **yapısal savunmaya**

- **CaMeL** (Google DeepMind, arXiv:2503.18813): kontrol akışı (güvenilir sorgu → planlayıcı LLM) ile veri akışını (güvenilmeyen içerik → karantina LLM) ayır; her değer **capability/provenance etiketi** taşır; tool çağrısı anında politika motoru taint'e bakarak engeller. AgentDojo'da görevlerin **%77'si kanıtlanabilir güvenlikle** çözülüyor (savunmasız sistem %84 — maliyet küçük).
- **Lethal trifecta** (Willison, 2025): *özel veri erişimi + güvenilmeyen içerik + dışa iletişim* üçü aynı ajanda birleşirse exfiltration kaçınılmaz; en az birini kes.
- 2026 durumu: CaMeL hâlâ araştırma-artefaktı; **hiçbir mainstream SDK'da yapısal savunma yok** (bizim `promptInjectionGuard` dahil — o heuristik).

**Bize tercümesi:** kanonik hattımız zaten her şeyi tek tipte akıtıyor — Part'lara **provenance** eklemek (hangi içerik güvenilmeyen kaynaktan türedi), tool-result'tan dönen taint'i yaymak ve `ToolPolicy` motoruyla "untrusted'dan türeyen argüman exfiltration-yetenekli tool'a giremez" kuralını çalıştırmak bizde **doğal**; ham byte proxy'leyen mimarilerde neredeyse imkânsız. Artı: `ToolSet`'i statik analiz eden bir **lethal-trifecta linter'ı** (üç yetenek aynı anda mı açık?) ucuz ve benzersiz.

---

## Faz 2 — Mekanizma kataloğu: eklenecek "mantıklar" (M1–M12)

Her kalem: dayanak → Deuz'a nereye → neden rakip hızla kopyalayamaz.

| # | Mekanizma | Dayanak | Nereye | Kopyalama bariyeri |
| --- | --- | --- | --- | --- |
| **M1** | **Playbook** — yapılandırılmış bullet'lı evrilen context; `{id, content, helpful, harmful}`; Reflector/Curator LLM'li, **merge deterministik saf fonksiyon**; `prepareStep` ile enjeksiyon | ACE (+10.6% ajan) | yeni `./playbook` subpath; `src/playbook.ts` | Deterministik merge bizim saf-çekirdek felsefemiz; AI SDK'da ambient yapı + otomatik compaction bile yok |
| **M2** | **Memory evolution** — yeni anı eskilerin attribute/link'lerini günceller; Zettelkasten grafiği | A-MEM | `memory.ts` reconcile'a `EVOLVE` operasyonu; markdown vault `[[wikilinks]]` hazır taşıyıcı | mem0-pipeline + vault kombinasyonu yalnız bizde |
| **M3** | **Write-gating + bounded memory** — salience skoru düşük yazım bellek katmanına girmez; store'lar sınırlı, taşınca konsolidasyon | CraniMem | `memory.ts` `remember()` önüne `gate` seam'i; `MemoryStore`'a bütçe | Küçük ama etkili; kimsede SDK-level yok |
| **M4** | **Sleep-time maintenance** — `runMemoryMaintenance()` / `runSkillCuration()`: boşta konsolidasyon, özet, arşivleme; cron dışarıda (seam), iş mantığı bizde | Letta sleep-time; Hermes Curator | yeni `src/maintenance.ts`; SessionStore + MemoryStore üstünde | Ürünlerde (Hermes) var, **SDK primitifi olarak yok** |
| **M5** | **Skills write-path + validation gate** — `createSkill`/`proposeSkillEdit` (sınırlı add/delete/replace) + **edit ancak kayıtlı eval setinde skoru düşürmüyorsa kabul** (golden-replay ile deterministik); rejected-edit buffer | SkillOpt (+19–25 puan), AutoSkill | `skills.ts` + `./testing` entegrasyonu | Held-out gate'i deterministik kurmak golden-replay altyapısı ister — bizde 4 yıllık test disiplini hazır |
| **M6** | **Lessons havuzu** — trajectory'den başarı/başarısızlık heuristikleri çıkar (`extractLessons`), göreve göre top-k enjekte (`recallLessons`) | ERL (+7.8 GAIA2) | `src/lessons.ts` (memory'nin hafif kardeşi) | Basit; farkı bizim maliyet/etiket takibiyle birleşmesi |
| **M7** | **Verified generation** — `bestOfN(generate, verify, n)`, `selfConsistency`, çoklu-doğrulayıcı (MAV), loop'a `verifyStep` kancası (adım-düzeyi PRM seam'i) | MAV, PRM survey, AgentV-RL | `src/inference/verify.ts`; `CommonCallOptions.verifyStep?` | Broadcaster + deterministik test bizde; SDK'larda üretim var doğrulama yok |
| **M8** | **MAST-aware loop diagnostics** — 14 hata modundan sinyalle tespit edilebilenler için dedektör + `mastReport` + yerleşik hafifletmeler (sonlanma-kriteri uyarısı, adım-tekrar dedektörü, doğrulamasız-bitiş bayrağı) | MAST (NeurIPS D&B) | `loop-shared.ts` enstrümantasyon + `providerMetadata.deuz.mast` | Akademik taksonominin SDK'laşmış hali — first-mover |
| **M9** | **Yapısal güvenlik (CaMeL-lite)** — Part/tool-result **provenance etiketi**, taint yayılımı, `ToolPolicy` motoru ("untrusted türevi arg, exfiltration-yetenekli tool'a giremez"), **lethal-trifecta linter'ı** (ToolSet statik analizi) | CaMeL (%77 kanıtlanabilir güvenlik), Willison | `types/` provenance alanı (additive) + `src/security.ts` | Kanonik hat şart — raw-proxy mimariler yapamaz; AI SDK'nın hattı bizim kadar tek-tip değil |
| **M10** | **Offline evolution harness** — koşu izlerinden prompt/tool-açıklaması/skill mutasyon önerileri (GEPA tarzı reflective), çıktı insan-onaylı diff | GEPA, Hermes self-evolution | `./evolve` (Node subpath) | Hermes'te ürün-içi; kütüphane olarak ilk |
| **M11** | **Self/user-model scope** — `memory` scope'una kalıcı kimlik/kullanıcı modeli katmanı (Hermes `user.md`/`SOUL.md` karşılığı) | Hermes, Honcho dialectic | `memory.ts` scope genişletme | Küçük; vault ile insan-okur formatta |
| **M12** | **Eval subpath** — golden-replay fixture'ları + deterministik mock model + senaryo koşucusu dışa açılır; GAIA2/SkillsBench/AgentDojo tarzı yerel eval kurma kılavuzu | SkillsBench, MemoryArena, AgentDojo | `./testing` | M5 ve M7'nin önkoşulu; determinizm rakipte yok |

**Bağımlılık grafiği:** M12 → M5/M7 (gate ve verifier eval ister) · M4 → M2/M3 (bakım, evrilen belleği yönetir) · M9 bağımsız · M8 bağımsız · M1 bağımsız ama `prepareStep`'i kullanır (v1.4'te hazır).

---

## Faz 3 — 2026 rubriği ve hedef doğrulaması

Rubrik güncellemesi (yeni K/O satırları — literatür gerekçeli): *yapısal güvenlik* (K — ajan üretimde 1 numaralı engel), *doğrulanmış üretim* (chatbot O, ajan K), *evrilen bellek/context* (O→K uzun-ufukta), *öğrenme döngüsü* (ajan K), *hata-modu tanılama* (O), mevcut satırlar korunur. Puanlama aynı: ✅=1, 🟡=0.5, ❌=0; K=3/O=2/D=1.

| Senaryo | Deuz bugün (1.4) | Deuz — rakip-analizi Faz A–D sonrası | Deuz — M1–M12 sonrası | AI SDK 7 (aynı rubrik, öngörülen doğal ilerlemesiyle) | Fark |
| --- | --- | --- | --- | --- | --- |
| **Chatbot** (güvenlik+doğrulama+bellek K/O eklendi) | ~%62 | ~%72 | **~%93** | ~%72 (güvenlik ❌, playbook ❌, memory pattern-only, verified-gen ❌, maliyet ❌) | **+21** ✅ |
| **CLI otonom ajan** (öğrenme+MAST+durable K eklendi) | ~%64 | ~%78 | **~%92** | ~%76 (durable vendor-bağlı 🟡, öğrenme ❌, MAST ❌, doğrulama 🟡) | **+16** ✅ |
| **AGI-track: uzun-ufuklu otonom genel ajan** (evrilen bellek K, self-evolution K, sleep-time O, güvenlik K) | ~%48 | ~%60 | **~%86** | ~%64 (agent sınıfı ✅, gerisi ❌/🟡) | **+22** ✅ (hedef ≥+18) |

Dürüstlük notları: (1) AI SDK'nın 2026 sonuna kendi ilerlemesini (+~%5) rubriklere işledim; buna rağmen yeni kriter ailelerinde kütüphane-primitifi çıkarmaları mimari değişiklik ister (ambient yapı, vendor-workflow bağı, raw-wire çeşitliliği). (2) Rubrik bizim — ama her satırın arkasında hakemli ölçüm var (ACE +10.6, SkillOpt +19–25, CaMeL %77-provable, MAV, MAST κ=0.88). (3) "AGI" burada pazarlama değil; "haftalar süren, öğrenen, denetlenebilir otonom koşu" senaryosunun kısaltması.

---

## Faz 4 — Uygulama sırası (sprint planı)

Önceki rapordaki Faz A–D (hijyen, OTel, durable, resumable UI) **önkoşul zemin** — değişmedi. Bu plan onun üstüne oturur:

### Sprint 1 (S–M): Zemin + ölçüm
- **M12** `./testing` subpath (fixture'lar + mock model + eval koşucusu) — her sonraki kalemin ölçüm altyapısı.
- **M8** MAST diagnostics v1: adım-tekrar, sonlanma-kriteri-yok, erken-bitiş dedektörleri + `mastReport`.
- **M6** Lessons havuzu (ERL basit; hızlı görünür kazanç).

### Sprint 2 (M): Context + bellek evrimi
- **M1** Playbook modülü (deterministik merge saf; Reflector/Curator `generateObject`).
- **M2** Memory EVOLVE operasyonu + vault link grafiği.
- **M3** Write-gating + bounded store.

### Sprint 3 (M): Öğrenme döngüsü
- **M5** Skills write-path + validation-gated edits (M12'ye dayanır).
- **M4** `maintenance.ts` (sleep-time konsolidasyon + skill curation).
- **M11** self/user-model scope.

### Sprint 4 (M–L): Doğrulama + güvenlik
- **M7** `bestOfN` / `selfConsistency` / `verifyStep`.
- **M9** Provenance + taint + `ToolPolicy` + lethal-trifecta linter (public type'lara additive alan — `surface.test-d.ts` append-only kuralına uygun).

### Sprint 5 (M): Evrim + kanıt
- **M10** `./evolve` offline harness (GEPA tarzı, insan-onaylı diff).
- Benchmark koşuları: GAIA2-tarzı yerel senaryo seti + AgentDojo güvenlik seti + SkillsBench-tarzı skill eval — sonuçlar README'ye, iddialar sayıyla.

Her sprint `npm run check` yeşil + type-surface kilidi + edge-safety lint ile kapanır; LLM'li her mekanizma (Reflector, Curator, verifier, lesson extractor) **seam üstünden** çalışır, çekirdek saf kalır.

---

## Faz 5 — Riskler ve karşı-tedbirler

1. **Rubrik meşruiyeti** — "+20" iddiası bizim rubrikte. Tedbir: her kriterin yanına hakemli kaynak; benchmark koşularının ham çıktısı repo'da; metodoloji `benchmark-ai-sdk.md` ile aynı.
2. **LLM'li mekanizmaların maliyeti** — Reflector/Curator/verifier ekstra çağrı demek. Tedbir: hepsi opt-in; maliyet `onUsage`+pricing ile görünür; ACE'nin −86.9% adaptasyon-gecikme bulgusu delta-merge'in ucuzluğunu destekliyor.
3. **Kapsam şişmesi** — 12 mekanizma çok. Tedbir: bağımlılık grafiği net; M12→M5/M7 dışında hepsi bağımsız kesilebilir; her sprint tek başına değer bırakır.
4. **AI SDK'nın kopyalaması** — playbook/lessons görece kopyalanabilir; **validation-gated skill edit** (determinizm ister), **CaMeL-lite taint** (kanonik hat ister) ve **vendorsuz durable** (seam mimarisi ister) yapısal olarak zor — farkın çekirdeği bu üçünde.
5. **Güvenlik iddiası hassastır** — "CaMeL-lite" asla "provable security" diye pazarlanmaz; AgentDojo'da ölçülür, sınırları (text-to-text saldırılar kapsam dışı) dokümante edilir.

---

## Sonuç — tek paragraf

2026 literatürü tek bir cümlede birleşiyor: **kazanan ajan, ağırlıkları değil bağlamı öğrenen; ürettiğini doğrulatan; ve güvenilmeyen içeriği yapısal olarak zapt eden ajan.** (ACE +10.6, SkillOpt +19–25, ERL +7.8, MAV/PRM, CaMeL %77-provable, MAST'ın tasarım-hatası bulgusu.) Bu üç yetenek bugün hiçbir TypeScript SDK'sında primitif olarak yok. Deuz'un deterministik seam mimarisi, golden-replay test disiplini ve kanonik akış hattı bu mekanizmaların **tam ön-gereksinimi** — yani literatürün işaret ettiği yol, bizim zaten döşediğimiz rayın devamı. M1–M12 + önceki raporun Faz A–D'si tamamlandığında: chatbot **+21**, CLI ajan **+16**, uzun-ufuk otonom **+22** — üç hedefin üçü de karşılanır.
