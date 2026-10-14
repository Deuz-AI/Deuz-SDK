# Golden wire fixtures

The gate behind spec §5.2 ("off means no difference"): with every 2.4 feature
left at its default, each provider request must be byte-identical to what
2.3.0 sent. `test/golden-wire.test.ts` replays every scenario of
`scenarios.ts` and compares its requests with the files in `2.3.0/`.

## What a fixture holds

One file per scenario, `2.3.0/<scenario id>.json`:

- `method` and the full `url` (scheme, host, path and query, so default base
  URLs, Azure's `api-version` and Vertex paths are pinned too);
- every `header`, sorted by name;
- a multipart body as its entries (`form`): `fetch` writes a random boundary,
  so the fields and each file's name, type and content are pinned instead of
  the bytes; a binary body as `bodyBase64`;
- the body as its JSON value, `json`. At recording time the bytes 2.3.0 sent
  were checked to be exactly `JSON.stringify(json)`, so the test compares the
  bytes sent now against that text. A body that was not such canonical JSON
  would be stored verbatim in `bodyText` instead; none of the 2.3.0 requests
  needed it.

The test reports a moved field as a structural diff of the JSON first, then
checks the bytes, which also catches key order and number or string
formatting.

## Determinism and normalisation

- Every scenario passes the same fake key, `golden-test-key-0000`, and the
  capture replaces it with `<secret>` wherever it appears in a header or the
  URL. That is the only normalisation: it pins where and how the key is sent
  (`x-api-key`, `authorization: Bearer`, `api-key`, `x-goog-api-key`) without
  storing a value. The keyless local hosts (Ollama, LM Studio) send their
  documented placeholder `sk-no-key`, which is recorded as is.
- `deps.generateId` counts up (`gid_0001`, ...) and `deps.clock.now()` is
  fixed. No 2.3.0 request body or header contains a generated id or a time, so
  nothing else is normalised. A scenario whose request needs a value that
  cannot be injected must normalise only that field and say so here.
- The provider answers are scripted in `harness.ts`, not taken from the shared
  test fixtures: the answer of a tool round decides what the next request
  replays, so a change to a shared fixture must never move a golden request.
- Recording runs each scenario twice and refuses to write when the two runs
  differ.

## Scenarios

Every chat target runs some of these calls (see `CHAT_TARGETS`):

| Kind              | Call                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `generate-text`   | `generateText` with `instructions` and `prompt`                                |
| `stream-chat`     | `streamChat` over a three-message history                                      |
| `tool-round`      | `generateText` with one tool and `maxSteps: 2`: the call and the result replay |
| `generate-object` | `generateObject` with a JSON schema (native JSON or forced-tool strategy)      |
| `run-agent`       | native `runAgent` with one tool; memory, compaction and chat left off          |
| `call-options`    | `temperature`, `topP`, `maxOutputTokens`, `stopSequences`, `effort: 'low'`     |
| `image-input`     | a user message with a text part and a base64 PNG image part                    |

The four main wires (Anthropic Claude Sonnet 4.5, OpenAI Chat Completions,
OpenAI Responses, Gemini native) also run with the 2.3 features a caller
switches on, because a 2.4 process with its own new features off must send
these exactly as 2.3 did:

| Kind                 | Call                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `reasoning-replay`   | a history with one reasoning block per family (Anthropic, OpenAI, Google)                |
| `compaction`         | the tool loop over two finished tool rounds, `prune-tool-results` forced by `countTokens` |
| `compaction-summary` | the same with the `summarize` layer: the summary side call, then the step                 |
| `memory-recall`      | `generateText` with memory recall (query embedding, then the call); extraction off        |
| `run-agent-memory`   | native `runAgent` with memory recall and one tool round; extraction off                   |

The memory scenarios store one fact whose vector equals the query's (cosine 1,
same embedding model and dimensions), so it is recalled under every recall rule,
including the 2.4 exclusion of mismatched or zero-score vectors.

Full matrix: Anthropic (Claude Sonnet 4.5, Claude Opus 5.5), OpenAI Chat
Completions, OpenAI Responses, Gemini native (2.5 Flash, 3.1 Pro), Gemini
OpenAI-compat, Vertex (Anthropic, Gemini compat, Gemini native), Azure,
Bedrock (Mantle), xAI and a generic `createOpenAICompatible` gateway. Every
named compatible host with a pinned registry row runs `generate-text` and
`tool-round`; hosts without one (tools off by default), Perplexity, the keyless
local hosts and a Responses-shaped gateway run `generate-text`. The embedding
adapters (OpenAI, Gemini, Voyage, Yunwu) run `embed` and `embedMany` with task
types, a title and `dimensions`. The media and relay requests are pinned too:
image generation (OpenAI-shaped, Yunwu), speech (OpenAI, ElevenLabs),
transcription (OpenAI multipart, Deepgram raw bytes), video and Midjourney
submission, the Voyage and Cohere rerankers, the Gemini context cache (AI
Studio and Vertex) and Files API upload, and batch submission (Anthropic,
OpenAI Chat Completions and Responses through the Files API, Gemini).

## Rules

- Never edit or re-record a file in `2.3.0/`. If a request moves, the change
  is a wire change for 2.3 users: fix the code, or get the integrator to accept
  it as a stated behaviour change.
- Removing or renaming a scenario fails the test, because its fixture would be
  left without one.
- This gate holds 2.3 behaviour only. A missing 2.3.0 fixture can only be
  recorded from the 2.3.0 code (check out `v2.3.0`, add the scenario, record,
  bring the file over). The wire of a 2.4 feature switched on is tested by the
  lane that owns the feature, not here.

## Recording

```sh
DEUZ_GOLDEN_WIRE_RECORD=1 npm run test -w @deuz-sdk/core -- test/golden-wire.test.ts
npx prettier --write packages/core/test/fixtures/golden-wire
```

Recording writes only the fixtures that are missing; it never rewrites an
existing file. Prettier changes only the whitespace of a fixture, never a
value the test compares.
