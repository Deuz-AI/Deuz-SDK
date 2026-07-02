# Plan A — Correctness Fixes + 2026-07 Catalog Refresh (0.2.0, Bölüm 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four correctness bugs that break the SDK on post-April-2026 Anthropic models and mischarge billing, and refresh the model/pricing catalog to the verified 2026-07 state.

**Architecture:** All changes are additive to the locked 1.0 surface. A new registry field (`effortWire`) routes Anthropic thinking to `output_config.effort` on 4.7+ models; the `effort` union gains `'xhigh' | 'max'`; pricing gains optional `over200k` tiering; usage parsing learns `output_tokens_details.thinking_tokens` and `usage.iterations[]`; `FinishStreamPart` gains optional `providerMetadata`.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`), vitest golden-replay (inject `deps.fetch`/factory `fetch` via `test/fixtures/sse.ts` — no real network), tsup dual build.

## Global Constraints

- **Additive-only:** no existing public type/function changes shape; `test/surface.test-d.ts` existing assertions must NOT be edited — only extended.
- **Edge-safety (lint-enforced):** no `node:*`/`Buffer`/`process` imports, no `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `console.*` in `src/**` (except the sanctioned files).
- **G-tag comments** (G1/G2/G3/G10/G11) near edited code must be preserved verbatim.
- Node >= 22; run tests with `npx vitest run <file>` or `npm test`.
- Never combine `vi.useFakeTimers()` with MSW.
- Final gate: `npm run check` must pass (format:check + lint + typecheck + test + test:types + build + publint + attw).
- Commit after every task with the exact message given in the task.

---

### Task 1: Registry — `effortWire` field, Anthropic row updates, Claude 5 rows

**Files:**
- Modify: `src/core/registry.ts` (interface at :16-38, `row()` at :42-60, Anthropic rows at :64-99)
- Test: `test/registry.test.ts` (create)

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: `ModelCapabilities.effortWire: 'budget_tokens' | 'output_config'` (required field, defaulted in `row()`), new registry keys `'claude-fable-5'`, `'claude-sonnet-5'`. Task 3 reads `caps.effortWire`; Task 3 also relies on `claude-fable-5` having `samplingRestrictions: true`.

- [ ] **Step 1: Write the failing test**

Create `test/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getCapabilities } from '../src/core/registry';

const anthropic = (modelId: string) =>
  ({ provider: 'anthropic', modelId, surface: 'anthropic' }) as const;

describe('registry: 2026-07 Anthropic catalog', () => {
  it('claude-fable-5 is a known row with output_config effort wire', () => {
    const caps = getCapabilities(anthropic('claude-fable-5'));
    expect(caps.known).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.caching).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.effortWire).toBe('output_config');
    expect(caps.samplingRestrictions).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('claude-sonnet-5 matches fable-5 caps shape', () => {
    const caps = getCapabilities(anthropic('claude-sonnet-5'));
    expect(caps.known).toBe(true);
    expect(caps.effortWire).toBe('output_config');
    expect(caps.samplingRestrictions).toBe(true);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('opus 4.7/4.8 moved to output_config + samplingRestrictions', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7']) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.effortWire).toBe('output_config');
      expect(caps.samplingRestrictions).toBe(true);
    }
  });

  it('opus 4.6 and older keep the budget_tokens wire and free sampling', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.effortWire).toBe('budget_tokens');
      expect(caps.samplingRestrictions).toBe(false);
    }
  });

  it('unknown slugs default to budget_tokens', () => {
    const caps = getCapabilities(anthropic('claude-opus-4-9'));
    expect(caps.known).toBe(false);
    expect(caps.effortWire).toBe('budget_tokens');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — `effortWire` is `undefined` (property does not exist) and `claude-fable-5` resolves `known: false`.

- [ ] **Step 3: Implement**

In `src/core/registry.ts`:

(a) Add to `ModelCapabilities` (after the `samplingRestrictions` member at :35):

```typescript
  /** How reasoning depth is sent to Anthropic: manual `thinking.budget_tokens`
   *  (pre-4.7) vs `output_config.effort` (Opus 4.7+, Sonnet 5, Fable 5 —
   *  budget_tokens returns 400 there). Non-Anthropic wires ignore this. */
  effortWire: 'budget_tokens' | 'output_config';
```

(b) Add the default to `row()` (inside the returned object, before `...over`):

```typescript
    effortWire: 'budget_tokens',
```

(c) Update the two Opus rows and add the Claude 5 rows in `REGISTRY` (the `--- Anthropic ---` section):

```typescript
  'claude-fable-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true, // temperature/top_p/top_k non-default → 400
  }),
  'claude-sonnet-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-8': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-7': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
```

(`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` stay exactly as they are — `row()`'s new default gives them `effortWire: 'budget_tokens'`.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/registry.test.ts` → PASS. Then `npm run typecheck` → clean (the new required field is defaulted in `row()`, `defaultRow()` and `defaultNativeRow()` both build via `row()` so they inherit it).

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): effortWire field + Claude 5 rows, opus 4.7/4.8 output_config"
```

---

### Task 2: `effort` union gains `'xhigh' | 'max'`

**Files:**
- Modify: `src/types/config.ts:34`
- Modify: `test/surface.test-d.ts` (append only)

**Interfaces:**
- Produces: `CommonCallOptions.effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Tasks 3, 6, 7 map the two new levels per wire.

- [ ] **Step 1: Extend the type**

In `src/types/config.ts` replace line 34:

```typescript
  /** Canonical reasoning effort; each adapter maps to its own unit. */
  effort?: 'none' | 'low' | 'medium' | 'high';
```

with:

```typescript
  /** Canonical reasoning effort; each adapter maps to its own unit.
   *  'xhigh' (Anthropic 4.7+/OpenAI) and 'max' (Anthropic 5.x) clamp down
   *  on wires that lack them. */
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

- [ ] **Step 2: Append a surface assertion**

At the END of `test/surface.test-d.ts` (do not touch existing lines), following the file's existing assertion style (check its imports first — it runs under `vitest --typecheck.only`):

```typescript
// --- 0.2.0 additive: effort accepts xhigh/max (input-union widening) ---
import type { CommonCallOptions as _CCO_020 } from '../src/types/config';
const _effortXhigh: _CCO_020['effort'] = 'xhigh';
const _effortMax: _CCO_020['effort'] = 'max';
void _effortXhigh;
void _effortMax;
```

- [ ] **Step 3: Verify**

Run: `npm run test:types` → PASS. Run `npm run typecheck` → PASS (callers of `THINKING_BUDGET[options.effort as 'low'|'medium'|'high']` in `anthropic.ts` still compile because of the cast; Task 3 removes that cast).

- [ ] **Step 4: Commit**

```bash
git add src/types/config.ts test/surface.test-d.ts
git commit -m "feat(types): effort union gains xhigh and max"
```

---

### Task 3: Anthropic adapter — `output_config.effort` wire + samplingRestrictions

**Files:**
- Modify: `src/adapters/anthropic.ts:70-150` (THINKING_BUDGET, buildRequest)
- Modify: `src/inference/generate-object.ts` (the G3 special case around :49-54)
- Test: `test/anthropic.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: `caps.effortWire`, `caps.samplingRestrictions` (Task 1), effort `'xhigh'|'max'` (Task 2).
- Produces: request bodies asserted below; no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/anthropic.test.ts`:

```typescript
function lastBody(calls: { url: string; init?: RequestInit }[]): Record<string, unknown> {
  return JSON.parse(String(calls[calls.length - 1]!.init!.body)) as Record<string, unknown>;
}

describe('Anthropic effort wire (0.2.0)', () => {
  it('fable-5: effort → output_config.effort, no thinking block, sampling stripped', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
      temperature: 0.2,
      topP: 0.9,
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(128_000); // caps.maxOutput, no budget bump
  });

  it('fable-5 without effort sends neither thinking nor output_config', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('opus-4-6 keeps the legacy budget_tokens path; xhigh/max map to 48k', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-6'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 48_000 });
    expect(body.output_config).toBeUndefined();
  });

  it('output_config.effort merges with json structured-output format', async () => {
    const { provider, calls } = model([TEXT_STREAM_JSON]);
    await generateObject({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
      schema: { type: 'object', properties: { a: { type: 'string' } } } as JSONSchema,
    });
    const body = lastBody(calls);
    const oc = body.output_config as Record<string, unknown>;
    expect(oc.effort).toBe('high');
    expect(oc.format).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { a: { type: 'string' } } },
    });
  });
});
```

`TEXT_STREAM_JSON` — add this fixture next to `TEXT_STREAM` (a minimal stream whose text is a JSON object, so `generateObject` parses it):

```typescript
const TEXT_STREAM_JSON = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '{"a":"x"}' },
    },
  },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/anthropic.test.ts -t "effort wire"`
Expected: FAIL — `body.thinking` is set on fable-5 (budget path taken), temperature present.

- [ ] **Step 3: Implement in `src/adapters/anthropic.ts`**

(a) Extend the budget map (replace :70-74):

```typescript
const THINKING_BUDGET: Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', number> = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
  xhigh: 48_000,
  max: 48_000,
};
```

(b) Rework the thinking/sampling section of `buildRequest` (replace :101-122):

```typescript
  const effortOn = caps.reasoning && options.effort !== undefined && options.effort !== 'none';
  // Opus 4.7+/Sonnet 5/Fable 5: budget_tokens returns 400 — effort rides output_config.
  const useOutputConfig = caps.effortWire === 'output_config';
  const thinkingOn = effortOn && !useOutputConfig;
  const maxTokens = options.maxOutputTokens ?? caps.maxOutput;

  const body: Record<string, unknown> = {
    model: call.modelId,
    max_tokens: thinkingOn
      ? Math.max(maxTokens, THINKING_BUDGET[options.effort as keyof typeof THINKING_BUDGET] + 1_024)
      : maxTokens,
    messages: wireMessages,
    stream: true,
  };
  if (system) body.system = system;
  if (thinkingOn) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: THINKING_BUDGET[options.effort as keyof typeof THINKING_BUDGET],
    };
    // Anthropic requires temperature unset (=1) when thinking is enabled.
  } else if (!caps.samplingRestrictions) {
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
  }
  if (options.stopSequences) body.stop_sequences = options.stopSequences;
```

(c) After the existing `ctx.object` / `ctx.tools` block (i.e. right after the `else if (ctx.tools) { … }` closes, before the Vertex section), add the merge so `output_config.effort` composes with the json-strategy `output_config.format`:

```typescript
  if (effortOn && useOutputConfig) {
    body.output_config = {
      ...(body.output_config as Record<string, unknown> | undefined),
      effort: options.effort,
    };
  }
```

(d) Adaptive-thinking models treat forced tool choice like thinking-on (forced choice is rejected): change the `mapAnthropicToolChoice` call site (:145-149) to pass the widened flag:

```typescript
    body.tool_choice = mapAnthropicToolChoice(
      ctx.tools.toolChoice,
      thinkingOn || (effortOn && useOutputConfig),
      ctx.tools.allowParallel,
    );
```

- [ ] **Step 4: Extend G3 in `src/inference/generate-object.ts`**

Find the G3 special case (Anthropic + extended thinking forces `'json'`, around :49-54). Its condition today checks `caps.reasoning && options.effort && options.effort !== 'none'` for provider `'anthropic'`. Widen it so `effortWire === 'output_config'` models (thinking effectively adaptive) also force `'json'` — keep the `G3` comment tag intact and add to the condition:

```typescript
    // G3: forced tool_choice is rejected with thinking on; adaptive-thinking
    // models (effortWire 'output_config') can't disable thinking → force json.
    const anthropicThinking =
      model.surface === 'anthropic' &&
      (caps.effortWire === 'output_config' ||
        (caps.reasoning && options.effort !== undefined && options.effort !== 'none'));
```

(Adapt to the file's exact existing variable names — the deliverable is: for surface `'anthropic'`, `effortWire === 'output_config'` alone is sufficient to pick the `'json'` strategy.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/anthropic.test.ts` → all PASS (existing tests use `claude-opus-4-8` — they must still pass; note the reworked temperature guard only drops sampling for rows with `samplingRestrictions: true`, and the existing suite does not set `temperature` on opus-4-8 calls; if any existing test asserts `body.thinking` on `claude-opus-4-8`, update THAT test to use `claude-opus-4-6` — the behavior change is intentional and release-noted).
Run: `npx vitest run test/tool-loop.test.ts test/openai.test.ts` → PASS (no cross-wire regressions).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/anthropic.ts src/inference/generate-object.ts test/anthropic.test.ts
git commit -m "fix(anthropic): route effort via output_config on 4.7+/5.x, honor samplingRestrictions"
```

---

### Task 4: Anthropic usage — `thinking_tokens` + `iterations[]`

**Files:**
- Modify: `src/adapters/anthropic.ts` (`AnthropicUsage` :188-194, `buildUsage` :226-240, `message_delta` handling :290-292)
- Test: `test/anthropic.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Usage.reasoningTokens` populated for Anthropic; iteration-aware totals.

- [ ] **Step 1: Write the failing tests**

Append to `test/anthropic.test.ts`:

```typescript
describe('Anthropic usage extensions (0.2.0)', () => {
  it('maps output_tokens_details.thinking_tokens to reasoningTokens', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const usage = await result.usage;
    expect(usage.reasoningTokens).toBe(7);
    expect(usage.outputTokens).toBe(20); // thinking stays inside output_tokens (billing unchanged)
    expect(usage.totalTokens).toBe(30);
  });

  it('sums usage.iterations when present (fallbacks/compaction)', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 20,
            iterations: [
              { type: 'message', input_tokens: 10, output_tokens: 3 },
              { type: 'fallback_message', input_tokens: 12, output_tokens: 20 },
            ],
          },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const usage = await result.usage;
    // Iterations replace the top-level attempt view: inputs and outputs sum across attempts.
    expect(usage.inputTokens).toBe(22);
    expect(usage.outputTokens).toBe(23);
    expect(usage.totalTokens).toBe(45);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/anthropic.test.ts -t "usage extensions"`
Expected: FAIL — `reasoningTokens` is 0, iteration test reports `inputTokens: 10`.

- [ ] **Step 3: Implement in `src/adapters/anthropic.ts`**

(a) Extend `AnthropicUsage`:

```typescript
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
  /** Per-attempt usage from server-side fallbacks / compaction — sum for billing. */
  iterations?: AnthropicUsage[];
}
```

(b) Replace `buildUsage`:

```typescript
function buildUsage(input: AnthropicUsage, outputTokens: number): Usage {
  // Fallbacks/compaction report per-attempt usage in `iterations` while the
  // top-level usage covers only the serving attempt — sum iterations instead.
  if (input.iterations && input.iterations.length > 0) {
    const totals = input.iterations.map((it) => buildUsage({ ...it, iterations: undefined }, it.output_tokens ?? 0));
    return totals.reduce((acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      reasoningTokens: acc.reasoningTokens + u.reasoningTokens,
      cachedReadTokens: acc.cachedReadTokens + u.cachedReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
      cacheWrite1hTokens: acc.cacheWrite1hTokens + u.cacheWrite1hTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }));
  }
  const cacheRead = input.cache_read_input_tokens ?? 0;
  const cacheWriteTotal = input.cache_creation_input_tokens ?? 0;
  const cacheWrite1h = input.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const inputTokens = input.input_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: input.output_tokens_details?.thinking_tokens ?? 0,
    cachedReadTokens: cacheRead,
    cacheWriteTokens: Math.max(0, cacheWriteTotal - cacheWrite1h),
    cacheWrite1hTokens: cacheWrite1h,
    totalTokens: inputTokens + cacheRead + cacheWriteTotal + outputTokens,
  };
}
```

(c) The `message_delta` branch must merge the final usage object (it carries `output_tokens_details`/`iterations` only on the last event). Replace the branch at :290-292:

```typescript
    } else if (type === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) {
        if (data.usage.output_tokens !== undefined) outputTokens = data.usage.output_tokens;
        inputUsage = { ...inputUsage, ...data.usage, input_tokens: inputUsage.input_tokens ?? data.usage.input_tokens };
      }
    }
```

Note the merge keeps `message_start`'s `input_tokens` (message_delta usage omits it; the `??` guard prevents clobbering with `undefined` while still allowing an explicit value through — see the reasoning-tokens test where `input_tokens` stays 10).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/anthropic.test.ts` → PASS, including the ORIGINAL usage assertion test (`totalTokens: 47`) — the merge must not change it.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/anthropic.ts test/anthropic.test.ts
git commit -m "feat(anthropic): reasoningTokens from thinking_tokens, iteration-aware usage"
```

---

### Task 5: `FinishStreamPart.providerMetadata` + `stop_details` passthrough

**Files:**
- Modify: `src/types/stream.ts:36-40`
- Modify: `src/adapters/anthropic.ts` (`AnthropicEvent`, message_delta/message_stop handling)
- Modify: `test/surface.test-d.ts` (append only)
- Test: `test/anthropic.test.ts` (append)

**Interfaces:**
- Produces: `FinishStreamPart.providerMetadata?: Record<string, unknown>` — generic channel; Anthropic fills `{ anthropic: { stop_details } }` when present. Plan B/C reuse this field for other wires.

- [ ] **Step 1: Write the failing test**

Append to `test/anthropic.test.ts`:

```typescript
describe('Anthropic refusal stop_details (0.2.0)', () => {
  it('maps refusal → content_filter and carries stop_details on the finish part', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'blocked' },
          },
          usage: { output_tokens: 0 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish && finish.type === 'finish' && finish.finishReason).toBe('content_filter');
    expect(
      finish && finish.type === 'finish' && (finish.providerMetadata?.anthropic as { stop_details?: { category?: string } })?.stop_details?.category,
    ).toBe('cyber');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/anthropic.test.ts -t "refusal stop_details"`
Expected: FAIL — `providerMetadata` does not exist on `FinishStreamPart` (compile error) or is `undefined`.

- [ ] **Step 3: Implement**

(a) `src/types/stream.ts` — extend `FinishStreamPart`:

```typescript
export interface FinishStreamPart {
  type: 'finish';
  usage: Usage;
  finishReason: FinishReason;
  /** Provider-specific finish detail (e.g. `{ anthropic: { stop_details } }`). Additive, optional. */
  providerMetadata?: Record<string, unknown>;
}
```

(b) `src/adapters/anthropic.ts` — add to `AnthropicEvent.delta`:

```typescript
    stop_details?: { type?: string; category?: string | null; explanation?: string | null };
```

Track it in `parseStream` (new local next to `stopReason`):

```typescript
  let stopDetails: unknown;
```

In the `message_delta` branch (after the `stop_reason` line): `if (data.delta?.stop_details) stopDetails = data.delta.stop_details;`

Both finish emissions (message_stop branch and the fallback after the loop) gain:

```typescript
      yield {
        type: 'finish',
        usage: buildUsage(inputUsage, outputTokens),
        finishReason: mapStopReason(stopReason),
        ...(stopDetails ? { providerMetadata: { anthropic: { stop_details: stopDetails } } } : {}),
      };
```

(c) `test/surface.test-d.ts` — append:

```typescript
// --- 0.2.0 additive: finish part optional providerMetadata ---
import type { FinishStreamPart as _FSP_020 } from '../src/types/stream';
const _finishMeta: _FSP_020 = {
  type: 'finish',
  usage: {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedReadTokens: 0,
    cacheWriteTokens: 0, cacheWrite1hTokens: 0, totalTokens: 0,
  },
  finishReason: 'stop',
  providerMetadata: { anthropic: {} },
};
void _finishMeta;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/anthropic.test.ts && npm run test:types && npm run typecheck` → PASS. Also `npx vitest run test/ui.test.ts` → PASS (`ui.ts` serializes finish parts positionally — unknown extra field must not break it; it spreads known fields only, verify no failure).

- [ ] **Step 5: Commit**

```bash
git add src/types/stream.ts src/adapters/anthropic.ts test/anthropic.test.ts test/surface.test-d.ts
git commit -m "feat(stream): finish part providerMetadata; anthropic stop_details passthrough"
```

---

### Task 6: Gemini `thinking_level` fix + xhigh/max mapping

**Files:**
- Modify: `src/adapters/google-native.ts:149-162`
- Test: `test/google-native.test.ts` (append)

**Interfaces:**
- Consumes: effort `'xhigh'|'max'` (Task 2).
- Produces: request bodies asserted below.

- [ ] **Step 1: Write the failing tests**

Append to `test/google-native.test.ts`, following that file's existing `mockFetch`/provider helper pattern (it builds a native Google provider with an injected fetch — reuse its helper; the assertions below only need the recorded request body):

```typescript
describe('Gemini thinking levels (0.2.0)', () => {
  async function bodyFor(modelId: string, effort: 'minimal' extends never ? never : 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
    const { fetch, calls } = mockFetch(() => sseResponse([GEMINI_TEXT_STREAM]));
    const provider = createGoogleNative({ apiKey: 'test', fetch });
    const result = streamChat({
      model: provider(modelId),
      messages: [{ role: 'user', content: 'hi' }],
      effort,
    });
    await result.finishReason;
    return JSON.parse(String(calls[0]!.init!.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number } };
    };
  }

  it('gemini-3.5-flash keeps medium as medium', async () => {
    const body = await bodyFor('gemini-3.5-flash', 'medium');
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('medium');
  });

  it('gemini-3.1-pro-preview collapses medium to low (low/high only model)', async () => {
    const body = await bodyFor('gemini-3.1-pro-preview', 'medium');
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('low');
  });

  it('xhigh/max clamp to high on the level wire', async () => {
    const body = await bodyFor('gemini-3.5-flash', 'max');
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('high');
  });

  it('gemini-2.5-pro maps xhigh to a 32768 budget', async () => {
    const body = await bodyFor('gemini-2.5-pro', 'xhigh');
    expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(32_768);
  });
});
```

(Adapt import names — `createGoogleNative` is whatever `src/google.ts` exports for the native factory; check the top of `test/google-native.test.ts` and reuse its exact fixture constant for a minimal text stream, e.g. an existing `GEMINI_TEXT_STREAM`-style constant. The `bodyFor` signature simplifies to `effort: CommonCallOptions['effort']`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/google-native.test.ts -t "thinking levels"`
Expected: FAIL — medium collapses to 'low' on 3.5-flash; 'max' produces `thinkingBudget: 12288` fallback or level 'low'.

- [ ] **Step 3: Implement in `src/adapters/google-native.ts`**

Replace the thinking block (:149-162) and the budget map (:63):

```typescript
const BUDGET_MAP: Record<string, number> = {
  low: 4096,
  medium: 12288,
  high: 24576,
  xhigh: 32768,
  max: 32768,
};

/** Pro-tier Gemini 3 models accept only low/high thinking levels. */
function levelOnlyLowHigh(modelId: string): boolean {
  return /^gemini-3(\.\d+)?-pro/.test(modelId);
}

function thinkingLevelFor(modelId: string, effort: string): string {
  const full: Record<string, string> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
  const level = full[effort] ?? 'low';
  if (levelOnlyLowHigh(modelId)) return level === 'high' ? 'high' : 'low';
  return level;
}
```

and in `buildRequest`:

```typescript
  // Thinking (gate strictly by model family — never send both level AND budget).
  if (caps.reasoning && options.effort && options.effort !== 'none') {
    if (usesThinkingLevel(call.modelId)) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: thinkingLevelFor(call.modelId, options.effort),
      };
    } else {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: BUDGET_MAP[options.effort] ?? 12288,
      };
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/google-native.test.ts` → PASS (existing thinking tests asserting `'low'` for medium on a gemini-3 FLASH slug must be updated to expect `'medium'` — that change is the point of this task; pro-slug expectations stay `'low'`).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/google-native.ts test/google-native.test.ts
git commit -m "fix(google): honor medium/minimal thinking levels on 3.x flash, add xhigh/max budgets"
```

---

### Task 7: OpenAI effort semantics + OpenAI registry rows

**Files:**
- Modify: `src/adapters/openai-compatible.ts:148`
- Modify: `src/adapters/openai-responses.ts:81-83`
- Modify: `src/core/registry.ts` (OpenAI sections)
- Test: `test/openai.test.ts` (append), `test/registry.test.ts` (append)

**Interfaces:**
- Consumes: effort `'xhigh'|'max'` (Task 2).
- Produces: `gpt-5.5` row gains `reasoning: true`; new rows `'gpt-5.4-mini'` (exists — update ctx only if wrong), `'gpt-5.4-nano'`, `'gpt-5.3-codex'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/registry.test.ts`:

```typescript
describe('registry: 2026-07 OpenAI catalog', () => {
  it('gpt-5.5 exposes reasoning (effort ships on both OpenAI wires)', () => {
    const caps = getCapabilities({ provider: 'openai', modelId: 'gpt-5.5', surface: 'chat_completions' });
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1_050_000);
  });
  it('gpt-5.4-nano and gpt-5.3-codex are known responses rows', () => {
    for (const id of ['gpt-5.4-nano', 'gpt-5.3-codex']) {
      const caps = getCapabilities({ provider: 'openai', modelId: id, surface: 'responses' });
      expect(caps.known).toBe(true);
      expect(caps.reasoning).toBe(true);
      expect(caps.samplingRestrictions).toBe(true);
      expect(caps.contextWindow).toBe(400_000);
    }
  });
});
```

Append to `test/openai.test.ts` (reuse that file's existing provider/mockFetch helpers and minimal CC + Responses stream fixtures — check its top for the constants; the tests only inspect the recorded request body):

```typescript
describe('OpenAI effort semantics (0.2.0)', () => {
  it('chat completions clamps max → xhigh', async () => {
    // build a gpt-5.5 CC call with effort: 'max' using this file's helper, then:
    // const body = JSON.parse(String(calls[0]!.init!.body));
    // expect(body.reasoning_effort).toBe('xhigh');
  });
  it("responses wire sends effort 'none' explicitly (real OpenAI value)", async () => {
    // gpt-5.4 responses call with effort: 'none', then:
    // expect(body.reasoning).toEqual({ effort: 'none' });
  });
});
```

Write these two tests fully against the file's actual helpers (the helper shape mirrors `test/anthropic.test.ts`'s `model()` — a `createOpenAI({ apiKey: 'test', fetch })` provider plus recorded `calls`). The assertions above are the deliverable; the arrangement code comes from the file's existing tests verbatim.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/openai.test.ts -t "effort semantics" && npx vitest run test/registry.test.ts -t "OpenAI catalog"`
Expected: FAIL — `reasoning_effort` is `'max'` (unclamped), responses body has no `reasoning` for `'none'`, registry rows unknown.

- [ ] **Step 3: Implement**

(a) `src/adapters/openai-compatible.ts:148` →

```typescript
  if (reasoning && options.effort !== undefined) {
    body.reasoning_effort = options.effort === 'max' ? 'xhigh' : options.effort;
  }
```

(b) `src/adapters/openai-responses.ts:81-83` — remove the `!== 'none'` guard and clamp:

```typescript
  if (caps.reasoning && options.effort !== undefined) {
    body.reasoning = { effort: options.effort === 'max' ? 'xhigh' : options.effort };
  }
```

(c) `src/core/registry.ts` — update `gpt-5.5`/`gpt-5.5-pro` (add `reasoning: true`, `contextWindow: 1_050_000`), update `gpt-5.4`/`gpt-5.4-mini` ctx to `400_000` (already), and add:

```typescript
  'gpt-5.4-nano': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  'gpt-5.3-codex': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
```

Also update the section comment `// --- OpenAI Chat Completions (no reasoning on this wire) ---` → `// --- OpenAI Chat Completions ---` (the claim is outdated: GPT-5.4+ expose reasoning_effort on CC too).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/openai.test.ts test/registry.test.ts` → PASS. Existing `test/openai.test.ts` cases that relied on gpt-5.5 NOT sending `reasoning_effort` (if any) must be reviewed: with `reasoning: true` the CC wire now sends `reasoning_effort` when the test passes `effort` — only update tests whose fixtures set `effort`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openai-compatible.ts src/adapters/openai-responses.ts src/core/registry.ts test/openai.test.ts test/registry.test.ts
git commit -m "feat(openai): effort none/xhigh/max semantics + 2026-07 registry rows"
```

---

### Task 8: Google registry rows (3.1 line)

**Files:**
- Modify: `src/core/registry.ts` (Google compat + native sections)
- Test: `test/registry.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
describe('registry: 2026-07 Google catalog', () => {
  it('gemini-3.1-pro-preview is known on both wires', () => {
    const native = getCapabilities({ provider: 'google', modelId: 'gemini-3.1-pro-preview', surface: 'native' });
    expect(native.known).toBe(true);
    expect(native.reasoning).toBe(true);
    expect(native.nativePdf).toBe(true);
    const compat = getCapabilities({ provider: 'google', modelId: 'gemini-3.1-pro-preview', surface: 'chat_completions' });
    expect(compat.known).toBe(true);
    expect(compat.usagePerChunk).toBe(true);
  });
  it('gemini-3.1-flash-lite is a known native row', () => {
    const caps = getCapabilities({ provider: 'google', modelId: 'gemini-3.1-flash-lite', surface: 'native' });
    expect(caps.known).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/registry.test.ts -t "Google catalog"` → FAIL (`known: false`).

- [ ] **Step 3: Implement**

In `REGISTRY` (compat section), after `'gemini-3.1-pro'` (keep that key — additive), add:

```typescript
  'gemini-3.1-pro-preview': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
```

In `NATIVE_REGISTRY`, add (same full-caps shape as `gemini-3.5-flash`):

```typescript
  // gemini-3-pro was shut down 2026-03-09 and now aliases gemini-3.1-pro-preview;
  // the row below stays for the alias, these are the real 2026-07 slugs.
  'gemini-3.1-pro-preview': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-3.1-flash-lite': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
```

(Place the comment above the `'gemini-3-pro'` entry.)

- [ ] **Step 4: Run** — `npx vitest run test/registry.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): gemini 3.1 line rows on both wires"
```

---

### Task 9: Pricing — corrections, additions, `over200k` tier, dead-slug removal

**Files:**
- Modify: `src/pricing.ts` (`ModelPrice` :23-36, `PRICES_2026` :45-97, `priceUsage` :129-153)
- Test: `test/pricing.test.ts` (append)

**Interfaces:**
- Produces: `ModelPrice.over200k?: { input: number; output: number; cachedRead?: number }`.

- [ ] **Step 0: Manual re-verify (research caveat)**

The Google/xAI numbers below came from official pages but missed the second verification pass. Open `https://ai.google.dev/gemini-api/docs/pricing` and `https://docs.x.ai/developers/models` and confirm: gemini-3.5-flash $1.50/$9.00, gemini-3.1-pro-preview $2/$12 (≤200k) and $4/$18 (>200k), gemini-3.1-flash-lite $0.25/$1.50, gemini-embedding-2 $0.20, grok-4.3 $1.25/$2.50. If a page disagrees, use the page's numbers everywhere below and note it in the commit body.

- [ ] **Step 1: Write the failing tests**

Append to `test/pricing.test.ts` (it already imports `priceUsage`; reuse its Usage builder if one exists, else this inline helper):

```typescript
const u = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0,
  cachedReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
  totalTokens: 2_000_000, ...over,
});

describe('PRICES 2026-07 refresh', () => {
  it('gpt-5.5 bills 5/30', () => expect(priceUsage('gpt-5.5', u())).toBe(35));
  it('gpt-5.5-pro bills 30/180 (no more prefix leak to gpt-5.5)', () =>
    expect(priceUsage('gpt-5.5-pro', u())).toBe(210));
  it('grok-4.3 bills 1.25/2.5 (no more grok-4 prefix leak)', () =>
    expect(priceUsage('grok-4.3', u())).toBe(3.75));
  it('claude-fable-5 bills 10/50 with 1h cache write 20', () =>
    expect(priceUsage('claude-fable-5', u({ cacheWrite1hTokens: 1_000_000, totalTokens: 3_000_000 }))).toBe(80));
  it('claude-sonnet-5 bills standard 3/15', () =>
    expect(priceUsage('claude-sonnet-5', u())).toBe(18));
  it('gemini-3.1-pro-preview uses over200k tier when input exceeds 200k', () => {
    expect(priceUsage('gemini-3.1-pro-preview', u({ inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 }))).toBe(0.2);
    expect(priceUsage('gemini-3.1-pro-preview', u({ inputTokens: 300_000, outputTokens: 0, totalTokens: 300_000 }))).toBe(1.2);
  });
  it('dead slugs are gone', () => {
    expect(priceUsage('text-embedding-004', u())).toBeUndefined();
  });
});
```

(Cost math to sanity-check the expectations: 1M in + 1M out at 5/30 → $35; at 30/180 → $210; at 1.25/2.5 → $3.75; fable with 1M in + 1M out + 1M 1h-write → 10+50+20 = $80; sonnet-5 → 3+15 = $18; gemini 100k in at $2/M → $0.2; 300k in at $4/M → $1.2.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/pricing.test.ts` → FAIL (gpt-5.5 returns 11.25, grok-4.3 returns 18, text-embedding-004 returns 0…).

- [ ] **Step 3: Implement in `src/pricing.ts`**

(a) `ModelPrice` gains (after `audio`):

```typescript
  /** Long-context tier: rates applied when `inputTokens + cachedReadTokens > 200_000` (Gemini Pro). */
  over200k?: { input: number; output: number; cachedRead?: number };
```

(b) Table edits inside `PRICES_2026`:

```typescript
  // ---- OpenAI (GPT-5 family; 2026-07 list prices) ----
  'gpt-5.5': { input: 5, output: 30, cachedRead: 0.5 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.4': { input: 2.5, output: 15, cachedRead: 0.25 },
  'gpt-5.4-pro': { input: 30, output: 180 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cachedRead: 0.075 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cachedRead: 0.02 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cachedRead: 0.175 },
```

(keep the existing gpt-5.2/5.1/5 rows as they are), Anthropic section adds:

```typescript
  'claude-fable-5': { input: 10, output: 50, cachedRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31; standard rates pinned
  // so we never undercharge. Flip nothing on Sept 1 — these are already standard.
  'claude-sonnet-5': { input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
```

Google section becomes:

```typescript
  'gemini-3.1-pro-preview': {
    input: 2, output: 12, cachedRead: 0.2,
    over200k: { input: 4, output: 18, cachedRead: 0.4 },
  },
  'gemini-3.1-pro': {
    input: 2, output: 12, cachedRead: 0.2,
    over200k: { input: 4, output: 18, cachedRead: 0.4 },
  },
  'gemini-3-pro': { input: 2, output: 12, cachedRead: 0.2 }, // alias → 3.1-pro-preview since 2026-03-09
  'gemini-3.5-flash': { input: 1.5, output: 9, cachedRead: 0.15 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cachedRead: 0.025 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cachedRead: 0.125 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedRead: 0.03 },
```

(delete the `'gemini-3-pro-preview'` row — prefix match still lands on `gemini-3-pro`), xAI adds `'grok-4.3': { input: 1.25, output: 2.5, cachedRead: 0.125 },`, embeddings: delete `'text-embedding-004'`, add `'gemini-embedding-2': { input: 0.2, output: 0 },`.

(c) `priceUsage` — tier selection at the top (after `if (!p) return undefined;`):

```typescript
  const longContext = p.over200k && usage.inputTokens + usage.cachedReadTokens > 200_000;
  const rates = longContext ? { ...p, ...p.over200k } : p;
```

then replace every `p.` read below with `rates.` (`rates.cachedRead ?? rates.input * 0.1`, etc. — `cacheWrite`/`audio` defaults now derive from the tiered input rate).

(d) Update the module docblock line "sourced from public 2026 list prices" → "sourced from public list prices, verified 2026-07-02".

- [ ] **Step 4: Run** — `npx vitest run test/pricing.test.ts` → PASS (existing tests too — if one pins the OLD gpt-5.5/grok numbers, update that test's expectation; the correction is the point).

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts test/pricing.test.ts
git commit -m "fix(pricing): 2026-07 verified prices, over200k tiering, drop dead slugs"
```

---

### Task 10: Embedding registry — `gemini-embedding-2`, drop `text-embedding-004`

**Files:**
- Modify: `src/core/registry.ts:330-342`
- Test: `test/registry.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { getEmbeddingCapabilities } from '../src/core/registry';

describe('registry: 2026-07 embedding catalog', () => {
  it('gemini-embedding-2 has no task_type (instructions go in the prompt)', () => {
    const caps = getEmbeddingCapabilities({
      provider: 'google', modelId: 'gemini-embedding-2', surface: 'gemini-embeddings',
    });
    expect(caps.known).toBe(true);
    expect(caps.embeddingDimensions).toBe(3072);
    expect(caps.embeddingMaxBatch).toBe(100);
    expect(caps.supportsTaskType).toBe(false);
  });
  it('text-embedding-004 (shut down 2026-01-14) falls back unknown', () => {
    const caps = getEmbeddingCapabilities({
      provider: 'google', modelId: 'text-embedding-004', surface: 'gemini-embeddings',
    });
    expect(caps.known).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/registry.test.ts -t "embedding catalog"` → FAIL.

- [ ] **Step 3: Implement** — in `EMBEDDING_REGISTRY`: delete the `'text-embedding-004'` entry, add:

```typescript
  'gemini-embedding-2': embRow('google', 'gemini-embeddings', {
    embeddingDimensions: 3072, // MRL 128–3072 via outputDimensionality
    embeddingMaxBatch: 100,
    reportsUsage: false,
    supportsTaskType: false, // gemini-embedding-2 dropped task_type — instructions ride the prompt
  }),
```

- [ ] **Step 4: Run** — `npx vitest run test/registry.test.ts test/embed.test.ts` → PASS (if an embed test uses `text-embedding-004`, switch it to `gemini-embedding-001` — behavior identical for the test's purpose).

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts test/embed.test.ts
git commit -m "feat(registry): gemini-embedding-2, retire text-embedding-004"
```

---

### Task 11: Docs + CHANGELOG sync, full gate

**Files:**
- Modify: `docs/content/docs/providers/anthropic.mdx`, `openai.mdx`, `xai.mdx`, `google.mdx`, `docs/content/docs/modules/pricing.mdx`, `docs/content/docs/advanced/model-registry.mdx`, `docs/content/docs/core/embeddings.mdx`
- Modify: `skills/deuz-sdk/rules/providers.md`, `skills/deuz-sdk/SKILL.md`
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Apply the exact value swaps**

- `anthropic.mdx`: model table adds `claude-fable-5` (1M/128k, $10/$50) and `claude-sonnet-5` (1M/128k, $3/$15 standard; intro $2/$10 → 2026-08-31 not); effort section: on Opus 4.7+/Sonnet 5/Fable 5 effort rides `output_config.effort` (`low|medium|high|xhigh|max`), older models keep budget_tokens 4k/10k/24k (+xhigh/max 48k); note `reasoningTokens` is now populated from `output_tokens_details.thinking_tokens` (replaces the "always 0" line at :85-92); note refusal → `content_filter` with `stop_details` on `finish.providerMetadata.anthropic`.
- `openai.mdx`: gpt-5.5 line "do not expose reasoning" is removed — gpt-5.5/5.5-pro expose `reasoning_effort` on Chat Completions; add gpt-5.4-nano and gpt-5.3-codex to the Responses list; document `effort: 'none'` is sent verbatim and `'max'` clamps to `xhigh`.
- `xai.mdx`: grok-4.3 price note $1.25 in / $2.50 out.
- `google.mdx`: effort table gains medium (3.x flash) and xhigh/max→high; add gemini-3.1-pro-preview / 3.1-flash-lite; embeddings section adds gemini-embedding-2 (no taskType — silently ignored flag) and marks text-embedding-004 shut down (2026-01-14).
- `embeddings.mdx`: same embedding model updates (:84-88 area).
- `pricing.mdx`: sample rows updated to the Task 9 numbers; add one `over200k` example (gemini-3.1-pro-preview).
- `model-registry.mdx`: representative rows updated (claude-fable-5, gpt-5.4-nano, gemini-3.1-pro-preview); document `effortWire` in the quirk-flag list.
- `skills/deuz-sdk/rules/providers.md` + `SKILL.md`: model examples bumped (recipes: `claude-fable-5`, keep gpt-5.2 only where the pricing example needs it); providers.md xai line "e.g. grok-4.1" → "e.g. grok-4.3".
- `README.md`: model mentions in quickstart stay valid (opus-4-8 exists); update the Yunwu chat catalog line ONLY if it mentions removed slugs (it doesn't — leave).
- `CHANGELOG.md`: prepend an `## 0.2.0 (unreleased)` section listing: Anthropic output_config effort routing (fixes 400 on 4.7+/5.x reasoning), samplingRestrictions on 4.7+/5.x, effort xhigh/max, Claude 5 rows, OpenAI/Google/xAI price corrections + over200k tiering, gemini-embedding-2, text-embedding-004 retirement, reasoningTokens for Anthropic, finish providerMetadata.

- [ ] **Step 2: Full gate**

Run: `npm run check`
Expected: all steps green. If `format:check` fails, run `npm run format` and re-run.

- [ ] **Step 3: Commit**

```bash
git add docs/content skills/deuz-sdk CHANGELOG.md README.md
git commit -m "docs: 2026-07 catalog + effort wire documentation, 0.2.0 changelog"
```

---

## Self-review notes (done at plan time)

- **Spec coverage (Bölüm 1):** 1a→Task 1+3, 1b→Task 2+3+6+7, 1c→Task 1+3, 1d→Task 1+7+8+10, 1e→Task 9, 1f→Task 4+5. Bölüm 2–8 are Plans B–D (separate documents).
- **Type consistency:** `effortWire` defined Task 1, consumed Task 3; `over200k` defined+consumed Task 9; `providerMetadata` on FinishStreamPart defined Task 5 only.
- **Known judgment calls:** iterations summing treats each iteration as a self-contained usage (spec: top-level covers only serving attempt); `claude-opus-4-8` existing tests keep passing because they don't set temperature/effort-with-thinking expectations — where they do, the test moves to `claude-opus-4-6` (explicitly allowed in Task 3 Step 5).
