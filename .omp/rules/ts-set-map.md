---
description: Prefer Set for membership and Record for keyed values.
condition: "namedColorTokens|new Set|Record<string, true>|\.has\("
scope: "tool:edit(*.ts), tool:write(*.ts)"
interruptMode: tool-only
---

Use the collection type that matches the operation being modeled.

Use `Set` for membership checks, including small static string token lists. The `.has()` call communicates that the data represents a set of valid values.

Use `Record<K, V>` when keys map to values that are used by the program.

```typescript
// Static membership → Set
const COLOR_TOKENS = new Set(["black", "white"]);
if (COLOR_TOKENS.has(token)) return token;

// Key maps to value → Record
const LABEL_BY_KIND: Record<string, string> = {
  text: "Text",
  json: "JSON",
  binary: "Binary",
};
```

Membership? `Set`. Key-value mapping? `Record` / `Map`.
