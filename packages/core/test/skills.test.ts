import { describe, it, expect } from 'vitest';
import {
  parseSkill,
  splitFrontmatter,
  validateSkillName,
  validateSkillDescription,
  staticSkillSource,
  fetchSkillSource,
  mergeSkillSources,
  lexicalMatcher,
  embeddingMatcher,
  createSkillRegistry,
  renderSkillCatalog,
  normalizeResourcePath,
  scopeToolsToSkill,
  type ToolSetLike,
} from '../src/skills';
import type { ToolSet } from '../src/types/tool';
import { InvalidRequestError } from '../src/errors';

const SKILL_MD = `---
name: pdf-filler
description: Fill in PDF forms from structured data.
license: MIT
allowed-tools:
  - Read
  - Bash(python:*)
custom-field: keep-me
---

# PDF Filler

Use this skill to fill PDF forms.

---

A horizontal rule above must NOT split frontmatter.
`;

describe('splitFrontmatter', () => {
  it('splits only the leading --- fence; body keeps its own ---', () => {
    const { frontmatter, body } = splitFrontmatter(SKILL_MD);
    expect(frontmatter).toContain('name: pdf-filler');
    expect(body).toContain('# PDF Filler');
    expect(body).toContain('horizontal rule'); // the body's --- survived
  });

  it('returns null frontmatter when the file does not start with ---', () => {
    const { frontmatter, body } = splitFrontmatter('# Just markdown\n');
    expect(frontmatter).toBeNull();
    expect(body).toBe('# Just markdown\n');
  });
});

describe('parseSkill', () => {
  it('parses frontmatter, normalizes allowed-tools, keeps extras in metadata', () => {
    const { manifest, issues } = parseSkill(SKILL_MD);
    expect(manifest.name).toBe('pdf-filler');
    expect(manifest.description).toBe('Fill in PDF forms from structured data.');
    expect(manifest.license).toBe('MIT');
    expect(manifest.allowedTools).toEqual(['Read', 'Bash(python:*)']);
    expect(manifest.metadata['custom-field']).toBe('keep-me');
    expect(manifest.body.startsWith('# PDF Filler')).toBe(true);
    expect(issues).toEqual([]);
  });

  it('parses an inline flow list for allowed-tools', () => {
    const { manifest } = parseSkill(`---
name: x
description: y
allowed-tools: [Read, Write]
---
body`);
    expect(manifest.allowedTools).toEqual(['Read', 'Write']);
  });

  it('parses a comma-list scalar for allowed-tools', () => {
    const { manifest } = parseSkill(`---
name: x
description: y
allowed-tools: Read, Bash(git:*)
---
body`);
    expect(manifest.allowedTools).toEqual(['Read', 'Bash(git:*)']);
  });

  it('collects validation issues but never throws', () => {
    const { issues } = parseSkill(`---
name: Claude-Bad Name!
description:
---
body`);
    const fields = issues.map((i) => i.field);
    expect(fields).toContain('name');
    expect(fields).toContain('description');
  });
});

describe('validators', () => {
  it('validateSkillName enforces kebab + no anthropic/claude', () => {
    expect(validateSkillName('good-name')).toEqual([]);
    expect(validateSkillName('Bad_Name').length).toBeGreaterThan(0);
    expect(validateSkillName('claude-helper').length).toBeGreaterThan(0);
  });
  it('validateSkillDescription enforces non-empty ≤1024 no-XML', () => {
    expect(validateSkillDescription('fine')).toEqual([]);
    expect(validateSkillDescription('')).toHaveLength(1);
    expect(validateSkillDescription('<b>x</b>').length).toBeGreaterThan(0);
  });
});

describe('staticSkillSource + registry (progressive disclosure)', () => {
  const source = staticSkillSource({
    'pdf-filler': { raw: SKILL_MD, resources: { 'forms/w2.json': '{"f":1}' } },
    weather: {
      raw: `---\nname: weather\ndescription: Get the weather for a city.\n---\nbody`,
    },
  });

  it('catalog() returns Level-1 entries only', async () => {
    const reg = createSkillRegistry({ source });
    const cat = await reg.catalog();
    expect(cat).toHaveLength(2);
    expect(cat.find((c) => c.id === 'pdf-filler')!.description).toContain('PDF');
  });

  it('trigger() loads + parses the full body on demand (Level 2)', async () => {
    const reg = createSkillRegistry({ source });
    const m = await reg.trigger('pdf-filler');
    expect(m.body).toContain('# PDF Filler');
    expect(m.allowedTools).toEqual(['Read', 'Bash(python:*)']);
  });

  it('resource() loads a bundled file (Level 3) with traversal guard', async () => {
    const reg = createSkillRegistry({ source });
    expect(await reg.resource('pdf-filler', 'forms/w2.json')).toBe('{"f":1}');
    await expect(reg.resource('pdf-filler', '../secret')).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it('match() prunes via the lexical matcher (default)', async () => {
    const reg = createSkillRegistry({ source });
    const matches = await reg.match('what is the weather today', { topK: 1 });
    expect(matches[0]!.id).toBe('weather');
  });
});

describe('matchers', () => {
  const candidates = [
    { id: 'a', name: 'pdf filler', description: 'fill pdf forms' },
    { id: 'b', name: 'weather', description: 'city weather forecast' },
  ];

  it('lexicalMatcher ranks by token overlap', () => {
    const m = lexicalMatcher.match('fill a pdf form', candidates) as {
      id: string;
      score: number;
    }[];
    expect(m[0]!.id).toBe('a');
    expect(m[0]!.score).toBeGreaterThan(0);
  });

  it('embeddingMatcher ranks by cosine over an injected embed fn', async () => {
    const embed = async (texts: string[]) =>
      texts.map((t) => (t.includes('weather') ? [0, 1] : [1, 0]));
    const m = await embeddingMatcher(embed).match('weather please', candidates, { topK: 1 });
    expect(m[0]!.id).toBe('b');
  });
});

describe('mergeSkillSources', () => {
  it('namespaces ids by prefix; earlier source wins on conflict', async () => {
    const s1 = staticSkillSource({
      shared: { raw: `---\nname: shared\ndescription: from one.\n---\nx` },
    });
    const s2 = staticSkillSource({
      shared: { raw: `---\nname: shared\ndescription: from two.\n---\ny` },
    });
    const merged = mergeSkillSources([
      { source: s1, prefix: 'proj' },
      { source: s2, prefix: 'user' },
    ]);
    const list = await merged.list();
    const ids = list.map((e) => e.id).sort();
    expect(ids).toEqual(['proj:shared', 'user:shared']);
    expect(await merged.read('user:shared')).toContain('from two');
  });
});

describe('rendering + scoping helpers', () => {
  it('renderSkillCatalog emits an <available_skills> block (empty when none)', () => {
    expect(renderSkillCatalog([])).toBe('');
    const out = renderSkillCatalog([{ id: 'a', name: 'A', description: 'does A' }]);
    expect(out).toContain('<available_skills>');
    expect(out).toContain('- A (a): does A');
  });

  it('normalizeResourcePath rejects traversal + leading slash, normalizes backslashes', () => {
    expect(normalizeResourcePath('forms\\w2.json')).toBe('forms/w2.json');
    expect(() => normalizeResourcePath('../x')).toThrow(InvalidRequestError);
    expect(() => normalizeResourcePath('/abs')).toThrow(InvalidRequestError);
  });

  it('scopeToolsToSkill intersects by tool key (scoped Bash(...) matches Bash)', () => {
    const tools = {
      Read: { parameters: {} },
      Write: { parameters: {} },
      Bash: { parameters: {} },
    } as unknown as ToolSet;
    const scoped = scopeToolsToSkill(tools, ['Read', 'Bash(python:*)']);
    expect(Object.keys(scoped).sort()).toEqual(['Bash', 'Read']);
    // undefined allowedTools = no restriction
    expect(Object.keys(scopeToolsToSkill(tools, undefined))).toHaveLength(3);
  });
});

describe('fetchSkillSource (edge default over injected fetch)', () => {
  it('reads the index.json catalog and a SKILL.md body', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/index.json')) {
        return new Response(
          JSON.stringify({ skills: [{ id: 'weather', name: 'weather', description: 'w' }] }),
        );
      }
      if (url.endsWith('/weather/SKILL.md')) {
        return new Response(`---\nname: weather\ndescription: w\n---\nbody`);
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const source = fetchSkillSource('https://cdn.example.com/skills', fetchImpl);
    expect(await source.list()).toEqual([{ id: 'weather', name: 'weather', description: 'w' }]);
    expect(await source.read('weather')).toContain('name: weather');
  });
});

// type-only re-export presence check (compile-time)
export type _Probe = ToolSetLike;
