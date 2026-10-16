---
'@deuz-sdk/core': patch
---

Reject unsupported incremental native function arguments rather than treating each partial frame as a complete empty call. Explicit streamFunctionCallArguments opt-in fails before HTTP; unexpected partialArgs or willContinue frames terminate the turn before tools execute. Complete calls, including zero-argument calls, are unchanged. This is a safety boundary, not an implementation of partial-argument assembly.
