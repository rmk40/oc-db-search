# opencode-db-search

> Where did my session go?

A CLI tool for searching and inspecting [OpenCode](https://github.com/sst/opencode) sessions directly from the SQLite database -- without the filters, lookback windows, or project scoping that can hide them in the TUI.

## The problem

OpenCode's session list applies several invisible filters:

- **30-day lookback** -- sessions older than 30 days disappear from the TUI
- **Project scoping** -- only sessions matching the current git repo are shown
- **Fork filtering** -- subagent/fork sessions are hidden by default
- **Channel isolation** -- dev builds (`opencode-local.db`) and release builds (`opencode.db`) use separate databases

When a session goes missing, there's no built-in way to find it. This tool queries the raw SQLite database with no filters, so you can always find any session.

## Install

Requires [Bun](https://bun.sh) v1.0+.

```sh
# From npm
bun install -g opencode-db-search

# From GitHub
bun install -g github:rmk40/opencode-db-search

# From a local clone
git clone https://github.com/rmk40/opencode-db-search && cd opencode-db-search && bun link
```

If `~/.bun/bin` is not on your PATH, add it:

```sh
export PATH="$HOME/.bun/bin:$PATH"
```

## Quick start

```sh
# What databases exist?
opencode-db-search dbs

# List all sessions across all projects
opencode-db-search sessions --all

# Search for a session by keyword
opencode-db-search search "refactor auth"

# Why isn't -c picking my session?
opencode-db-search latest

# Get full details on a session
opencode-db-search inspect ses_abc123...

# Open a session in OpenCode
opencode-db-search load ses_abc123...
```

## Example output

```
$ opencode-db-search sessions --all --limit 5
┌──────────────────────────┬───────────────────────────┬──────────────────────────┬──────────┬──────┐
│ ID                       │ Title                     │ Directory                │ Updated  │ Msgs │
├──────────────────────────┼───────────────────────────┼──────────────────────────┼──────────┼──────┤
│ ses_27b4926f3ffe9q475j…  │ Refactor auth middleware  │ /home/user/projects/app  │ just now │  142 │
│ ses_2be0ef954ffeImu3vl…  │ Fix pagination bug        │ /home/user/projects/api  │ 1h ago   │ 1050 │
│ ses_2957fa195ffemZs3FU…  │ Add dark mode             │ /home/user/projects/web  │ 3h ago   │   64 │
│ ses_2c40c9050ffeYUwQ75…  │ Deploy pipeline           │ /home/user/infra         │ 2d ago   │  737 │
│ ses_1b632aafa8931d2e61…  │ Initial setup             │ /home/user/projects/app  │ 12d ago  │   79 │
└──────────────────────────┴───────────────────────────┴──────────────────────────┴──────────┴──────┘
5 session(s)
```

```
$ opencode-db-search latest
Project
ID      4b0ea68d7af9a6031a7ffda7ad66e0cb83315750
Source  inferred from cwd

TUI mode (-c)
Session    ses_27b4926f3ffe9q475jVn131I3j
Title      Refactor auth middleware
Updated    2026-04-13 03:40:18
Directory  /home/user/projects/app

Headless mode (run -c)
  Same as TUI mode

Root sessions       12
Outside 30d window  3
```

## Commands

| Command          | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `dbs`            | List available database files with size, age, and channel |
| `projects`       | List all projects with session counts                     |
| `sessions`       | List sessions with filtering by project, date, status     |
| `messages <id>`  | Show messages in a session                                |
| `parts <id>`     | Show message parts (text, tool calls, reasoning)          |
| `search <query>` | Full-text search across titles and content                |
| `inspect <id>`   | Detailed session info: stats, tokens, cost, todos         |
| `latest`         | Debug why `-c` picks (or doesn't pick) a session          |
| `load <id>`      | Open a session directly in OpenCode                       |

Every command supports `--json` for machine-readable output.

## Key flags

```sh
# Show sessions from all projects, not just current
opencode-db-search sessions --all

# Include archived and fork sessions
opencode-db-search sessions --archived --forks

# Filter by date range
opencode-db-search sessions --since 2024-01-01 --before 2024-02-01

# Use a specific database file
opencode-db-search sessions --db ~/.local/share/opencode/opencode-local.db

# Search only titles, or only content
opencode-db-search search "query" --scope title
opencode-db-search search "query" --scope content

# Preview what load would do
opencode-db-search load ses_abc123 --dry-run
```

## How it finds the database

1. `--db <path>` flag (explicit)
2. `$OPENCODE_DB` environment variable
3. `--channel <name>` flag (`local` -> `opencode-local.db`, etc.)
4. Auto-detect: most recently modified `opencode*.db` in `~/.local/share/opencode/`

## How it scopes to your project

By default, `sessions` and `latest` filter to the current project, inferred from:

1. Cached ID in `.git/opencode` (matches OpenCode's own logic)
2. Git root commit hash
3. Falls back to `"global"` outside git repos

Use `--all` to see everything, or `--project <id>` to target a specific project.

## License

MIT
