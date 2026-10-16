---
'@deuz-sdk/core': patch
---

Preserve optional Gemini native function-call IDs in provider metadata and echo them in subsequent function calls and matching function responses, including on Vertex AI. Keep canonical tool-call IDs independently generated and leave ID-less calls and thought signatures unchanged.
