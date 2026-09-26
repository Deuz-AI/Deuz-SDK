import type { ProviderLogoSlug } from './provider-logos.generated';

export type Provider = {
  /** Deuz provider id, or the family a single tile stands for (`vertex` covers both Vertex ids). */
  slug: string;
  name: string;
  /** Key into the generated logo map; `null` renders `textMark` instead. */
  logo: ProviderLogoSlug | null;
  /** Text mark for a provider that has no logo. */
  textMark?: string;
  /**
   * Hover colour for marks that only ship a single-colour variant. Leave unset for
   * brands whose identity is black — they stay ink and only the label reacts.
   */
  hoverHex?: string;
  /** Set to `false` when the colour variant is unreadable on black: the mark then stays ink in dark mode. */
  colorOnDark?: boolean;
  /** Docs path in default-locale form; `localePath()` adds the prefix. */
  href: string;
};

/**
 * Every built-in provider id, in the order the SDK groups them: dedicated wires
 * first, then OpenAI-compatible cloud hosts, then keyless local hosts, then the
 * embeddings-only Voyage. 28 tiles for 29 ids — `vertex-anthropic` and
 * `vertex-google` share one.
 */
export const providers: Provider[] = [
  {
    slug: 'anthropic',
    name: 'Anthropic',
    logo: 'anthropic',
    hoverHex: '#D97757',
    href: '/docs/providers/anthropic',
  },
  {
    slug: 'openai',
    name: 'OpenAI',
    logo: 'openai',
    hoverHex: '#10A37F',
    href: '/docs/providers/openai',
  },
  { slug: 'google', name: 'Google Gemini', logo: 'google', href: '/docs/providers/google' },
  { slug: 'xai', name: 'xAI Grok', logo: 'xai', href: '/docs/providers/xai' },
  { slug: 'azure', name: 'Azure OpenAI', logo: 'azure', href: '/docs/providers/azure' },
  { slug: 'bedrock', name: 'Amazon Bedrock', logo: 'bedrock', href: '/docs/providers/bedrock' },
  { slug: 'vertex', name: 'Vertex AI', logo: 'vertex', href: '/docs/providers/vertex' },
  { slug: 'yunwu', name: 'Yunwu', logo: null, textMark: '云雾', href: '/docs/providers/yunwu' },
  { slug: 'groq', name: 'Groq', logo: 'groq', hoverHex: '#F55036', href: '/docs/providers/compat' },
  { slug: 'mistral', name: 'Mistral', logo: 'mistral', href: '/docs/providers/compat' },
  { slug: 'deepseek', name: 'DeepSeek', logo: 'deepseek', href: '/docs/providers/compat' },
  { slug: 'together', name: 'Together AI', logo: 'together', href: '/docs/providers/compat' },
  { slug: 'openrouter', name: 'OpenRouter', logo: 'openrouter', href: '/docs/providers/compat' },
  { slug: 'cerebras', name: 'Cerebras', logo: 'cerebras', href: '/docs/providers/compat' },
  { slug: 'fireworks', name: 'Fireworks AI', logo: 'fireworks', href: '/docs/providers/compat' },
  { slug: 'moonshot', name: 'Moonshot Kimi', logo: 'moonshot', href: '/docs/providers/compat' },
  { slug: 'qwen', name: 'Qwen', logo: 'qwen', href: '/docs/providers/compat' },
  { slug: 'glm', name: 'Zhipu GLM', logo: 'glm', href: '/docs/providers/compat' },
  { slug: 'minimax', name: 'MiniMax', logo: 'minimax', href: '/docs/providers/compat' },
  { slug: 'perplexity', name: 'Perplexity', logo: 'perplexity', href: '/docs/providers/compat' },
  { slug: 'cohere', name: 'Cohere', logo: 'cohere', href: '/docs/providers/compat' },
  { slug: 'deepinfra', name: 'DeepInfra', logo: 'deepinfra', href: '/docs/providers/compat' },
  { slug: 'nvidia', name: 'NVIDIA NIM', logo: 'nvidia', href: '/docs/providers/compat' },
  { slug: 'sambanova', name: 'SambaNova', logo: 'sambanova', href: '/docs/providers/compat' },
  { slug: 'hyperbolic', name: 'Hyperbolic', logo: 'hyperbolic', href: '/docs/providers/compat' },
  { slug: 'ollama', name: 'Ollama', logo: 'ollama', href: '/docs/providers/local' },
  { slug: 'lmstudio', name: 'LM Studio', logo: 'lmstudio', href: '/docs/providers/local' },
  { slug: 'voyage', name: 'Voyage AI', logo: 'voyage', href: '/docs/providers/voyage' },
];
