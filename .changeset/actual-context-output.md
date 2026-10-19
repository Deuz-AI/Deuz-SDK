---
'@deuz-sdk/core': patch
---

Reserve the effective model-call output cap when compiling V3 context, including prepared tool steps and final structured answers. Reuse the same wire output rules as request construction, including provider thinking-budget adjustments, instead of always subtracting the catalog's default. This does not change the caller's output budget or provide exact token counting.
