import type { Locale } from './i18n';

export type HomeFeatureKey = 'stream' | 'agents' | 'stores' | 'mcp' | 'edge' | 'media';

export type HomeReleaseKey = 'meter' | 'harness' | 'acp' | 'toolSearch' | 'aiSdk' | 'ledger';

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
  skillsTag: string;
  skillsTitle: string;
  skillsBody: string;
  skillsCta: string;
  skillsList: { name: string; body: string }[];
  /** The "New in 2.5" section of the home page. */
  release: {
    tag: string;
    title: string;
    body: string;
    preview: string;
    cta: string;
    items: Record<HomeReleaseKey, { title: string; body: string }>;
  };
  languagesLabel: string;
  footerDocs: string;
  footerChangelog: string;
  footerWhatsNew: string;
};

export const homeCopy: Record<Locale, HomeCopy> = {
  en: {
    badge:
      'v2.5.0 — a budget meter for coding harnesses, the deuz CLI, ACP, tool search & MCP resources and prompts',
    titleA: 'One canonical wire for',
    titleB: 'every AI provider',
    lead: 'Pure · Web-first · Multi-provider AI SDK for TypeScript',
    description:
      '29 providers behind one StreamPart delta stream. Zero runtime dependencies — SQLite, Redis and Postgres packs, guardrails and handoffs in the loop, MCP that connects itself. A Web-API-only core, built for anywhere fetch runs.',
    ctaDocs: 'Get started',
    ctaWhatsNew: 'What is new in 2.5',
    worksWith: 'One API surface across',
    providersMore:
      'Each mark opens its guide. Any other OpenAI-compatible host works through createOpenAICompatible.',
    stats: [
      { value: '29', label: 'provider ids' },
      { value: '88', label: 'subpaths' },
      { value: '3', label: 'database packs' },
      { value: '2.4 → 2.5', label: 'mostly additive' },
    ],
    features: {
      stream: {
        title: 'Canonical delta stream',
        body: 'Every provider response is normalized to one typed StreamPart stream before your code sees it. No raw SSE ever leaks through.',
      },
      agents: {
        title: 'Native agents and durable swarms',
        body: 'Opt-in runAgent with validated results, shared and persistent budgets. Swarms that spawn tasks at runtime, share a blackboard and move between processes with leases, on memory, SQLite, Postgres or Redis.',
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
        body: 'Web APIs only — no node:*, no Buffer, no ambient state. Tested on Node; a browser-platform bundle build keeps Node-only code out.',
      },
      media: {
        title: 'Speech, transcription, video',
        body: 'generateSpeech, transcribe and generateVideo as their own model kinds — OpenAI, ElevenLabs, Deepgram, and any OpenAI-Videos relay.',
      },
    },
    codeTitle: 'Streaming in three lines',
    codeBody:
      'streamChat returns synchronously and never throws — the request starts lazily on first read. Swap the factory to change provider; nothing else moves.',
    skillsTag: 'For your coding agent',
    skillsTitle: 'Your coding agent already knows this SDK',
    skillsBody:
      'Two Agent Skills ship with the repository, so an agent writes against the real surface instead of reconstructing it from memory. Every symbol in them is resolved against the export table on each commit and every example is compiled, so a name that does not exist cannot be merged.',
    skillsCta: 'How they are verified',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'The whole surface: the invariants, a task-to-file router, and twenty-six reference files loaded only when a task needs them.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'The verified name-by-name port from ai and @ai-sdk packages.',
      },
    ],
    release: {
      tag: 'New in 2.5',
      title: 'Budgets, receipts and approvals for the tools you already use',
      body: '2.5 applies them outside your own code: to coding agents such as Claude Code and Codex, to ACP editors, to Vercel AI SDK code and to MCP clients.',
      preview: 'preview',
      cta: 'Read the 2.5 notes',
      items: {
        meter: {
          title: 'Budget meter',
          body: 'A local proxy charges the model requests of Claude Code or Codex to a budget and answers 402 at the ceiling. The deuz CLI (preview) starts it with one command.',
        },
        harness: {
          title: 'Harness runner',
          body: 'runHarness runs Claude Code, Codex or OpenCode as a sub-agent under a budget and applies your policy to its permission requests.',
        },
        acp: {
          title: 'ACP for editors',
          body: 'Serve a Deuz agent to ACP editors such as Zed and JetBrains IDEs, with signed approvals and a budget, or drive any ACP agent from code.',
        },
        toolSearch: {
          title: 'Tool search',
          body: 'A large tool catalog behind one search tool. A search never returns a tool the run’s policy refuses.',
        },
        aiSdk: {
          title: 'AI SDK provider',
          body: 'Wrap a Vercel AI SDK 7 model in one line, and existing AI SDK code runs under a Deuz budget.',
        },
        ledger: {
          title: 'MCP ledger',
          body: 'A ready-made MCP server for any MCP client: versioned memory, an advisory spend record and a hash-chained receipt log.',
        },
      },
    },
    languagesLabel: 'Documentation UI',
    footerDocs: 'Documentation',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'What is new in 2.5',
  },
  de: {
    badge:
      'v2.5.0 — Budget-Meter für Coding-Harnesses, die deuz-CLI, ACP, Tool-Suche sowie MCP-Ressourcen und -Prompts',
    titleA: 'Ein kanonisches Protokoll für',
    titleB: 'jeden KI-Provider',
    lead: 'Pures · Web-first · Multi-Provider AI SDK für TypeScript',
    description:
      '29 Provider hinter einem StreamPart-Delta-Stream. Keine Runtime-Abhängigkeiten — SQLite-, Redis- und Postgres-Packs, Guardrails und Handoffs im Loop, MCP das sich selbst verbindet. Ein Kern nur aus Web-APIs, gebaut für jede Umgebung mit fetch.',
    ctaDocs: 'Loslegen',
    ctaWhatsNew: 'Neu in 2.5',
    worksWith: 'Eine API-Oberfläche für',
    providersMore:
      'Jedes Zeichen öffnet seine Anleitung. Jeder andere OpenAI-kompatible Host läuft über createOpenAICompatible.',
    stats: [
      { value: '29', label: 'Provider-IDs' },
      { value: '88', label: 'Subpfade' },
      { value: '3', label: 'Datenbank-Packs' },
      { value: '2.4 → 2.5', label: 'größtenteils additiv' },
    ],
    features: {
      stream: {
        title: 'Kanonischer Delta-Stream',
        body: 'Jede Provider-Antwort wird zu einem typisierten StreamPart-Stream normalisiert, bevor dein Code sie sieht. Rohe SSE-Bytes dringen nie durch.',
      },
      agents: {
        title: 'Native Agenten und persistente Swarms',
        body: 'Optionale native Agenten mit validierten Ergebnissen, gemeinsamen und dauerhaften Budgets. Swarms, die zur Laufzeit Aufgaben erzeugen, ein Blackboard teilen und per Lease zwischen Prozessen wandern, auf Memory, SQLite, Postgres oder Redis.',
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
        body: 'Nur Web-APIs — kein node:*, kein Buffer, kein Umgebungszustand. Getestet auf Node; ein Bundle-Build für die Browser-Plattform hält Node-only-Code fern.',
      },
      media: {
        title: 'Sprache, Transkription, Video',
        body: 'generateSpeech, transcribe und generateVideo als eigene Modellarten — OpenAI, ElevenLabs, Deepgram und jeder OpenAI-Videos-Relay.',
      },
    },
    codeTitle: 'Streaming in drei Zeilen',
    codeBody:
      'streamChat kehrt synchron zurück und wirft nie — der Request startet lazy beim ersten Lesen. Tausche die Factory, um den Provider zu wechseln; sonst ändert sich nichts.',
    skillsTag: 'Für deinen Coding-Agenten',
    skillsTitle: 'Dein Coding-Agent kennt dieses SDK bereits',
    skillsBody:
      'Zwei Agent Skills liegen im Repository, damit ein Agent gegen die echte Oberfläche schreibt, statt sie aus dem Gedächtnis zu rekonstruieren. Jedes Symbol darin wird bei jedem Commit gegen die Export-Tabelle aufgelöst und jedes Beispiel kompiliert — ein Name, den es nicht gibt, kommt nicht durch.',
    skillsCta: 'Wie sie geprüft werden',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Die gesamte Oberfläche: die Invarianten, ein Router von Aufgabe zu Datei und fünfundzwanzig Referenzdateien, die nur bei Bedarf geladen werden.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'Die geprüfte Migration Name für Name von ai und den @ai-sdk-Paketen.',
      },
    ],
    release: {
      tag: 'Neu in 2.5',
      title: 'Budgets, Belege und Freigaben für die Werkzeuge, die du schon nutzt',
      body: '2.5 wendet sie außerhalb deines eigenen Codes an: auf Coding-Agenten wie Claude Code und Codex, auf ACP-Editoren, auf Vercel-AI-SDK-Code und auf MCP-Clients.',
      preview: 'Preview',
      cta: 'Die Notizen zu 2.5 lesen',
      items: {
        meter: {
          title: 'Budget-Meter',
          body: 'Ein lokaler Proxy bucht die Modellanfragen von Claude Code oder Codex auf ein Budget und antwortet an der Obergrenze mit 402. Die deuz-CLI (Preview) startet ihn mit einem Befehl.',
        },
        harness: {
          title: 'Harness-Runner',
          body: 'runHarness führt Claude Code, Codex oder OpenCode als Sub-Agent unter einem Budget aus und wendet deine Policy auf dessen Berechtigungsanfragen an.',
        },
        acp: {
          title: 'ACP für Editoren',
          body: 'Stelle einen Deuz-Agenten für ACP-Editoren wie Zed und die JetBrains-IDEs bereit, mit signierten Freigaben und einem Budget, oder steuere jeden ACP-Agenten aus dem Code.',
        },
        toolSearch: {
          title: 'Tool-Suche',
          body: 'Ein großer Tool-Katalog hinter einem einzigen Such-Tool. Eine Suche liefert nie ein Tool, das die Policy des Laufs ablehnt.',
        },
        aiSdk: {
          title: 'AI-SDK-Provider',
          body: 'Umschließe ein Modell des Vercel AI SDK 7 in einer Zeile, und bestehender AI-SDK-Code läuft unter einem Deuz-Budget.',
        },
        ledger: {
          title: 'MCP-Ledger',
          body: 'Ein fertiger MCP-Server für jeden MCP-Client: versioniertes Gedächtnis, eine unverbindliche Ausgabenübersicht und ein hash-verkettetes Belegprotokoll.',
        },
      },
    },
    languagesLabel: 'Dokumentations-UI',
    footerDocs: 'Dokumentation',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'Neu in 2.5',
  },
  tr: {
    badge:
      'v2.5.0 — kodlama araçları için bütçe ölçer, deuz CLI, ACP, araç arama ve MCP kaynakları ile prompt’ları',
    titleA: 'Tüm yapay zeka sağlayıcıları için',
    titleB: 'tek kanonik protokol',
    lead: 'Saf · Web öncelikli · Çok sağlayıcılı TypeScript AI SDK',
    description:
      '29 sağlayıcı, tek bir StreamPart delta akışının arkasında. Sıfır çalışma zamanı bağımlılığı — SQLite, Redis ve Postgres paketleri, döngüde guardrail ve handoff, kendini bağlayan MCP. Yalnızca Web API’leri kullanan, fetch’in olduğu her ortam için tasarlanmış bir çekirdek.',
    ctaDocs: 'Başla',
    ctaWhatsNew: '2.5’te neler yeni',
    worksWith: 'Tek API yüzeyi:',
    providersMore:
      'Her işaret kendi rehberini açar. Diğer OpenAI uyumlu her sunucu createOpenAICompatible ile çalışır.',
    stats: [
      { value: '29', label: 'sağlayıcı kimliği' },
      { value: '88', label: 'alt yol' },
      { value: '3', label: 'veritabanı paketi' },
      { value: '2.4 → 2.5', label: 'çoğunlukla eklemeli' },
    ],
    features: {
      stream: {
        title: 'Kanonik delta akışı',
        body: 'Her sağlayıcı yanıtı, kodunuz görmeden önce tipli tek bir StreamPart akışına normalize edilir. Ham SSE baytları asla sızmaz.',
      },
      agents: {
        title: 'Native ajanlar ve kalıcı swarm',
        body: 'İsteğe bağlı native ajanlar: doğrulanmış çıktılar, ortak ve kalıcı bütçeler. Çalışırken görev üreten, ortak pano kullanan ve lease ile süreçler arasında taşınan swarm’lar; bellek, SQLite, Postgres veya Redis üzerinde.',
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
        body: 'Yalnızca Web API’leri — node:* yok, Buffer yok, ortam durumu yok. Node üzerinde test edilir; tarayıcı platformu için bir paket derlemesi yalnızca Node’a özgü kodu dışarıda tutar.',
      },
      media: {
        title: 'Konuşma, transkripsiyon, video',
        body: 'generateSpeech, transcribe ve generateVideo ayrı model türleri — OpenAI, ElevenLabs, Deepgram ve her OpenAI-Videos rölesi.',
      },
    },
    codeTitle: 'Üç satırda akış',
    codeBody:
      'streamChat senkron döner ve asla fırlatmaz — istek ilk okumada tembelce başlar. Sağlayıcıyı değiştirmek için factory’yi değiştirin; başka hiçbir şey değişmez.',
    skillsTag: 'Kod yazan ajanınız için',
    skillsTitle: 'Ajanınız bu SDK’yı zaten biliyor',
    skillsBody:
      'Repo iki Agent Skill ile geliyor; ajan API’yi hafızasından yeniden kurmak yerine gerçek yüzeye göre yazıyor. İçlerindeki her sembol her commit’te export tablosuna karşı çözülüyor ve her örnek derleniyor — var olmayan bir isim merge edilemiyor.',
    skillsCta: 'Nasıl doğrulanıyor',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Yüzeyin tamamı: değişmezler, göreve göre dosya yönlendirmesi ve yalnızca gerektiğinde yüklenen yirmi beş referans dosyası.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'ai ve @ai-sdk paketlerinden isim isim doğrulanmış geçiş.',
      },
    ],
    release: {
      tag: '2.5 ile gelenler',
      title: 'Zaten kullandığın araçlar için bütçe, makbuz ve onay',
      body: '2.5 bunları kendi kodunun dışına taşıyor: Claude Code ve Codex gibi kodlama ajanlarına, ACP editörlerine, Vercel AI SDK koduna ve MCP istemcilerine.',
      preview: 'önizleme',
      cta: '2.5 notlarını oku',
      items: {
        meter: {
          title: 'Bütçe ölçer',
          body: 'Yerel bir proxy, Claude Code ya da Codex’in model isteklerini bir bütçeye yazar ve tavanda 402 döner. deuz CLI (önizleme) onu tek komutla başlatır.',
        },
        harness: {
          title: 'Harness çalıştırıcı',
          body: 'runHarness; Claude Code, Codex ya da OpenCode’u bütçe altında bir alt ajan olarak çalıştırır ve izin isteklerine senin politikanı uygular.',
        },
        acp: {
          title: 'Editörler için ACP',
          body: 'Bir Deuz ajanını Zed ve JetBrains IDE’leri gibi ACP editörlerine imzalı onaylar ve bir bütçeyle sun, ya da herhangi bir ACP ajanını koddan yönet.',
        },
        toolSearch: {
          title: 'Araç arama',
          body: 'Büyük bir araç kataloğu tek bir arama aracının arkasında. Arama, çalıştırmanın politikasının reddettiği bir aracı asla döndürmez.',
        },
        aiSdk: {
          title: 'AI SDK sağlayıcısı',
          body: 'Bir Vercel AI SDK 7 modelini tek satırda sar; mevcut AI SDK kodu bir Deuz bütçesi altında çalışsın.',
        },
        ledger: {
          title: 'MCP defteri',
          body: 'Her MCP istemcisi için hazır bir MCP sunucusu: sürümlü bellek, bağlayıcı olmayan bir harcama kaydı ve hash zincirli bir makbuz günlüğü.',
        },
      },
    },
    languagesLabel: 'Dokümantasyon arayüzü',
    footerDocs: 'Dokümantasyon',
    footerChangelog: 'Sürüm notları',
    footerWhatsNew: '2.5’te neler yeni',
  },
  fr: {
    badge:
      'v2.5.0 — Compteur de budget pour les agents de code, CLI deuz, ACP, recherche d’outils, ressources et prompts MCP',
    titleA: 'Un protocole canonique pour',
    titleB: 'chaque fournisseur d’IA',
    lead: 'SDK IA TypeScript pur · web-first · multi-fournisseur',
    description:
      '29 fournisseurs derrière un seul flux delta StreamPart. Zéro dépendance runtime — packs SQLite, Redis et Postgres, guardrails et handoffs dans la boucle, MCP qui se connecte tout seul. Un cœur uniquement en API Web, conçu pour tout environnement doté de fetch.',
    ctaDocs: 'Commencer',
    ctaWhatsNew: 'Nouveautés de la 2.5',
    worksWith: 'Une seule surface d’API pour',
    providersMore:
      'Chaque marque ouvre son guide. Tout autre hôte compatible OpenAI passe par createOpenAICompatible.',
    stats: [
      { value: '29', label: 'ids de fournisseur' },
      { value: '88', label: 'sous-chemins' },
      { value: '3', label: 'packs base de données' },
      { value: '2.4 → 2.5', label: 'surtout additif' },
    ],
    features: {
      stream: {
        title: 'Flux delta canonique',
        body: 'Chaque réponse de fournisseur est normalisée en un flux StreamPart typé avant que votre code ne la voie. Aucun SSE brut ne s’échappe jamais.',
      },
      agents: {
        title: 'Agents natifs et swarms persistants',
        body: 'Agents natifs optionnels, résultats validés, budgets partagés et persistants. Des swarms qui créent des tâches en cours d’exécution, partagent un tableau et passent d’un processus à l’autre grâce aux baux, en mémoire, SQLite, Postgres ou Redis.',
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
        body: 'API Web uniquement — pas de node:*, pas de Buffer, pas d’état ambiant. Testé sur Node, et un build de bundle pour la plateforme navigateur écarte le code propre à Node.',
      },
      media: {
        title: 'Parole, transcription, vidéo',
        body: 'generateSpeech, transcribe et generateVideo comme kinds de modèle distincts — OpenAI, ElevenLabs, Deepgram, et tout relais OpenAI-Videos.',
      },
    },
    codeTitle: 'Le streaming en trois lignes',
    codeBody:
      'streamChat retourne de façon synchrone et ne lève jamais d’exception — la requête démarre paresseusement à la première lecture. Changez la factory pour changer de fournisseur ; rien d’autre ne bouge.',
    skillsTag: 'Pour votre agent de code',
    skillsTitle: 'Votre agent connaît déjà ce SDK',
    skillsBody:
      'Deux Agent Skills sont fournis avec le dépôt : l’agent écrit face à la vraie surface au lieu de la reconstituer de mémoire. Chaque symbole y est résolu contre la table d’exports à chaque commit et chaque exemple est compilé — un nom inexistant ne peut pas être fusionné.',
    skillsCta: 'Comment ils sont vérifiés',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Toute la surface : les invariants, un routeur tâche-vers-fichier et vingt-cinq fichiers de référence chargés seulement quand la tâche l’exige.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'Le portage vérifié, nom par nom, depuis ai et les paquets @ai-sdk.',
      },
    ],
    release: {
      tag: 'Nouveau dans la 2.5',
      title: 'Budgets, reçus et approbations pour les outils que vous utilisez déjà',
      body: 'La 2.5 les applique en dehors de votre propre code : aux agents de programmation comme Claude Code et Codex, aux éditeurs ACP, au code du Vercel AI SDK et aux clients MCP.',
      preview: 'aperçu',
      cta: 'Lire les notes de la 2.5',
      items: {
        meter: {
          title: 'Compteur de budget',
          body: 'Un proxy local impute les requêtes de modèle de Claude Code ou de Codex à un budget et répond 402 au plafond. La CLI deuz (aperçu) le lance en une commande.',
        },
        harness: {
          title: 'Exécuteur de harness',
          body: 'runHarness exécute Claude Code, Codex ou OpenCode comme sous-agent sous un budget et applique votre politique à ses demandes d’autorisation.',
        },
        acp: {
          title: 'ACP pour les éditeurs',
          body: 'Servez un agent Deuz aux éditeurs ACP comme Zed et les IDE JetBrains, avec des approbations signées et un budget, ou pilotez n’importe quel agent ACP depuis le code.',
        },
        toolSearch: {
          title: 'Recherche d’outils',
          body: 'Un grand catalogue d’outils derrière un seul outil de recherche. Une recherche ne renvoie jamais un outil que la politique de l’exécution refuse.',
        },
        aiSdk: {
          title: 'Fournisseur AI SDK',
          body: 'Enveloppez un modèle du Vercel AI SDK 7 en une ligne, et le code AI SDK existant s’exécute sous un budget Deuz.',
        },
        ledger: {
          title: 'Registre MCP',
          body: 'Un serveur MCP prêt à l’emploi pour tout client MCP : mémoire versionnée, relevé de dépenses indicatif et journal de reçus chaîné par hachage.',
        },
      },
    },
    languagesLabel: 'Interface de la documentation',
    footerDocs: 'Documentation',
    footerChangelog: 'Journal des modifications',
    footerWhatsNew: 'Nouveautés de la 2.5',
  },
  it: {
    badge:
      'v2.5.0 — Contatore di budget per gli agenti di coding, CLI deuz, ACP, ricerca degli strumenti, risorse e prompt MCP',
    titleA: 'Un protocollo canonico per',
    titleB: 'ogni provider di IA',
    lead: 'SDK IA TypeScript puro · web-first · multi-provider',
    description:
      '29 provider dietro un unico stream delta StreamPart. Zero dipendenze runtime — pack SQLite, Redis e Postgres, guardrail e handoff nel loop, MCP che si connette da solo. Un core solo Web API, pensato per ogni ambiente con fetch.',
    ctaDocs: 'Inizia',
    ctaWhatsNew: 'Novità della 2.5',
    worksWith: 'Un’unica superficie API per',
    providersMore:
      'Ogni marchio apre la sua guida. Qualsiasi altro host compatibile con OpenAI passa da createOpenAICompatible.',
    stats: [
      { value: '29', label: 'id provider' },
      { value: '88', label: 'sottopath' },
      { value: '3', label: 'pack database' },
      { value: '2.4 → 2.5', label: 'per lo più additivo' },
    ],
    features: {
      stream: {
        title: 'Stream delta canonico',
        body: 'Ogni risposta del provider viene normalizzata in un unico stream StreamPart tipizzato prima che il tuo codice la veda. Nessun SSE grezzo trapela mai.',
      },
      agents: {
        title: 'Agenti nativi e swarm persistenti',
        body: 'Agenti nativi opzionali, risultati validati, budget condivisi e persistenti. Swarm che creano attività durante l’esecuzione, condividono una lavagna e passano tra processi con i lease, in memoria, SQLite, Postgres o Redis.',
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
        body: 'Solo Web API — niente node:*, niente Buffer, nessuno stato ambientale. Testato su Node; una build del bundle per la piattaforma browser tiene fuori il codice solo-Node.',
      },
      media: {
        title: 'Speech, trascrizione, video',
        body: 'generateSpeech, transcribe e generateVideo come kind di modello distinti — OpenAI, ElevenLabs, Deepgram e qualsiasi relay OpenAI-Videos.',
      },
    },
    codeTitle: 'Streaming in tre righe',
    codeBody:
      'streamChat ritorna in modo sincrono e non lancia mai eccezioni — la richiesta parte pigramente alla prima lettura. Cambia la factory per cambiare provider; nient’altro si muove.',
    skillsTag: 'Per il tuo agente di codice',
    skillsTitle: 'Il tuo agente conosce già questo SDK',
    skillsBody:
      'Il repository include due Agent Skill, così l’agente scrive sulla superficie reale invece di ricostruirla a memoria. Ogni simbolo viene risolto contro la tabella degli export a ogni commit e ogni esempio viene compilato: un nome che non esiste non passa.',
    skillsCta: 'Come vengono verificate',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'L’intera superficie: gli invarianti, un router da attività a file e venticinque file di riferimento caricati solo quando servono.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'La migrazione verificata, nome per nome, da ai e dai pacchetti @ai-sdk.',
      },
    ],
    release: {
      tag: 'Novità della 2.5',
      title: 'Budget, ricevute e approvazioni per gli strumenti che usi già',
      body: 'La 2.5 li applica fuori dal tuo codice: agli agenti di programmazione come Claude Code e Codex, agli editor ACP, al codice del Vercel AI SDK e ai client MCP.',
      preview: 'anteprima',
      cta: 'Leggi le note della 2.5',
      items: {
        meter: {
          title: 'Contatore di budget',
          body: 'Un proxy locale addebita a un budget le richieste al modello di Claude Code o Codex e risponde 402 al tetto. La CLI deuz (anteprima) lo avvia con un comando.',
        },
        harness: {
          title: 'Esecutore di harness',
          body: 'runHarness esegue Claude Code, Codex o OpenCode come sotto-agente entro un budget e applica la tua policy alle sue richieste di autorizzazione.',
        },
        acp: {
          title: 'ACP per gli editor',
          body: 'Servi un agente Deuz agli editor ACP come Zed e gli IDE JetBrains, con approvazioni firmate e un budget, oppure guida qualsiasi agente ACP dal codice.',
        },
        toolSearch: {
          title: 'Ricerca di strumenti',
          body: 'Un grande catalogo di strumenti dietro un solo strumento di ricerca. Una ricerca non restituisce mai uno strumento che la policy dell’esecuzione rifiuta.',
        },
        aiSdk: {
          title: 'Provider AI SDK',
          body: 'Avvolgi un modello del Vercel AI SDK 7 in una riga, e il codice AI SDK esistente gira entro un budget Deuz.',
        },
        ledger: {
          title: 'Registro MCP',
          body: 'Un server MCP pronto all’uso per qualsiasi client MCP: memoria versionata, un registro di spesa indicativo e un log di ricevute concatenato da hash.',
        },
      },
    },
    languagesLabel: 'Interfaccia della documentazione',
    footerDocs: 'Documentazione',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'Novità della 2.5',
  },
  es: {
    badge:
      'v2.5.0 — Medidor de presupuesto para agentes de código, CLI deuz, ACP, búsqueda de herramientas, recursos y prompts MCP',
    titleA: 'Un protocolo canónico para',
    titleB: 'cada proveedor de IA',
    lead: 'SDK de IA para TypeScript puro · web-first · multiproveedor',
    description:
      '29 proveedores detrás de un único stream delta StreamPart. Cero dependencias en tiempo de ejecución — packs SQLite, Redis y Postgres, guardrails y handoffs en el bucle, MCP que se conecta solo. Un núcleo solo con Web APIs, pensado para cualquier entorno con fetch.',
    ctaDocs: 'Empezar',
    ctaWhatsNew: 'Novedades de 2.5',
    worksWith: 'Una sola superficie de API para',
    providersMore:
      'Cada marca abre su guía. Cualquier otro host compatible con OpenAI funciona mediante createOpenAICompatible.',
    stats: [
      { value: '29', label: 'ids de proveedor' },
      { value: '88', label: 'subrutas' },
      { value: '3', label: 'packs de base de datos' },
      { value: '2.4 → 2.5', label: 'casi todo aditivo' },
    ],
    features: {
      stream: {
        title: 'Stream delta canónico',
        body: 'Cada respuesta del proveedor se normaliza a un stream StreamPart tipado antes de que tu código la vea. Nunca se filtra SSE crudo.',
      },
      agents: {
        title: 'Agentes nativos y swarms persistentes',
        body: 'Agentes nativos opcionales, resultados validados, presupuestos compartidos y persistentes. Swarms que crean tareas en ejecución, comparten una pizarra y pasan entre procesos con leases, en memoria, SQLite, Postgres o Redis.',
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
        body: 'Solo Web APIs — sin node:*, sin Buffer, sin estado ambiental. Probado en Node; una compilación del bundle para la plataforma navegador deja fuera el código exclusivo de Node.',
      },
      media: {
        title: 'Voz, transcripción, vídeo',
        body: 'generateSpeech, transcribe y generateVideo como kinds de modelo propios — OpenAI, ElevenLabs, Deepgram y cualquier relé OpenAI-Videos.',
      },
    },
    codeTitle: 'Streaming en tres líneas',
    codeBody:
      'streamChat retorna de forma síncrona y nunca lanza excepciones — la petición arranca perezosamente en la primera lectura. Cambia la factory para cambiar de proveedor; nada más se mueve.',
    skillsTag: 'Para tu agente de código',
    skillsTitle: 'Tu agente ya conoce este SDK',
    skillsBody:
      'El repositorio incluye dos Agent Skills, de modo que el agente escribe contra la superficie real en lugar de reconstruirla de memoria. Cada símbolo se resuelve contra la tabla de exports en cada commit y cada ejemplo se compila: un nombre que no existe no se puede fusionar.',
    skillsCta: 'Cómo se verifican',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Toda la superficie: los invariantes, un enrutador de tarea a archivo y veinticinco archivos de referencia que se cargan solo cuando hacen falta.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'La migración verificada, nombre por nombre, desde ai y los paquetes @ai-sdk.',
      },
    ],
    release: {
      tag: 'Novedades de la 2.5',
      title: 'Presupuestos, recibos y aprobaciones para las herramientas que ya usas',
      body: 'La 2.5 los aplica fuera de tu propio código: a agentes de programación como Claude Code y Codex, a editores ACP, al código del Vercel AI SDK y a clientes MCP.',
      preview: 'vista previa',
      cta: 'Leer las notas de la 2.5',
      items: {
        meter: {
          title: 'Medidor de presupuesto',
          body: 'Un proxy local carga a un presupuesto las peticiones al modelo de Claude Code o Codex y responde 402 al llegar al tope. La CLI deuz (vista previa) lo inicia con un comando.',
        },
        harness: {
          title: 'Ejecutor de harness',
          body: 'runHarness ejecuta Claude Code, Codex u OpenCode como subagente bajo un presupuesto y aplica tu política a sus solicitudes de permiso.',
        },
        acp: {
          title: 'ACP para editores',
          body: 'Sirve un agente Deuz a editores ACP como Zed y los IDE de JetBrains, con aprobaciones firmadas y un presupuesto, o dirige cualquier agente ACP desde el código.',
        },
        toolSearch: {
          title: 'Búsqueda de herramientas',
          body: 'Un catálogo grande de herramientas detrás de una sola herramienta de búsqueda. Una búsqueda nunca devuelve una herramienta que la política de la ejecución rechaza.',
        },
        aiSdk: {
          title: 'Proveedor AI SDK',
          body: 'Envuelve un modelo del Vercel AI SDK 7 en una línea, y el código AI SDK existente se ejecuta bajo un presupuesto Deuz.',
        },
        ledger: {
          title: 'Registro MCP',
          body: 'Un servidor MCP listo para cualquier cliente MCP: memoria versionada, un registro de gasto orientativo y un registro de recibos encadenado por hash.',
        },
      },
    },
    languagesLabel: 'Interfaz de la documentación',
    footerDocs: 'Documentación',
    footerChangelog: 'Registro de cambios',
    footerWhatsNew: 'Novedades de 2.5',
  },
  ru: {
    badge:
      'v2.5.0 — счётчик бюджета для агентов программирования, CLI deuz, ACP, поиск инструментов, ресурсы и промпты MCP',
    titleA: 'Один канонический протокол для',
    titleB: 'каждого ИИ-провайдера',
    lead: 'Чистый · web-first · мультипровайдерный TypeScript AI SDK',
    description:
      '29 провайдеров за одним дельта-потоком StreamPart. Ноль runtime-зависимостей — пакеты SQLite, Redis и Postgres, guardrail и handoff в цикле, MCP, который подключается сам. Ядро только на Web API, рассчитанное на любую среду с fetch.',
    ctaDocs: 'Начать',
    ctaWhatsNew: 'Что нового в 2.5',
    worksWith: 'Единая поверхность API для',
    providersMore:
      'Каждый знак открывает своё руководство. Любой другой OpenAI-совместимый хост работает через createOpenAICompatible.',
    stats: [
      { value: '29', label: 'id провайдеров' },
      { value: '88', label: 'подпутей' },
      { value: '3', label: 'пакета БД' },
      { value: '2.4 → 2.5', label: 'в основном аддитивно' },
    ],
    features: {
      stream: {
        title: 'Канонический дельта-поток',
        body: 'Каждый ответ провайдера нормализуется в типизированный поток StreamPart до того, как его увидит ваш код. Сырой SSE никогда не просачивается.',
      },
      agents: {
        title: 'Нативные агенты и сохраняемые swarm',
        body: 'Опциональные нативные агенты с проверкой результатов, общими и постоянными бюджетами. Swarm, которые создают задачи во время работы, делят общую доску и переходят между процессами по lease, в памяти, SQLite, Postgres или Redis.',
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
        body: 'Только Web API — без node:*, без Buffer, без внешнего состояния. Тестируется на Node; сборка бандла под браузерную платформу не пропускает код только для Node.',
      },
      media: {
        title: 'Речь, транскрипция, видео',
        body: 'generateSpeech, transcribe и generateVideo как отдельные виды моделей — OpenAI, ElevenLabs, Deepgram и любой релей OpenAI-Videos.',
      },
    },
    codeTitle: 'Стриминг в три строки',
    codeBody:
      'streamChat возвращается синхронно и никогда не бросает исключений — запрос лениво стартует при первом чтении. Поменяйте фабрику, чтобы сменить провайдера; больше ничего не меняется.',
    skillsTag: 'Для вашего кодового агента',
    skillsTitle: 'Ваш агент уже знает этот SDK',
    skillsBody:
      'В репозитории лежат два Agent Skill, поэтому агент пишет по реальной поверхности, а не восстанавливает её по памяти. Каждый символ сверяется с таблицей экспортов на каждом коммите, а каждый пример компилируется — несуществующее имя не пройдёт.',
    skillsCta: 'Как они проверяются',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Вся поверхность: инварианты, маршрутизатор «задача → файл» и двадцать пять справочных файлов, загружаемых только по необходимости.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'Проверенный перенос имя в имя из ai и пакетов @ai-sdk.',
      },
    ],
    release: {
      tag: 'Новое в 2.5',
      title: 'Бюджеты, квитанции и подтверждения для инструментов, которыми вы уже пользуетесь',
      body: '2.5 применяет их за пределами вашего кода: к агентам-программистам, таким как Claude Code и Codex, к редакторам с ACP, к коду на Vercel AI SDK и к MCP-клиентам.',
      preview: 'превью',
      cta: 'Читать заметки о 2.5',
      items: {
        meter: {
          title: 'Счётчик бюджета',
          body: 'Локальный прокси списывает запросы Claude Code или Codex к модели с бюджета и отвечает 402 на пределе. CLI deuz (превью) запускает его одной командой.',
        },
        harness: {
          title: 'Запуск harness',
          body: 'runHarness запускает Claude Code, Codex или OpenCode как суб-агента в рамках бюджета и применяет вашу политику к его запросам разрешений.',
        },
        acp: {
          title: 'ACP для редакторов',
          body: 'Подключите агента Deuz к редакторам с ACP, таким как Zed и IDE от JetBrains, с подписанными подтверждениями и бюджетом, или управляйте любым ACP-агентом из кода.',
        },
        toolSearch: {
          title: 'Поиск инструментов',
          body: 'Большой каталог инструментов за одним инструментом поиска. Поиск никогда не возвращает инструмент, который политика запуска запрещает.',
        },
        aiSdk: {
          title: 'Провайдер для AI SDK',
          body: 'Оберните модель Vercel AI SDK 7 одной строкой, и существующий код на AI SDK будет работать в рамках бюджета Deuz.',
        },
        ledger: {
          title: 'MCP-журнал',
          body: 'Готовый MCP-сервер для любого MCP-клиента: версионируемая память, справочный учёт расходов и журнал квитанций, связанный хешами.',
        },
      },
    },
    languagesLabel: 'Интерфейс документации',
    footerDocs: 'Документация',
    footerChangelog: 'История изменений',
    footerWhatsNew: 'Что нового в 2.5',
  },
  ja: {
    badge:
      'v2.5.0 — コーディングエージェント向け予算メーター、deuz CLI、ACP、ツール検索、MCP リソースとプロンプト',
    titleA: 'すべての AI プロバイダーを',
    titleB: 'ひとつの正規プロトコルで',
    lead: 'ピュア · ウェブファースト · マルチプロバイダー TypeScript AI SDK',
    description:
      '29 のプロバイダーを単一の StreamPart デルタストリームの背後に統合。ランタイム依存ゼロ — SQLite / Redis / Postgres パック、ループ内のガードレールとハンドオフ、自分で接続する MCP。Web API のみのコアで、fetch のある環境を対象に設計されています。',
    ctaDocs: 'はじめる',
    ctaWhatsNew: '2.5 の新機能',
    worksWith: '単一の API サーフェスで',
    providersMore:
      '各マークをクリックするとガイドが開きます。その他の OpenAI 互換ホストは createOpenAICompatible で利用できます。',
    stats: [
      { value: '29', label: 'プロバイダー ID' },
      { value: '88', label: 'サブパス' },
      { value: '3', label: 'データベースパック' },
      { value: '2.4 → 2.5', label: 'ほぼ加算的' },
    ],
    features: {
      stream: {
        title: '正規デルタストリーム',
        body: 'すべてのプロバイダー応答は、コードが目にする前に型付き StreamPart ストリームへ正規化されます。生の SSE が漏れることはありません。',
      },
      agents: {
        title: 'ネイティブエージェントと永続 Swarm',
        body: '任意で使えるネイティブエージェントで出力を検証し、予算を共有・永続化。実行中にタスクを生成し、ブラックボードを共有し、リースでプロセス間を移動する Swarm を、メモリ・SQLite・Postgres・Redis で動かせます。',
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
        body: 'Web API のみ — node:* なし、Buffer なし、環境状態なし。Node でテスト済み。ブラウザープラットフォーム向けのバンドルビルドが Node 専用コードの混入を防ぎます。',
      },
      media: {
        title: '音声・文字起こし・動画',
        body: 'generateSpeech、transcribe、generateVideo は独自のモデル種別 — OpenAI、ElevenLabs、Deepgram、任意の OpenAI-Videos リレー。',
      },
    },
    codeTitle: '3 行でストリーミング',
    codeBody:
      'streamChat は同期的に返り、決して例外を投げません — リクエストは最初の読み取り時に遅延開始します。ファクトリを差し替えるだけでプロバイダーを変更でき、他には何も変わりません。',
    skillsTag: 'コーディングエージェント向け',
    skillsTitle: 'エージェントはすでにこの SDK を知っています',
    skillsBody:
      'リポジトリには 2 つの Agent Skill が同梱されているため、エージェントは記憶から API を組み立てるのではなく実際の表面に従って書きます。含まれるすべてのシンボルはコミットごとにエクスポート表と照合され、すべての例はコンパイルされます。存在しない名前はマージできません。',
    skillsCta: '検証のしくみ',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: '表面のすべて: 不変条件、タスクからファイルへのルーター、必要なときだけ読み込まれる 26 個のリファレンス。',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'ai および @ai-sdk パッケージからの、名前単位で検証された移行。',
      },
    ],
    release: {
      tag: '2.5 の新機能',
      title: 'いつものツールに、予算・レシート・承認を',
      body: '2.5 はこれらを自分のコードの外にも適用します。Claude Code や Codex などのコーディングエージェント、ACP 対応エディタ、Vercel AI SDK のコード、MCP クライアントが対象です。',
      preview: 'プレビュー',
      cta: '2.5 のノートを読む',
      items: {
        meter: {
          title: '予算メーター',
          body: 'ローカルプロキシが Claude Code や Codex のモデルリクエストを予算に計上し、上限では 402 を返します。deuz CLI (プレビュー) なら 1 コマンドで起動できます。',
        },
        harness: {
          title: 'ハーネスランナー',
          body: 'runHarness は Claude Code、Codex、OpenCode を予算の範囲内でサブエージェントとして実行し、その権限リクエストにポリシーを適用します。',
        },
        acp: {
          title: 'エディタ向け ACP',
          body: 'Deuz エージェントを Zed や JetBrains IDE などの ACP 対応エディタに、署名付き承認と予算つきで提供できます。任意の ACP エージェントをコードから操作することもできます。',
        },
        toolSearch: {
          title: 'ツール検索',
          body: '大きなツールカタログを 1 つの検索ツールの背後に置きます。実行のポリシーが拒否するツールは検索結果に決して含まれません。',
        },
        aiSdk: {
          title: 'AI SDK プロバイダー',
          body: 'Vercel AI SDK 7 のモデルを 1 行でラップすれば、既存の AI SDK コードが Deuz の予算のもとで動きます。',
        },
        ledger: {
          title: 'MCP レジャー',
          body: 'あらゆる MCP クライアント向けの、すぐ使える MCP サーバー。バージョン管理されたメモリ、参考用の支出記録、ハッシュチェーンのレシートログを備えます。',
        },
      },
    },
    languagesLabel: 'ドキュメント UI',
    footerDocs: 'ドキュメント',
    footerChangelog: '変更履歴',
    footerWhatsNew: '2.5 の新機能',
  },
  ko: {
    badge: 'v2.5.0 — 코딩 에이전트용 예산 미터, deuz CLI, ACP, 도구 검색, MCP 리소스와 프롬프트',
    titleA: '모든 AI 프로바이더를 위한',
    titleB: '단 하나의 정규 프로토콜',
    lead: '순수 · 웹 우선 · 멀티 프로바이더 TypeScript AI SDK',
    description:
      '29개 프로바이더를 하나의 StreamPart 델타 스트림 뒤에 둡니다. 런타임 의존성 제로 — SQLite, Redis, Postgres 팩, 루프 안의 가드레일과 핸드오프, 스스로 연결하는 MCP. Web API만 쓰는 코어로, fetch가 있는 환경을 대상으로 설계되었습니다.',
    ctaDocs: '시작하기',
    ctaWhatsNew: '2.5의 새로운 점',
    worksWith: '단일 API 표면:',
    providersMore:
      '각 마크를 누르면 안내 문서가 열립니다. 그 밖의 OpenAI 호환 호스트는 createOpenAICompatible로 사용할 수 있습니다.',
    stats: [
      { value: '29', label: '프로바이더 id' },
      { value: '88', label: '서브패스' },
      { value: '3', label: '데이터베이스 팩' },
      { value: '2.4 → 2.5', label: '대부분 가산적' },
    ],
    features: {
      stream: {
        title: '정규 델타 스트림',
        body: '모든 프로바이더 응답은 코드가 보기 전에 타입이 지정된 StreamPart 스트림으로 정규화됩니다. 원시 SSE가 새어 나가는 일은 없습니다.',
      },
      agents: {
        title: '네이티브 에이전트와 영속 Swarm',
        body: '선택형 네이티브 에이전트로 결과를 검증하고 예산을 공유·영속화합니다. 실행 중에 작업을 만들고 블랙보드를 공유하며 리스로 프로세스 간을 옮겨 다니는 Swarm을 메모리, SQLite, Postgres, Redis에서 실행합니다.',
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
        body: 'Web API만 사용 — node:* 없음, Buffer 없음, 환경 상태 없음. Node에서 테스트합니다. 브라우저 플랫폼용 번들 빌드가 Node 전용 코드의 유입을 막습니다.',
      },
      media: {
        title: '음성, 전사, 비디오',
        body: 'generateSpeech, transcribe, generateVideo는 고유 모델 종류 — OpenAI, ElevenLabs, Deepgram, 임의의 OpenAI-Videos 릴레이.',
      },
    },
    codeTitle: '세 줄로 스트리밍',
    codeBody:
      'streamChat은 동기적으로 반환되며 절대 예외를 던지지 않습니다 — 요청은 첫 읽기에서 지연 시작됩니다. 팩토리만 바꾸면 프로바이더가 바뀌고, 그 외에는 아무것도 달라지지 않습니다.',
    skillsTag: '코딩 에이전트를 위해',
    skillsTitle: '에이전트는 이미 이 SDK를 알고 있습니다',
    skillsBody:
      '저장소에 두 개의 Agent Skill이 함께 제공되므로, 에이전트는 기억으로 API를 재구성하지 않고 실제 표면에 맞춰 작성합니다. 모든 심벌은 커밋마다 익스포트 표와 대조되고 모든 예제는 컴파일됩니다. 존재하지 않는 이름은 머지될 수 없습니다.',
    skillsCta: '어떻게 검증되나',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: '표면 전체: 불변 조건, 작업에서 파일로 가는 라우터, 필요할 때만 로드되는 26개의 레퍼런스 파일.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'ai 및 @ai-sdk 패키지에서의 이름 단위 검증 마이그레이션.',
      },
    ],
    release: {
      tag: '2.5의 새로운 기능',
      title: '이미 쓰고 있는 도구에 예산, 영수증, 승인을',
      body: '2.5는 이를 내 코드 밖에도 적용합니다. Claude Code와 Codex 같은 코딩 에이전트, ACP 에디터, Vercel AI SDK 코드, MCP 클라이언트가 대상입니다.',
      preview: '프리뷰',
      cta: '2.5 노트 읽기',
      items: {
        meter: {
          title: '예산 미터',
          body: '로컬 프록시가 Claude Code나 Codex의 모델 요청을 예산에 기록하고, 한도에 이르면 402로 응답합니다. deuz CLI(프리뷰)는 명령 하나로 이를 시작합니다.',
        },
        harness: {
          title: '하니스 러너',
          body: 'runHarness는 Claude Code, Codex, OpenCode를 예산 안에서 서브 에이전트로 실행하고, 그 권한 요청에 정책을 적용합니다.',
        },
        acp: {
          title: '에디터용 ACP',
          body: 'Deuz 에이전트를 Zed와 JetBrains IDE 같은 ACP 에디터에 서명된 승인과 예산과 함께 제공하거나, 어떤 ACP 에이전트든 코드에서 구동할 수 있습니다.',
        },
        toolSearch: {
          title: '도구 검색',
          body: '큰 도구 카탈로그를 검색 도구 하나 뒤에 둡니다. 실행의 정책이 거부하는 도구는 검색 결과에 절대 나오지 않습니다.',
        },
        aiSdk: {
          title: 'AI SDK 프로바이더',
          body: 'Vercel AI SDK 7 모델을 한 줄로 감싸면, 기존 AI SDK 코드가 Deuz 예산 아래에서 실행됩니다.',
        },
        ledger: {
          title: 'MCP 레저',
          body: '모든 MCP 클라이언트를 위한 바로 쓸 수 있는 MCP 서버입니다. 버전 관리되는 메모리, 참고용 지출 기록, 해시 체인 영수증 로그를 제공합니다.',
        },
      },
    },
    languagesLabel: '문서 UI',
    footerDocs: '문서',
    footerChangelog: '변경 이력',
    footerWhatsNew: '2.5의 새로운 점',
  },
  zh: {
    badge: 'v2.5.0 — 面向编码代理的预算计量器、deuz CLI、ACP、工具搜索以及 MCP 资源与提示词',
    titleA: '为每一个 AI 提供商',
    titleB: '提供同一条规范协议',
    lead: '纯净 · Web 优先 · 多提供商 TypeScript AI SDK',
    description:
      '29 个提供商统一在同一条 StreamPart 增量流之后。零运行时依赖 — SQLite、Redis、Postgres 包，循环内的护栏与交接，会自己连接的 MCP。核心仅使用 Web API，面向任何提供 fetch 的环境。',
    ctaDocs: '快速开始',
    ctaWhatsNew: '2.5 新特性',
    worksWith: '同一套 API 表面覆盖',
    providersMore:
      '点击任一标识即可打开对应指南。其他 OpenAI 兼容主机可通过 createOpenAICompatible 使用。',
    stats: [
      { value: '29', label: '提供商 id' },
      { value: '88', label: '子路径' },
      { value: '3', label: '数据库包' },
      { value: '2.4 → 2.5', label: '几乎全部是加法' },
    ],
    features: {
      stream: {
        title: '规范增量流',
        body: '每个提供商的响应在你的代码看到之前都会被规范化为带类型的 StreamPart 流。原始 SSE 字节永远不会泄漏。',
      },
      agents: {
        title: '原生智能体与持久化 Swarm',
        body: '按需启用原生智能体，验证结果并共享、持久化预算。Swarm 可在运行时派生任务、共享黑板，并通过租约在进程间迁移，支持内存、SQLite、Postgres 或 Redis。',
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
        body: '仅使用 Web API — 没有 node:*、没有 Buffer、没有环境状态。在 Node 上测试；面向浏览器平台的打包构建会把仅限 Node 的代码挡在外面。',
      },
      media: {
        title: '语音、转写、视频',
        body: 'generateSpeech、transcribe 和 generateVideo 是独立的模型种类 — OpenAI、ElevenLabs、Deepgram，以及任何 OpenAI-Videos 中继。',
      },
    },
    codeTitle: '三行代码实现流式输出',
    codeBody:
      'streamChat 同步返回且永不抛出异常 — 请求在首次读取时惰性启动。换一个 factory 即可切换提供商，其余一切保持不变。',
    skillsTag: '为你的编码代理准备',
    skillsTitle: '你的编码代理已经了解这个 SDK',
    skillsBody:
      '仓库随附两个 Agent Skill，代理据此按真实接口编写代码，而不是凭记忆拼凑。其中每个符号都会在每次提交时与导出表核对，每个示例都会编译——不存在的名称无法合入。',
    skillsCta: '它们如何被验证',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: '完整接口：不变量、从任务到文件的路由，以及仅在需要时加载的二十五个参考文件。',
      },
      { name: 'migrate-from-ai-sdk', body: '从 ai 与 @ai-sdk 系列包逐个名称验证过的迁移路径。' },
    ],
    release: {
      tag: '2.5 新增内容',
      title: '为你已经在用的工具带来预算、回执和审批',
      body: '2.5 把它们用到你自己的代码之外：Claude Code、Codex 这样的编码智能体，ACP 编辑器，Vercel AI SDK 代码，以及 MCP 客户端。',
      preview: '预览',
      cta: '阅读 2.5 说明',
      items: {
        meter: {
          title: '预算计量器',
          body: '本地代理把 Claude Code 或 Codex 的模型请求记入预算，到达上限时返回 402。deuz CLI（预览）用一条命令启动它。',
        },
        harness: {
          title: 'Harness 运行器',
          body: 'runHarness 在预算内把 Claude Code、Codex 或 OpenCode 作为子智能体运行，并把你的策略应用到它的权限请求上。',
        },
        acp: {
          title: '面向编辑器的 ACP',
          body: '把 Deuz 智能体提供给 Zed、JetBrains IDE 等 ACP 编辑器，带有签名审批和预算；也可以从代码驱动任意 ACP 智能体。',
        },
        toolSearch: {
          title: '工具搜索',
          body: '把庞大的工具目录放在一个搜索工具之后。搜索绝不会返回运行策略拒绝的工具。',
        },
        aiSdk: {
          title: 'AI SDK 提供方',
          body: '用一行代码包装 Vercel AI SDK 7 的模型，现有的 AI SDK 代码就能在 Deuz 预算下运行。',
        },
        ledger: {
          title: 'MCP 账本',
          body: '面向任意 MCP 客户端的现成 MCP 服务器：版本化记忆、仅供参考的支出记录，以及哈希链回执日志。',
        },
      },
    },
    languagesLabel: '文档界面',
    footerDocs: '文档',
    footerChangelog: '更新日志',
    footerWhatsNew: '2.5 新特性',
  },
};
