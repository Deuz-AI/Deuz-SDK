/**
 * skills/node.ts — Node-only filesystem `SkillSource` for Agent Skills.
 * Exported as `@deuz/core/skills/node` (NOT bundled into edge-safe core). Lazily
 * imports `node:fs/promises` / `node:path` exactly like `mcp/stdio.ts`, so core
 * stays edge-safe; calling these in an edge runtime throws a clear error.
 */
import {
  parseSkill,
  normalizeResourcePath,
  type SkillSource,
  type SkillSourceEntry,
} from '../skills';

interface NodeFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(
    path: string,
    opts: { withFileTypes: true },
  ): Promise<{ name: string; isDirectory(): boolean }[]>;
  access(path: string): Promise<void>;
}
interface NodePath {
  join(...parts: string[]): string;
}

async function load(): Promise<{ fs: NodeFs; path: NodePath }> {
  try {
    // `as string` specifiers keep tsup's dts builder from statically resolving
    // the node: builtins (matches the optional-peer evasion in rag-node.ts).
    const fs = (await import('node:fs/promises' as string)) as unknown as NodeFs;
    const path = (await import('node:path' as string)) as unknown as NodePath;
    return { fs, path };
  } catch (err) {
    throw new Error(
      'nodeSkillSource requires a Node runtime (node:fs/promises). Use fetchSkillSource on the edge.',
      { cause: err },
    );
  }
}

/**
 * Walk one or more directories for `<id>/SKILL.md` skill folders. `list()` reads
 * each manifest's frontmatter for the Level-1 catalog; `read()`/`readResource()`
 * load bodies and bundled files on demand.
 */
export function nodeSkillSource(dirs: string[]): SkillSource {
  // Find which dir holds a given skill id (first match wins).
  async function locate(
    id: string,
  ): Promise<{ fs: NodeFs; path: NodePath; dir: string } | undefined> {
    const { fs, path } = await load();
    for (const dir of dirs) {
      try {
        await fs.access(path.join(dir, id, 'SKILL.md'));
        return { fs, path, dir };
      } catch {
        /* not here */
      }
    }
    return undefined;
  }

  return {
    async list() {
      const { fs, path } = await load();
      const out: SkillSourceEntry[] = [];
      const seen = new Set<string>();
      for (const dir of dirs) {
        let entries: { name: string; isDirectory(): boolean }[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // missing dir is fine
        }
        for (const ent of entries) {
          if (!ent.isDirectory() || seen.has(ent.name)) continue;
          const file = path.join(dir, ent.name, 'SKILL.md');
          try {
            const raw = await fs.readFile(file, 'utf-8');
            const { manifest } = parseSkill(raw, { validate: false });
            out.push({
              id: ent.name,
              name: manifest.name || ent.name,
              description: manifest.description,
              path: file,
            });
            seen.add(ent.name);
          } catch {
            /* no SKILL.md in this folder */
          }
        }
      }
      return out;
    },
    async read(id) {
      const found = await locate(id);
      if (!found) throw new Error(`Skill '${id}' not found in: ${dirs.join(', ')}`);
      return found.fs.readFile(found.path.join(found.dir, id, 'SKILL.md'), 'utf-8');
    },
    async readResource(id, rel) {
      const safe = normalizeResourcePath(rel);
      const found = await locate(id);
      if (!found) throw new Error(`Skill '${id}' not found in: ${dirs.join(', ')}`);
      return found.fs.readFile(found.path.join(found.dir, id, safe));
    },
  };
}
