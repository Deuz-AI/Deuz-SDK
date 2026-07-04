import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages();

  return [
    {
      url: siteUrl,
    },
    ...pages.map((page) => ({
      url: `${siteUrl}${page.url}`,
    })),
  ];
}
