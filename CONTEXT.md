# Development context for opencode-db-search

This document contains everything a new agent needs to develop against this codebase.

## Architecture

Single-file Bun script (`opencode-db-search.ts`) with zero external dependencies. Uses only `bun:sqlite` and Node built-ins (`path`, `os`, `fs`). No build step, no transpilation, no package manager beyond Bun itself.

The tool is intentionally standalone and has no imports from the OpenCode codebase. It reads the OpenCode SQLite database directly using raw SQL queries against a known schema.

## Running

```sh
# After installing globally
opencode-db-search <command> [options]

# Or directly from the repo
bun opencode-db-search.ts <command> [options]
```

## Code structure

The file is organized in sections separated by comment banners:

### Helpers

Utility functions used across subcommands:

| Function                 | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `die(msg)`               | Print error to stderr and exit 1                         |
| `ts(ms)`                 | Format ms epoch as `YYYY-MM-DD HH:mm:ss`                 |
| `ago(ms)`                | Format ms epoch as relative time (`3h ago`)              |
| `stripAnsi(s)`           | Strip ANSI escape sequences, returning plain string      |
| `visibleLen(s)`          | Count visible characters (excludes ANSI escapes)         |
| `trunc(s, n)`            | ANSI-aware truncation to n visible chars with ellipsis   |
| `pad(s, n)`              | ANSI-aware right-pad to n visible chars                  |
| `size(bytes)`            | Format bytes as human-readable size                      |
| `ansi(code, text)`       | Wrap text in ANSI escape codes (TTY-gated)               |
| `highlight(text, query)` | Bold-yellow highlight of query matches (TTY-gated)       |
| `escapeLike(s)`          | Escape `%` and `_` for SQL LIKE patterns                 |
| `partPreview(raw)`       | Extract human-readable preview from a part's JSON `data` |
| `jsonField(raw, field)`  | Extract a field from a JSON string with fallback         |
| `msgPreview(parts)`      | Pick the best preview text from a message's parts        |
| `jsonOut(data)`          | Print data as formatted JSON (for `--json` output)       |
| `fetchParts(db, msgId)`  | Fetch parts for a message, ordered by id                 |
| `findSession(db, id)`    | Look up session by ID with prefix-match suggestions      |

### Table Rendering

| Function / Type     | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `Column` interface  | Column definition: key, label, align, min, max, flex |
| `termWidth()`       | Returns terminal width (falls back to 120)           |
| `table(cols, rows)` | Unicode box-drawing table with dynamic column widths |
| `heading(text)`     | Print a bold section heading                         |
| `kvBlock(pairs)`    | Render aligned key-value pairs                       |

### Query Building

| Function / Class        | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `WhereBuilder`          | Accumulates SQL WHERE conditions with parameterized values       |
| `sortOrder(sort, opts)` | Resolves sort field to SQL ORDER BY clause with alias validation |

### Row Types

Lightweight interfaces for common query result shapes: `SessionRow`, `CountRow`.

### DB Resolution

| Function                 | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `dataDir()`              | Returns `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`) |
| `listDbs()`              | Lists all `opencode*.db` files in data dir, sorted by mtime desc      |
| `channelFromName(name)`  | Maps DB filename to channel name                                      |
| `resolveDb(db, channel)` | Resolves the DB path from flags/env/auto-detect                       |
| `openDb()`               | Opens the DB in readonly mode using flag/bool/num accessors           |

### Project ID Inference

| Function         | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `inferProject()` | Infers the OpenCode project ID for the current directory |

Resolution order:

1. Read cached ID from `.git/opencode` (handles worktrees via `--git-common-dir`)
2. Fall back to `git rev-list --max-parents=0 HEAD` (first root commit, sorted)
3. Returns `null` if not in a git repo

### Arg Parsing

Hand-rolled minimal parser. No external dependency.

| Function / Constant | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `BOOLEAN_FLAGS`     | Set of flags that never consume the next positional as a value |
| `parseArgs(argv)`   | Returns `{ cmd, pos, flags }` from argv                        |

The `flag(key)`, `bool(key)`, and `num(key, def)` accessor functions are defined in the Main section as closures over the singleton `parsed.flags`.

### Subcommands

Each subcommand is a function taking `db: Database` (except `cmdDbs` and `cmdHelp`).

| Function              | Command    | Description                                     |
| --------------------- | ---------- | ----------------------------------------------- |
| `cmdDbs()`            | `dbs`      | List DB files in data dir                       |
| `cmdProjects(db)`     | `projects` | List all projects with session counts           |
| `cmdSessions(db)`     | `sessions` | List sessions with filtering/sorting            |
| `cmdMessages(db)`     | `messages` | Show messages for a session                     |
| `cmdParts(db)`        | `parts`    | Show parts for a session or message             |
| `cmdSearch(db)`       | `search`   | Full-text search across titles and part content |
| `cmdInspect(db)`      | `inspect`  | Detailed session info with stats                |
| `latestRootSession()` | (helper)   | Shared query for latest root session            |
| `cmdLatest(db)`       | `latest`   | Simulate what `-c` would pick                   |
| `cmdLoad(db)`         | `load`     | Spawn OpenCode with the right session/directory |
| `cmdHelp()`           | `help`     | Print usage                                     |

### Main

Parses args, defines flag accessors, dispatches to the appropriate subcommand, handles top-level errors (DB locked, can't open).

## OpenCode database schema

The tool queries these tables. All timestamps are milliseconds since epoch. All IDs are branded strings with prefixes.

### `project`

| Column             | Type                 | Notes                               |
| ------------------ | -------------------- | ----------------------------------- |
| `id`               | text PK              | Git root commit hash, or `"global"` |
| `worktree`         | text NOT NULL        | Git worktree root path              |
| `vcs`              | text                 | `"git"` or null                     |
| `name`             | text                 | Display name                        |
| `icon_url`         | text                 |                                     |
| `icon_color`       | text                 |                                     |
| `time_created`     | integer NOT NULL     | ms epoch                            |
| `time_updated`     | integer NOT NULL     | ms epoch                            |
| `time_initialized` | integer              |                                     |
| `sandboxes`        | text (JSON) NOT NULL | string array                        |
| `commands`         | text (JSON)          | `{ start?: string }`                |

### `session`

| Column              | Type             | Notes                                                  |
| ------------------- | ---------------- | ------------------------------------------------------ |
| `id`                | text PK          | Prefix `ses_`, 30 chars, descending timestamp encoding |
| `project_id`        | text FK          | References `project.id`                                |
| `workspace_id`      | text             |                                                        |
| `parent_id`         | text             | Non-null = fork/subagent child session                 |
| `slug`              | text NOT NULL    | Used for plan file naming                              |
| `directory`         | text NOT NULL    | cwd at session creation                                |
| `title`             | text NOT NULL    | Session title                                          |
| `version`           | text NOT NULL    | OpenCode version                                       |
| `share_url`         | text             |                                                        |
| `summary_additions` | integer          |                                                        |
| `summary_deletions` | integer          |                                                        |
| `summary_files`     | integer          |                                                        |
| `summary_diffs`     | text (JSON)      | File diff array                                        |
| `revert`            | text (JSON)      | Revert state                                           |
| `permission`        | text (JSON)      | Permission ruleset                                     |
| `time_created`      | integer NOT NULL | ms epoch                                               |
| `time_updated`      | integer NOT NULL | ms epoch                                               |
| `time_compacting`   | integer          | Compaction in progress                                 |
| `time_archived`     | integer          | Non-null = archived                                    |

Indexes: `session_project_idx(project_id)`, `session_workspace_idx(workspace_id)`, `session_parent_idx(parent_id)`. No index on `title`.

### `message`

| Column         | Type             | Notes                                                          |
| -------------- | ---------------- | -------------------------------------------------------------- |
| `id`           | text PK          | Prefix `msg_`                                                  |
| `session_id`   | text FK          | References `session.id`                                        |
| `time_created` | integer NOT NULL | ms epoch                                                       |
| `time_updated` | integer NOT NULL | ms epoch                                                       |
| `data`         | text (JSON)      | Metadata: `role`, `model`, `cost`, `tokens`, `error`, `finish` |

The `data` JSON contains metadata about the message but **not** the actual conversation text. Text content lives in the `part` table.

Index: `message_session_time_created_id_idx(session_id, time_created, id)`.

### `part`

| Column         | Type             | Notes                         |
| -------------- | ---------------- | ----------------------------- |
| `id`           | text PK          | Prefix `prt_`                 |
| `message_id`   | text FK          | References `message.id`       |
| `session_id`   | text             | Denormalized for fast queries |
| `time_created` | integer NOT NULL | ms epoch                      |
| `time_updated` | integer NOT NULL | ms epoch                      |
| `data`         | text (JSON)      | Part content (see below)      |

The `data` JSON has a `type` discriminant. Common types:

| Type          | Key fields                                           | Description                    |
| ------------- | ---------------------------------------------------- | ------------------------------ |
| `text`        | `text` or `content`                                  | User or assistant text content |
| `tool`        | `tool`, `state.title`, `state.input`, `state.output` | Tool call and result           |
| `reasoning`   | `content` or `text`                                  | Model reasoning/thinking       |
| `snapshot`    | —                                                    | File snapshot                  |
| `subtask`     | `title`                                              | Subagent task                  |
| `file`        | `path`                                               | File reference                 |
| `step-start`  | —                                                    | Step boundary marker           |
| `step-finish` | —                                                    | Step boundary marker           |
| `compaction`  | —                                                    | Context compaction marker      |
| `patch`       | —                                                    | Code patch                     |

Indexes: `part_message_id_id_idx(message_id, id)`, `part_session_idx(session_id)`.

### `todo`

| Column         | Type             | Notes                                              |
| -------------- | ---------------- | -------------------------------------------------- |
| `session_id`   | text FK          | Composite PK with `position`                       |
| `content`      | text NOT NULL    |                                                    |
| `status`       | text NOT NULL    | `pending`, `in_progress`, `completed`, `cancelled` |
| `priority`     | text NOT NULL    |                                                    |
| `position`     | integer NOT NULL | Composite PK with `session_id`                     |
| `time_created` | integer NOT NULL | ms epoch                                           |
| `time_updated` | integer NOT NULL | ms epoch                                           |

### `permission`

| Column         | Type             | Notes                   |
| -------------- | ---------------- | ----------------------- |
| `project_id`   | text PK FK       | References `project.id` |
| `time_created` | integer NOT NULL | ms epoch                |
| `time_updated` | integer NOT NULL | ms epoch                |
| `data`         | text (JSON)      | Permission ruleset      |

## DB file location

OpenCode stores its database at `$XDG_DATA_HOME/opencode/` (default `~/.local/share/opencode/`). The filename depends on the build channel:

| Channel                  | Filename                | When used                        |
| ------------------------ | ----------------------- | -------------------------------- |
| `latest`, `beta`, `prod` | `opencode.db`           | Installed release builds         |
| `local`                  | `opencode-local.db`     | Local dev builds (`bun run dev`) |
| Other                    | `opencode-<channel>.db` | Custom channel builds            |

This is a common source of "missing session" bugs: sessions created with a release build are invisible to a dev build and vice versa.

The DB uses WAL mode with these pragmas:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `busy_timeout = 5000`
- `cache_size = -64000` (64MB)
- `foreign_keys = ON`

This tool opens in readonly mode to avoid WAL contention with running OpenCode instances.

## How OpenCode scopes sessions

Understanding this is critical for debugging "missing session" issues.

### Project resolution

1. OpenCode looks for a cached project ID in `.git/opencode` (resolves `--git-common-dir` for worktrees)
2. Falls back to the first root commit: `git rev-list --max-parents=0 HEAD | sort | head -1`
3. Non-git directories use project ID `"global"`

### Session listing (TUI)

The TUI loads sessions on bootstrap with a **30-day lookback**: `Session.list({ start: now - 30d })`. It then sorts by `time_updated DESC` and shows only root sessions (`parent_id IS NULL`). Archived sessions are NOT filtered by `Session.list()` but may be hidden by the UI.

### Continue flag (`-c`)

**TUI mode**: picks the most recently updated root session from the 30-day window.

**Headless mode** (`opencode run -c`): picks the most recently updated root session with no time filter.

Neither mode filters archived sessions.

## How OpenCode IDs work

IDs use the format `{prefix}_{6-byte-hex-timestamp}{14-char-random-base62}`, totaling 30 characters.

Session IDs (`ses_`) use **descending** timestamps (bitwise NOT), so newer sessions sort first lexicographically. Message IDs (`msg_`) and part IDs (`prt_`) use ascending timestamps.

## Schema source of truth

The canonical schema is defined in the OpenCode repo using Drizzle ORM:

- `packages/opencode/src/session/session.sql.ts` — session, message, part, todo, permission tables
- `packages/opencode/src/project/project.sql.ts` — project table
- `packages/opencode/src/storage/schema.sql.ts` — shared `Timestamps` mixin

If the schema changes upstream, this tool's raw SQL queries may need updating. Check the OpenCode migration directory (`packages/opencode/migration/`) for recent schema changes.

## Testing

No automated tests. Verify manually against a real OpenCode database:

```sh
opencode-db-search dbs                           # should list DB files
opencode-db-search projects                      # should list projects
opencode-db-search sessions --all --limit 5      # should list sessions across all projects
opencode-db-search search "some term" --limit 5  # should find matches with highlighting
opencode-db-search latest                        # should show what -c would pick
opencode-db-search inspect <sessionID>           # should show full session detail
opencode-db-search load <sessionID> --dry-run    # should print the opencode command
```

## Known limitations

- No FTS5 index: content search scans JSON blobs with `LIKE`, which is slow on large databases
- No schema coupling: if OpenCode renames columns or changes JSON structure, queries silently break
- Single DB per invocation: cannot search across multiple DB files in one command
- Project inference may disagree with OpenCode's in edge cases (worktrees with different HEAD, post-migration cached IDs)
