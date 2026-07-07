import Link from 'next/link';
import {
  ArrowRight,
  Blocks,
  BrainCircuit,
  Cable,
  Globe,
  ShieldCheck,
  Waves,
  Workflow,
} from 'lucide-react';
import { i18n, isLocale, type Locale } from '@/lib/i18n';
import { localePath } from '@/lib/layout.shared';
import { gitConfig } from '@/lib/shared';

const copy = {
  en: {
    badge: 'v1.4 — sub-agents, compaction & budget stops',
    titleA: 'One canonical wire for',
    titleB: 'every AI provider',
    lead: 'Pure · Web-first · Multi-provider AI SDK for TypeScript',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini and Vertex AI behind one canonical streaming protocol. Zero runtime dependencies, deterministic by design — runs anywhere fetch runs.',
    ctaDocs: 'Get started',
    ctaChangelog: 'Changelog',
    worksWith: 'One API surface across',
    features: [
      {
        icon: Waves,
        title: 'Canonical delta stream',
        body: 'Every provider response is normalized to one typed StreamPart stream before your code sees it. No raw SSE ever leaks through.',
      },
      {
        icon: Workflow,
        title: 'Agentic tool loop',
        body: 'Parallel, self-healing tool execution with runaway guards, budget stops, approval gates and nested sub-agents.',
      },
      {
        icon: Globe,
        title: 'Edge-safe core',
        body: 'Web APIs only — no node:*, no Buffer, no ambient state. Node, Deno, Bun, Vercel Edge and Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Deterministic & testable',
        body: 'Clock, randomness, fetch and keys are injected through one Dependencies seam. Golden-replay tests, no real network.',
      },
      {
        icon: BrainCircuit,
        title: 'Memory, RAG & skills',
        body: 'mem0-style memory pipeline, hybrid BM25 + vector retrieval, and progressive SKILL.md disclosure — all edge-safe.',
      },
      {
        icon: Blocks,
        title: 'Structured output & UI wire',
        body: 'Schema-typed generateObject / streamObject, React hooks, and a versioned SSE wire you own end to end.',
      },
    ],
    codeTitle: 'Streaming in three lines',
    codeBody:
      'streamChat returns synchronously and never throws — the request starts lazily on first read. Swap the factory to change provider; nothing else moves.',
    footerDocs: 'Documentation',
    footerChangelog: 'Changelog',
  },
  de: {
    badge: 'v1.4 — Sub-Agenten, Kompaktierung & Budget-Stops',
    titleA: 'Ein kanonisches Protokoll für',
    titleB: 'jeden KI-Provider',
    lead: 'Pures · Web-first · Multi-Provider AI SDK für TypeScript',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini und Vertex AI hinter einem kanonischen Streaming-Protokoll. Keine Runtime-Abhängigkeiten, deterministisch by design — läuft überall, wo fetch läuft.',
    ctaDocs: 'Loslegen',
    ctaChangelog: 'Changelog',
    worksWith: 'Eine API-Oberfläche für',
    features: [
      {
        icon: Waves,
        title: 'Kanonischer Delta-Stream',
        body: 'Jede Provider-Antwort wird zu einem typisierten StreamPart-Stream normalisiert, bevor dein Code sie sieht. Rohe SSE-Bytes dringen nie durch.',
      },
      {
        icon: Workflow,
        title: 'Agentischer Tool-Loop',
        body: 'Parallele, selbstheilende Tool-Ausführung mit Runaway-Guards, Budget-Stops, Freigabe-Gates und verschachtelten Sub-Agenten.',
      },
      {
        icon: Globe,
        title: 'Edge-sicherer Kern',
        body: 'Nur Web-APIs — kein node:*, kein Buffer, kein Umgebungszustand. Node, Deno, Bun, Vercel Edge und Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Deterministisch & testbar',
        body: 'Clock, Zufall, fetch und Keys werden über eine Dependencies-Naht injiziert. Golden-Replay-Tests, kein echtes Netzwerk.',
      },
      {
        icon: BrainCircuit,
        title: 'Memory, RAG & Skills',
        body: 'mem0-artige Memory-Pipeline, hybrides BM25- + Vektor-Retrieval und progressive SKILL.md-Offenlegung — alles edge-sicher.',
      },
      {
        icon: Blocks,
        title: 'Strukturierte Ausgabe & UI-Wire',
        body: 'Schema-typisiertes generateObject / streamObject, React Hooks und ein versioniertes SSE-Protokoll, das dir gehört.',
      },
    ],
    codeTitle: 'Streaming in drei Zeilen',
    codeBody:
      'streamChat kehrt synchron zurück und wirft nie — der Request startet lazy beim ersten Lesen. Tausche die Factory, um den Provider zu wechseln; sonst ändert sich nichts.',
    footerDocs: 'Dokumentation',
    footerChangelog: 'Changelog',
  },
  tr: {
    badge: 'v1.4 — alt ajanlar, sıkıştırma ve bütçe durakları',
    titleA: 'Tüm yapay zeka sağlayıcıları için',
    titleB: 'tek kanonik protokol',
    lead: 'Saf · Web öncelikli · Çok sağlayıcılı TypeScript AI SDK',
    description:
      "Anthropic, OpenAI, xAI Grok, Google Gemini ve Vertex AI tek bir kanonik akış protokolünün arkasında. Sıfır çalışma zamanı bağımlılığı, tasarımı gereği deterministik — fetch'in çalıştığı her yerde çalışır.",
    ctaDocs: 'Başla',
    ctaChangelog: 'Sürüm notları',
    worksWith: 'Tek API yüzeyi:',
    features: [
      {
        icon: Waves,
        title: 'Kanonik delta akışı',
        body: 'Her sağlayıcı yanıtı, kodunuz görmeden önce tipli tek bir StreamPart akışına normalize edilir. Ham SSE baytları asla sızmaz.',
      },
      {
        icon: Workflow,
        title: 'Ajanik araç döngüsü',
        body: 'Paralel, kendi kendini onaran araç çalıştırma; taşma korumaları, bütçe durakları, onay kapıları ve iç içe alt ajanlarla.',
      },
      {
        icon: Globe,
        title: 'Edge-güvenli çekirdek',
        body: 'Yalnızca Web API’leri — node:* yok, Buffer yok, ortam durumu yok. Node, Deno, Bun, Vercel Edge ve Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Deterministik ve test edilebilir',
        body: 'Saat, rastgelelik, fetch ve anahtarlar tek bir Dependencies dikişinden enjekte edilir. Golden-replay testleri, gerçek ağ yok.',
      },
      {
        icon: BrainCircuit,
        title: 'Bellek, RAG ve beceriler',
        body: 'mem0 tarzı bellek hattı, hibrit BM25 + vektör arama ve aşamalı SKILL.md açığa çıkarma — hepsi edge-güvenli.',
      },
      {
        icon: Blocks,
        title: 'Yapılandırılmış çıktı ve UI protokolü',
        body: 'Şema tipli generateObject / streamObject, React hook’ları ve uçtan uca size ait, sürümlü bir SSE protokolü.',
      },
    ],
    codeTitle: 'Üç satırda akış',
    codeBody:
      'streamChat senkron döner ve asla fırlatmaz — istek ilk okumada tembelce başlar. Sağlayıcıyı değiştirmek için factory’yi değiştirin; başka hiçbir şey değişmez.',
    footerDocs: 'Dokümantasyon',
    footerChangelog: 'Sürüm notları',
  },
  fr: {
    badge: 'v1.4 — sous-agents, compactage & arrêts budgétaires',
    titleA: 'Un protocole canonique pour',
    titleB: 'chaque fournisseur d’IA',
    lead: 'SDK IA TypeScript pur · web-first · multi-fournisseur',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini et Vertex AI derrière un seul protocole de streaming canonique. Zéro dépendance runtime, déterministe par conception — fonctionne partout où fetch fonctionne.',
    ctaDocs: 'Commencer',
    ctaChangelog: 'Journal des modifications',
    worksWith: 'Une seule surface d’API pour',
    features: [
      {
        icon: Waves,
        title: 'Flux delta canonique',
        body: 'Chaque réponse de fournisseur est normalisée en un flux StreamPart typé avant que votre code ne la voie. Aucun SSE brut ne s’échappe jamais.',
      },
      {
        icon: Workflow,
        title: 'Boucle d’outils agentique',
        body: 'Exécution d’outils parallèle et auto-réparatrice avec garde-fous anti-emballement, arrêts budgétaires, portes d’approbation et sous-agents imbriqués.',
      },
      {
        icon: Globe,
        title: 'Cœur edge-safe',
        body: 'API Web uniquement — pas de node:*, pas de Buffer, pas d’état ambiant. Node, Deno, Bun, Vercel Edge et Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Déterministe & testable',
        body: 'Horloge, aléatoire, fetch et clés sont injectés via une seule couture Dependencies. Tests golden-replay, sans réseau réel.',
      },
      {
        icon: BrainCircuit,
        title: 'Mémoire, RAG & skills',
        body: 'Pipeline mémoire façon mem0, récupération hybride BM25 + vecteurs et divulgation progressive SKILL.md — le tout edge-safe.',
      },
      {
        icon: Blocks,
        title: 'Sortie structurée & wire UI',
        body: 'generateObject / streamObject typés par schéma, hooks React et un wire SSE versionné que vous possédez de bout en bout.',
      },
    ],
    codeTitle: 'Le streaming en trois lignes',
    codeBody:
      'streamChat retourne de façon synchrone et ne lève jamais d’exception — la requête démarre paresseusement à la première lecture. Changez la factory pour changer de fournisseur ; rien d’autre ne bouge.',
    footerDocs: 'Documentation',
    footerChangelog: 'Journal des modifications',
  },
  it: {
    badge: 'v1.4 — sub-agenti, compattazione e stop di budget',
    titleA: 'Un protocollo canonico per',
    titleB: 'ogni provider di IA',
    lead: 'SDK IA TypeScript puro · web-first · multi-provider',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini e Vertex AI dietro un unico protocollo di streaming canonico. Zero dipendenze runtime, deterministico by design — funziona ovunque funzioni fetch.',
    ctaDocs: 'Inizia',
    ctaChangelog: 'Changelog',
    worksWith: 'Un’unica superficie API per',
    features: [
      {
        icon: Waves,
        title: 'Stream delta canonico',
        body: 'Ogni risposta del provider viene normalizzata in un unico stream StreamPart tipizzato prima che il tuo codice la veda. Nessun SSE grezzo trapela mai.',
      },
      {
        icon: Workflow,
        title: 'Loop di strumenti agentico',
        body: 'Esecuzione parallela e auto-riparante degli strumenti con protezioni anti-runaway, stop di budget, gate di approvazione e sub-agenti annidati.',
      },
      {
        icon: Globe,
        title: 'Core edge-safe',
        body: 'Solo Web API — niente node:*, niente Buffer, nessuno stato ambientale. Node, Deno, Bun, Vercel Edge e Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Deterministico e testabile',
        body: 'Orologio, casualità, fetch e chiavi vengono iniettati attraverso un’unica giuntura Dependencies. Test golden-replay, nessuna rete reale.',
      },
      {
        icon: BrainCircuit,
        title: 'Memoria, RAG e skills',
        body: 'Pipeline di memoria in stile mem0, retrieval ibrido BM25 + vettoriale e disclosure progressiva SKILL.md — tutto edge-safe.',
      },
      {
        icon: Blocks,
        title: 'Output strutturato e wire UI',
        body: 'generateObject / streamObject tipizzati da schema, hook React e un wire SSE versionato che possiedi end-to-end.',
      },
    ],
    codeTitle: 'Streaming in tre righe',
    codeBody:
      'streamChat ritorna in modo sincrono e non lancia mai eccezioni — la richiesta parte pigramente alla prima lettura. Cambia la factory per cambiare provider; nient’altro si muove.',
    footerDocs: 'Documentazione',
    footerChangelog: 'Changelog',
  },
  es: {
    badge: 'v1.4 — subagentes, compactación y paradas de presupuesto',
    titleA: 'Un protocolo canónico para',
    titleB: 'cada proveedor de IA',
    lead: 'SDK de IA para TypeScript puro · web-first · multiproveedor',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini y Vertex AI detrás de un único protocolo de streaming canónico. Cero dependencias en tiempo de ejecución, determinista por diseño — funciona dondequiera que funcione fetch.',
    ctaDocs: 'Empezar',
    ctaChangelog: 'Registro de cambios',
    worksWith: 'Una sola superficie de API para',
    features: [
      {
        icon: Waves,
        title: 'Stream delta canónico',
        body: 'Cada respuesta del proveedor se normaliza a un stream StreamPart tipado antes de que tu código la vea. Nunca se filtra SSE crudo.',
      },
      {
        icon: Workflow,
        title: 'Bucle de herramientas agéntico',
        body: 'Ejecución de herramientas paralela y autorreparadora con protecciones anti-desbocamiento, paradas de presupuesto, puertas de aprobación y subagentes anidados.',
      },
      {
        icon: Globe,
        title: 'Núcleo edge-safe',
        body: 'Solo Web APIs — sin node:*, sin Buffer, sin estado ambiental. Node, Deno, Bun, Vercel Edge y Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Determinista y testeable',
        body: 'Reloj, aleatoriedad, fetch y claves se inyectan a través de una única costura Dependencies. Tests golden-replay, sin red real.',
      },
      {
        icon: BrainCircuit,
        title: 'Memoria, RAG y skills',
        body: 'Pipeline de memoria estilo mem0, recuperación híbrida BM25 + vectorial y divulgación progresiva SKILL.md — todo edge-safe.',
      },
      {
        icon: Blocks,
        title: 'Salida estructurada y wire de UI',
        body: 'generateObject / streamObject tipados por esquema, hooks de React y un wire SSE versionado que posees de extremo a extremo.',
      },
    ],
    codeTitle: 'Streaming en tres líneas',
    codeBody:
      'streamChat retorna de forma síncrona y nunca lanza excepciones — la petición arranca perezosamente en la primera lectura. Cambia la factory para cambiar de proveedor; nada más se mueve.',
    footerDocs: 'Documentación',
    footerChangelog: 'Registro de cambios',
  },
  ru: {
    badge: 'v1.4 — суб-агенты, компакция и бюджетные стопы',
    titleA: 'Один канонический протокол для',
    titleB: 'каждого ИИ-провайдера',
    lead: 'Чистый · web-first · мультипровайдерный TypeScript AI SDK',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini и Vertex AI за одним каноническим протоколом стриминга. Ноль runtime-зависимостей, детерминизм по дизайну — работает везде, где работает fetch.',
    ctaDocs: 'Начать',
    ctaChangelog: 'История изменений',
    worksWith: 'Единая поверхность API для',
    features: [
      {
        icon: Waves,
        title: 'Канонический дельта-поток',
        body: 'Каждый ответ провайдера нормализуется в типизированный поток StreamPart до того, как его увидит ваш код. Сырой SSE никогда не просачивается.',
      },
      {
        icon: Workflow,
        title: 'Агентный цикл инструментов',
        body: 'Параллельное, самовосстанавливающееся выполнение инструментов с защитой от зацикливания, бюджетными стопами, воротами одобрения и вложенными суб-агентами.',
      },
      {
        icon: Globe,
        title: 'Edge-безопасное ядро',
        body: 'Только Web API — без node:*, без Buffer, без внешнего состояния. Node, Deno, Bun, Vercel Edge и Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: 'Детерминированный и тестируемый',
        body: 'Часы, случайность, fetch и ключи внедряются через единый шов Dependencies. Golden-replay-тесты без реальной сети.',
      },
      {
        icon: BrainCircuit,
        title: 'Память, RAG и skills',
        body: 'Пайплайн памяти в стиле mem0, гибридный поиск BM25 + векторы и прогрессивное раскрытие SKILL.md — всё edge-safe.',
      },
      {
        icon: Blocks,
        title: 'Структурированный вывод и UI-протокол',
        body: 'Схемно-типизированные generateObject / streamObject, React-хуки и версионируемый SSE-протокол, которым вы владеете целиком.',
      },
    ],
    codeTitle: 'Стриминг в три строки',
    codeBody:
      'streamChat возвращается синхронно и никогда не бросает исключений — запрос лениво стартует при первом чтении. Поменяйте фабрику, чтобы сменить провайдера; больше ничего не меняется.',
    footerDocs: 'Документация',
    footerChangelog: 'История изменений',
  },
  ja: {
    badge: 'v1.4 — サブエージェント、コンパクション、予算ストップ',
    titleA: 'すべての AI プロバイダーを',
    titleB: 'ひとつの正規プロトコルで',
    lead: 'ピュア · ウェブファースト · マルチプロバイダー TypeScript AI SDK',
    description:
      'Anthropic、OpenAI、xAI Grok、Google Gemini、Vertex AI を単一の正規ストリーミングプロトコルの背後に統合。ランタイム依存ゼロ、設計から決定論的 — fetch が動くところならどこでも動きます。',
    ctaDocs: 'はじめる',
    ctaChangelog: '変更履歴',
    worksWith: '単一の API サーフェスで',
    features: [
      {
        icon: Waves,
        title: '正規デルタストリーム',
        body: 'すべてのプロバイダー応答は、コードが目にする前に型付き StreamPart ストリームへ正規化されます。生の SSE が漏れることはありません。',
      },
      {
        icon: Workflow,
        title: 'エージェント型ツールループ',
        body: '並列かつ自己修復的なツール実行。暴走ガード、予算ストップ、承認ゲート、ネストされたサブエージェントを備えています。',
      },
      {
        icon: Globe,
        title: 'エッジセーフなコア',
        body: 'Web API のみ — node:* なし、Buffer なし、環境状態なし。Node、Deno、Bun、Vercel Edge、Cloudflare Workers で動作。',
      },
      {
        icon: ShieldCheck,
        title: '決定論的でテスト可能',
        body: '時計・乱数・fetch・キーはすべて単一の Dependencies シームから注入。実ネットワークなしのゴールデンリプレイテスト。',
      },
      {
        icon: BrainCircuit,
        title: 'メモリ、RAG、スキル',
        body: 'mem0 スタイルのメモリパイプライン、BM25 + ベクトルのハイブリッド検索、SKILL.md の段階的開示 — すべてエッジセーフ。',
      },
      {
        icon: Blocks,
        title: '構造化出力と UI ワイヤ',
        body: 'スキーマ型付きの generateObject / streamObject、React フック、そしてエンドツーエンドで所有できるバージョン付き SSE ワイヤ。',
      },
    ],
    codeTitle: '3 行でストリーミング',
    codeBody:
      'streamChat は同期的に返り、決して例外を投げません — リクエストは最初の読み取り時に遅延開始します。ファクトリを差し替えるだけでプロバイダーを変更でき、他には何も変わりません。',
    footerDocs: 'ドキュメント',
    footerChangelog: '変更履歴',
  },
  ko: {
    badge: 'v1.4 — 서브 에이전트, 컴팩션, 예산 스톱',
    titleA: '모든 AI 프로바이더를 위한',
    titleB: '단 하나의 정규 프로토콜',
    lead: '순수 · 웹 우선 · 멀티 프로바이더 TypeScript AI SDK',
    description:
      'Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex AI를 하나의 정규 스트리밍 프로토콜 뒤에 통합합니다. 런타임 의존성 제로, 설계부터 결정론적 — fetch가 동작하는 곳이라면 어디서든 실행됩니다.',
    ctaDocs: '시작하기',
    ctaChangelog: '변경 이력',
    worksWith: '단일 API 표면:',
    features: [
      {
        icon: Waves,
        title: '정규 델타 스트림',
        body: '모든 프로바이더 응답은 코드가 보기 전에 타입이 지정된 StreamPart 스트림으로 정규화됩니다. 원시 SSE가 새어 나가는 일은 없습니다.',
      },
      {
        icon: Workflow,
        title: '에이전트형 도구 루프',
        body: '폭주 가드, 예산 스톱, 승인 게이트, 중첩 서브 에이전트를 갖춘 병렬·자가 복구 도구 실행.',
      },
      {
        icon: Globe,
        title: '엣지 안전 코어',
        body: 'Web API만 사용 — node:* 없음, Buffer 없음, 환경 상태 없음. Node, Deno, Bun, Vercel Edge, Cloudflare Workers.',
      },
      {
        icon: ShieldCheck,
        title: '결정론적이며 테스트 가능',
        body: '시계, 난수, fetch, 키가 모두 하나의 Dependencies 심을 통해 주입됩니다. 실제 네트워크 없는 골든 리플레이 테스트.',
      },
      {
        icon: BrainCircuit,
        title: '메모리, RAG, 스킬',
        body: 'mem0 스타일 메모리 파이프라인, BM25 + 벡터 하이브리드 검색, SKILL.md 점진적 공개 — 모두 엣지 안전.',
      },
      {
        icon: Blocks,
        title: '구조화된 출력과 UI 와이어',
        body: '스키마 타입의 generateObject / streamObject, React 훅, 그리고 끝까지 직접 소유하는 버전 관리 SSE 와이어.',
      },
    ],
    codeTitle: '세 줄로 스트리밍',
    codeBody:
      'streamChat은 동기적으로 반환되며 절대 예외를 던지지 않습니다 — 요청은 첫 읽기에서 지연 시작됩니다. 팩토리만 바꾸면 프로바이더가 바뀌고, 그 외에는 아무것도 달라지지 않습니다.',
    footerDocs: '문서',
    footerChangelog: '변경 이력',
  },
  zh: {
    badge: 'v1.4 — 子代理、上下文压缩与预算停止',
    titleA: '为每一个 AI 提供商',
    titleB: '提供同一条规范协议',
    lead: '纯净 · Web 优先 · 多提供商 TypeScript AI SDK',
    description:
      'Anthropic、OpenAI、xAI Grok、Google Gemini 和 Vertex AI 统一在同一条规范流式协议之后。零运行时依赖，从设计上保证确定性 — fetch 能运行的地方就能运行。',
    ctaDocs: '快速开始',
    ctaChangelog: '更新日志',
    worksWith: '同一套 API 表面覆盖',
    features: [
      {
        icon: Waves,
        title: '规范增量流',
        body: '每个提供商的响应在你的代码看到之前都会被规范化为带类型的 StreamPart 流。原始 SSE 字节永远不会泄漏。',
      },
      {
        icon: Workflow,
        title: '代理式工具循环',
        body: '并行、自愈的工具执行，内置失控防护、预算停止、审批门控和可嵌套的子代理。',
      },
      {
        icon: Globe,
        title: '边缘安全内核',
        body: '仅使用 Web API — 没有 node:*、没有 Buffer、没有环境状态。Node、Deno、Bun、Vercel Edge 和 Cloudflare Workers 均可运行。',
      },
      {
        icon: ShieldCheck,
        title: '确定性且可测试',
        body: '时钟、随机数、fetch 和密钥都通过唯一的 Dependencies 接缝注入。黄金回放测试，无需真实网络。',
      },
      {
        icon: BrainCircuit,
        title: '记忆、RAG 与技能',
        body: 'mem0 风格的记忆管线、BM25 + 向量混合检索，以及 SKILL.md 渐进式披露 — 全部边缘安全。',
      },
      {
        icon: Blocks,
        title: '结构化输出与 UI 协议',
        body: '模式类型化的 generateObject / streamObject、React 钩子，以及一条端到端由你掌控的带版本 SSE 协议。',
      },
    ],
    codeTitle: '三行代码实现流式输出',
    codeBody:
      'streamChat 同步返回且永不抛出异常 — 请求在首次读取时惰性启动。换一个 factory 即可切换提供商，其余一切保持不变。',
    footerDocs: '文档',
    footerChangelog: '更新日志',
  },
} satisfies Record<Locale, unknown>;

const providers = ['Anthropic', 'OpenAI', 'xAI Grok', 'Google Gemini', 'Vertex AI', 'Yunwu'];

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function HomePage(props: PageProps<'/[lang]'>) {
  const { lang } = await props.params;
  const locale: Locale = isLocale(lang) ? lang : i18n.defaultLanguage;
  const t = copy[locale];

  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(ellipse 80% 50% at 50% -10%, color-mix(in oklab, var(--color-fd-primary) 18%, transparent), transparent)',
          }}
        />
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pt-20 pb-16 text-center sm:pt-28">
          <Link
            href={localePath(locale, '/docs/changelog')}
            className="mb-6 inline-flex items-center gap-2 rounded-full border bg-fd-card px-3 py-1 text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            <span className="inline-block size-2 rounded-full bg-fd-primary" />
            {t.badge}
            <ArrowRight className="size-3.5" />
          </Link>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
            {t.titleA}{' '}
            <span className="bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 bg-clip-text text-transparent">
              {t.titleB}
            </span>
          </h1>
          <p className="mt-5 text-lg font-medium text-fd-foreground/90">{t.lead}</p>
          <p className="mt-3 max-w-2xl text-fd-muted-foreground text-pretty">{t.description}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={localePath(locale, '/docs')}
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              {t.ctaDocs}
              <ArrowRight className="size-4" />
            </Link>
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg border bg-fd-card px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
            >
              GitHub
            </a>
          </div>
          <code className="mt-8 rounded-lg border bg-fd-secondary px-4 py-2.5 font-mono text-sm text-fd-secondary-foreground">
            npm install @deuz-sdk/core
          </code>

          {/* Providers */}
          <p className="mt-14 text-xs font-medium uppercase tracking-widest text-fd-muted-foreground">
            {t.worksWith}
          </p>
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm font-medium text-fd-muted-foreground">
            {providers.map((name) => (
              <li key={name} className="flex items-center gap-2">
                <Cable className="size-3.5 opacity-60" aria-hidden="true" />
                {name}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-fd-card/40">
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-16 sm:grid-cols-2 lg:grid-cols-3">
          {t.features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border bg-fd-card p-5 shadow-sm transition-colors hover:border-fd-primary/40"
            >
              <feature.icon className="size-5 text-fd-primary" aria-hidden="true" />
              <h2 className="mt-3 font-semibold">{feature.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Code teaser */}
      <section className="border-t">
        <div className="mx-auto grid w-full max-w-5xl items-center gap-10 px-4 py-16 lg:grid-cols-[2fr_3fr]">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{t.codeTitle}</h2>
            <p className="mt-3 text-fd-muted-foreground">{t.codeBody}</p>
            <Link
              href={localePath(locale, '/docs/quickstart')}
              className="mt-5 inline-flex items-center gap-1.5 font-medium text-fd-primary hover:underline"
            >
              Quickstart
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <pre className="overflow-x-auto rounded-xl border bg-[#0d1220] p-5 text-sm leading-relaxed text-slate-200 shadow-md">
            <code>
              <span className="text-slate-500">{'// swap the factory to swap providers'}</span>
              {'\n'}
              <span className="text-sky-300">import</span>
              {' { streamChat } '}
              <span className="text-sky-300">from</span>{' '}
              <span className="text-emerald-300">'@deuz-sdk/core'</span>;{'\n'}
              <span className="text-sky-300">import</span>
              {' { createAnthropic } '}
              <span className="text-sky-300">from</span>{' '}
              <span className="text-emerald-300">'@deuz-sdk/core/anthropic'</span>;{'\n\n'}
              <span className="text-sky-300">const</span> anthropic ={' '}
              <span className="text-yellow-200">createAnthropic</span>
              {'({ apiKey });\n'}
              <span className="text-sky-300">const</span> res ={' '}
              <span className="text-yellow-200">streamChat</span>
              {'({\n  model: '}
              <span className="text-yellow-200">anthropic</span>
              {'('}
              <span className="text-emerald-300">'claude-opus-4-8'</span>
              {'),\n  messages: [{ role: '}
              <span className="text-emerald-300">'user'</span>
              {', content: '}
              <span className="text-emerald-300">'Hello!'</span>
              {' }],\n});\n\n'}
              <span className="text-sky-300">for await</span>
              {' ('}
              <span className="text-sky-300">const</span>
              {' chunk '}
              <span className="text-sky-300">of</span>
              {' res.textStream) {\n  process.stdout.'}
              <span className="text-yellow-200">write</span>
              {'(chunk);\n}'}
            </code>
          </pre>
        </div>
      </section>
    </main>
  );
}
