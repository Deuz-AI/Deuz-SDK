#!/usr/bin/env node
/**
 * generate-api-index — rebuilds the Agent Skill's `references/api-index.md`
 * (every subpath, every export, Values apart from Types, and a reverse lookup)
 * from the package's real export surface.
 *
 *   node packages/core/tooling/skills/generate-api-index.mjs --date 2026-10-20
 *
 * Writes the index into both skill copies (`skills/deuz-sdk/` and
 * `.claude/skills/deuz-sdk/`). The stamp date comes from `--date` or
 * `SOURCE_DATE_EPOCH`, never from the clock, so a run is reproducible: the
 * same sources and date give the same bytes on any machine.
 *
 * Options:
 *   --date YYYY-MM-DD   stamp date (else SOURCE_DATE_EPOCH, else an error)
 *   --out <file>        write only this file instead of the two skill copies
 *   --core <dir>        read another checkout's packages/core (its react is ../react);
 *                       needs --out
 *   --locale <bcp47>    collation for the name lists (default: en, which verify-skill
 *                       expects; `tr` reproduces the order of the 2.2.0 index)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, compareNames, loadExportTable } from './export-table.mjs';

/** The command the generated header tells a maintainer to run. */
export const REGENERATE_COMMAND =
  'node packages/core/tooling/skills/generate-api-index.mjs --date YYYY-MM-DD';

/** Where the index lives in each skill copy, relative to the repository root. */
export const INDEX_PATHS = [
  'skills/deuz-sdk/references/api-index.md',
  '.claude/skills/deuz-sdk/references/api-index.md',
];

/**
 * One line per public module. This table is the source of the descriptions in
 * the index: edit a blurb here, then regenerate. A subpath missing from it
 * fails the generator, so a new export is never published undescribed.
 */
export const SUBPATH_DESCRIPTIONS = {
  '@deuz-sdk/core':
    'The six call functions, tool authoring, stop conditions, errors, and every canonical type.',
  '@deuz-sdk/core/anthropic': 'Anthropic Messages wire (Claude).',
  '@deuz-sdk/core/openai': 'OpenAI Chat Completions + Responses wires, and OpenAI embeddings.',
  '@deuz-sdk/core/xai': 'xAI Grok over the Chat Completions wire.',
  '@deuz-sdk/core/google': 'Gemini on either wire: native generateContent or OpenAI-compatible.',
  '@deuz-sdk/core/google/extras': 'Gemini explicit context caching and the Files API.',
  '@deuz-sdk/core/voyage': 'Voyage embeddings (retrieval-tuned, embedding-only provider).',
  '@deuz-sdk/core/azure': 'Azure OpenAI / Azure AI Foundry, api-key or Entra auth.',
  '@deuz-sdk/core/bedrock':
    'AWS Bedrock over its OpenAI-compatible endpoint with Bearer keys (no SigV4 SDK).',
  '@deuz-sdk/core/providers':
    'Every provider factory re-exported, plus the OpenAI-compatible host presets and the registry.',
  '@deuz-sdk/core/testing':
    'Deterministic mock models, SSE fixtures, fetch mocks, and eval runners for YOUR tests.',
  '@deuz-sdk/core/workspace':
    'A file-tree seam agents use as externalized memory, plus the tools that drive it.',
  '@deuz-sdk/core/workspace/node': 'Real-filesystem workspace (Node only).',
  '@deuz-sdk/core/compute': 'CodeAct: let the model act by writing code; sandbox seam and shell tool.',
  '@deuz-sdk/core/compute/node': 'Node child-process sandbox for the compute tools.',
  '@deuz-sdk/core/agent':
    'Native run/stream/resume, validated outputs, execution policies, shared and persistent budgets; also createAgent templates and handoff.',
  '@deuz-sdk/core/swarm':
    'Bounded agent/reducer DAGs, runtime spawning, blackboards, rounds, leases, drain and recovery, atomic snapshots and cursor events.',
  '@deuz-sdk/core/swarm/sqlite':
    'Node-only SQLite persistence for swarm runs, native agent envelopes and events.',
  '@deuz-sdk/core/swarm/postgres':
    'Node-only Postgres swarm store: every write one revision-gated statement.',
  '@deuz-sdk/core/swarm/redis':
    'Node-only Redis swarm store: revision-gated commits as Lua scripts (Redis 7+).',
  '@deuz-sdk/core/ops':
    'Leases for cross-process runs: the LeaseProvider contract and an in-memory provider.',
  '@deuz-sdk/core/ops/sqlite':
    'Node-only SQLite leases, native agent run store and persistent budget store.',
  '@deuz-sdk/core/ops/postgres':
    'Node-only Postgres leases, native agent run store and persistent budget store.',
  '@deuz-sdk/core/ops/redis':
    'Node-only Redis leases, native agent run store, schedule claims and persistent budget store.',
  '@deuz-sdk/core/evolve':
    'Evolutionary program search: evolve blocks, SEARCH/REPLACE patches, cascade, islands, zero-call resume.',
  '@deuz-sdk/core/evolve/sqlite': 'Node-only SQLite population store for evolve.',
  '@deuz-sdk/core/schedule':
    'Five-field UTC cron, a tick-driven scheduler with dedupe, and verified webhooks.',
  '@deuz-sdk/core/goal':
    'Goals, wakeups and events: versioned records, pure transitions, evidence-based acceptance, a GoalStore seam.',
  '@deuz-sdk/core/autonomy':
    'Ensemble strategies: best-of-N, self-consistency, parallel agents, task planning.',
  '@deuz-sdk/core/runtime':
    'Background runs: run store, run manager, live plan/activity feed, steering.',
  '@deuz-sdk/core/runtime/node': 'File-backed run store and stale-run polling (Node only).',
  '@deuz-sdk/core/browser': 'Browser-control tools over a pluggable controller seam.',
  '@deuz-sdk/core/browser/node': 'Playwright-backed browser controller (Node only).',
  '@deuz-sdk/core/pricing':
    'USD cost accounting: bundled price table, price provider, cache savings.',
  '@deuz-sdk/core/middleware':
    'Removable model layers: logging, caching, PII redaction, fallback, injection guard.',
  '@deuz-sdk/core/guardrails': 'Built-in input/tool-call/tool-result/output guardrails.',
  '@deuz-sdk/core/image': 'Synchronous image generation.',
  '@deuz-sdk/core/speech': 'Text to speech.',
  '@deuz-sdk/core/transcription': 'Speech to text.',
  '@deuz-sdk/core/realtime':
    'Live speech-to-speech over the OpenAI Realtime and Gemini Live WebSockets, with tools and ephemeral tokens.',
  '@deuz-sdk/core/batch':
    'Provider batch APIs (OpenAI, Anthropic, Gemini): submit, wait, read results, batch-tier pricing and budget holds.',
  '@deuz-sdk/core/a2a':
    'Agent2Agent v1.0.0: call remote agents and serve your own over JSON-RPC or HTTP+JSON.',
  '@deuz-sdk/core/headless':
    'Headless preview: run, resume, inspect and check native agent runs from a script (Node only).',
  '@deuz-sdk/core/video': 'Video generation: submit, poll, download.',
  '@deuz-sdk/core/midjourney': 'Midjourney submit/poll/action flow.',
  '@deuz-sdk/core/yunwu':
    'Yunwu relay: one key and base URL for chat, image, video, embeddings and Midjourney.',
  '@deuz-sdk/core/memory':
    'Long-term memory: extract, reconcile, apply — behind one swappable store seam.',
  '@deuz-sdk/core/memory/markdown':
    'Obsidian-style markdown vault as the memory store (Node only).',
  '@deuz-sdk/core/rag':
    'Edge-safe RAG: sniff, parse, chunk, embed, dense + BM25 hybrid retrieval, citations.',
  '@deuz-sdk/core/rag/node': 'PDF / DOCX / XLSX / HTML parsers for the RAG registry (Node only).',
  '@deuz-sdk/core/skills':
    'Agent Skills: SKILL.md parsing, registry, matchers, catalog rendering, tool scoping.',
  '@deuz-sdk/core/skills/node': 'Load skills from directories on disk (Node only).',
  '@deuz-sdk/core/vertex':
    'Claude and Gemini through Vertex AI; edge-safe service-account JWT signing.',
  '@deuz-sdk/core/vertex/node': 'Vertex Application Default Credentials (Node only).',
  '@deuz-sdk/core/mcp':
    'MCP client over HTTP/SSE, connection pool, OAuth provider, tool conversion.',
  '@deuz-sdk/core/mcp/stdio': 'MCP over stdio — spawn a local server process (Node only).',
  '@deuz-sdk/core/mcp/node': 'Node OAuth helpers for MCP: file token store, loopback redirect.',
  '@deuz-sdk/core/mcp/server':
    'Serve Deuz tools, native agent tools and whole agents as an MCP server over Streamable HTTP.',
  '@deuz-sdk/core/mcp/server/stdio': 'The same MCP server over stdio (Node only).',
  '@deuz-sdk/core/stores/sqlite':
    'One factory for memory + chat + session + run stores on node:sqlite.',
  '@deuz-sdk/core/stores/redis': 'The same four store seams on Redis.',
  '@deuz-sdk/core/stores/postgres':
    'The same four store seams on Postgres (pgvector when available).',
  '@deuz-sdk/core/durable': 'Checkpoints, resume-after-crash, and HMAC-signed tool approvals.',
  '@deuz-sdk/core/otel': 'OpenTelemetry bridge for traces and events.',
  '@deuz-sdk/core/observe':
    'Local-first observation events: observers, run summaries, reports. No hosted service.',
  '@deuz-sdk/core/observe/node': 'JSONL persistence for observation events (Node only).',
  '@deuz-sdk/core/edge': 'A curated re-export subset guaranteed to contain nothing Node-only.',
  '@deuz-sdk/core/ui':
    'The Deuz UI wire: SSE responses, resumable streams, and the client-side reader.',
  '@deuz-sdk/core/react': 'Legacy in-core React hooks — prefer the @deuz-sdk/react package.',
  '@deuz-sdk/core/chat':
    'The pure chat state engine plus validateChatRequest — the gate in front of client history.',
  '@deuz-sdk/core/chat/node': 'File-backed chat store (Node only).',
  '@deuz-sdk/react': 'React hooks and components: useChat, useObject, approval card, cost badge.',
};

/** The curated re-export subset would list half the package again; the reverse lookup skips it. */
const NOT_A_HOME = new Set(['@deuz-sdk/core/edge']);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertDate(date) {
  const m = DATE.exec(date ?? '');
  const parsed = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!parsed || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`stamp date must be a real YYYY-MM-DD date, got "${date}"`);
  }
  return date;
}

/**
 * The stamp date: `date` when given, else the UTC day of `SOURCE_DATE_EPOCH`.
 * There is deliberately no clock fallback.
 */
export function resolveStampDate({ date, env = process.env } = {}) {
  if (date !== undefined) return assertDate(date);
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === '') {
    throw new Error('no stamp date: pass --date YYYY-MM-DD or set SOURCE_DATE_EPOCH');
  }
  if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH must be whole seconds, got "${epoch}"`);
  return new Date(Number(epoch) * 1000).toISOString().slice(0, 10);
}

const code = (text) => `\`${text}\``;

function list(label, names) {
  return `**${label}** (${names.length}): ${names.length > 0 ? names.join(', ') : '_none_'}`;
}

/** Renders the index for `table` (from `loadExportTable`). Pure: same input, same bytes. */
export function renderApiIndex(
  table,
  { date, locale = 'en', descriptions = SUBPATH_DESCRIPTIONS } = {},
) {
  assertDate(date);
  const byName = (a, b) => compareNames(a, b, locale);
  const core = table.modules.filter((module) => module.specifier !== '@deuz-sdk/react');
  const lines = [
    '<!-- GENERATED FILE — do not hand-edit.',
    `     regenerate: ${REGENERATE_COMMAND}`,
    '     source: packages/core/{package.json exports, tsup.config.ts} + src walk (export * followed)',
    `     verified: ${date} against @deuz-sdk/core@${table.version} · api-contract sha256:${table.contractHash} -->`,
    '',
    '# API index — every subpath, every export',
    '',
    '**Load when:** checking whether a name exists, finding which subpath exports it, or exploring an unfamiliar module.',
    '',
    `${code(`@deuz-sdk/core@${table.version}`)} ships **${core.length} subpaths**; ${code('@deuz-sdk/react')} ships one. Names marked under **Types** are type-only — import them with ${code('import type')}, or a bundler-free runtime will crash looking for a value that was erased at compile time.`,
    '',
    `If anything here disagrees with ${code('packages/core/package.json')} ${code('exports')} or ${code('tooling/api-contract.json')}, those win — and this file is stale; regenerate it.`,
  ];

  for (const module of table.modules) {
    const description = descriptions[module.specifier];
    if (!description) {
      throw new Error(
        `no description for ${module.specifier}: add one to SUBPATH_DESCRIPTIONS in generate-api-index.mjs`,
      );
    }
    const names = [...module.names];
    const values = names.filter(([, kind]) => kind === 'value').map(([name]) => name);
    const types = names.filter(([, kind]) => kind === 'type').map(([name]) => name);
    lines.push(
      '',
      `## ${code(module.specifier)}`,
      '',
      description,
      '',
      list('Values', values.sort(byName)),
      '',
      list('Types', types.sort(byName)),
    );
  }

  const root = table.modules.find((module) => module.specifier === '@deuz-sdk/core');
  const homes = new Map();
  for (const module of table.modules) {
    if (module === root || NOT_A_HOME.has(module.specifier)) continue;
    for (const [name, kind] of module.names) {
      if (kind !== 'value' || root?.names.has(name)) continue;
      if (!homes.has(name)) homes.set(name, []);
      homes.get(name).push(module.label);
    }
  }
  lines.push(
    '',
    '## Where a value lives (everything not exported from the root)',
    '',
    `Reverse lookup for "which subpath do I import this from?". Root exports are omitted — try ${code('@deuz-sdk/core')} first.`,
    '',
    ...[...homes.keys()]
      .sort(byName)
      .map((name) => `- ${code(name)} — ${homes.get(name).map(code).join(', ')}`),
  );
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--date', '--out', '--core', '--locale'].includes(flag)) {
      throw new Error(`unknown argument "${flag}"`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = value;
    i++;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.core && !options.out) {
    throw new Error("--core needs --out: the default targets are this repository's skill copies");
  }
  const date = resolveStampDate({ date: options.date });
  const table = loadExportTable(options.core ? { core: resolve(options.core) } : {});
  if (table.problems.length > 0) {
    throw new Error(`the export table is inconsistent:\n- ${table.problems.join('\n- ')}`);
  }
  const text = renderApiIndex(table, { date, locale: options.locale });
  const targets = options.out ? [resolve(options.out)] : INDEX_PATHS.map((p) => join(REPO_ROOT, p));
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`wrote ${target}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`generate-api-index: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
