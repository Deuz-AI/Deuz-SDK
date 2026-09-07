import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Link from 'next/link';
import {
  ArrowRight,
  AudioLines,
  Database,
  Globe,
  Server,
  Sparkles,
  Waves,
  Workflow,
} from 'lucide-react';
import { HeroMascot } from '@/components/home/hero-mascot';
import { ProviderGrid } from '@/components/home/provider-grid';
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

/** The Blender export lands here (see docs/MASCOT-MODEL.md). Until it does, the hero shows the built-in rig. */
const mascotModel = join(process.cwd(), 'public', 'mascot', 'deuz-mascot.glb');

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring';
const button = `inline-flex items-center gap-2 rounded-lg px-5 py-2.5 font-medium transition-colors motion-reduce:transition-none ${focusRing}`;
const primaryButton = `${button} bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/85`;
const secondaryButton = `${button} border hover:bg-fd-accent`;
const inlineLink = `inline-flex items-center gap-1.5 font-medium underline-offset-4 hover:underline ${focusRing}`;
const sectionTitle = 'font-serif text-3xl font-normal tracking-tight sm:text-4xl';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function HomePage(props: PageProps<'/[lang]'>) {
  const { lang } = await props.params;
  const locale: Locale = isLocale(lang) ? lang : i18n.defaultLanguage;
  const t = homeCopy[locale];
  const modelUrl = existsSync(mascotModel) ? '/mascot/deuz-mascot.glb' : null;

  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto w-full max-w-6xl px-4 pt-10 pb-16 sm:pt-16 lg:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          <div className="order-last flex min-w-0 flex-col items-start lg:order-first">
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-0')}
              className={`mb-8 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-sm text-fd-muted-foreground transition-colors hover:border-fd-foreground hover:text-fd-foreground motion-reduce:transition-none ${focusRing}`}
            >
              <span className="inline-block size-2 shrink-0 rounded-full bg-fd-foreground" />
              <span className="truncate">{t.badge}</span>
              <ArrowRight className="size-3.5 shrink-0" />
            </Link>
            <h1 className="max-w-2xl font-serif text-5xl leading-[1.05] font-normal tracking-tight text-balance sm:text-6xl lg:text-7xl">
              {t.titleA} {t.titleB}
            </h1>
            <p className="mt-6 text-lg font-medium">{t.lead}</p>
            <p className="mt-3 max-w-xl text-fd-muted-foreground text-pretty">{t.description}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href={localePath(locale, '/docs')} className={primaryButton}>
                {t.ctaDocs}
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href={localePath(locale, '/docs/reference/whats-new-2-0')}
                className={secondaryButton}
              >
                {t.ctaWhatsNew}
              </Link>
              <a
                href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
                rel="noreferrer noopener"
                className={secondaryButton}
              >
                GitHub
              </a>
            </div>
            <code className="mt-8 rounded-lg border px-4 py-2.5 font-mono text-sm">
              npm install @deuz-sdk/core
            </code>
          </div>
          <div className="flex min-w-0 justify-center lg:justify-end">
            <HeroMascot modelUrl={modelUrl} className="w-40 sm:w-52 lg:w-[22rem]" />
          </div>
        </div>

        <dl className="mt-14 flex flex-wrap gap-x-12 gap-y-5 border-y py-6">
          {t.stats.map((stat) => (
            <div key={stat.label} className="flex flex-col-reverse">
              <dt className="mt-1.5 text-sm text-fd-muted-foreground">{stat.label}</dt>
              <dd className="font-serif text-3xl leading-none tracking-tight">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="border-t">
        <div className="mx-auto w-full max-w-6xl px-4 py-16">
          <h2 className={sectionTitle}>{t.worksWith}</h2>
          <div className="mt-8">
            <ProviderGrid locale={locale} />
          </div>
          <p className="mt-4 text-sm text-fd-muted-foreground">{t.providersMore}</p>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto w-full max-w-6xl px-4 py-16">
          <div className="grid border-t border-l sm:grid-cols-2 lg:grid-cols-3">
            {featureOrder.map(({ key, icon: Icon }) => {
              const feature = t.features[key];
              return (
                <div key={key} className="border-r border-b p-6">
                  <Icon className="size-5" aria-hidden="true" />
                  <h2 className="mt-4 font-medium">{feature.title}</h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                    {feature.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 lg:grid-cols-[2fr_3fr]">
          <div>
            <h2 className={sectionTitle}>{t.codeTitle}</h2>
            <p className="mt-4 text-fd-muted-foreground">{t.codeBody}</p>
            <Link href={localePath(locale, '/docs/quickstart')} className={`mt-6 ${inlineLink}`}>
              {t.ctaDocs}
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-fd-foreground p-5 text-sm leading-relaxed text-fd-background">
            <code>
              <span className="text-fd-background/45">
                {'// swap the factory to swap providers'}
              </span>
              {'\n'}
              import {' { streamChat } '} from{' '}
              <span className="text-fd-background/70">'@deuz-sdk/core'</span>;{'\n'}
              import {' { createAnthropic } '} from{' '}
              <span className="text-fd-background/70">'@deuz-sdk/core/anthropic'</span>;{'\n\n'}
              const anthropic = createAnthropic
              {'({ apiKey });\n'}
              const res = streamChat
              {'({\n  model: anthropic('}
              <span className="text-fd-background/70">'claude-opus-4-8'</span>
              {'),\n  messages: [{ role: '}
              <span className="text-fd-background/70">'user'</span>
              {', content: '}
              <span className="text-fd-background/70">'Hello!'</span>
              {' }],\n});\n\n'}
              for await (const chunk of res.textStream) {'{\n  process.stdout.write(chunk);\n}'}
            </code>
          </pre>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 lg:grid-cols-[3fr_2fr]">
          <div>
            <p className="text-sm text-fd-muted-foreground">{t.skillsTag}</p>
            <h2 className={`mt-3 ${sectionTitle}`}>{t.skillsTitle}</h2>
            <p className="mt-4 text-fd-muted-foreground">{t.skillsBody}</p>
            <Link
              href={localePath(locale, '/docs/reference/agent-skills')}
              className={`mt-6 ${inlineLink}`}
            >
              {t.skillsCta}
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <div className="rounded-lg border p-5">
            <Sparkles className="size-5" aria-hidden="true" />
            <pre className="mt-4 overflow-x-auto rounded-lg bg-fd-foreground p-4 text-sm text-fd-background">
              <code>
                <span className="text-fd-background/45">$ </span>
                npx skills add Deuz-AI/Deuz-SDK
              </code>
            </pre>
            <ul className="mt-4 space-y-3">
              {t.skillsList.map((skill) => (
                <li key={skill.name}>
                  <code className="text-sm font-semibold">{skill.name}</code>
                  <p className="mt-1 text-sm leading-relaxed text-fd-muted-foreground">
                    {skill.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-4 py-12 text-center">
          <p className="text-sm text-fd-muted-foreground">{t.languagesLabel}</p>
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
                        ? `inline-flex rounded-full border border-fd-foreground bg-fd-foreground px-3 py-1 text-sm font-medium text-fd-background ${focusRing}`
                        : `inline-flex rounded-full border px-3 py-1 text-sm text-fd-muted-foreground transition-colors hover:border-fd-foreground hover:text-fd-foreground motion-reduce:transition-none ${focusRing}`
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
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-fd-muted-foreground">
          <span>@deuz-sdk/core 2.0.0</span>
          <nav className="flex flex-wrap gap-4">
            <Link
              href={localePath(locale, '/docs')}
              className={`hover:text-fd-foreground ${focusRing}`}
            >
              {t.footerDocs}
            </Link>
            <Link
              href={localePath(locale, '/docs/reference/whats-new-2-0')}
              className={`hover:text-fd-foreground ${focusRing}`}
            >
              {t.footerWhatsNew}
            </Link>
            <Link
              href={localePath(locale, '/docs/changelog')}
              className={`hover:text-fd-foreground ${focusRing}`}
            >
              {t.footerChangelog}
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
