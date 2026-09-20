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
    text: 'Deuz SDK 2.1 is out — native agents, durable swarms, and shared execution budgets.',
    link: 'What is new in 2.1',
  },
  de: {
    text: 'Deuz SDK 2.1 ist da — native Agenten, persistente Swarms und gemeinsame Ausführungsbudgets.',
    link: 'Neu in 2.1',
  },
  tr: {
    text: 'Deuz SDK 2.1 çıktı — yerel ajanlar, kalıcı swarm’lar ve ortak yürütme bütçeleri.',
    link: '2.1’de neler yeni',
  },
  fr: {
    text: 'Deuz SDK 2.1 est sorti — agents natifs, swarms persistants et budgets d’exécution partagés.',
    link: 'Nouveautés de la 2.1',
  },
  it: {
    text: 'Deuz SDK 2.1 è uscito — agenti nativi, swarm persistenti e budget di esecuzione condivisi.',
    link: 'Novità della 2.1',
  },
  es: {
    text: 'Deuz SDK 2.1 ya está aquí — agentes nativos, swarms persistentes y presupuestos de ejecución compartidos.',
    link: 'Novedades de 2.1',
  },
  ru: {
    text: 'Вышел Deuz SDK 2.1 — нативные агенты, персистентные swarms и общие бюджеты выполнения.',
    link: 'Что нового в 2.1',
  },
  ja: {
    text: 'Deuz SDK 2.1 リリース — ネイティブエージェント、永続化されたスウォーム、共有実行予算。',
    link: '2.1 の新機能',
  },
  ko: {
    text: 'Deuz SDK 2.1 출시 — 네이티브 에이전트, 영속 스웜, 공유 실행 예산.',
    link: '2.1의 새로운 점',
  },
  zh: {
    text: 'Deuz SDK 2.1 已发布 — 原生智能体、持久化 swarm 与共享执行预算。',
    link: '2.1 新特性',
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
          <Banner id="deuz-sdk-2-1">
            {banner.text}{' '}
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-1')}
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
