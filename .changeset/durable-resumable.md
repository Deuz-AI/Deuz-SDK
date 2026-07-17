---
'@deuz-sdk/core': minor
---

Durable × resumable together, vendor-free (D5) — `resumeDeuzChatResponse` on `./durable` is ONE endpoint for the whole "unbreakable chatbot" story:

- Replays the stored wire log from the client's `Last-Event-ID` and keeps tailing while the original producer is still alive (a refreshed tab just re-attaches — the model is never re-driven).
- If the process DIED mid-run (deploy, crash, serverless freeze — detected by a configurable silence probe over the wire log), it continues the run itself from the last durable checkpoint and pipes the new leg through the same wire log: seq numbering continues, the leg journals itself, and the client sees one gapless stream ending in `[DONE]`.
- `connectDeuzStream` pointed at this endpoint makes refreshes, network drops and server crashes all look identical to the UI. E2E golden: F5 in the middle of a tool loop → checkpoint continuation completes the turn with monotonic gapless seq ids.
- Vercel needs the hosted Workflow runtime for durability AND Redis (`resumable-stream`) for resume; Deuz does both in-library over two 2-method seams you can back with anything.
