import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { i18n, isLocale, type Locale } from './i18n';

const navLabels: Record<Locale, { docs: string; whatsNew: string; changelog: string }> = {
  en: { docs: 'Documentation', whatsNew: 'What is new', changelog: 'Changelog' },
  de: { docs: 'Dokumentation', whatsNew: 'Was ist neu', changelog: 'Changelog' },
  tr: { docs: 'Dokümantasyon', whatsNew: 'Yenilikler', changelog: 'Sürüm notları' },
  fr: { docs: 'Documentation', whatsNew: 'Nouveautés', changelog: 'Journal des modifications' },
  it: { docs: 'Documentazione', whatsNew: 'Novità', changelog: 'Changelog' },
  es: { docs: 'Documentación', whatsNew: 'Novedades', changelog: 'Registro de cambios' },
  ru: { docs: 'Документация', whatsNew: 'Что нового', changelog: 'История изменений' },
  ja: { docs: 'ドキュメント', whatsNew: '新着', changelog: '変更履歴' },
  ko: { docs: '문서', whatsNew: '새로운 점', changelog: '변경 이력' },
  zh: { docs: '文档', whatsNew: '新特性', changelog: '更新日志' },
};

/** Prefix a path with the locale, except for the default language (hidden prefix). */
export function localePath(locale: string, path: string): string {
  if (path === '/') {
    return locale === i18n.defaultLanguage ? '/' : `/${locale}`;
  }
  return locale === i18n.defaultLanguage ? path : `/${locale}${path}`;
}

/** The ring and the dot — the same mark the favicon and the mascot's head carry (ring:dot = 4:1). */
export function Logo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-5"
    >
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

export function baseOptions(locale: string): BaseLayoutProps {
  const labels = navLabels[isLocale(locale) ? locale : i18n.defaultLanguage];

  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <Logo />
          {appName}
        </span>
      ),
    },
    links: [
      {
        text: labels.docs,
        url: localePath(locale, '/docs'),
        active: 'nested-url',
      },
      {
        text: labels.whatsNew,
        url: localePath(locale, '/docs/reference/whats-new-2-1'),
        active: 'url',
      },
      {
        text: labels.changelog,
        url: localePath(locale, '/docs/changelog'),
        active: 'url',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
