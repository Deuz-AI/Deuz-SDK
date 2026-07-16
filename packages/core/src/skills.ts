/**
 * skills.ts — PURE, edge-safe Agent Skills (SKILL.md) support (Faz 3).
 *
 * Progressive disclosure: only name+description (Level 1, the catalog) load into
 * context until a skill is triggered, then its body (Level 2) and bundled
 * resources (Level 3) load on demand. The ONLY IO touchpoint is the
 * `SkillSource` seam — the edge default reads over the injected `fetch`; the
 * Node filesystem loader lives in `@deuz-sdk/core/skills/node`, so core stays
 * edge-safe and zero-dependency. Triggering stays model-driven; the
 * `SkillMatcher` seam only prunes a large catalog, it is not a hidden router.
 */
import type { ToolSet } from './types/tool';
import { InvalidRequestError } from './errors';

/** Re-export for convenience so callers can type tool maps without a second import. */
export type ToolSetLike = ToolSet;

// ===================================================================
// Parsed manifest (no IO)
// ===================================================================

export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  allowedTools?: string[];
  /** All other frontmatter keys (host extensions survive here untyped). */
  metadata: Record<string, unknown>;
  /** Markdown body after the frontmatter fence. */
  body: string;
  /** The original raw file text. */
  raw: string;
}

export interface SkillValidationIssue {
  field: 'name' | 'description';
  message: string;
}

export interface ParseSkillOptions {
  /** Inject a full YAML parser; omitted → built-in zero-dep subset parser. */
  parseYaml?: (yaml: string) => Record<string, unknown>;
  /** Collect name/description constraint warnings (default true). */
  validate?: boolean;
}

/** Split ONLY a leading `---` fenced block (after an optional BOM). Body keeps its own `---`/```. */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Frontmatter must open on the very first line.
  const opening = text.match(/^---[ \t]*\r?\n/);
  if (!opening) return { frontmatter: null, body: text };
  const rest = text.slice(opening[0].length);
  // Close on the next line that is exactly '---'.
  const close = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!close || close.index === undefined) return { frontmatter: null, body: text };
  const frontmatter = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  return { frontmatter, body };
}

const KEBAB_TO_CAMEL: Record<string, string> = {
  'allowed-tools': 'allowedTools',
};

/** Minimal YAML-subset parser: scalars, quoted strings, block/flow lists, '|'/'>' blocks. */
function parseYamlSubset(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    let valueRaw = m[2]!;

    // Block scalar ('|' literal / '>' folded).
    if (valueRaw === '|' || valueRaw === '>' || valueRaw === '|-' || valueRaw === '>-') {
      const folded = valueRaw.startsWith('>');
      const collected: string[] = [];
      i++;
      while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.trim() === '')) {
        collected.push(lines[i]!.replace(/^ {2}/, ''));
        i++;
      }
      out[key] = folded ? collected.join(' ').trim() : collected.join('\n').trim();
      continue;
    }

    // Block list ('- item' on following indented lines).
    if (valueRaw === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[ \t]*-[ \t]+/.test(lines[j]!)) {
        items.push(
          lines[j]!.replace(/^[ \t]*-[ \t]+/, '')
            .trim()
            .replace(/^["']|["']$/g, ''),
        );
        j++;
      }
      if (items.length) {
        out[key] = items;
        i = j;
        continue;
      }
      out[key] = '';
      i++;
      continue;
    }

    // Flow list [a, b, c].
    const flow = valueRaw.match(/^\[(.*)\]$/);
    if (flow) {
      out[key] = flow[1]!
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      i++;
      continue;
    }

    // Quoted or bare scalar; a bare comma-list becomes an array for known list keys.
    valueRaw = valueRaw.replace(/^["']|["']$/g, '');
    if ((key === 'allowed-tools' || key === 'allowedTools') && valueRaw.includes(',')) {
      out[key] = valueRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      out[key] = valueRaw;
    }
    i++;
  }
  return out;
}

/** ^[a-z0-9-]{1,64}$, no 'anthropic'/'claude' substring, no XML angle brackets. */
export function validateSkillName(name: string): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    issues.push({ field: 'name', message: 'name must match ^[a-z0-9-]{1,64}$' });
  }
  if (/anthropic|claude/i.test(name)) {
    issues.push({ field: 'name', message: "name must not contain 'anthropic' or 'claude'" });
  }
  if (/[<>]/.test(name)) issues.push({ field: 'name', message: 'name must not contain < or >' });
  return issues;
}

/** Non-empty, ≤1024 chars, no XML angle brackets. */
export function validateSkillDescription(description: string): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  if (!description.trim())
    issues.push({ field: 'description', message: 'description is required' });
  if (description.length > 1024) {
    issues.push({ field: 'description', message: 'description must be ≤ 1024 chars' });
  }
  if (/[<>]/.test(description)) {
    issues.push({ field: 'description', message: 'description must not contain < or >' });
  }
  return issues;
}

/** Parse a SKILL.md file → manifest + non-fatal validation issues (never throws on content). */
export function parseSkill(
  raw: string,
  options?: ParseSkillOptions,
): { manifest: SkillManifest; issues: SkillValidationIssue[] } {
  const { frontmatter, body } = splitFrontmatter(raw);
  const parseYaml = options?.parseYaml ?? parseYamlSubset;
  const fm = frontmatter ? parseYaml(frontmatter) : {};

  // Normalize kebab keys to camelCase typed fields; keep everything in metadata.
  const metadata: Record<string, unknown> = {};
  let name = '';
  let description = '';
  let license: string | undefined;
  let allowedTools: string[] | undefined;

  for (const [k, v] of Object.entries(fm)) {
    const camel = KEBAB_TO_CAMEL[k] ?? k;
    if (camel === 'name') name = String(v);
    else if (camel === 'description') description = String(v);
    else if (camel === 'license') license = String(v);
    else if (camel === 'allowedTools') {
      allowedTools = Array.isArray(v)
        ? v.map(String)
        : String(v)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    metadata[camel] = v;
  }

  const manifest: SkillManifest = {
    name,
    description,
    ...(license !== undefined ? { license } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    metadata,
    body: body.trim(),
    raw,
  };

  const issues =
    options?.validate === false
      ? []
      : [...validateSkillName(name), ...validateSkillDescription(description)];

  return { manifest, issues };
}

// ===================================================================
// [seam] SkillSource — the ONLY IO touchpoint
// ===================================================================

export interface SkillSourceEntry {
  id: string;
  name: string;
  description: string;
  path?: string;
}

export interface SkillSource {
  /** Level 1: lightweight catalog (id + name + description only). */
  list(): Promise<SkillSourceEntry[]>;
  /** Level 2: full SKILL.md text for a skill id. */
  read(id: string): Promise<string>;
  /** Level 3: a bundled resource (bytes or text) relative to the skill. */
  readResource?(id: string, rel: string): Promise<Uint8Array | string>;
}

/** Edge default: catalog from `${baseUrl}/index.json`, bodies/resources over `fetch`. */
export function fetchSkillSource(baseUrl: string, fetchImpl?: typeof fetch): SkillSource {
  const f = fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async list() {
      const res = await f(`${root}/index.json`);
      if (!res.ok)
        throw new InvalidRequestError({
          message: `Skill index fetch failed (HTTP ${res.status}).`,
        });
      const json = (await res.json()) as { skills?: SkillSourceEntry[] } | SkillSourceEntry[];
      return Array.isArray(json) ? json : (json.skills ?? []);
    },
    async read(id) {
      const res = await f(`${root}/${id}/SKILL.md`);
      if (!res.ok)
        throw new InvalidRequestError({
          message: `Skill '${id}' fetch failed (HTTP ${res.status}).`,
        });
      return res.text();
    },
    async readResource(id, rel) {
      const safe = normalizeResourcePath(rel);
      const res = await f(`${root}/${id}/${safe}`);
      if (!res.ok)
        throw new InvalidRequestError({
          message: `Resource '${rel}' fetch failed (HTTP ${res.status}).`,
        });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** In-memory source from a literal map (tests / static catalogs / no-op default). */
export function staticSkillSource(
  skills: Record<string, { raw: string; resources?: Record<string, Uint8Array | string> }>,
): SkillSource {
  return {
    async list() {
      return Object.entries(skills).map(([id, { raw }]) => {
        const { manifest } = parseSkill(raw, { validate: false });
        return { id, name: manifest.name || id, description: manifest.description };
      });
    },
    async read(id) {
      const entry = skills[id];
      if (!entry) throw new InvalidRequestError({ message: `Unknown skill '${id}'.` });
      return entry.raw;
    },
    async readResource(id, rel) {
      const safe = normalizeResourcePath(rel);
      const res = skills[id]?.resources?.[safe];
      if (res === undefined)
        throw new InvalidRequestError({ message: `Unknown resource '${rel}' for skill '${id}'.` });
      return res;
    },
  };
}

/** Compose sources (project/user/plugin/remote); earlier ids win unless override. */
export function mergeSkillSources(
  sources: Array<{ source: SkillSource; prefix?: string }>,
  opts?: { override?: boolean },
): SkillSource {
  const qualify = (prefix: string | undefined, id: string): string =>
    prefix ? `${prefix}:${id}` : id;
  return {
    async list() {
      const seen = new Map<string, SkillSourceEntry>();
      for (const { source, prefix } of sources) {
        for (const e of await source.list()) {
          const qid = qualify(prefix, e.id);
          if (!seen.has(qid) || opts?.override) seen.set(qid, { ...e, id: qid });
        }
      }
      return [...seen.values()];
    },
    async read(id) {
      // Try each source whose prefix matches; fall back to raw id.
      for (const { source, prefix } of sources) {
        const localId = prefix
          ? id.startsWith(`${prefix}:`)
            ? id.slice(prefix.length + 1)
            : undefined
          : id;
        if (localId === undefined) continue;
        try {
          return await source.read(localId);
        } catch {
          /* try next source */
        }
      }
      throw new InvalidRequestError({ message: `Unknown skill '${id}'.` });
    },
    async readResource(id, rel) {
      // Fall through across sources (matching read()): try every source whose
      // prefix matches, not just the first unprefixed one.
      for (const { source, prefix } of sources) {
        const localId = prefix
          ? id.startsWith(`${prefix}:`)
            ? id.slice(prefix.length + 1)
            : undefined
          : id;
        if (localId === undefined || !source.readResource) continue;
        try {
          return await source.readResource(localId, rel);
        } catch {
          /* try next source */
        }
      }
      throw new InvalidRequestError({ message: `No resource '${rel}' for skill '${id}'.` });
    },
  };
}

// ===================================================================
// [seam] SkillMatcher — ranking/pruning, NOT a router
// ===================================================================

export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
}

export interface SkillMatch {
  id: string;
  score: number;
}

export interface SkillMatchOptions {
  topK?: number;
  threshold?: number;
}

export interface SkillMatcher {
  match(
    query: string,
    candidates: SkillCandidate[],
    opts?: SkillMatchOptions,
  ): SkillMatch[] | Promise<SkillMatch[]>;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'how',
  'do',
  'i',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

/** Pure token-overlap matcher (zero-dep). Good edge default for catalog pruning. */
export const lexicalMatcher: SkillMatcher = {
  match(query, candidates, opts) {
    const q = new Set(tokenize(query));
    const scored = candidates.map((c) => {
      const tokens = new Set(tokenize(`${c.name} ${c.description}`));
      let overlap = 0;
      for (const t of q) if (tokens.has(t)) overlap++;
      return { id: c.id, score: q.size ? overlap / q.size : 0 };
    });
    const threshold = opts?.threshold ?? 0;
    return scored
      .filter((s) => s.score > threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts?.topK ?? candidates.length);
  },
};

/** Embedding matcher wired to Faz-3 embed.ts (cosine over name+description). */
export function embeddingMatcher(embed: (texts: string[]) => Promise<number[][]>): SkillMatcher {
  return {
    async match(query, candidates, opts) {
      if (candidates.length === 0) return [];
      const vectors = await embed([query, ...candidates.map((c) => `${c.name} ${c.description}`)]);
      const qv = vectors[0]!;
      const scored = candidates.map((c, i) => ({ id: c.id, score: cosine(qv, vectors[i + 1]!) }));
      const threshold = opts?.threshold ?? -1;
      return scored
        .filter((s) => s.score > threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, opts?.topK ?? candidates.length);
    },
  };
}

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ===================================================================
// Progressive-disclosure registry: pure orchestration over the two seams
// ===================================================================

export interface SkillRegistry {
  /** Level 1. */
  catalog(): Promise<SkillCandidate[]>;
  /** Level 2 — load + parse a skill body on demand. */
  trigger(id: string): Promise<SkillManifest>;
  /** Level 3 — load a bundled resource on demand. */
  resource(id: string, rel: string): Promise<Uint8Array | string>;
  /** Prune the catalog with the matcher (does NOT auto-trigger). */
  match(query: string, opts?: SkillMatchOptions): Promise<SkillMatch[]>;
}

export function createSkillRegistry(deps: {
  source: SkillSource;
  matcher?: SkillMatcher;
  parseYaml?: (yaml: string) => Record<string, unknown>;
}): SkillRegistry {
  const matcher = deps.matcher ?? lexicalMatcher;
  return {
    async catalog() {
      const entries = await deps.source.list();
      return entries.map((e) => ({ id: e.id, name: e.name, description: e.description }));
    },
    async trigger(id) {
      const raw = await deps.source.read(id);
      return parseSkill(raw, { parseYaml: deps.parseYaml }).manifest;
    },
    async resource(id, rel) {
      if (!deps.source.readResource) {
        throw new InvalidRequestError({ message: 'This SkillSource has no resource loader.' });
      }
      return deps.source.readResource(id, normalizeResourcePath(rel));
    },
    async match(query, opts) {
      const candidates = await this.catalog();
      return matcher.match(query, candidates, opts);
    },
  };
}

// ===================================================================
// Model-facing rendering helpers (pure)
// ===================================================================

/** Render the catalog as a system-prompt `<available_skills>` block. */
export function renderSkillCatalog(candidates: SkillCandidate[]): string {
  if (candidates.length === 0) return '';
  const lines = candidates.map((c) => `- ${c.name} (${c.id}): ${c.description}`);
  return `<available_skills>\n${lines.join('\n')}\n</available_skills>`;
}

/** Normalize a Level-3 relative path; reject traversal ('..', leading '/'). */
export function normalizeResourcePath(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('/') || norm.split('/').some((seg) => seg === '..')) {
    throw new InvalidRequestError({
      message: `Illegal resource path '${rel}' (traversal not allowed).`,
    });
  }
  return norm;
}

/**
 * Intersect an active ToolSet with a triggered skill's `allowed-tools`. A bare
 * 'Read' matches key 'Read'; a scoped 'Bash(git:*)' matches key 'Bash' (the
 * inner pattern is advisory metadata, not enforced by core). `undefined`
 * allowedTools means "no restriction" → the full set passes through.
 */
export function scopeToolsToSkill(tools: ToolSet, allowedTools: string[] | undefined): ToolSet {
  if (!allowedTools) return tools;
  const allowedKeys = new Set(allowedTools.map((t) => t.replace(/\(.*\)$/, '').trim()));
  const out: ToolSet = {};
  for (const [key, tool] of Object.entries(tools)) {
    if (allowedKeys.has(key)) out[key] = tool;
  }
  return out;
}
