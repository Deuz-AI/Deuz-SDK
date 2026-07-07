import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { i18n, isLocale, type Locale } from './i18n';

const navLabels: Record<Locale, { docs: string; changelog: string }> = {
  en: { docs: 'Documentation', changelog: 'Changelog' },
  de: { docs: 'Dokumentation', changelog: 'Changelog' },
  tr: { docs: 'Dokümantasyon', changelog: 'Sürüm notları' },
  fr: { docs: 'Documentation', changelog: 'Journal des modifications' },
  it: { docs: 'Documentazione', changelog: 'Changelog' },
  es: { docs: 'Documentación', changelog: 'Registro de cambios' },
  ru: { docs: 'Документация', changelog: 'История изменений' },
  ja: { docs: 'ドキュメント', changelog: '変更履歴' },
  ko: { docs: '문서', changelog: '변경 이력' },
  zh: { docs: '文档', changelog: '更新日志' },
};

/** Prefix a path with the locale, except for the default language (hidden prefix). */
export function localePath(locale: string, path: string): string {
  return locale === i18n.defaultLanguage ? path : `/${locale}${path}`;
}

export function Logo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="rounded-md"
    >
      <rect width="24" height="24" rx="6" fill="url(#deuz-logo-gradient)" />
      <path
        d="M5 14.5c1.75 0 1.75-2.5 3.5-2.5s1.75 2.5 3.5 2.5 1.75-2.5 3.5-2.5 1.75 2.5 3.5 2.5"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M5 9.5c1.75 0 1.75-2 3.5-2s1.75 2 3.5 2 1.75-2 3.5-2 1.75 2 3.5 2"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity="0.55"
      />
      <defs>
        <linearGradient id="deuz-logo-gradient" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#0EA5E9" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
      </defs>
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
        text: labels.changelog,
        url: localePath(locale, '/docs/changelog'),
        active: 'url',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
