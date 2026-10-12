/**
 * Claims the Agent Skills make (skills/deuz-sdk, its .claude mirror, skills/migrate-from-ai-sdk),
 * each held against the code it describes (W3 review V5-1 .. V5-6). A block pins the behaviour
 * first, then checks that the skill text says so, in every copy that carries the claim.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPriceProvider, PRICES_2026, type PriceTable } from '../src/pricing';
import type { Usage } from '../src/types/usage';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

/** Every Markdown file of both skills, the mirror included, as repository paths. */
function skillMarkdown(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push(relative(REPO, path).replace(/\\/g, '/'));
    }
  };
  walk(join(REPO, 'skills'));
  walk(join(REPO, '.claude/skills'));
  return files.sort();
}

const MILLION: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2_000_000,
};

describe('createPriceProvider takes an options object (W3 review V5-1)', () => {
  it('ignores a table passed positionally; { table } prices it', () => {
    const table: PriceTable = { ...PRICES_2026, 'acme-1': { input: 1, output: 2 } };
    expect(createPriceProvider({ table }).priceUsage('acme-1', MILLION)).toBe(3);
    // A PriceTable is an index signature, so TypeScript accepts it as the options object.
    expect(createPriceProvider(table).priceUsage('acme-1', MILLION)).toBeUndefined();
  });

  it('no skill passes createPriceProvider anything but an options object', () => {
    const positional = skillMarkdown().flatMap((path) =>
      (read(path).match(/createPriceProvider\((?![){])[^)]*\)/g) ?? []).map(
        (call) => `${path}: ${call}`,
      ),
    );
    expect(positional).toEqual([]);
  });
});
