import Link from 'next/link';
import {
  ArrowRight,
  AudioLines,
  Cable,
  Database,
  Globe,
  Server,
  Waves,
  Workflow,
} from 'lucide-react';
import { i18n, isLocale, localeNames, type Locale } from '@/lib/i18n';
import { homeCopy, type HomeFeatureKey } from '@/lib/home-copy';
import { localePath } from '@/lib/layout.shared';
import { gitConfig } from '@/lib/shared';

const featureOrder: { key: HomeFeatureKey; icon: typeof Waves }[] = [
  { key: 'stream', icon: Waves },
  { key: 'agents', icon: Workflow },
  { key: 'stores', icon: Database },
  { key: 'mcp', icon: Server },
  { key: 'edge', icon: Globe },
  { key: 'media', icon: AudioLines },
];

const providers = [
  'Anthropic',
  'OpenAI',
  'Google Gemini',
  'xAI Grok',
  'Azure',
  'Bedrock',
  'Ollama',
  'LM Studio',
];

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function HomePage(props: PageProps<'/[lang]'>) {
  const { lang } = await props.params;
  const locale: Locale = isLocale(lang) ? lang : i18n.defaultLanguage;
  const t = homeCopy[locale];

  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(ellipse 80% 50% at 50% -10%, color-mix(in oklab, var(--color-fd-primary) 18%, transparent), transparent)',
          }}
        />
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pt-20 pb-16 text-center sm:pt-28">
          <Link
            href={localePath(locale, '/docs/reference/whats-new-2-0')}
            className="mb-6 inline-flex max-w-full items-center gap-2 rounded-full border bg-fd-card px-3 py-1 text-sm text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground"
          >
            <span className="inline-block size-2 shrink-0 rounded-full bg-fd-primary" />
            <span className="truncate">{t.badge}</span>
            <ArrowRight className="size-3.5 shrink-0" />
          </Link>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
            {t.titleA}{' '}
            <span className="bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 bg-clip-text text-transparent">
              {t.titleB}
            </span>
          </h1>
          <p className="mt-5 text-lg font-medium text-fd-foreground/90">{t.lead}</p>
          <p className="mt-3 max-w-2xl text-fd-muted-foreground text-pretty">{t.description}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={localePath(locale, '/docs')}
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              {t.ctaDocs}
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-0')}
              className="inline-flex items-center gap-2 rounded-lg border bg-fd-card px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
            >
              {t.ctaWhatsNew}
            </Link>
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg border bg-fd-card px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
            >
              GitHub
            </a>
          </div>
          <code className="mt-8 rounded-lg border bg-fd-secondary px-4 py-2.5 font-mono text-sm text-fd-secondary-foreground">
            npm install @deuz-sdk/core
          </code>

          <dl className="mt-14 grid w-full max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
            {t.stats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border bg-fd-card/80 px-3 py-4"
              >
                <dt className="text-xs font-medium uppercase tracking-wider text-fd-muted-foreground">
                  {stat.label}
                </dt>
                <dd className="mt-1 text-lg font-semibold tracking-tight">{stat.value}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-14 text-xs font-medium uppercase tracking-widest text-fd-muted-foreground">
            {t.worksWith}
          </p>
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-medium text-fd-muted-foreground">
            {providers.map((name) => (
              <li key={name} className="flex items-center gap-2">
                <Cable className="size-3.5 opacity-60" aria-hidden="true" />
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-fd-muted-foreground">{t.providersMore}</p>
        </div>
      </section>

      <section className="border-t bg-fd-card/40">
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-16 sm:grid-cols-2 lg:grid-cols-3">
          {featureOrder.map(({ key, icon: Icon }) => {
            const feature = t.features[key];
            return (
              <div
                key={key}
                className="rounded-xl border bg-fd-card p-5 transition-colors hover:border-fd-primary/40"
              >
                <Icon className="size-5 text-fd-primary" aria-hidden="true" />
                <h2 className="mt-3 font-semibold">{feature.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                  {feature.body}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto grid w-full max-w-5xl items-center gap-10 px-4 py-16 lg:grid-cols-[2fr_3fr]">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{t.codeTitle}</h2>
            <p className="mt-3 text-fd-muted-foreground">{t.codeBody}</p>
            <Link
              href={localePath(locale, '/docs/quickstart')}
              className="mt-5 inline-flex items-center gap-1.5 font-medium text-fd-primary hover:underline"
            >
              {t.ctaDocs}
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <pre className="overflow-x-auto rounded-xl border bg-[#0d1220] p-5 text-sm leading-relaxed text-slate-200">
            <code>
              <span className="text-slate-500">{'// swap the factory to swap providers'}</span>
              {'\n'}
              <span className="text-sky-300">import</span>
              {' { streamChat } '}
              <span className="text-sky-300">from</span>{' '}
              <span className="text-emerald-300">'@deuz-sdk/core'</span>;{'\n'}
              <span className="text-sky-300">import</span>
              {' { createAnthropic } '}
              <span className="text-sky-300">from</span>{' '}
              <span className="text-emerald-300">'@deuz-sdk/core/anthropic'</span>;{'\n\n'}
              <span className="text-sky-300">const</span> anthropic ={' '}
              <span className="text-yellow-200">createAnthropic</span>
              {'({ apiKey });\n'}
              <span className="text-sky-300">const</span> res ={' '}
              <span className="text-yellow-200">streamChat</span>
              {'({\n  model: '}
              <span className="text-yellow-200">anthropic</span>
              {'('}
              <span className="text-emerald-300">'claude-opus-4-8'</span>
              {'),\n  messages: [{ role: '}
              <span className="text-emerald-300">'user'</span>
              {', content: '}
              <span className="text-emerald-300">'Hello!'</span>
              {' }],\n});\n\n'}
              <span className="text-sky-300">for await</span>
              {' ('}
              <span className="text-sky-300">const</span>
              {' chunk '}
              <span className="text-sky-300">of</span>
              {' res.textStream) {\n  process.stdout.'}
              <span className="text-yellow-200">write</span>
              {'(chunk);\n}'}
            </code>
          </pre>
        </div>
      </section>

      <section className="border-t bg-fd-card/40">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-4 px-4 py-12 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-fd-muted-foreground">
            {t.languagesLabel}
          </p>
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {i18n.languages.map((code) => {
              const active = code === locale;
              return (
                <li key={code}>
                  <Link
                    href={localePath(code, '/')}
                    hrefLang={code}
                    lang={code}
                    aria-current={active ? 'page' : undefined}
                    className={
                      active
                        ? 'inline-flex rounded-full border border-fd-primary/40 bg-fd-primary/10 px-3 py-1 text-sm font-medium text-fd-foreground'
                        : 'inline-flex rounded-full border bg-fd-card px-3 py-1 text-sm text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground'
                    }
                  >
                    {localeNames[code]}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-fd-muted-foreground">
          <span>@deuz-sdk/core 2.0.0</span>
          <nav className="flex flex-wrap gap-4">
            <Link href={localePath(locale, '/docs')} className="hover:text-fd-foreground">
              {t.footerDocs}
            </Link>
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-0')}
              className="hover:text-fd-foreground"
            >
              {t.footerWhatsNew}
            </Link>
            <Link
              href={localePath(locale, '/docs/changelog')}
              className="hover:text-fd-foreground"
            >
              {t.footerChangelog}
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
