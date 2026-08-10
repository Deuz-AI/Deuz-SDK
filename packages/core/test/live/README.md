# Live smoke tests

Everything else in `test/` is golden-replay over an injected `deps.fetch`: no
network, deterministic, and it proves the SDK builds the request it means to.
What it cannot prove is that the request is the one the provider actually
accepts — a base URL with the wrong `/v1`, a header a vendor renamed, a model
slug that moved. These tests close that gap by talking to the real endpoints.

They are **excluded from `npm test`** (see `vitest.config.ts`) and skip
themselves when a key is absent, so a contributor without credentials — and CI —
sees nothing change.

## Running them

Put the keys you have in `.env.smoke` at the repo root. It is covered by
`.gitignore` (`.env.*`), and nothing here ever prints a key: failures report the
provider, the URL and the status, never the credential.

```
DEEPSEEK_API_KEY=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...
```

Then, from `packages/core`:

```bash
npm run test:live                 # every provider a key was supplied for
npm run test:live -- -t deepseek  # one of them
```

These calls cost real money. They are deliberately tiny — a handful of output
tokens each — but the media ones (speech, transcription, video) are the
expensive kind, so keep them narrow.
