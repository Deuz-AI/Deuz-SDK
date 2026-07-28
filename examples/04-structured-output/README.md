# 04 — Structured output

**Shows:** one zod schema driving both `generateObject` (buffered, validated, one repair retry) and `streamObject` (live `partialObjectStream`, no repair) — plus the optional peer `@standard-community/standard-json` that converts a Standard Schema into the JSON Schema sent on the wire.

**Run:** from the repo root, `npm install && npm run build`, then `ANTHROPIC_API_KEY=sk-ant-… npm run dev -w @deuz-examples/04-structured-output`.

**Look at:** the `asSchema()` helper at the top — core's inlined `StandardSchemaV1` types `issue.path` as `ReadonlyArray<PropertyKey>` while the published spec allows `ReadonlyArray<PropertyKey | PathSegment>`, so a real zod schema needs one cast at the boundary today (runtime is unaffected). And look at the partial objects printed while the JSON streams in — every field is optional at every depth until the object completes, which is what lets a UI render progressively without ever seeing an invalid shape.
