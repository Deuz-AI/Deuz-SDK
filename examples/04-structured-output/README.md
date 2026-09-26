# 04 — Structured output

**Shows:** one zod schema driving both `generateObject` (buffered, validated, one repair retry) and `streamObject` (live `partialObjectStream`, no repair) — plus the optional peer `@standard-community/standard-json` that converts a Standard Schema into the JSON Schema sent on the wire.

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/04-structured-output`.

**Look at:** `schema: Recipe` — the zod schema goes in as is: it validates the result and types it, so `object.title` is a `string`. Earlier versions of this example routed it through an `asSchema()` cast for a `StandardSchemaV1` typing gap (`issue.path`) that core has since closed. And look at the partial objects printed while the JSON streams in — every field is optional at every depth until the object completes, which is what lets a UI render progressively without ever seeing an invalid shape.
