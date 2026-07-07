import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const { GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  localeMap: {
    en: { language: 'english' },
    de: { language: 'german' },
    tr: { language: 'turkish' },
    fr: { language: 'french' },
    it: { language: 'italian' },
    es: { language: 'spanish' },
    ru: { language: 'russian' },
    // Orama's stemmer list has no CJK entries; until content is translated the
    // indexed text is English anyway, so tokenize these locales as English.
    ja: { language: 'english' },
    ko: { language: 'english' },
    zh: { language: 'english' },
  },
});
