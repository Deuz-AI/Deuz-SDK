<!-- verified: 2026-09-20 against @deuz-sdk/core@2.2.0 · api-contract sha256:c301da6ab500
     sources: packages/core/src/image.ts, packages/core/src/speech.ts, packages/core/src/transcription.ts,
     packages/core/src/video.ts, packages/core/src/midjourney.ts, packages/core/src/yunwu.ts,
     packages/core/src/adapters/transcription.ts, packages/core/src/client.ts,
     packages/core/src/types/config.ts, packages/core/src/types/observe.ts,
     packages/core/src/types/message.ts, packages/core/test/video.test.ts,
     docs/content/docs/modules/image-generation.mdx, docs/content/docs/modules/speech.mdx,
     docs/content/docs/modules/transcription.mdx, docs/content/docs/modules/video-generation.mdx,
     docs/content/docs/providers/yunwu.mdx -->

# Images, speech, transcription and video

**Load when:** generating an image or a video clip, synthesizing speech, transcribing an audio file, driving Midjourney, wiring a voice turn (mic → text → answer → audio), or deciding whether audio belongs in a chat message or in a dedicated modality call.

## One rule explains the whole surface

**Each modality is its own model kind, on its own subpath, driven by its own free function.** There is no `modality:` option on `streamChat` and no way to hand an `ImageModel` to a chat call — the descriptors carry a different `surface` literal, so TypeScript refuses the mistake at the call site rather than at the provider.

| Modality | Subpath | Factories | Call | Descriptor `surface` | Shape |
| --- | --- | --- | --- | --- | --- |
| Image | `@deuz-sdk/core/image` | `createImageProvider` | `generateImage` | `'images'` | one request, one answer |
| Midjourney | `@deuz-sdk/core/midjourney` | `createMidjourney` (optional) | `imagine`, `submitImagine`, `waitForTask`, `submitAction` | `'midjourney'` | submit → poll → action |
| Speech (TTS) | `@deuz-sdk/core/speech` | `createOpenAISpeech`, `createElevenLabs` | `generateSpeech` | `'openai-speech'`, `'elevenlabs-speech'` | one request, one file |
| Transcription (STT) | `@deuz-sdk/core/transcription` | `createOpenAITranscription`, `createDeepgram` | `transcribe` | `'openai-transcription'`, `'deepgram-transcription'` | one request, one answer |
| Video | `@deuz-sdk/core/video` | `createVideoProvider` | `generateVideo`, `submitVideo`, `fetchVideoTask`, `waitForVideo`, `downloadVideo` | `'video'` | submit → poll → download |

Facts that hold across all five, so they are stated once:

- **Audio a CHAT model should hear is not this page.** It travels as `filePart({ data, mediaType: 'audio/…' })` inside a normal `Message`, exactly like a PDF or an image. The `Part` union has five members and none of them is an audio part.
- **Key resolution is the same G1 chain as everywhere:** `deps.keyProvider` → factory `apiKey` (or, on video/Midjourney, the call's own `apiKey`) → `createClient`'s `apiKeys[provider]`. Nothing supplied throws `AuthenticationError` **before** the network is touched. Core never reads `process.env` — read it yourself and pass the value.
- **`createClient` keys only reach these calls through `client.bind(...)`.** These are free functions on separate subpaths with no method on `DeuzClient`, so the client context rides on the options object you pass through `bind`.
- **No retries, no circuit breaker, no timeout, no `maxRetries`.** Every step is one plain `fetch`. A `429` surfaces immediately with `retryAfterMs` and `isRetryable` on the error; acting on them is yours. `signal` is the only deadline.
- **No cost accounting.** `deps.priceProvider` is never consulted, `PRICES_2026` has no rows for these, and no cost event reaches the observation stream. Meter on `usage.characters` (speech), `usage.seconds ?? usage.totalTokens` (transcription), or `task.seconds` + `task.size` (video) yourself.
- **No capability matrix.** These descriptors are not `LanguageModel`, so `getModelCapabilities` does not apply and an unknown slug produces no warning — just the provider's `404` → `ModelNotFoundError`.
- **HTTP status mapping is identical everywhere:** `401`/`403` → `AuthenticationError`, `404` → `ModelNotFoundError`, `429` → `RateLimitError`, `529` → `OverloadedError`, other `4xx` → `InvalidRequestError`, `5xx` → retryable `APICallError`.
- **`raw` always carries the untouched provider JSON** on `GenerateImageResult`, `TranscribeResult` and `VideoTask` — a field the canonical shape drops is never lost.

## Images — `generateImage`

OpenAI-compatible `POST {baseURL}/images/generations`. Covers DALL·E, GPT-Image, Flux, SD, Recraft, Ideogram and any relay that mirrors the endpoint. Synchronous: no streaming, no polling.

```ts
import { generateImage, createImageProvider, type GeneratedImage } from '@deuz-sdk/core/image';

const images = createImageProvider({ apiKey: process.env.OPENAI_API_KEY! });

export async function poster(prompt: string): Promise<GeneratedImage> {
  const { images: out, raw } = await generateImage({
    model: images('gpt-image-1'),
    prompt,
    n: 1,
    size: '1024x1024',
    quality: 'hd',
    responseFormat: 'b64_json', // sent as response_format; omit for the provider default ('url')
  });
  console.log(raw); // provider-specific extras live here
  const first = out[0];
  if (!first) throw new Error('no image returned');
  return first; // { url?, b64Json?, revisedPrompt? }
}
```

`GenerateImageOptions`: `model`, `prompt`, `n` (default 1 — DALL·E 3 only accepts 1), `size`, `quality`, `style`, `responseFormat`, `signal`, `headers`, `deps`. `ImageProviderSettings`: `apiKey`, `baseURL` (default `https://api.openai.com/v1`), `fetch`, `headers`, `provider` (default `'openai'`, the id key resolution uses).

`GeneratedImage` has three optional fields and no guaranteed one: `url` when `responseFormat` is `'url'`, `b64Json` when it is `'b64_json'`, `revisedPrompt` only when the provider rewrote your prompt. Always check before dereferencing.

## Midjourney — submit, poll, act

The midjourney-proxy contract, not an OpenAI shape: the proxy is mounted at the **bare host root** (`{baseURL}/mj/...`), *not* under `/v1`. Default `baseURL` is `https://yunwu.ai`, default `provider` is `'yunwu'`. Every function takes the shared `MidjourneyConfig` (`apiKey`, `baseURL`, `provider`, `fetch`, `headers`, `signal`, `deps`) plus its own fields.

| Function | Purpose | Returns |
| --- | --- | --- |
| `submitImagine` | Start a grid. Takes `prompt`, `base64Array?`, `notifyHook?`, `state?`. | `SubmitResult` |
| `submitAction` | Run U/V/reroll from a button. Takes `taskId`, `customId`. | `SubmitResult` |
| `submitBlend` | Blend 2–5 images. Takes `base64Array`, `dimensions?` (`'PORTRAIT'`/`'SQUARE'`/`'LANDSCAPE'`), `notifyHook?`. | `SubmitResult` |
| `submitDescribe` | Image → prompt suggestions. Takes `base64`, `notifyHook?`. | `SubmitResult` |
| `fetchTask(taskId, cfg)` | One snapshot; `null` when the relay does not know the id. | `MidjourneyTask \| null` |
| `waitForTask(taskId, opts)` | Poll to a terminal status. `pollIntervalMs` 3000, `timeoutMs` 300_000, `onProgress`. | `MidjourneyTask` |
| `imagine(opts)` | `submitImagine` + `waitForTask` in one call. | `MidjourneyTask` |

`SubmitResult` is `{ taskId, code, description?, raw }`; a relay that accepts the request but names no task id (a banned prompt, `code: 4`) throws `APICallError`. `MidjourneyStatus` is `'NOT_START' | 'SUBMITTED' | 'IN_PROGRESS' | 'FAILURE' | 'SUCCESS' | 'MODAL' | 'CANCEL'`; terminal means `SUCCESS`, `FAILURE` or `CANCEL`. `task.progress` is a **string** (`'50%'`) here — unlike video's number.

```ts
import { imagine, submitAction, waitForTask, type MidjourneyTask } from '@deuz-sdk/core/midjourney';

const mj = { apiKey: process.env.YUNWU_API_KEY!, provider: 'yunwu' };

export async function gridThenUpscale(prompt: string): Promise<MidjourneyTask> {
  const grid = await imagine({
    ...mj,
    prompt: `${prompt} --ar 16:9`,
    pollIntervalMs: 3000,
    onProgress: (t) => console.log(t.status, t.progress), // 'IN_PROGRESS' '50%'
  });
  if (grid.status !== 'SUCCESS') throw new Error(grid.failReason ?? grid.status);

  // Actions are driven by a customId off the finished task's buttons — never a slug.
  const u1 = grid.buttons?.find((b) => b.label === 'U1');
  if (!u1) return grid;
  const { taskId } = await submitAction({ ...mj, taskId: grid.id, customId: u1.customId });
  return waitForTask(taskId, mj);
}
```

Prefer `notifyHook` over `waitForTask` in a request handler: pass a webhook URL to `submitImagine`/`submitBlend`/`submitDescribe`, store the `taskId`, return immediately, and read the finished task in the handler (or re-`fetchTask` it). Holding an HTTP connection open for five minutes is the failure mode the async API exists to avoid.

## Speech — `generateSpeech`

Text in, finished audio bytes out. No streaming exists here, not even with `providerOptions: { stream_format: 'audio' }` — the response is always buffered into one `Uint8Array`.

```ts
import { generateSpeech, createOpenAISpeech, createElevenLabs } from '@deuz-sdk/core/speech';
import { writeFile } from 'node:fs/promises';

const openaiTts = createOpenAISpeech({ apiKey: process.env.OPENAI_API_KEY! });
const eleven = createElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY! });

export async function speak(text: string): Promise<string> {
  const { audio, mediaType, format, usage } = await generateSpeech({
    model: openaiTts('gpt-4o-mini-tts'), // the only OpenAI model that reads `instructions`
    text,
    voice: 'nova',
    format: 'mp3',
    speed: 1.0,
    instructions: 'Warm, unhurried, conversational.',
  });
  console.log(mediaType, usage.characters); // 'audio/mpeg' — billed per input character
  await writeFile(`reply.${format}`, audio);
  return mediaType;
}

export async function speakEleven(text: string): Promise<number> {
  const { audio } = await generateSpeech({
    model: eleven('eleven_turbo_v2_5'),
    text,
    voice: '21m00Tcm4TlvDq8ikWAM', // REQUIRED here: the voice IS the URL path
    format: 'mp3',
    providerOptions: { voice_settings: { stability: 0.4, speed: 1.1 } },
  });
  return audio.byteLength;
}
```

`SpeechAudioFormat` is `'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'`, default `'mp3'`. `GenerateSpeechResult` is `{ audio, mediaType, format, usage: { characters } }`, where `mediaType` comes from the response `content-type` (parameters stripped) and `usage.characters` is `text.length` — known before the call, so you can budget on it.

Wire differences that bite:

| | `createOpenAISpeech` | `createElevenLabs` |
| --- | --- | --- |
| Endpoint | `POST {baseURL}/audio/speech` | `POST {baseURL}/text-to-speech/{voice}?output_format=…` |
| Auth header | `Authorization: Bearer` | `xi-api-key` |
| Default `baseURL` | `https://api.openai.com/v1` | `https://api.elevenlabs.io/v1` |
| `voice` | defaults to `'alloy'` | **required** — omitting it is `InvalidRequestError` before the request |
| Formats | all six | `mp3`→`mp3_44100_128`, `opus`→`opus_48000_128`, `pcm`→`pcm_44100`; `aac`/`flac`/`wav` throw `UnsupportedCapabilityError` before the request |
| `speed`, `instructions` | honoured | ignored — use `providerOptions.voice_settings` |

`providerOptions` is shallow-merged and **canonical fields always win**, so it can add wire fields but never silently redefine `format` or `voice`. On ElevenLabs, `providerOptions.output_format` is lifted into the query string verbatim, bypassing the format mapping (and its unsupported-format check) — that is the escape hatch for tiers like `mp3_22050_32`.

There is no `listVoices()`, no SSML, no transcoding, no concatenation, and no speech-to-speech. Long documents are yours to split and stitch.

## Transcription — `transcribe`

```ts
import { transcribe, createOpenAITranscription, createDeepgram } from '@deuz-sdk/core/transcription';

const whisper = createOpenAITranscription({ apiKey: process.env.OPENAI_API_KEY! });
const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY! });

export async function timedTranscript(bytes: Uint8Array): Promise<string> {
  const { text, segments, usage } = await transcribe({
    model: whisper('whisper-1'), // the gpt-4o-* models cannot return timings at all
    audio: bytes,
    mediaType: 'audio/mpeg', // load-bearing — OpenAI dispatches on the derived filename
    language: 'en',
    timestamps: true,
  });
  console.log(usage.seconds ?? usage.totalTokens ?? 0); // every usage field is optional
  return (segments ?? []).map((s) => `[${Math.floor(s.start)}s] ${s.text}`).join('\n') || text;
}

export async function fromStorage(url: string): Promise<string> {
  const { text, words } = await transcribe({
    model: deepgram('nova-3'),
    audio: { url }, // Deepgram fetches it server-side; nothing large moves through you
    providerOptions: { deepgram: { diarize: true, utterances: true } },
  });
  console.log(words?.[0]); // { word, start, end, confidence? }
  return text;
}
```

`TranscriptionInput` is `Uint8Array | ArrayBuffer | Blob | { url: string }`. `{ url }` on an OpenAI model throws `InvalidRequestError` before any request — that wire uploads bytes, full stop.

`TranscribeResult` is `{ text, language?, durationSeconds?, segments?, words?, usage, raw }`. Optional fields are **absent, not `undefined`**, when the wire did not produce them: a plain OpenAI `json` response is exactly `{ text, usage, raw }`.

| Model / wire | Timings you get |
| --- | --- |
| OpenAI `whisper-1` + `timestamps: true` | `segments` **and** `words` (sends `verbose_json`) |
| OpenAI `whisper-1`, `timestamps` unset | none (`json`) |
| OpenAI `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | **none, ever** — `verbose_json` 400s there, so `timestamps: true` is silently ignored |
| Deepgram, any model | `words` always; `segments` whenever `smart_format` is on (it is by default) |

Other sharp edges: OpenAI ignores the multipart part's content type and dispatches on the **file extension**, derived from `mediaType` (`audio/mpeg` → `audio.mp3`; an unknown type becomes `audio.bin`, which OpenAI rejects) — pass `mediaType`, or a `Blob` whose own `type` is set, or override with `filename`. Never add a `content-type` header on the OpenAI wire: `fetch` writes the multipart boundary itself. Deepgram authenticates with `Authorization: Token`, sends the audio as the raw body, and puts `providerOptions.deepgram` entries into the query string; `prompt` is OpenAI-only. `TranscriptionSegment` is `{ start, end, text }` with **no speaker field** — Deepgram diarization lands in `raw`.

`TranscriptionUsage` carries `seconds?`, `inputTokens?`, `outputTokens?`, `audioTokens?`, `totalTokens?` and can be `{}` — read `usage.seconds ?? usage.totalTokens ?? 0`. A long recording is a long wait with no progress signal; put it behind a queue, not a request handler. And a transcript is untrusted input — it came from someone else's microphone.

## Video — submit, poll, download

The wire is the **OpenAI Videos** shape: `POST {baseURL}/videos` → `GET {baseURL}/videos/{id}` → `GET {baseURL}/videos/{id}/content`. Any host that mirrors those three paths under one versioned root works: `createVideoProvider` defaults to `provider: 'yunwu'` + `baseURL: 'https://yunwu.ai/v1'` (the relay that actually serves Sora / Veo / Kling / Hailuo), and pointing it at `https://api.openai.com/v1` with `provider: 'openai'` targets OpenAI's own endpoint. The relay root is a **setting, not a constant** — retarget it rather than waiting for an SDK release.

`generateVideo` is submit + poll + optional download in one call:

```ts
import { generateVideo } from '@deuz-sdk/core/video';
import { createYunwu } from '@deuz-sdk/core/yunwu';
import { createCallbackObserver } from '@deuz-sdk/core/observe';

const yunwu = createYunwu({ apiKey: process.env.YUNWU_API_KEY! });
const observer = createCallbackObserver((e) => {
  if (e.type === 'operation.completed') console.log(e.subsystem, e.operation, e.durationMs);
});

export async function clip(prompt: string): Promise<string | undefined> {
  const { task } = await generateVideo({
    model: yunwu.video('sora-2'),
    prompt,
    size: '1280x720',
    seconds: 8, // number | string; coerced to a string on the wire
    providerOptions: { seed: 42, aspect_ratio: '16:9' }, // canonical fields always win
    pollIntervalMs: 5000, // default
    timeoutMs: 600_000, // default: 10 minutes
    onProgress: (t) => console.log(t.status, t.progress),
    deps: { observer },
  });
  // A refused or botched job RESOLVES with status 'failed' — it does not throw.
  if (task.status === 'failed') throw new Error(task.failReason ?? 'video failed');
  return task.url; // add `download: true` for { video: Uint8Array, mediaType } instead
}
```

In production, do not hold a connection open for ten minutes. The only state that matters is the job id, and the model descriptor is just settings — re-mint it in the worker and it addresses the same relay:

```ts
import { submitVideo, fetchVideoTask, downloadVideo } from '@deuz-sdk/core/video';
import { createYunwuVideo } from '@deuz-sdk/core/yunwu';

const model = createYunwuVideo({ apiKey: process.env.YUNWU_API_KEY! })('sora-2');

declare const jobs: {
  insert(row: { id: string; status: string }): Promise<void>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
};
declare const storage: { put(key: string, bytes: Uint8Array, mediaType: string): Promise<void> };

export async function enqueue(prompt: string): Promise<string> {
  const job = await submitVideo({ model, prompt, size: '1280x720' });
  await jobs.insert({ id: job.id, status: job.status });
  return job.id; // the client polls YOUR endpoint, not the relay
}

export async function tick(jobId: string): Promise<void> {
  const task = await fetchVideoTask(jobId, { model }); // the one call that emits no event
  if (!task) return; // 'unknown right now', NOT 'gone' — the relay may still be registering it
  await jobs.update(jobId, { status: task.status, progress: task.progress });
  if (task.status === 'completed') {
    const { video, mediaType } = await downloadVideo(task.id, { model });
    await storage.put(`${task.id}.mp4`, video, mediaType);
  }
  if (task.status === 'failed') await jobs.update(jobId, { error: task.failReason ?? 'unknown' });
}
```

`VideoTask` is `{ id, status, progress?, model?, seconds?, size?, url?, failReason?, raw }` — `progress` is a **number** 0-100 (parsed from `42` or `'42%'`), `seconds` is a **string** as the relay reports it. `VideoTaskStatus` is `'queued' | 'in_progress' | 'completed' | 'failed' | (string & {})`; only the first four are canonical and only `completed`/`failed` are terminal. Statuses are normalized before you see them:

| Relay says | You get |
| --- | --- |
| `succeeded`, `success`, `complete`, `done` | `completed` |
| `processing`, `running`, `in-progress`, `generating` | `in_progress` |
| `pending`, `queuing`, `waiting` | `queued` |
| `failure`, `error`, `cancelled`, `canceled` | `failed` |
| anything else | passed through verbatim — **and not terminal**, so it polls to the timeout |

`url` is read from `url`, then `video_url`, then `output.url`, then `data[0].url`; `failReason` from `error.message`, a bare `error` string, then `fail_reason`.

Poll-loop behaviour worth knowing before you debug it: a `null` from `fetchVideoTask` means "not ready", so a **typo'd or expired id polls the full `timeoutMs`** then throws `TimeoutError` — call `fetchVideoTask` yourself if ids may not exist. `timeoutMs` is a floor (the elapsed check runs after each poll), `onProgress` fires per poll rather than per change and is skipped when the poll returned `null`, and the default cadence is ~120 requests per ten-minute job. Aborting `signal` rejects your poll with `AbortError` but does **not** cancel the remote job — there is no delete, so the relay may keep generating and billing.

Image-to-video: pass `inputReference` (a `Blob`/`File`, or `{ data, mediaType?, filename? }`) and the submit switches from JSON to `multipart/form-data` with the reference as the `input_reference` part. Raw bytes need a `mediaType` so the relay can tell a PNG from an MP4. Never set `content-type` yourself.

## Yunwu — one relay across several of these

`createYunwu({ apiKey, baseURL })` takes the host root **once** (no `/v1`, trailing `/v1` or `/` is stripped) and derives every surface: `.chat()` → `/v1/chat/completions`, `.image()` → `/v1/images/generations`, `.video()` → `/v1/videos`, `.embedding()` → `/v1/embeddings`, and `.mj()` → a pre-bound `MidjourneyConfig` pointed at the **bare root**. Point `baseURL` at a mirror and all five follow.

```ts
import { generateImage } from '@deuz-sdk/core/image';
import { imagine } from '@deuz-sdk/core/midjourney';
import { createYunwu, YUNWU_VIDEO_MODELS } from '@deuz-sdk/core/yunwu';

const yunwu = createYunwu({ apiKey: process.env.YUNWU_API_KEY! });

export async function twoSurfacesOneKey(prompt: string): Promise<string[]> {
  const { images } = await generateImage({ model: yunwu.image('flux-2-pro'), prompt });
  const task = await imagine({ ...yunwu.mj(), prompt: `${prompt} --ar 16:9` });
  console.log(YUNWU_VIDEO_MODELS); // pinned catalog, not a validated enum
  return [images[0]?.url ?? '', task.imageUrl ?? ''];
}
```

Standalone equivalents when you need one surface: `createYunwuChat`, `createYunwuImage`, `createYunwuVideo`, `createYunwuEmbedding`. Catalogs: `YUNWU_MODELS` (grouped), `YUNWU_CHAT_MODELS`, `YUNWU_IMAGE_MODELS`, `YUNWU_VIDEO_MODELS`, `YUNWU_MIDJOURNEY_MODELS`, plus `YUNWU_DEFAULT_BASE_URL`. Slugs are pass-through — any string reaches the wire. The `yunwu` singleton carries no key; supply one via `deps.keyProvider` keyed `'yunwu'`.

## Observation

All five emit only the auxiliary `operation.started` / `operation.completed` / `operation.failed` events — they are operations, not runs, so no `run.*` or `model.*` event appears. With no `deps.observer` the fast path applies and no event object is built at all.

| Subsystem | `operation` values |
| --- | --- |
| `'image'` | `image.generate` (`itemCount` = `n`, `resultCount` = images returned) |
| `'midjourney'` | `midjourney.submit-imagine`, `midjourney.submit-action`, `midjourney.submit-blend`, `midjourney.submit-describe`, `midjourney.wait` |
| `'speech'` | `speech.generate` (`itemCount` = input chars, `resultCount` = audio bytes) |
| `'transcription'` | `transcription.transcribe` |
| `'video'` | `video.submit`, `video.wait` (the whole poll, one event), `video.download` |

`fetchTask` and `fetchVideoTask` emit nothing, on purpose — a tight polling worker must not flood the observer.

## Wiring keys from `createClient`

```ts
import { createClient } from '@deuz-sdk/core';
import { generateSpeech, createElevenLabs } from '@deuz-sdk/core/speech';

const client = createClient({
  apiKeys: { elevenlabs: process.env.ELEVENLABS_API_KEY!, deepgram: process.env.DEEPGRAM_API_KEY! },
});
const eleven = createElevenLabs(); // no key on the factory

export async function say(text: string): Promise<Uint8Array> {
  // WITHOUT client.bind(...) this throws AuthenticationError: the client context
  // rides on a private symbol that only bind() attaches to the options object.
  const { audio } = await generateSpeech(
    client.bind({ model: eleven('eleven_turbo_v2_5'), text, voice: '21m00Tcm4TlvDq8ikWAM' }),
  );
  return audio;
}
```

## Audio into a chat model — the other direction

When you want the model to reason about *how* something was said (tone, overlap, background), a transcript throws that away. Send the bytes to a chat model that accepts audio, as a `filePart`:

```ts
import { generateText, filePart, type Message } from '@deuz-sdk/core';
import { createGoogle } from '@deuz-sdk/core/google';

const google = createGoogle({ apiKey: process.env.GOOGLE_API_KEY! });

export async function whoSoundsAnnoyed(bytes: Uint8Array): Promise<string> {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Who sounds annoyed on this call, and at which moment?' },
        filePart({ data: bytes, mediaType: 'audio/mpeg' }),
      ],
    },
  ];
  const { text } = await generateText({ model: google('gemini-3-pro-preview'), messages });
  return text;
}
```

Use `transcribe` instead when you want the words, cheaply, as text you can index, cite or feed to a smaller model.

## Failure modes, and what to do instead

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AuthenticationError` before any HTTP call | No key on the G1 chain; or `createClient` keys used without `bind` | Pass `apiKey` to the factory, or wrap the options in `client.bind(...)` |
| `InvalidRequestError` on an ElevenLabs call | `voice` omitted — it is the URL path | Always pass `voice` on that wire |
| `UnsupportedCapabilityError` before the request | `aac`/`flac`/`wav` asked of ElevenLabs | Use `mp3`/`opus`/`pcm`, or `providerOptions.output_format` |
| OpenAI STT rejects the file | `mediaType` missing → filename `audio.bin` | Pass `mediaType`, a typed `Blob`, or `filename` |
| `timestamps: true` returns nothing | A `gpt-4o-*transcribe` model | Use `whisper-1`, or Deepgram |
| `{ url }` rejected locally | OpenAI STT uploads bytes only | Use Deepgram, or read the bytes yourself |
| Video job polls for ten minutes then `TimeoutError` | Unknown id, or a relay status the alias table misses | `fetchVideoTask` yourself; inspect `task.raw` |
| `generateVideo` resolved but there is no `video` | `download: true` missing, or the job did not complete | Check `task.status === 'completed'` and set `download` |
| Midjourney action does nothing | A slug was passed instead of a button `customId` | Read `customId` off the finished task's `buttons` |
| TS refuses the model | A modality descriptor handed to `streamChat`/`generateText` | Use that modality's own function; the kinds are deliberately incompatible |

## Deep dive

- [/docs/modules/image-generation](/docs/modules/image-generation) — `generateImage` and the full Midjourney submit/poll/action/webhook flow.
- [/docs/modules/speech](/docs/modules/speech) — TTS wires, format choice, a complete voice turn, what `generateSpeech` does not do.
- [/docs/modules/transcription](/docs/modules/transcription) — choosing a wire, the `verbose_json` gate, media types and filenames, a recording → notes pipeline.
- [/docs/modules/video-generation](/docs/modules/video-generation) — the async job surface, status normalization, the submit-here/poll-there production shape.
- [/docs/providers/yunwu](/docs/providers/yunwu) — one key and base URL across chat, image, video, embeddings and Midjourney.
- [/docs/modules/observability](/docs/modules/observability) — the `operation.*` event protocol these modules emit.
- [/docs/core/dependencies](/docs/core/dependencies) — the `fetch` / `clock` / `keyProvider` injection seam and `createClient`.
