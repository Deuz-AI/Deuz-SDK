import { RootProvider } from 'fumadocs-ui/provider/next';
import { i18nProvider } from 'fumadocs-ui/i18n';
import { Banner } from 'fumadocs-ui/components/banner';
import Link from 'next/link';
import '../global.css';
import { Instrument_Serif, Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { i18n, isLocale, type Locale } from '@/lib/i18n';
import { translations } from '@/lib/translations';
import { localePath } from '@/lib/layout.shared';
import { appName, siteUrl } from '@/lib/shared';

const inter = Inter({
  subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'],
  display: 'swap',
  variable: '--font-sans',
});

// Display face for the hero and section headings (Latin locales only — see global.css).
const instrumentSerif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-instrument-serif',
});

const siteDescriptions: Record<Locale, string> = {
  en: 'A pure, web-first, multi-provider TypeScript AI SDK with zero runtime dependencies and one canonical streaming wire.',
  de: 'Ein pures, web-first, Multi-Provider TypeScript AI SDK ohne Runtime-Abhängigkeiten und mit einem kanonischen Streaming-Protokoll.',
  tr: 'Sıfır çalışma zamanı bağımlılığı ve tek bir kanonik akış protokolüyle saf, web öncelikli, çok sağlayıcılı bir TypeScript yapay zeka SDK’sı.',
  fr: 'Un SDK IA TypeScript pur, web-first et multi-fournisseur, sans dépendances runtime et avec un protocole de streaming canonique unique.',
  it: 'Un SDK IA TypeScript puro, web-first e multi-provider, senza dipendenze runtime e con un unico protocollo di streaming canonico.',
  es: 'Un SDK de IA para TypeScript puro, web-first y multiproveedor, sin dependencias en tiempo de ejecución y con un único protocolo de streaming canónico.',
  ru: 'Чистый, web-first, мультипровайдерный TypeScript AI SDK без runtime-зависимостей и с единым каноническим протоколом стриминга.',
  ja: 'ランタイム依存ゼロ、単一の正規ストリーミングプロトコルを備えた、ピュアでウェブファーストなマルチプロバイダー TypeScript AI SDK。',
  ko: '런타임 의존성이 없고 단일 정규 스트리밍 프로토콜을 갖춘 순수한 웹 우선 멀티 프로바이더 TypeScript AI SDK.',
  zh: '一个纯净、Web 优先、多提供商的 TypeScript AI SDK：零运行时依赖，单一规范流式协议。',
};

const bannerCopy: Record<Locale, { text: string; link: string }> = {
  en: {
    text: 'Deuz SDK 2.3 is out — an MCP server, A2A, realtime voice, batch requests and Redis backends.',
    link: 'What is new in 2.3',
  },
  de: {
    text: 'Deuz SDK 2.3 ist da — MCP-Server, A2A, Echtzeit-Sprache, Batch-Anfragen und Redis-Backends.',
    link: 'Neu in 2.3',
  },
  tr: {
    text: 'Deuz SDK 2.3 çıktı — MCP sunucusu, A2A, gerçek zamanlı ses, toplu istekler ve Redis backend’leri.',
    link: '2.3’te neler yeni',
  },
  fr: {
    text: 'Deuz SDK 2.3 est sorti — serveur MCP, A2A, voix en temps réel, requêtes par lots et backends Redis.',
    link: 'Nouveautés de la 2.3',
  },
  it: {
    text: 'Deuz SDK 2.3 è uscito — server MCP, A2A, voce in tempo reale, richieste batch e backend Redis.',
    link: 'Novità della 2.3',
  },
  es: {
    text: 'Deuz SDK 2.3 ya está aquí — servidor MCP, A2A, voz en tiempo real, solicitudes por lotes y backends de Redis.',
    link: 'Novedades de 2.3',
  },
  ru: {
    text: 'Вышел Deuz SDK 2.3 — MCP-сервер, A2A, голос в реальном времени, пакетные запросы и бэкенды Redis.',
    link: 'Что нового в 2.3',
  },
  ja: {
    text: 'Deuz SDK 2.3 リリース — MCP サーバー、A2A、リアルタイム音声、バッチリクエスト、Redis バックエンド。',
    link: '2.3 の新機能',
  },
  ko: {
    text: 'Deuz SDK 2.3 출시 — MCP 서버, A2A, 실시간 음성, 배치 요청, Redis 백엔드.',
    link: '2.3의 새로운 점',
  },
  zh: {
    text: 'Deuz SDK 2.3 已发布 — MCP 服务器、A2A、实时语音、批量请求与 Redis 后端。',
    link: '2.3 新特性',
  },
};

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export async function generateMetadata(props: LayoutProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await props.params;
  const locale: Locale = isLocale(lang) ? lang : i18n.defaultLanguage;

  return {
    metadataBase: new URL(siteUrl),
    title: {
      template: `%s | ${appName}`,
      default: appName,
    },
    description: siteDescriptions[locale],
  };
}

export default async function Layout({ params, children }: LayoutProps<'/[lang]'>) {
  const { lang } = await params;
  const locale: Locale = isLocale(lang) ? lang : i18n.defaultLanguage;
  const banner = bannerCopy[locale];

  return (
    <html
      lang={lang}
      className={`${inter.variable} ${inter.className} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nProvider(translations, lang)}>
          <Banner id="deuz-sdk-2-3">
            {banner.text}{' '}
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-3')}
              className="font-medium underline underline-offset-4"
            >
              {banner.link}
            </Link>
          </Banner>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
