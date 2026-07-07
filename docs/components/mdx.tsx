import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { AnchorHTMLAttributes, ElementType } from 'react';
import { i18n, isLocale } from '@/lib/i18n';

/**
 * Content is written with default-locale absolute links (`/docs/...`).
 * For other locales, prefix internal docs links with the current locale so
 * readers stay in their language.
 */
function withLocaleLinks(components: MDXComponents, locale: string): MDXComponents {
  const Anchor = (components.a ?? 'a') as ElementType;

  return {
    ...components,
    a: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
      let target = href;
      if (typeof target === 'string' && (target === '/docs' || target.startsWith('/docs/'))) {
        target = `/${locale}${target}`;
      }
      return <Anchor href={target} {...props} />;
    },
  };
}

export function getMDXComponents(components?: MDXComponents, lang?: string) {
  const merged: MDXComponents = {
    ...defaultMdxComponents,
    ...components,
  };

  if (lang && isLocale(lang) && lang !== i18n.defaultLanguage) {
    return withLocaleLinks(merged, lang);
  }

  return merged;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
