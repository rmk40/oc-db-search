# Agent guidance for opencode-db-search

## SQL & bun:sqlite quirks

- `ESCAPE '\\'` in template strings needs exactly one backslash escape level. Double-escaping (`'\\\\'`) produces a two-char string that SQLite rejects with "ESCAPE expression must be a single character".
- `COALESCE(a, b, c) LIKE ?` only tests the first non-null field. To search multiple JSON fields independently, use `a LIKE ? OR b LIKE ? OR c LIKE ?` with the pattern repeated per field.
- All user-input values used in `LIKE` patterns must go through `escapeLike()` to neutralize `%` and `_` wildcards — including session ID prefix matches and `--directory` filters.

## ANSI terminal output

- Three functions must stay in sync: `stripAnsi` (returns plain string), `visibleLen` (returns visible char count), `trunc` (truncates to N visible chars preserving escapes). If any of these diverge, table rendering and search output will corrupt terminal output.
- Any new function that measures or slices user-visible strings must use `visibleLen()`, not `.length`, if the string could contain ANSI codes.

## Bun packaging

- Bun's `bin` field in package.json works directly with `.ts` files — no compile step needed. The `#!/usr/bin/env bun` shebang is required.
- `bun link` installs binaries to `~/.bun/bin/`, which may not be on PATH. Test with the full path or `bun <file>.ts` directly.

## Code patterns

- `jsonField(raw, field)` uses `v != null && v !== ""` — never `||` — because `||` swallows legitimate falsy values from JSON (`0`, `false`, `""`).
- `WhereBuilder.add()` accepts raw SQL fragments. All current callers use string literals. Never pass user input as the condition string; user values go in the `...params` rest args.
- `sortOrder()` validates its `alias` parameter against `/^[a-z_][a-z0-9_]*$/i`. The `sort` value itself never reaches SQL — it's matched against a fixed set with a static default fallback.

## Documentation

- CONTEXT.md must not contain line numbers or line counts — they go stale with every edit. Use section names and function tables for navigation; agents can grep for section banners (`// ───`).
- README.md command examples should use the installed binary name (`opencode-db-search`), not `bun opencode-db-search.ts`.
