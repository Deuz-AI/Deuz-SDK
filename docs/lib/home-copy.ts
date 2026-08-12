import type { Locale } from './i18n';

export type HomeFeatureKey =
  | 'stream'
  | 'agents'
  | 'stores'
  | 'mcp'
  | 'edge'
  | 'media';

export type HomeCopy = {
  badge: string;
  titleA: string;
  titleB: string;
  lead: string;
  description: string;
  ctaDocs: string;
  ctaWhatsNew: string;
  worksWith: string;
  providersMore: string;
  stats: { value: string; label: string }[];
  features: Record<HomeFeatureKey, { title: string; body: string }>;
  codeTitle: string;
  codeBody: string;
  languagesLabel: string;
  footerDocs: string;
  footerChangelog: string;
  footerWhatsNew: string;
};

export const homeCopy: Record<Locale, HomeCopy> = {
  en: {
    badge: 'v2.0.0 — Persistent stores, guardrails, handoffs & zero-config MCP',
    titleA: 'One canonical wire for',
    titleB: 'every AI provider',
    lead: 'Pure · Web-first · Multi-provider AI SDK for TypeScript',
    description:
      '29 providers behind one StreamPart delta stream. Zero runtime dependencies — SQLite, Redis and Postgres packs, guardrails and handoffs in the loop, MCP that connects itself. Runs anywhere fetch runs.',
    ctaDocs: 'Get started',
    ctaWhatsNew: 'What is new in 2.0',
    worksWith: 'One API surface across',
    providersMore: '+ 21 more, including Ollama and LM Studio',
    stats: [
      { value: '29', label: 'provider ids' },
      { value: '53', label: 'subpaths' },
      { value: '3', label: 'database packs' },
      { value: '1.9 → 2.0', label: 'mostly additive' },
    ],
    features: {
      stream: {
        title: 'Canonical delta stream',
        body: 'Every provider response is normalized to one typed StreamPart stream before your code sees it. No raw SSE ever leaks through.',
      },
      agents: {
        title: 'Agentic loop, now with policy',
        body: 'Parallel self-healing tools, nested sub-agents, plus 2.0 guardrails (pass / block / rewrite) and handoff() to transfer the whole run.',
      },
      stores: {
        title: 'Point persistence at a database',
        body: 'SQLite, Redis and Postgres packs behind memory, chat, session and run seams. FTS5 + pgvector when you want them — zero deps when you do not.',
      },
      mcp: {
        title: 'Zero-config MCP',
        body: 'Name servers on the call; the loop connects, namespaces, hot-refreshes and closes them. OAuth 2.0, sampling, roots and ping-verified reconnect.',
      },
      edge: {
        title: 'Edge-safe core',
        body: 'Web APIs only — no node:*, no Buffer, no ambient state. Node, Deno, Bun, Vercel Edge and Cloudflare Workers.',
      },
      media: {
        title: 'Speech, transcription, video',
        body: 'generateSpeech, transcribe and generateVideo as their own model kinds — OpenAI, ElevenLabs, Deepgram, and any OpenAI-Videos relay.',
      },
    },
    codeTitle: 'Streaming in three lines',
    codeBody:
      'streamChat returns synchronously and never throws — the request starts lazily on first read. Swap the factory to change provider; nothing else moves.',
    languagesLabel: 'Documentation UI',
    footerDocs: 'Documentation',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'What is new in 2.0',
  },
  de: {
    badge: 'v2.0.0 — Persistente Stores, Guardrails, Handoffs & Zero-Config-MCP',
    titleA: 'Ein kanonisches Protokoll für',
    titleB: 'jeden KI-Provider',
    lead: 'Pures · Web-first · Multi-Provider AI SDK für TypeScript',
    description:
      '29 Provider hinter einem StreamPart-Delta-Stream. Keine Runtime-Abhängigkeiten — SQLite-, Redis- und Postgres-Packs, Guardrails und Handoffs im Loop, MCP das sich selbst verbindet. Läuft überall, wo fetch läuft.',
    ctaDocs: 'Loslegen',
    ctaWhatsNew: 'Neu in 2.0',
    worksWith: 'Eine API-Oberfläche für',
    providersMore: '+ 21 weitere, inkl. Ollama und LM Studio',
    stats: [
      { value: '29', label: 'Provider-IDs' },
      { value: '53', label: 'Subpfade' },
      { value: '3', label: 'Datenbank-Packs' },
      { value: '1.9 → 2.0', label: 'größtenteils additiv' },
    ],
    features: {
      stream: {
        title: 'Kanonischer Delta-Stream',
        body: 'Jede Provider-Antwort wird zu einem typisierten StreamPart-Stream normalisiert, bevor dein Code sie sieht. Rohe SSE-Bytes dringen nie durch.',
      },
      agents: {
        title: 'Agentischer Loop, jetzt mit Policy',
        body: 'Parallele, selbstheilende Tools, verschachtelte Sub-Agenten, plus Guardrails (pass / block / rewrite) und handoff() für den ganzen Run.',
      },
      stores: {
        title: 'Persistenz auf eine Datenbank zeigen',
        body: 'SQLite-, Redis- und Postgres-Packs hinter Memory-, Chat-, Session- und Run-Nähten. FTS5 + pgvector wenn du sie willst — null Deps wenn nicht.',
      },
      mcp: {
        title: 'Zero-Config-MCP',
        body: 'Server am Call benennen; der Loop verbindet, namespaced, aktualisiert und schließt sie. OAuth 2.0, Sampling, Roots und ping-verifizierter Reconnect.',
      },
      edge: {
        title: 'Edge-sicherer Kern',
        body: 'Nur Web-APIs — kein node:*, kein Buffer, kein Umgebungszustand. Node, Deno, Bun, Vercel Edge und Cloudflare Workers.',
      },
      media: {
        title: 'Sprache, Transkription, Video',
        body: 'generateSpeech, transcribe und generateVideo als eigene Modellarten — OpenAI, ElevenLabs, Deepgram und jeder OpenAI-Videos-Relay.',
      },
    },
    codeTitle: 'Streaming in drei Zeilen',
    codeBody:
      'streamChat kehrt synchron zurück und wirft nie — der Request startet lazy beim ersten Lesen. Tausche die Factory, um den Provider zu wechseln; sonst ändert sich nichts.',
    languagesLabel: 'Dokumentations-UI',
    footerDocs: 'Dokumentation',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'Neu in 2.0',
  },
  tr: {
    badge: 'v2.0.0 — Kalıcı store’lar, guardrail’ler, handoff ve sıfır yapılandırmalı MCP',
    titleA: 'Tüm yapay zeka sağlayıcıları için',
    titleB: 'tek kanonik protokol',
    lead: 'Saf · Web öncelikli · Çok sağlayıcılı TypeScript AI SDK',
    description:
      '29 sağlayıcı, tek bir StreamPart delta akışının arkasında. Sıfır çalışma zamanı bağımlılığı — SQLite, Redis ve Postgres paketleri, döngüde guardrail ve handoff, kendini bağlayan MCP. fetch’in çalıştığı her yerde çalışır.',
    ctaDocs: 'Başla',
    ctaWhatsNew: '2.0’da neler yeni',
    worksWith: 'Tek API yüzeyi:',
    providersMore: '+ 21 tane daha, Ollama ve LM Studio dahil',
    stats: [
      { value: '29', label: 'sağlayıcı kimliği' },
      { value: '53', label: 'alt yol' },
      { value: '3', label: 'veritabanı paketi' },
      { value: '1.9 → 2.0', label: 'çoğunlukla eklemeli' },
    ],
    features: {
      stream: {
        title: 'Kanonik delta akışı',
        body: 'Her sağlayıcı yanıtı, kodunuz görmeden önce tipli tek bir StreamPart akışına normalize edilir. Ham SSE baytları asla sızmaz.',
      },
      agents: {
        title: 'Ajanik döngü, artık politikayla',
        body: 'Paralel, kendi kendini onaran araçlar, iç içe alt ajanlar; 2.0’da pass / block / rewrite guardrail’leri ve tüm koşuyu devreden handoff().',
      },
      stores: {
        title: 'Kalıcılığı bir veritabanına bağla',
        body: 'Bellek, sohbet, oturum ve koşu dikişlerinin arkasında SQLite, Redis ve Postgres. İstersen FTS5 + pgvector — istemezsen sıfır bağımlılık.',
      },
      mcp: {
        title: 'Sıfır yapılandırmalı MCP',
        body: 'Çağrıda sunucuları adlandırın; döngü bağlar, ad alanına alır, yeniler ve kapatır. OAuth 2.0, sampling, roots ve ping doğrulamalı yeniden bağlanma.',
      },
      edge: {
        title: 'Edge-güvenli çekirdek',
        body: 'Yalnızca Web API’leri — node:* yok, Buffer yok, ortam durumu yok. Node, Deno, Bun, Vercel Edge ve Cloudflare Workers.',
      },
      media: {
        title: 'Konuşma, transkripsiyon, video',
        body: 'generateSpeech, transcribe ve generateVideo ayrı model türleri — OpenAI, ElevenLabs, Deepgram ve her OpenAI-Videos rölesi.',
      },
    },
    codeTitle: 'Üç satırda akış',
    codeBody:
      'streamChat senkron döner ve asla fırlatmaz — istek ilk okumada tembelce başlar. Sağlayıcıyı değiştirmek için factory’yi değiştirin; başka hiçbir şey değişmez.',
    languagesLabel: 'Dokümantasyon arayüzü',
    footerDocs: 'Dokümantasyon',
    footerChangelog: 'Sürüm notları',
    footerWhatsNew: '2.0’da neler yeni',
  },
  fr: {
    badge: 'v2.0.0 — Stores persistants, guardrails, handoffs et MCP zéro-config',
    titleA: 'Un protocole canonique pour',
    titleB: 'chaque fournisseur d’IA',
    lead: 'SDK IA TypeScript pur · web-first · multi-fournisseur',
    description:
      '29 fournisseurs derrière un seul flux delta StreamPart. Zéro dépendance runtime — packs SQLite, Redis et Postgres, guardrails et handoffs dans la boucle, MCP qui se connecte tout seul. Fonctionne partout où fetch fonctionne.',
    ctaDocs: 'Commencer',
    ctaWhatsNew: 'Nouveautés de la 2.0',
    worksWith: 'Une seule surface d’API pour',
    providersMore: '+ 21 autres, dont Ollama et LM Studio',
    stats: [
      { value: '29', label: 'ids de fournisseur' },
      { value: '53', label: 'sous-chemins' },
      { value: '3', label: 'packs base de données' },
      { value: '1.9 → 2.0', label: 'surtout additif' },
    ],
    features: {
      stream: {
        title: 'Flux delta canonique',
        body: 'Chaque réponse de fournisseur est normalisée en un flux StreamPart typé avant que votre code ne la voie. Aucun SSE brut ne s’échappe jamais.',
      },
      agents: {
        title: 'Boucle agentique, désormais avec politique',
        body: 'Outils parallèles auto-réparateurs, sous-agents imbriqués, plus les guardrails 2.0 (pass / block / rewrite) et handoff() pour transférer tout le run.',
      },
      stores: {
        title: 'Pointer la persistance vers une base',
        body: 'Packs SQLite, Redis et Postgres derrière les coutures mémoire, chat, session et run. FTS5 + pgvector si vous les voulez — zéro dep sinon.',
      },
      mcp: {
        title: 'MCP zéro-config',
        body: 'Nommez les serveurs sur l’appel ; la boucle les connecte, les namespace, les rafraîchit et les ferme. OAuth 2.0, sampling, roots et reconnect vérifié par ping.',
      },
      edge: {
        title: 'Cœur edge-safe',
        body: 'API Web uniquement — pas de node:*, pas de Buffer, pas d’état ambiant. Node, Deno, Bun, Vercel Edge et Cloudflare Workers.',
      },
      media: {
        title: 'Parole, transcription, vidéo',
        body: 'generateSpeech, transcribe et generateVideo comme kinds de modèle distincts — OpenAI, ElevenLabs, Deepgram, et tout relais OpenAI-Videos.',
      },
    },
    codeTitle: 'Le streaming en trois lignes',
    codeBody:
      'streamChat retourne de façon synchrone et ne lève jamais d’exception — la requête démarre paresseusement à la première lecture. Changez la factory pour changer de fournisseur ; rien d’autre ne bouge.',
    languagesLabel: 'Interface de la documentation',
    footerDocs: 'Documentation',
    footerChangelog: 'Journal des modifications',
    footerWhatsNew: 'Nouveautés de la 2.0',
  },
  it: {
    badge: 'v2.0.0 — Store persistenti, guardrail, handoff e MCP zero-config',
    titleA: 'Un protocollo canonico per',
    titleB: 'ogni provider di IA',
    lead: 'SDK IA TypeScript puro · web-first · multi-provider',
    description:
      '29 provider dietro un unico stream delta StreamPart. Zero dipendenze runtime — pack SQLite, Redis e Postgres, guardrail e handoff nel loop, MCP che si connette da solo. Funziona ovunque funzioni fetch.',
    ctaDocs: 'Inizia',
    ctaWhatsNew: 'Novità della 2.0',
    worksWith: 'Un’unica superficie API per',
    providersMore: '+ altri 21, inclusi Ollama e LM Studio',
    stats: [
      { value: '29', label: 'id provider' },
      { value: '53', label: 'sottopath' },
      { value: '3', label: 'pack database' },
      { value: '1.9 → 2.0', label: 'per lo più additivo' },
    ],
    features: {
      stream: {
        title: 'Stream delta canonico',
        body: 'Ogni risposta del provider viene normalizzata in un unico stream StreamPart tipizzato prima che il tuo codice la veda. Nessun SSE grezzo trapela mai.',
      },
      agents: {
        title: 'Loop agentico, ora con policy',
        body: 'Strumenti paralleli auto-riparanti, sub-agenti annidati, più i guardrail 2.0 (pass / block / rewrite) e handoff() per trasferire l’intero run.',
      },
      stores: {
        title: 'Punta la persistenza a un database',
        body: 'Pack SQLite, Redis e Postgres dietro le seam memory, chat, session e run. FTS5 + pgvector se li vuoi — zero dipendenze altrimenti.',
      },
      mcp: {
        title: 'MCP zero-config',
        body: 'Indica i server sulla chiamata; il loop li connette, li namespace, li aggiorna e li chiude. OAuth 2.0, sampling, roots e reconnect verificato con ping.',
      },
      edge: {
        title: 'Core edge-safe',
        body: 'Solo Web API — niente node:*, niente Buffer, nessuno stato ambientale. Node, Deno, Bun, Vercel Edge e Cloudflare Workers.',
      },
      media: {
        title: 'Speech, trascrizione, video',
        body: 'generateSpeech, transcribe e generateVideo come kind di modello distinti — OpenAI, ElevenLabs, Deepgram e qualsiasi relay OpenAI-Videos.',
      },
    },
    codeTitle: 'Streaming in tre righe',
    codeBody:
      'streamChat ritorna in modo sincrono e non lancia mai eccezioni — la richiesta parte pigramente alla prima lettura. Cambia la factory per cambiare provider; nient’altro si muove.',
    languagesLabel: 'Interfaccia della documentazione',
    footerDocs: 'Documentazione',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'Novità della 2.0',
  },
  es: {
    badge: 'v2.0.0 — Stores persistentes, guardrails, handoffs y MCP cero-config',
    titleA: 'Un protocolo canónico para',
    titleB: 'cada proveedor de IA',
    lead: 'SDK de IA para TypeScript puro · web-first · multiproveedor',
    description:
      '29 proveedores detrás de un único stream delta StreamPart. Cero dependencias en tiempo de ejecución — packs SQLite, Redis y Postgres, guardrails y handoffs en el bucle, MCP que se conecta solo. Funciona dondequiera que funcione fetch.',
    ctaDocs: 'Empezar',
    ctaWhatsNew: 'Novedades de 2.0',
    worksWith: 'Una sola superficie de API para',
    providersMore: '+ 21 más, incluidos Ollama y LM Studio',
    stats: [
      { value: '29', label: 'ids de proveedor' },
      { value: '53', label: 'subrutas' },
      { value: '3', label: 'packs de base de datos' },
      { value: '1.9 → 2.0', label: 'casi todo aditivo' },
    ],
    features: {
      stream: {
        title: 'Stream delta canónico',
        body: 'Cada respuesta del proveedor se normaliza a un stream StreamPart tipado antes de que tu código la vea. Nunca se filtra SSE crudo.',
      },
      agents: {
        title: 'Bucle agéntico, ahora con política',
        body: 'Herramientas paralelas autorreparadoras, subagentes anidados, más guardrails 2.0 (pass / block / rewrite) y handoff() para transferir todo el run.',
      },
      stores: {
        title: 'Apunta la persistencia a una base',
        body: 'Packs SQLite, Redis y Postgres detrás de las costuras de memoria, chat, sesión y run. FTS5 + pgvector si los quieres — cero deps si no.',
      },
      mcp: {
        title: 'MCP cero-config',
        body: 'Nombra servidores en la llamada; el bucle los conecta, les da namespace, los refresca y los cierra. OAuth 2.0, sampling, roots y reconexión verificada con ping.',
      },
      edge: {
        title: 'Núcleo edge-safe',
        body: 'Solo Web APIs — sin node:*, sin Buffer, sin estado ambiental. Node, Deno, Bun, Vercel Edge y Cloudflare Workers.',
      },
      media: {
        title: 'Voz, transcripción, vídeo',
        body: 'generateSpeech, transcribe y generateVideo como kinds de modelo propios — OpenAI, ElevenLabs, Deepgram y cualquier relé OpenAI-Videos.',
      },
    },
    codeTitle: 'Streaming en tres líneas',
    codeBody:
      'streamChat retorna de forma síncrona y nunca lanza excepciones — la petición arranca perezosamente en la primera lectura. Cambia la factory para cambiar de proveedor; nada más se mueve.',
    languagesLabel: 'Interfaz de la documentación',
    footerDocs: 'Documentación',
    footerChangelog: 'Registro de cambios',
    footerWhatsNew: 'Novedades de 2.0',
  },
  ru: {
    badge: 'v2.0.0 — Постоянные store, guardrail, handoff и MCP без конфигурации',
    titleA: 'Один канонический протокол для',
    titleB: 'каждого ИИ-провайдера',
    lead: 'Чистый · web-first · мультипровайдерный TypeScript AI SDK',
    description:
      '29 провайдеров за одним дельта-потоком StreamPart. Ноль runtime-зависимостей — пакеты SQLite, Redis и Postgres, guardrail и handoff в цикле, MCP, который подключается сам. Работает везде, где работает fetch.',
    ctaDocs: 'Начать',
    ctaWhatsNew: 'Что нового в 2.0',
    worksWith: 'Единая поверхность API для',
    providersMore: '+ ещё 21, включая Ollama и LM Studio',
    stats: [
      { value: '29', label: 'id провайдеров' },
      { value: '53', label: 'подпутей' },
      { value: '3', label: 'пакета БД' },
      { value: '1.9 → 2.0', label: 'в основном аддитивно' },
    ],
    features: {
      stream: {
        title: 'Канонический дельта-поток',
        body: 'Каждый ответ провайдера нормализуется в типизированный поток StreamPart до того, как его увидит ваш код. Сырой SSE никогда не просачивается.',
      },
      agents: {
        title: 'Агентный цикл — теперь с политикой',
        body: 'Параллельные самовосстанавливающиеся инструменты, вложенные суб-агенты, плюс guardrail 2.0 (pass / block / rewrite) и handoff() для передачи всего запуска.',
      },
      stores: {
        title: 'Направьте персистентность в базу',
        body: 'Пакеты SQLite, Redis и Postgres за швами memory, chat, session и run. FTS5 + pgvector по желанию — ноль зависимостей, если не нужны.',
      },
      mcp: {
        title: 'MCP без конфигурации',
        body: 'Укажите серверы в вызове; цикл подключает, именует, обновляет и закрывает их. OAuth 2.0, sampling, roots и reconnect с проверкой ping.',
      },
      edge: {
        title: 'Edge-безопасное ядро',
        body: 'Только Web API — без node:*, без Buffer, без внешнего состояния. Node, Deno, Bun, Vercel Edge и Cloudflare Workers.',
      },
      media: {
        title: 'Речь, транскрипция, видео',
        body: 'generateSpeech, transcribe и generateVideo как отдельные виды моделей — OpenAI, ElevenLabs, Deepgram и любой релей OpenAI-Videos.',
      },
    },
    codeTitle: 'Стриминг в три строки',
    codeBody:
      'streamChat возвращается синхронно и никогда не бросает исключений — запрос лениво стартует при первом чтении. Поменяйте фабрику, чтобы сменить провайдера; больше ничего не меняется.',
    languagesLabel: 'Интерфейс документации',
    footerDocs: 'Документация',
    footerChangelog: 'История изменений',
    footerWhatsNew: 'Что нового в 2.0',
  },
  ja: {
    badge: 'v2.0.0 — 永続ストア、ガードレール、ハンドオフ、ゼロ設定 MCP',
    titleA: 'すべての AI プロバイダーを',
    titleB: 'ひとつの正規プロトコルで',
    lead: 'ピュア · ウェブファースト · マルチプロバイダー TypeScript AI SDK',
    description:
      '29 のプロバイダーを単一の StreamPart デルタストリームの背後に統合。ランタイム依存ゼロ — SQLite / Redis / Postgres パック、ループ内のガードレールとハンドオフ、自分で接続する MCP。fetch が動くところならどこでも動きます。',
    ctaDocs: 'はじめる',
    ctaWhatsNew: '2.0 の新機能',
    worksWith: '単一の API サーフェスで',
    providersMore: '+ さらに 21、Ollama と LM Studio を含む',
    stats: [
      { value: '29', label: 'プロバイダー ID' },
      { value: '53', label: 'サブパス' },
      { value: '3', label: 'データベースパック' },
      { value: '1.9 → 2.0', label: 'ほぼ加算的' },
    ],
    features: {
      stream: {
        title: '正規デルタストリーム',
        body: 'すべてのプロバイダー応答は、コードが目にする前に型付き StreamPart ストリームへ正規化されます。生の SSE が漏れることはありません。',
      },
      agents: {
        title: 'エージェントループ、ポリシー付き',
        body: '並列かつ自己修復的なツール、ネストされたサブエージェントに加え、2.0 のガードレール（pass / block / rewrite）と run 全体を移す handoff()。',
      },
      stores: {
        title: '永続化をデータベースへ',
        body: 'memory / chat / session / run の各シームの背後に SQLite、Redis、Postgres。必要なら FTS5 + pgvector — 不要なら依存ゼロ。',
      },
      mcp: {
        title: 'ゼロ設定 MCP',
        body: '呼び出しでサーバーを指定するだけ。ループが接続・名前空間化・更新・クローズします。OAuth 2.0、sampling、roots、ping 検証付き再接続。',
      },
      edge: {
        title: 'エッジセーフなコア',
        body: 'Web API のみ — node:* なし、Buffer なし、環境状態なし。Node、Deno、Bun、Vercel Edge、Cloudflare Workers で動作。',
      },
      media: {
        title: '音声・文字起こし・動画',
        body: 'generateSpeech、transcribe、generateVideo は独自のモデル種別 — OpenAI、ElevenLabs、Deepgram、任意の OpenAI-Videos リレー。',
      },
    },
    codeTitle: '3 行でストリーミング',
    codeBody:
      'streamChat は同期的に返り、決して例外を投げません — リクエストは最初の読み取り時に遅延開始します。ファクトリを差し替えるだけでプロバイダーを変更でき、他には何も変わりません。',
    languagesLabel: 'ドキュメント UI',
    footerDocs: 'ドキュメント',
    footerChangelog: '変更履歴',
    footerWhatsNew: '2.0 の新機能',
  },
  ko: {
    badge: 'v2.0.0 — 영구 스토어, 가드레일, 핸드오프, 제로 설정 MCP',
    titleA: '모든 AI 프로바이더를 위한',
    titleB: '단 하나의 정규 프로토콜',
    lead: '순수 · 웹 우선 · 멀티 프로바이더 TypeScript AI SDK',
    description:
      '29개 프로바이더를 하나의 StreamPart 델타 스트림 뒤에 둡니다. 런타임 의존성 제로 — SQLite, Redis, Postgres 팩, 루프 안의 가드레일과 핸드오프, 스스로 연결하는 MCP. fetch가 동작하는 곳이라면 어디서든 실행됩니다.',
    ctaDocs: '시작하기',
    ctaWhatsNew: '2.0의 새로운 점',
    worksWith: '단일 API 표면:',
    providersMore: '+ 21개 더, Ollama와 LM Studio 포함',
    stats: [
      { value: '29', label: '프로바이더 id' },
      { value: '53', label: '서브패스' },
      { value: '3', label: '데이터베이스 팩' },
      { value: '1.9 → 2.0', label: '대부분 가산적' },
    ],
    features: {
      stream: {
        title: '정규 델타 스트림',
        body: '모든 프로바이더 응답은 코드가 보기 전에 타입이 지정된 StreamPart 스트림으로 정규화됩니다. 원시 SSE가 새어 나가는 일은 없습니다.',
      },
      agents: {
        title: '에이전트 루프, 이제 정책과 함께',
        body: '병렬 자가 복구 도구, 중첩 서브 에이전트, 그리고 2.0 가드레일(pass / block / rewrite)과 전체 런을 넘기는 handoff().',
      },
      stores: {
        title: '영속성을 데이터베이스에 연결',
        body: 'memory, chat, session, run 심 뒤에 SQLite, Redis, Postgres 팩. 원하면 FTS5 + pgvector — 아니면 의존성 제로.',
      },
      mcp: {
        title: '제로 설정 MCP',
        body: '호출에서 서버만 지정하면 루프가 연결, 네임스페이스, 갱신, 종료합니다. OAuth 2.0, sampling, roots, ping 검증 재연결.',
      },
      edge: {
        title: '엣지 안전 코어',
        body: 'Web API만 사용 — node:* 없음, Buffer 없음, 환경 상태 없음. Node, Deno, Bun, Vercel Edge, Cloudflare Workers.',
      },
      media: {
        title: '음성, 전사, 비디오',
        body: 'generateSpeech, transcribe, generateVideo는 고유 모델 종류 — OpenAI, ElevenLabs, Deepgram, 임의의 OpenAI-Videos 릴레이.',
      },
    },
    codeTitle: '세 줄로 스트리밍',
    codeBody:
      'streamChat은 동기적으로 반환되며 절대 예외를 던지지 않습니다 — 요청은 첫 읽기에서 지연 시작됩니다. 팩토리만 바꾸면 프로바이더가 바뀌고, 그 외에는 아무것도 달라지지 않습니다.',
    languagesLabel: '문서 UI',
    footerDocs: '문서',
    footerChangelog: '변경 이력',
    footerWhatsNew: '2.0의 새로운 점',
  },
  zh: {
    badge: 'v2.0.0 — 持久化存储、护栏、交接与零配置 MCP',
    titleA: '为每一个 AI 提供商',
    titleB: '提供同一条规范协议',
    lead: '纯净 · Web 优先 · 多提供商 TypeScript AI SDK',
    description:
      '29 个提供商统一在同一条 StreamPart 增量流之后。零运行时依赖 — SQLite、Redis、Postgres 包，循环内的护栏与交接，会自己连接的 MCP。fetch 能运行的地方就能运行。',
    ctaDocs: '快速开始',
    ctaWhatsNew: '2.0 新特性',
    worksWith: '同一套 API 表面覆盖',
    providersMore: '+ 另外 21 个，包括 Ollama 和 LM Studio',
    stats: [
      { value: '29', label: '提供商 id' },
      { value: '53', label: '子路径' },
      { value: '3', label: '数据库包' },
      { value: '1.9 → 2.0', label: '几乎全部是加法' },
    ],
    features: {
      stream: {
        title: '规范增量流',
        body: '每个提供商的响应在你的代码看到之前都会被规范化为带类型的 StreamPart 流。原始 SSE 字节永远不会泄漏。',
      },
      agents: {
        title: '代理循环，现已带策略',
        body: '并行自愈工具、可嵌套子代理，加上 2.0 护栏（pass / block / rewrite）以及把整次运行交出去的 handoff()。',
      },
      stores: {
        title: '把持久化指向数据库',
        body: 'memory / chat / session / run 接缝背后的 SQLite、Redis、Postgres 包。需要时用 FTS5 + pgvector — 不需要则零依赖。',
      },
      mcp: {
        title: '零配置 MCP',
        body: '在调用上点名服务器；循环负责连接、命名空间、热刷新和关闭。OAuth 2.0、sampling、roots，以及经 ping 验证的重连。',
      },
      edge: {
        title: '边缘安全内核',
        body: '仅使用 Web API — 没有 node:*、没有 Buffer、没有环境状态。Node、Deno、Bun、Vercel Edge 和 Cloudflare Workers 均可运行。',
      },
      media: {
        title: '语音、转写、视频',
        body: 'generateSpeech、transcribe 和 generateVideo 是独立的模型种类 — OpenAI、ElevenLabs、Deepgram，以及任何 OpenAI-Videos 中继。',
      },
    },
    codeTitle: '三行代码实现流式输出',
    codeBody:
      'streamChat 同步返回且永不抛出异常 — 请求在首次读取时惰性启动。换一个 factory 即可切换提供商，其余一切保持不变。',
    languagesLabel: '文档界面',
    footerDocs: '文档',
    footerChangelog: '更新日志',
    footerWhatsNew: '2.0 新特性',
  },
};
