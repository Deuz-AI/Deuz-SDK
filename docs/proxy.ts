import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { docsContentRoute, docsRoute } from '@/lib/shared';
import { i18n } from '@/lib/i18n';

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);

const i18nMiddleware = createI18nMiddleware(i18n);

// Routes that must never be locale-prefixed (route handlers + metadata).
const SYSTEM_PATH =
  /^\/(?:api|og|llms\.mdx|llms\.txt|llms-full\.txt|sitemap\.xml|robots\.txt|icon\.svg|favicon\.ico)(?:\/|$)/;

export default function proxy(request: NextRequest, ...rest: unknown[]) {
  const { pathname } = request.nextUrl;

  // Markdown negotiation for the default locale (LLM content is English).
  const result = rewriteSuffix(pathname);
  if (result) {
    return NextResponse.rewrite(new URL(result, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const result = rewriteDocs(pathname);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  if (SYSTEM_PATH.test(pathname)) {
    return NextResponse.next();
  }

  // Locale detection / hidden default-locale rewrite.
  return (i18nMiddleware as (req: NextRequest, ...args: unknown[]) => unknown)(request, ...rest);
}

export const config = {
  // Skip static assets and Next.js internals.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
