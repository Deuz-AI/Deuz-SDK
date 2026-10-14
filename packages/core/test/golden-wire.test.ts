/**
 * golden-wire.test.ts (2.4, W0A) — the "off means no difference" gate of
 * spec §5.2. Every scenario of `fixtures/golden-wire/scenarios.ts` makes a
 * default call through a provider factory; its HTTP requests (method, URL,
 * headers, body bytes) must equal the ones 2.3.0 sent, recorded in
 * `fixtures/golden-wire/2.3.0/`. A 2.4 feature that is off must not move a
 * single byte. See `fixtures/golden-wire/README.md`.
 *
 * `DEUZ_GOLDEN_WIRE_RECORD=1` writes the fixture of a scenario that has none
 * (it never rewrites an existing file); without it a missing fixture fails.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GOLDEN_SCENARIOS, type GoldenScenario } from './fixtures/golden-wire/scenarios';
import {
  fixtureBody,
  goldenDeps,
  recordingFetch,
  toFixtureRequest,
  type FixtureRequest,
  type GoldenFixture,
  type WireRequest,
} from './fixtures/golden-wire/harness';

const RELEASE = '2.3.0';
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden-wire', RELEASE);
const RECORD = process.env.DEUZ_GOLDEN_WIRE_RECORD === '1';

async function capture(scenario: GoldenScenario): Promise<WireRequest[]> {
  const { fetch, requests } = recordingFetch(scenario.script);
  await scenario.run(fetch, goldenDeps());
  return requests;
}

const fixturePath = (id: string) => join(DIR, `${id}.json`);

function readFixture(id: string): GoldenFixture | undefined {
  const path = fixturePath(id);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as GoldenFixture) : undefined;
}

/** The body as a JSON value, for a structural diff before the byte check. */
function parsed(body: string | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function expectSameRequest(
  id: string,
  index: number,
  actual: WireRequest,
  expected: FixtureRequest,
) {
  const at = `${id} request #${index + 1}`;
  const body = fixtureBody(expected);
  expect(actual.method, `${at}: method`).toBe(expected.method);
  expect(actual.url, `${at}: URL`).toBe(expected.url);
  expect(actual.headers, `${at}: headers`).toEqual(expected.headers);
  // The JSON value first, so a failure shows which field moved; then the bytes,
  // which also catch key order and number or string formatting.
  expect(parsed(actual.body), `${at}: body (as JSON)`).toEqual(parsed(body));
  expect(actual.body, `${at}: body bytes (same JSON value, other bytes: key order?)`).toBe(body);
  expect(actual.form, `${at}: multipart entries`).toEqual(expected.form);
  expect(actual.bodyBase64, `${at}: binary body`).toEqual(expected.bodyBase64);
}

describe('golden wire: default requests are byte-identical to 2.3.0', () => {
  it('scenario ids are unique', () => {
    const ids = GOLDEN_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every 2.3.0 fixture still has its scenario', () => {
    const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
    const ids = new Set(GOLDEN_SCENARIOS.map((s) => `${s.id}.json`));
    expect(files.filter((f) => !ids.has(f))).toEqual([]);
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    it(scenario.id, async () => {
      const requests = await capture(scenario);
      expect(requests.length, `${scenario.id}: no request was sent`).toBeGreaterThan(0);
      const fixture = readFixture(scenario.id);
      if (!fixture) {
        if (!RECORD) {
          throw new Error(
            `No golden fixture for '${scenario.id}'. A 2.3.0 fixture can only be recorded from ` +
              'the 2.3.0 code (DEUZ_GOLDEN_WIRE_RECORD=1); see fixtures/golden-wire/README.md.',
          );
        }
        // A second run must send the same bytes, or the scenario is not deterministic.
        expect(await capture(scenario), `${scenario.id}: two runs differ`).toEqual(requests);
        const record: GoldenFixture = {
          scenario: scenario.id,
          recordedFrom: RELEASE,
          requests: requests.map(toFixtureRequest),
        };
        mkdirSync(DIR, { recursive: true });
        writeFileSync(fixturePath(scenario.id), `${JSON.stringify(record, null, 2)}\n`);
        return;
      }
      expect(fixture.scenario).toBe(scenario.id);
      expect(requests.length, `${scenario.id}: request count`).toBe(fixture.requests.length);
      requests.forEach((request, index) =>
        expectSameRequest(scenario.id, index, request, fixture.requests[index]!),
      );
    });
  }
});
