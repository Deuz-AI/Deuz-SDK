import Link from 'next/link';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { localePath } from '@/lib/layout.shared';
import { providerLogos } from '@/lib/provider-logos.generated';
import { providers } from '@/lib/providers';

/**
 * The "One API surface across" grid: one tile per provider, the mark in ink and its
 * brand colour on hover or keyboard focus. Pure CSS — this stays a server component
 * and ships no JavaScript. Both layers are inlined from the generated module, which
 * is static markup copied from a pinned package by `npm run logos:sync`.
 */
export function ProviderGrid({ locale }: { locale: string }) {
  return (
    <ul className="grid grid-cols-4 border-t border-l lg:grid-cols-7">
      {providers.map((provider) => {
        const logo = provider.logo ? providerLogos[provider.logo] : null;
        const hasColor = Boolean(logo?.color);
        const inkInDark = provider.colorOnDark === false;
        const style = provider.hoverHex
          ? ({ '--brand': provider.hoverHex } as CSSProperties)
          : undefined;

        return (
          <li key={provider.slug} className="border-r border-b">
            <Link
              href={localePath(locale, provider.href)}
              style={style}
              className="group flex h-full flex-col items-center gap-2.5 px-2 py-5 transition-colors hover:bg-fd-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fd-foreground motion-reduce:transition-none"
            >
              <span aria-hidden="true" className="relative size-8 [&_svg]:size-full">
                {logo ? (
                  <>
                    <span
                      className={cn(
                        'absolute inset-0 transition-opacity duration-200 motion-reduce:transition-none',
                        hasColor && 'group-hover:opacity-0 group-focus-visible:opacity-0',
                        hasColor &&
                          inkInDark &&
                          'dark:group-hover:opacity-100 dark:group-focus-visible:opacity-100',
                        provider.hoverHex &&
                          'transition-[opacity,color] group-hover:text-(color:--brand) group-focus-visible:text-(color:--brand)',
                      )}
                      dangerouslySetInnerHTML={{ __html: logo.mono }}
                    />
                    {logo.color ? (
                      <span
                        className={cn(
                          'absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none',
                          inkInDark &&
                            'dark:group-hover:opacity-0 dark:group-focus-visible:opacity-0',
                        )}
                        dangerouslySetInnerHTML={{ __html: logo.color }}
                      />
                    ) : null}
                  </>
                ) : (
                  <span className="flex size-full items-center justify-center font-serif text-xl leading-none">
                    {provider.textMark}
                  </span>
                )}
              </span>
              <span className="text-center text-xs leading-tight text-fd-muted-foreground transition-colors group-hover:text-fd-foreground group-focus-visible:text-fd-foreground motion-reduce:transition-none">
                {provider.name}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
