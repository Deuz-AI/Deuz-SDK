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
    text: 'Deuz SDK 2.4 is out — versioned memory and a context compiler, a goal supervisor and durable scheduler, a local Docker runner and durable chat streams.',
    link: 'What is new in 2.4',
  },
  de: {
    text: 'Deuz SDK 2.4 ist da — versioniertes Gedächtnis und ein Kontext-Compiler, ein Goal-Supervisor und dauerhafter Scheduler, ein lokaler Docker-Runner und dauerhafte Chat-Streams.',
    link: 'Neu in 2.4',
  },
  tr: {
    text: 'Deuz SDK 2.4 çıktı — sürümlü bellek ve bağlam derleyicisi, hedef denetleyicisi ve kalıcı zamanlayıcı, yerel Docker çalıştırıcısı ve kalıcı sohbet akışları.',
    link: '2.4’te neler yeni',
  },
  fr: {
    text: 'Deuz SDK 2.4 est sorti — mémoire versionnée et compilateur de contexte, superviseur d’objectifs et planificateur durable, exécuteur Docker local et flux de chat durables.',
    link: 'Nouveautés de la 2.4',
  },
  it: {
    text: 'Deuz SDK 2.4 è uscito — memoria versionata e compilatore di contesto, supervisore degli obiettivi e scheduler durevole, runner Docker locale e stream di chat durevoli.',
    link: 'Novità della 2.4',
  },
  es: {
    text: 'Deuz SDK 2.4 ya está aquí — memoria versionada y compilador de contexto, supervisor de objetivos y planificador duradero, ejecutor Docker local y streams de chat duraderos.',
    link: 'Novedades de 2.4',
  },
  ru: {
    text: 'Вышел Deuz SDK 2.4 — версионируемая память и компилятор контекста, супервизор целей и надёжный планировщик, локальный Docker-раннер и надёжные потоки чата.',
    link: 'Что нового в 2.4',
  },
  ja: {
    text: 'Deuz SDK 2.4 リリース — バージョン管理されたメモリとコンテキストコンパイラ、ゴールスーパーバイザーと永続スケジューラ、ローカル Docker ランナー、永続チャットストリーム。',
    link: '2.4 の新機能',
  },
  ko: {
    text: 'Deuz SDK 2.4 출시 — 버전 관리 메모리와 컨텍스트 컴파일러, 목표 감독자와 영속 스케줄러, 로컬 Docker 러너, 영속 채팅 스트림.',
    link: '2.4의 새로운 점',
  },
  zh: {
    text: 'Deuz SDK 2.4 已发布 — 版本化记忆与上下文编译器、目标监督器与持久调度器、本地 Docker 运行器以及持久聊天流。',
    link: '2.4 新特性',
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
          <Banner id="deuz-sdk-2-4">
            {banner.text}{' '}
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-4')}
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
