import { defineI18n } from 'fumadocs-core/i18n';

export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: ['en', 'de', 'tr', 'fr', 'it', 'es', 'ru', 'ja', 'ko', 'zh'],
  // English stays at /docs/..., other locales get /<locale>/docs/...
  hideLocale: 'default-locale',
});

export type Locale = (typeof i18n)['languages'][number];

export function isLocale(value: string): value is Locale {
  return (i18n.languages as readonly string[]).includes(value);
}
