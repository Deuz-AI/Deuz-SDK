import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { gitConfig } from '@/lib/shared';
import { i18n, isLocale, type Locale } from '@/lib/i18n';

const contentLanguageNote: Record<Exclude<Locale, 'en'>, string> = {
  de: 'Die Dokumentationsseiten selbst sind auf Englisch. Navigation, Suche und UI-Texte folgen der gewählten Sprache.',
  tr: 'Doküman sayfalarının içeriği İngilizce’dir. Gezinme, arama ve arayüz metinleri seçtiğiniz dile göre çevrilir.',
  fr: 'Le contenu des pages de documentation est en anglais. La navigation, la recherche et l’interface suivent la langue choisie.',
  it: 'Il contenuto delle pagine di documentazione è in inglese. Navigazione, ricerca e interfaccia seguono la lingua scelta.',
  es: 'El contenido de las páginas de documentación está en inglés. La navegación, la búsqueda y la interfaz siguen el idioma elegido.',
  ru: 'Текст страниц документации на английском. Навигация, поиск и интерфейс следуют выбранному языку.',
  ja: 'ドキュメント本文は英語です。ナビゲーション・検索・UI は選択した言語に従います。',
  ko: '문서 본문은 영어입니다. 탐색, 검색, UI는 선택한 언어를 따릅니다.',
  zh: '文档正文为英文。导航、搜索和界面会跟随你选择的语言。',
};

export default async function Page(props: PageProps<'/[lang]/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug, params.lang);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const locale: Locale = isLocale(params.lang) ? params.lang : i18n.defaultLanguage;
  const languageNote = locale === 'en' ? null : contentLanguageNote[locale];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} tableOfContent={{ style: 'clerk' }}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs/content/docs/${page.path}`}
        />
      </div>
      {languageNote ? (
        <p className="not-prose mb-6 rounded-lg border bg-fd-card px-3 py-2 text-sm text-fd-muted-foreground">
          {languageNote}
        </p>
      ) : null}
      <DocsBody>
        <MDX
          components={getMDXComponents(
            {
              a: createRelativeLink(source, page),
            },
            params.lang,
          )}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<'/[lang]/docs/[[...slug]]'>,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug, params.lang);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}
