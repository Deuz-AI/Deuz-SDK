import type { Locale } from './i18n';

export type HomeFeatureKey = 'stream' | 'agents' | 'stores' | 'mcp' | 'edge' | 'media';

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
  languagesLabel: string;
  footerDocs: string;
  footerChangelog: string;
  footerWhatsNew: string;
};

export const homeCopy: Record<Locale, HomeCopy> = {
  en: {
    badge: 'v2.1.0 — Native agents, validated results & durable swarm DAGs',
    titleA: 'One canonical wire for',
    titleB: 'every AI provider',
    lead: 'Pure · Web-first · Multi-provider AI SDK for TypeScript',
    description:
      '29 providers behind one StreamPart delta stream. Zero runtime dependencies — SQLite, Redis and Postgres packs, guardrails and handoffs in the loop, MCP that connects itself. Runs anywhere fetch runs.',
    ctaDocs: 'Get started',
    ctaWhatsNew: 'What is new in 2.1',
    worksWith: 'One API surface across',
    providersMore:
      'Each mark opens its guide. Any other OpenAI-compatible host works through createOpenAICompatible.',
    stats: [
      { value: '29', label: 'provider ids' },
      { value: '55', label: 'subpaths' },
      { value: '3', label: 'database packs' },
      { value: '2.0 → 2.1', label: 'mostly additive' },
    ],
    features: {
      stream: {
        title: 'Canonical delta stream',
        body: 'Every provider response is normalized to one typed StreamPart stream before your code sees it. No raw SSE ever leaks through.',
      },
      agents: {
        title: 'Native agents and durable swarms',
        body: 'Opt-in runAgent with validated results, shared policy and budgets. Fixed swarm DAGs with bounded concurrency and memory/SQLite persistence.',
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
    skillsTag: 'For your coding agent',
    skillsTitle: 'Your coding agent already knows this SDK',
    skillsBody:
      'Two Agent Skills ship with the repository, so an agent writes against the real surface instead of reconstructing it from memory. Every symbol in them is resolved against the export table on each commit and every example is compiled, so a name that does not exist cannot be merged.',
    skillsCta: 'How they are verified',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'The whole surface: the invariants, a task-to-file router, and thirteen reference files loaded only when a task needs them.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'The verified name-by-name port from ai and @ai-sdk packages.',
      },
    ],
    languagesLabel: 'Documentation UI',
    footerDocs: 'Documentation',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'What is new in 2.1',
  },
  de: {
    badge: 'v2.1.0 — Native Agenten, validierte Ergebnisse und persistente Swarm-DAGs',
    titleA: 'Ein kanonisches Protokoll für',
    titleB: 'jeden KI-Provider',
    lead: 'Pures · Web-first · Multi-Provider AI SDK für TypeScript',
    description:
      '29 Provider hinter einem StreamPart-Delta-Stream. Keine Runtime-Abhängigkeiten — SQLite-, Redis- und Postgres-Packs, Guardrails und Handoffs im Loop, MCP das sich selbst verbindet. Läuft überall, wo fetch läuft.',
    ctaDocs: 'Loslegen',
    ctaWhatsNew: 'Neu in 2.1',
    worksWith: 'Eine API-Oberfläche für',
    providersMore:
      'Jedes Zeichen öffnet seine Anleitung. Jeder andere OpenAI-kompatible Host läuft über createOpenAICompatible.',
    stats: [
      { value: '29', label: 'Provider-IDs' },
      { value: '55', label: 'Subpfade' },
      { value: '3', label: 'Datenbank-Packs' },
      { value: '2.0 → 2.1', label: 'größtenteils additiv' },
    ],
    features: {
      stream: {
        title: 'Kanonischer Delta-Stream',
        body: 'Jede Provider-Antwort wird zu einem typisierten StreamPart-Stream normalisiert, bevor dein Code sie sieht. Rohe SSE-Bytes dringen nie durch.',
      },
      agents: {
        title: 'Native Agenten und persistente Swarms',
        body: 'Optionale native Agenten mit validierten Ergebnissen, gemeinsamen Richtlinien und Budgets. Swarm-DAGs mit begrenzter Parallelität und Memory-/SQLite-Persistenz.',
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
    skillsTag: 'Für deinen Coding-Agenten',
    skillsTitle: 'Dein Coding-Agent kennt dieses SDK bereits',
    skillsBody:
      'Zwei Agent Skills liegen im Repository, damit ein Agent gegen die echte Oberfläche schreibt, statt sie aus dem Gedächtnis zu rekonstruieren. Jedes Symbol darin wird bei jedem Commit gegen die Export-Tabelle aufgelöst und jedes Beispiel kompiliert — ein Name, den es nicht gibt, kommt nicht durch.',
    skillsCta: 'Wie sie geprüft werden',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Die gesamte Oberfläche: die Invarianten, ein Router von Aufgabe zu Datei und dreizehn Referenzdateien, die nur bei Bedarf geladen werden.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'Die geprüfte Migration Name für Name von ai und den @ai-sdk-Paketen.',
      },
    ],
    languagesLabel: 'Dokumentations-UI',
    footerDocs: 'Dokumentation',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'Neu in 2.1',
  },
  tr: {
    badge: 'v2.1.0 — Native ajanlar, doğrulanmış çıktılar ve kalıcı swarm DAG’leri',
    titleA: 'Tüm yapay zeka sağlayıcıları için',
    titleB: 'tek kanonik protokol',
    lead: 'Saf · Web öncelikli · Çok sağlayıcılı TypeScript AI SDK',
    description:
      '29 sağlayıcı, tek bir StreamPart delta akışının arkasında. Sıfır çalışma zamanı bağımlılığı — SQLite, Redis ve Postgres paketleri, döngüde guardrail ve handoff, kendini bağlayan MCP. fetch’in çalıştığı her yerde çalışır.',
    ctaDocs: 'Başla',
    ctaWhatsNew: '2.1’da neler yeni',
    worksWith: 'Tek API yüzeyi:',
    providersMore:
      'Her işaret kendi rehberini açar. Diğer OpenAI uyumlu her sunucu createOpenAICompatible ile çalışır.',
    stats: [
      { value: '29', label: 'sağlayıcı kimliği' },
      { value: '55', label: 'alt yol' },
      { value: '3', label: 'veritabanı paketi' },
      { value: '2.0 → 2.1', label: 'çoğunlukla eklemeli' },
    ],
    features: {
      stream: {
        title: 'Kanonik delta akışı',
        body: 'Her sağlayıcı yanıtı, kodunuz görmeden önce tipli tek bir StreamPart akışına normalize edilir. Ham SSE baytları asla sızmaz.',
      },
      agents: {
        title: 'Native ajanlar ve kalıcı swarm',
        body: 'İsteğe bağlı native ajanlar: doğrulanmış çıktılar, ortak politika ve bütçe. Sınırlı eşzamanlı swarm DAG’leri, bellek/SQLite kalıcılığı.',
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
    skillsTag: 'Kod yazan ajanınız için',
    skillsTitle: 'Ajanınız bu SDK’yı zaten biliyor',
    skillsBody:
      'Repo iki Agent Skill ile geliyor; ajan API’yi hafızasından yeniden kurmak yerine gerçek yüzeye göre yazıyor. İçlerindeki her sembol her commit’te export tablosuna karşı çözülüyor ve her örnek derleniyor — var olmayan bir isim merge edilemiyor.',
    skillsCta: 'Nasıl doğrulanıyor',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Yüzeyin tamamı: değişmezler, göreve göre dosya yönlendirmesi ve yalnızca gerektiğinde yüklenen on üç referans dosyası.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'ai ve @ai-sdk paketlerinden isim isim doğrulanmış geçiş.',
      },
    ],
    languagesLabel: 'Dokümantasyon arayüzü',
    footerDocs: 'Dokümantasyon',
    footerChangelog: 'Sürüm notları',
    footerWhatsNew: '2.1’da neler yeni',
  },
  fr: {
    badge: 'v2.1.0 — Agents natifs, résultats validés et DAG de swarm persistants',
    titleA: 'Un protocole canonique pour',
    titleB: 'chaque fournisseur d’IA',
    lead: 'SDK IA TypeScript pur · web-first · multi-fournisseur',
    description:
      '29 fournisseurs derrière un seul flux delta StreamPart. Zéro dépendance runtime — packs SQLite, Redis et Postgres, guardrails et handoffs dans la boucle, MCP qui se connecte tout seul. Fonctionne partout où fetch fonctionne.',
    ctaDocs: 'Commencer',
    ctaWhatsNew: 'Nouveautés de la 2.1',
    worksWith: 'Une seule surface d’API pour',
    providersMore:
      'Chaque marque ouvre son guide. Tout autre hôte compatible OpenAI passe par createOpenAICompatible.',
    stats: [
      { value: '29', label: 'ids de fournisseur' },
      { value: '55', label: 'sous-chemins' },
      { value: '3', label: 'packs base de données' },
      { value: '2.0 → 2.1', label: 'surtout additif' },
    ],
    features: {
      stream: {
        title: 'Flux delta canonique',
        body: 'Chaque réponse de fournisseur est normalisée en un flux StreamPart typé avant que votre code ne la voie. Aucun SSE brut ne s’échappe jamais.',
      },
      agents: {
        title: 'Agents natifs et swarms persistants',
        body: 'Agents natifs optionnels, résultats validés, politiques et budgets partagés. DAG de swarm à concurrence limitée, avec stockage mémoire ou SQLite.',
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
    skillsTag: 'Pour votre agent de code',
    skillsTitle: 'Votre agent connaît déjà ce SDK',
    skillsBody:
      'Deux Agent Skills sont fournis avec le dépôt : l’agent écrit face à la vraie surface au lieu de la reconstituer de mémoire. Chaque symbole y est résolu contre la table d’exports à chaque commit et chaque exemple est compilé — un nom inexistant ne peut pas être fusionné.',
    skillsCta: 'Comment ils sont vérifiés',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Toute la surface : les invariants, un routeur tâche-vers-fichier et treize fichiers de référence chargés seulement quand la tâche l’exige.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'Le portage vérifié, nom par nom, depuis ai et les paquets @ai-sdk.',
      },
    ],
    languagesLabel: 'Interface de la documentation',
    footerDocs: 'Documentation',
    footerChangelog: 'Journal des modifications',
    footerWhatsNew: 'Nouveautés de la 2.1',
  },
  it: {
    badge: 'v2.1.0 — Agenti nativi, risultati validati e DAG swarm persistenti',
    titleA: 'Un protocollo canonico per',
    titleB: 'ogni provider di IA',
    lead: 'SDK IA TypeScript puro · web-first · multi-provider',
    description:
      '29 provider dietro un unico stream delta StreamPart. Zero dipendenze runtime — pack SQLite, Redis e Postgres, guardrail e handoff nel loop, MCP che si connette da solo. Funziona ovunque funzioni fetch.',
    ctaDocs: 'Inizia',
    ctaWhatsNew: 'Novità della 2.1',
    worksWith: 'Un’unica superficie API per',
    providersMore:
      'Ogni marchio apre la sua guida. Qualsiasi altro host compatibile con OpenAI passa da createOpenAICompatible.',
    stats: [
      { value: '29', label: 'id provider' },
      { value: '55', label: 'sottopath' },
      { value: '3', label: 'pack database' },
      { value: '2.0 → 2.1', label: 'per lo più additivo' },
    ],
    features: {
      stream: {
        title: 'Stream delta canonico',
        body: 'Ogni risposta del provider viene normalizzata in un unico stream StreamPart tipizzato prima che il tuo codice la veda. Nessun SSE grezzo trapela mai.',
      },
      agents: {
        title: 'Agenti nativi e swarm persistenti',
        body: 'Agenti nativi opzionali, risultati validati, regole e budget condivisi. DAG swarm con concorrenza limitata e persistenza in memoria o SQLite.',
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
    skillsTag: 'Per il tuo agente di codice',
    skillsTitle: 'Il tuo agente conosce già questo SDK',
    skillsBody:
      'Il repository include due Agent Skill, così l’agente scrive sulla superficie reale invece di ricostruirla a memoria. Ogni simbolo viene risolto contro la tabella degli export a ogni commit e ogni esempio viene compilato: un nome che non esiste non passa.',
    skillsCta: 'Come vengono verificate',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'L’intera superficie: gli invarianti, un router da attività a file e tredici file di riferimento caricati solo quando servono.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'La migrazione verificata, nome per nome, da ai e dai pacchetti @ai-sdk.',
      },
    ],
    languagesLabel: 'Interfaccia della documentazione',
    footerDocs: 'Documentazione',
    footerChangelog: 'Changelog',
    footerWhatsNew: 'Novità della 2.1',
  },
  es: {
    badge: 'v2.1.0 — Agentes nativos, resultados validados y DAG de swarm persistentes',
    titleA: 'Un protocolo canónico para',
    titleB: 'cada proveedor de IA',
    lead: 'SDK de IA para TypeScript puro · web-first · multiproveedor',
    description:
      '29 proveedores detrás de un único stream delta StreamPart. Cero dependencias en tiempo de ejecución — packs SQLite, Redis y Postgres, guardrails y handoffs en el bucle, MCP que se conecta solo. Funciona dondequiera que funcione fetch.',
    ctaDocs: 'Empezar',
    ctaWhatsNew: 'Novedades de 2.1',
    worksWith: 'Una sola superficie de API para',
    providersMore:
      'Cada marca abre su guía. Cualquier otro host compatible con OpenAI funciona mediante createOpenAICompatible.',
    stats: [
      { value: '29', label: 'ids de proveedor' },
      { value: '55', label: 'subrutas' },
      { value: '3', label: 'packs de base de datos' },
      { value: '2.0 → 2.1', label: 'casi todo aditivo' },
    ],
    features: {
      stream: {
        title: 'Stream delta canónico',
        body: 'Cada respuesta del proveedor se normaliza a un stream StreamPart tipado antes de que tu código la vea. Nunca se filtra SSE crudo.',
      },
      agents: {
        title: 'Agentes nativos y swarms persistentes',
        body: 'Agentes nativos opcionales, resultados validados, políticas y presupuestos compartidos. DAG de swarm con concurrencia limitada y memoria o SQLite.',
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
    skillsTag: 'Para tu agente de código',
    skillsTitle: 'Tu agente ya conoce este SDK',
    skillsBody:
      'El repositorio incluye dos Agent Skills, de modo que el agente escribe contra la superficie real en lugar de reconstruirla de memoria. Cada símbolo se resuelve contra la tabla de exports en cada commit y cada ejemplo se compila: un nombre que no existe no se puede fusionar.',
    skillsCta: 'Cómo se verifican',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Toda la superficie: los invariantes, un enrutador de tarea a archivo y trece archivos de referencia que se cargan solo cuando hacen falta.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'La migración verificada, nombre por nombre, desde ai y los paquetes @ai-sdk.',
      },
    ],
    languagesLabel: 'Interfaz de la documentación',
    footerDocs: 'Documentación',
    footerChangelog: 'Registro de cambios',
    footerWhatsNew: 'Novedades de 2.1',
  },
  ru: {
    badge: 'v2.1.0 — Нативные агенты, проверяемые результаты и сохраняемые DAG swarm',
    titleA: 'Один канонический протокол для',
    titleB: 'каждого ИИ-провайдера',
    lead: 'Чистый · web-first · мультипровайдерный TypeScript AI SDK',
    description:
      '29 провайдеров за одним дельта-потоком StreamPart. Ноль runtime-зависимостей — пакеты SQLite, Redis и Postgres, guardrail и handoff в цикле, MCP, который подключается сам. Работает везде, где работает fetch.',
    ctaDocs: 'Начать',
    ctaWhatsNew: 'Что нового в 2.1',
    worksWith: 'Единая поверхность API для',
    providersMore:
      'Каждый знак открывает своё руководство. Любой другой OpenAI-совместимый хост работает через createOpenAICompatible.',
    stats: [
      { value: '29', label: 'id провайдеров' },
      { value: '55', label: 'подпутей' },
      { value: '3', label: 'пакета БД' },
      { value: '2.0 → 2.1', label: 'в основном аддитивно' },
    ],
    features: {
      stream: {
        title: 'Канонический дельта-поток',
        body: 'Каждый ответ провайдера нормализуется в типизированный поток StreamPart до того, как его увидит ваш код. Сырой SSE никогда не просачивается.',
      },
      agents: {
        title: 'Нативные агенты и сохраняемые swarm',
        body: 'Опциональные нативные агенты с проверкой результатов, общими политиками и бюджетами. Фиксированные DAG swarm с ограниченным параллелизмом и хранением в памяти или SQLite.',
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
    skillsTag: 'Для вашего кодового агента',
    skillsTitle: 'Ваш агент уже знает этот SDK',
    skillsBody:
      'В репозитории лежат два Agent Skill, поэтому агент пишет по реальной поверхности, а не восстанавливает её по памяти. Каждый символ сверяется с таблицей экспортов на каждом коммите, а каждый пример компилируется — несуществующее имя не пройдёт.',
    skillsCta: 'Как они проверяются',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: 'Вся поверхность: инварианты, маршрутизатор «задача → файл» и тринадцать справочных файлов, загружаемых только по необходимости.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'Проверенный перенос имя в имя из ai и пакетов @ai-sdk.',
      },
    ],
    languagesLabel: 'Интерфейс документации',
    footerDocs: 'Документация',
    footerChangelog: 'История изменений',
    footerWhatsNew: 'Что нового в 2.1',
  },
  ja: {
    badge: 'v2.1.0 — ネイティブエージェント、出力検証、永続化する Swarm DAG',
    titleA: 'すべての AI プロバイダーを',
    titleB: 'ひとつの正規プロトコルで',
    lead: 'ピュア · ウェブファースト · マルチプロバイダー TypeScript AI SDK',
    description:
      '29 のプロバイダーを単一の StreamPart デルタストリームの背後に統合。ランタイム依存ゼロ — SQLite / Redis / Postgres パック、ループ内のガードレールとハンドオフ、自分で接続する MCP。fetch が動くところならどこでも動きます。',
    ctaDocs: 'はじめる',
    ctaWhatsNew: '2.1 の新機能',
    worksWith: '単一の API サーフェスで',
    providersMore:
      '各マークをクリックするとガイドが開きます。その他の OpenAI 互換ホストは createOpenAICompatible で利用できます。',
    stats: [
      { value: '29', label: 'プロバイダー ID' },
      { value: '55', label: 'サブパス' },
      { value: '3', label: 'データベースパック' },
      { value: '2.0 → 2.1', label: 'ほぼ加算的' },
    ],
    features: {
      stream: {
        title: '正規デルタストリーム',
        body: 'すべてのプロバイダー応答は、コードが目にする前に型付き StreamPart ストリームへ正規化されます。生の SSE が漏れることはありません。',
      },
      agents: {
        title: 'ネイティブエージェントと永続 Swarm',
        body: '任意で使えるネイティブエージェントで出力を検証し、ポリシーと予算を共有。固定の Swarm DAG を同時実行数の上限付きで処理し、メモリまたは SQLite に保存します。',
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
    skillsTag: 'コーディングエージェント向け',
    skillsTitle: 'エージェントはすでにこの SDK を知っています',
    skillsBody:
      'リポジトリには 2 つの Agent Skill が同梱されているため、エージェントは記憶から API を組み立てるのではなく実際の表面に従って書きます。含まれるすべてのシンボルはコミットごとにエクスポート表と照合され、すべての例はコンパイルされます。存在しない名前はマージできません。',
    skillsCta: '検証のしくみ',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: '表面のすべて: 不変条件、タスクからファイルへのルーター、必要なときだけ読み込まれる 13 個のリファレンス。',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'ai および @ai-sdk パッケージからの、名前単位で検証された移行。',
      },
    ],
    languagesLabel: 'ドキュメント UI',
    footerDocs: 'ドキュメント',
    footerChangelog: '変更履歴',
    footerWhatsNew: '2.1 の新機能',
  },
  ko: {
    badge: 'v2.1.0 — 네이티브 에이전트, 결과 검증, 영속 Swarm DAG',
    titleA: '모든 AI 프로바이더를 위한',
    titleB: '단 하나의 정규 프로토콜',
    lead: '순수 · 웹 우선 · 멀티 프로바이더 TypeScript AI SDK',
    description:
      '29개 프로바이더를 하나의 StreamPart 델타 스트림 뒤에 둡니다. 런타임 의존성 제로 — SQLite, Redis, Postgres 팩, 루프 안의 가드레일과 핸드오프, 스스로 연결하는 MCP. fetch가 동작하는 곳이라면 어디서든 실행됩니다.',
    ctaDocs: '시작하기',
    ctaWhatsNew: '2.1의 새로운 점',
    worksWith: '단일 API 표면:',
    providersMore:
      '각 마크를 누르면 안내 문서가 열립니다. 그 밖의 OpenAI 호환 호스트는 createOpenAICompatible로 사용할 수 있습니다.',
    stats: [
      { value: '29', label: '프로바이더 id' },
      { value: '55', label: '서브패스' },
      { value: '3', label: '데이터베이스 팩' },
      { value: '2.0 → 2.1', label: '대부분 가산적' },
    ],
    features: {
      stream: {
        title: '정규 델타 스트림',
        body: '모든 프로바이더 응답은 코드가 보기 전에 타입이 지정된 StreamPart 스트림으로 정규화됩니다. 원시 SSE가 새어 나가는 일은 없습니다.',
      },
      agents: {
        title: '네이티브 에이전트와 영속 Swarm',
        body: '선택형 네이티브 에이전트로 결과를 검증하고 정책과 예산을 공유합니다. 고정된 Swarm DAG의 동시 실행 수를 제한하고 메모리 또는 SQLite에 저장합니다.',
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
    skillsTag: '코딩 에이전트를 위해',
    skillsTitle: '에이전트는 이미 이 SDK를 알고 있습니다',
    skillsBody:
      '저장소에 두 개의 Agent Skill이 함께 제공되므로, 에이전트는 기억으로 API를 재구성하지 않고 실제 표면에 맞춰 작성합니다. 모든 심벌은 커밋마다 익스포트 표와 대조되고 모든 예제는 컴파일됩니다. 존재하지 않는 이름은 머지될 수 없습니다.',
    skillsCta: '어떻게 검증되나',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: '표면 전체: 불변 조건, 작업에서 파일로 가는 라우터, 필요할 때만 로드되는 13개의 레퍼런스 파일.',
      },
      {
        name: 'migrate-from-ai-sdk',
        body: 'ai 및 @ai-sdk 패키지에서의 이름 단위 검증 마이그레이션.',
      },
    ],
    languagesLabel: '문서 UI',
    footerDocs: '문서',
    footerChangelog: '변경 이력',
    footerWhatsNew: '2.1의 새로운 점',
  },
  zh: {
    badge: 'v2.1.0 — 原生智能体、结果验证与持久化 Swarm DAG',
    titleA: '为每一个 AI 提供商',
    titleB: '提供同一条规范协议',
    lead: '纯净 · Web 优先 · 多提供商 TypeScript AI SDK',
    description:
      '29 个提供商统一在同一条 StreamPart 增量流之后。零运行时依赖 — SQLite、Redis、Postgres 包，循环内的护栏与交接，会自己连接的 MCP。fetch 能运行的地方就能运行。',
    ctaDocs: '快速开始',
    ctaWhatsNew: '2.1 新特性',
    worksWith: '同一套 API 表面覆盖',
    providersMore:
      '点击任一标识即可打开对应指南。其他 OpenAI 兼容主机可通过 createOpenAICompatible 使用。',
    stats: [
      { value: '29', label: '提供商 id' },
      { value: '55', label: '子路径' },
      { value: '3', label: '数据库包' },
      { value: '2.0 → 2.1', label: '几乎全部是加法' },
    ],
    features: {
      stream: {
        title: '规范增量流',
        body: '每个提供商的响应在你的代码看到之前都会被规范化为带类型的 StreamPart 流。原始 SSE 字节永远不会泄漏。',
      },
      agents: {
        title: '原生智能体与持久化 Swarm',
        body: '按需启用原生智能体，验证结果并共享策略与预算。固定 Swarm DAG 支持并发上限，以及内存或 SQLite 持久化。',
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
    skillsTag: '为你的编码代理准备',
    skillsTitle: '你的编码代理已经了解这个 SDK',
    skillsBody:
      '仓库随附两个 Agent Skill，代理据此按真实接口编写代码，而不是凭记忆拼凑。其中每个符号都会在每次提交时与导出表核对，每个示例都会编译——不存在的名称无法合入。',
    skillsCta: '它们如何被验证',
    skillsList: [
      {
        name: 'deuz-sdk',
        body: '完整接口：不变量、从任务到文件的路由，以及仅在需要时加载的十三个参考文件。',
      },
      { name: 'migrate-from-ai-sdk', body: '从 ai 与 @ai-sdk 系列包逐个名称验证过的迁移路径。' },
    ],
    languagesLabel: '文档界面',
    footerDocs: '文档',
    footerChangelog: '更新日志',
    footerWhatsNew: '2.1 新特性',
  },
};
