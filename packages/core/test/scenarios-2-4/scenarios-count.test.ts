import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENFORCE_SCENARIO_MINIMUMS, SCENARIO_MINIMUMS, type ScenarioArea } from './registry';

const DIR = fileURLToPath(new URL('.', import.meta.url));
/** `scenario('area', 'id'` — the first two arguments, as the registry requires them. */
const CALL = /\bscenario\(\s*'([a-z-]+)'\s*,\s*'([a-z0-9-]+)'/g;

function declared(): { area: string; id: string; file: string }[] {
  const found: { area: string; id: string; file: string }[] = [];
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith('.test.ts') || file === 'scenarios-count.test.ts') continue;
    const text = readFileSync(DIR + file, 'utf8');
    for (const match of text.matchAll(CALL)) found.push({ area: match[1]!, id: match[2]!, file });
  }
  return found;
}

describe('2.4 acceptance scenarios (new.txt §5.1)', () => {
  const scenarios = declared();

  it('every scenario names a spec area', () => {
    const areas = new Set(Object.keys(SCENARIO_MINIMUMS));
    expect(scenarios.filter((s) => !areas.has(s.area))).toEqual([]);
  });

  it('no two scenarios share an id within an area', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const s of scenarios) {
      const key = `${s.area}/${s.id}`;
      if (seen.has(key)) duplicates.push(`${key} (${seen.get(key)} and ${s.file})`);
      else seen.set(key, s.file);
    }
    expect(duplicates).toEqual([]);
  });

  it.runIf(ENFORCE_SCENARIO_MINIMUMS)('each area reaches its spec minimum', () => {
    const counts = Object.fromEntries(
      Object.keys(SCENARIO_MINIMUMS).map((area) => [
        area,
        scenarios.filter((s) => s.area === area).length,
      ]),
    ) as Record<ScenarioArea, number>;
    const short = (Object.keys(SCENARIO_MINIMUMS) as ScenarioArea[]).filter(
      (area) => counts[area] < SCENARIO_MINIMUMS[area],
    );
    expect(short.map((area) => `${area}: ${counts[area]}/${SCENARIO_MINIMUMS[area]}`)).toEqual([]);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThanOrEqual(56);
  });
});
