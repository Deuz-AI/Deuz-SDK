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
    text: 'Deuz SDK 2.2 is out — dynamic swarms, cross-process operations, persistent budgets and evolve.',
    link: 'What is new in 2.2',
  },
  de: {
    text: 'Deuz SDK 2.2 ist da — dynamische Swarms, prozessübergreifender Betrieb, dauerhafte Budgets und Evolve.',
    link: 'Neu in 2.2',
  },
  tr: {
    text: 'Deuz SDK 2.2 çıktı — dinamik swarm’lar, süreçler arası operasyon, kalıcı bütçeler ve evolve.',
    link: '2.2’de neler yeni',
  },
  fr: {
    text: 'Deuz SDK 2.2 est sorti — swarms dynamiques, opérations multi-processus, budgets persistants et evolve.',
    link: 'Nouveautés de la 2.2',
  },
  it: {
    text: 'Deuz SDK 2.2 è uscito — swarm dinamici, operazioni tra processi, budget persistenti ed evolve.',
    link: 'Novità della 2.2',
  },
  es: {
    text: 'Deuz SDK 2.2 ya está aquí — swarms dinámicos, operaciones entre procesos, presupuestos persistentes y evolve.',
    link: 'Novedades de 2.2',
  },
  ru: {
    text: 'Вышел Deuz SDK 2.2 — динамические swarms, работа между процессами, постоянные бюджеты и evolve.',
    link: 'Что нового в 2.2',
  },
  ja: {
    text: 'Deuz SDK 2.2 リリース — 動的なスウォーム、プロセス間の運用、永続的な予算、Evolve。',
    link: '2.2 の新機能',
  },
  ko: {
    text: 'Deuz SDK 2.2 출시 — 동적 스웜, 프로세스 간 운영, 영속 예산, Evolve.',
    link: '2.2의 새로운 점',
  },
  zh: {
    text: 'Deuz SDK 2.2 已发布 — 动态 swarm、跨进程运行、持久化预算与 Evolve。',
    link: '2.2 新特性',
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
          <Banner id="deuz-sdk-2-2">
            {banner.text}{' '}
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-2')}
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
