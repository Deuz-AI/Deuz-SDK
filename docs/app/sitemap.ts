import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';
import { i18n } from '@/lib/i18n';

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [{ url: siteUrl }];

  for (const lang of i18n.languages) {
    const prefix = lang === i18n.defaultLanguage ? '' : `/${lang}`;
    if (prefix) entries.push({ url: `${siteUrl}${prefix}` });

    for (const page of source.getPages(lang)) {
      // page.url already carries the locale prefix for non-default locales
      entries.push({ url: `${siteUrl}${page.url}` });
    }
  }

  return entries;
}
