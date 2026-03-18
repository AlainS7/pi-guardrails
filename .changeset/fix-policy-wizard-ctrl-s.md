---
"@aliou/pi-guardrails": patch
---

fix: update `@aliou/pi-utils-settings` to 0.10.1 for nested wizard Ctrl+S handling

- pulls in the `pi-utils-settings` fix that lets nested settings submenus receive `Ctrl+S` before the top-level settings screen intercepts save
- fixes the add-policy flow so the review step can submit with `Ctrl+S`
