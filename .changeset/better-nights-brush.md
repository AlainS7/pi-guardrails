---
"@aliou/pi-guardrails": minor
---

Redesign file protection from legacy `envFiles` to a new `policies` system with per-rule protection levels (`noAccess`, `readOnly`, `none`), add migration from old config fields, replace the old env hook with a general policies hook, and add `/guardrails:add-policy` for AI-assisted rule creation.
