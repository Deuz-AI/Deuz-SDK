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
    text: 'Deuz SDK 2.5 is out — a budget meter for coding harnesses and the deuz CLI, harnesses as budgeted sub-agents, ACP for editors, tool search, and MCP resources and prompts.',
    link: 'What is new in 2.5',
  },
  de: {
    text: 'Deuz SDK 2.5 ist da — ein Budget-Meter für Coding-Harnesses und die deuz-CLI, Harnesses als budgetierte Sub-Agenten, ACP für Editoren, Tool-Suche sowie MCP-Ressourcen und -Prompts.',
    link: 'Neu in 2.5',
  },
  tr: {
    text: 'Deuz SDK 2.5 çıktı — kodlama araçları için bütçe ölçer ve deuz CLI, bütçeli alt ajan olarak kodlama araçları, editörler için ACP, araç arama, MCP kaynakları ve prompt’ları.',
    link: '2.5’te neler yeni',
  },
  fr: {
    text: 'Deuz SDK 2.5 est sorti — un compteur de budget pour les agents de code et la CLI deuz, ces agents en sous-agents budgétés, ACP pour les éditeurs, la recherche d’outils, et les ressources et prompts MCP.',
    link: 'Nouveautés de la 2.5',
  },
  it: {
    text: 'Deuz SDK 2.5 è uscito — un contatore di budget per gli agenti di coding e la CLI deuz, gli agenti di coding come sotto-agenti con budget, ACP per gli editor, la ricerca degli strumenti, e risorse e prompt MCP.',
    link: 'Novità della 2.5',
  },
  es: {
    text: 'Deuz SDK 2.5 ya está aquí — un medidor de presupuesto para agentes de código y la CLI deuz, esos agentes como subagentes con presupuesto, ACP para editores, búsqueda de herramientas, y recursos y prompts MCP.',
    link: 'Novedades de 2.5',
  },
  ru: {
    text: 'Вышел Deuz SDK 2.5 — счётчик бюджета для агентов программирования и CLI deuz, такие агенты как суб-агенты с бюджетом, ACP для редакторов, поиск инструментов, а также ресурсы и промпты MCP.',
    link: 'Что нового в 2.5',
  },
  ja: {
    text: 'Deuz SDK 2.5 リリース — コーディングエージェント向け予算メーターと deuz CLI、予算付きサブエージェントとしてのコーディングエージェント、エディター向け ACP、ツール検索、MCP リソースとプロンプト。',
    link: '2.5 の新機能',
  },
  ko: {
    text: 'Deuz SDK 2.5 출시 — 코딩 에이전트용 예산 미터와 deuz CLI, 예산이 걸린 서브 에이전트로서의 코딩 에이전트, 에디터용 ACP, 도구 검색, MCP 리소스와 프롬프트.',
    link: '2.5의 새로운 점',
  },
  zh: {
    text: 'Deuz SDK 2.5 已发布 — 面向编码代理的预算计量器与 deuz CLI、作为受预算约束子代理的编码代理、面向编辑器的 ACP、工具搜索，以及 MCP 资源与提示词。',
    link: '2.5 新特性',
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
          <Banner id="deuz-sdk-2-5">
            {banner.text}{' '}
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-5')}
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
