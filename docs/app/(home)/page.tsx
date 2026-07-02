import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center items-center text-center flex-1 px-4">
      <h1 className="text-4xl font-bold mb-4">Deuz SDK</h1>
      <p className="text-fd-muted-foreground text-lg mb-2">
        Pure · Web-first · Multi-provider AI SDK for TypeScript
      </p>
      <p className="text-fd-muted-foreground mb-8 max-w-xl">
        Anthropic · OpenAI · xAI Grok · Google Gemini · Vertex AI — one canonical
        wire, zero runtime dependencies, runs anywhere <code>fetch</code> runs.
      </p>
      <div className="flex gap-4">
        <Link
          href="/docs"
          className="px-4 py-2 rounded-lg bg-fd-primary text-fd-primary-foreground font-medium"
        >
          Documentation
        </Link>
        <a
          href="https://www.npmjs.com/package/@deuz-sdk/core"
          className="px-4 py-2 rounded-lg border font-medium"
        >
          npm
        </a>
      </div>
      <pre className="mt-8 px-4 py-2 rounded-lg border text-sm bg-fd-secondary">
        npm install @deuz-sdk/core
      </pre>
    </div>
  );
}
