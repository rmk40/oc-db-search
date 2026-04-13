#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BIN = "opencode-db-search";

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const tty = process.stdout.isTTY ?? false;

function ts(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function ago(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape sequences, returning the plain string. */
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible character count (excludes ANSI escapes). */
function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Truncate a string to n visible characters, preserving ANSI sequences.
 * Appends "…" if truncated.
 */
function trunc(s: string, n: number): string {
  if (n <= 0) return "";
  // Fast path: no ANSI codes
  if (!s.includes("\x1b")) {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }
  // Walk through the string, counting only visible characters
  if (visibleLen(s) <= n) return s;
  let visible = 0;
  let i = 0;
  let result = "";
  // Use a sticky-like approach: set lastIndex and test at each position
  const re = new RegExp(ANSI_RE.source, "g");
  while (i < s.length && visible < n - 1) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m && m.index === i) {
      result += m[0];
      i += m[0].length;
    } else {
      result += s[i];
      visible++;
      i++;
    }
  }
  // Reset any open styles before the ellipsis
  return `${result}\x1b[0m…`;
}

function pad(s: string, n: number): string {
  const len = visibleLen(s);
  return len >= n ? s : s + " ".repeat(n - len);
}

// ─── Table Rendering ──────────────────────────────────────────────────────────

const BOX = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  lm: "├",
  rm: "┤",
  tm: "┬",
  bm: "┴",
  x: "┼",
} as const;

interface Column {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Maximum width this column can grow to */
  max?: number;
  /** Minimum width */
  min?: number;
  /** If true, this column absorbs remaining terminal width */
  flex?: boolean;
}

function termWidth(): number {
  return process.stdout.columns || 120;
}

/**
 * Render a unicode box-drawing table with dynamic column widths.
 *
 * @param cols  Column definitions
 * @param rows  Array of row objects (values are strings)
 * @param opts  Optional: { footer?: string }
 */
function table(
  cols: Column[],
  rows: Array<Record<string, string>>,
  opts?: { footer?: string; emptyMsg?: string },
): void {
  if (rows.length === 0) {
    if (opts?.emptyMsg) console.log(opts.emptyMsg);
    return;
  }

  const tw = termWidth();

  // Measure natural width per column (header label + all data values)
  const natural: number[] = cols.map((c) => {
    let w = c.label.length;
    for (const r of rows) {
      const len = visibleLen(r[c.key] || "");
      if (len > w) w = len;
    }
    // Clamp to min/max
    if (c.min && w < c.min) w = c.min;
    if (c.max && w > c.max) w = c.max;
    return w;
  });

  // Total: content + padding (1 space each side) + borders (cols+1 border chars)
  const fixedOverhead = cols.length + 1 + cols.length * 2; // borders + padding
  const contentBudget = Math.max(cols.length, tw - fixedOverhead); // floor at 1 char/col

  // First pass: assign non-flex columns their natural width
  const widths: number[] = new Array(cols.length).fill(0);
  let usedByFixed = 0;
  const flexIndices: number[] = [];

  for (let i = 0; i < cols.length; i++) {
    if (cols[i].flex) {
      flexIndices.push(i);
    } else {
      widths[i] = Math.max(1, Math.min(natural[i], contentBudget));
      usedByFixed += widths[i];
    }
  }

  // Distribute remaining space to flex columns
  const remaining = Math.max(0, contentBudget - usedByFixed);
  if (flexIndices.length > 0) {
    const totalNatural = flexIndices.reduce((s, i) => s + natural[i], 0);
    let distributed = 0;
    for (let fi = 0; fi < flexIndices.length; fi++) {
      const i = flexIndices[fi];
      const minW = cols[i].min || 4;
      const maxW = cols[i].max;
      if (fi === flexIndices.length - 1) {
        widths[i] = Math.max(remaining - distributed, minW);
      } else {
        const share =
          totalNatural > 0
            ? Math.floor((natural[i] / totalNatural) * remaining)
            : Math.floor(remaining / flexIndices.length);
        widths[i] = Math.max(share, minW);
      }
      if (maxW && widths[i] > maxW) widths[i] = maxW;
      distributed += widths[i];
    }
  }

  // Final shrink pass: if total exceeds budget, shrink widest columns first.
  // Two rounds: first respects min, then allows going below min (floor at 1).
  let totalWidth = widths.reduce((a, b) => a + b, 0);
  if (totalWidth > contentBudget) {
    let excess = totalWidth - contentBudget;
    const order = widths.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
    // Round 1: shrink to min
    for (const { i } of order) {
      if (excess <= 0) break;
      const floor = cols[i].min || 1;
      const shrink = Math.min(excess, widths[i] - floor);
      if (shrink > 0) {
        widths[i] -= shrink;
        excess -= shrink;
      }
    }
    // Round 2: if still over budget, shrink below min (floor at 1)
    if (excess > 0) {
      order.sort((a, b) => widths[b.i] - widths[a.i]);
      for (const { i } of order) {
        if (excess <= 0) break;
        const shrink = Math.min(excess, widths[i] - 1);
        if (shrink > 0) {
          widths[i] -= shrink;
          excess -= shrink;
        }
      }
    }
  }

  // Cell formatter: truncate + pad
  function fmtCell(
    value: string,
    width: number,
    align: "left" | "right",
  ): string {
    const visible = visibleLen(value);
    const display = visible > width ? trunc(value, width) : value;
    const displayLen = visibleLen(display);
    const gap = Math.max(0, width - displayLen);
    return align === "right"
      ? " ".repeat(gap) + display
      : display + " ".repeat(gap);
  }

  // Build lines
  function hline(left: string, mid: string, right: string): string {
    return left + widths.map((w) => BOX.h.repeat(w + 2)).join(mid) + right;
  }

  // Render
  const dim = (s: string) => ansi("2", s);

  console.log(dim(hline(BOX.tl, BOX.tm, BOX.tr)));
  console.log(
    dim(BOX.v) +
      cols
        .map(
          (c, i) =>
            ` ${ansi("1", fmtCell(c.label, widths[i], c.align || "left"))} `,
        )
        .join(dim(BOX.v)) +
      dim(BOX.v),
  );
  console.log(dim(hline(BOX.lm, BOX.x, BOX.rm)));

  for (const r of rows) {
    const cells = cols.map((c) => r[c.key] || "");
    console.log(
      dim(BOX.v) +
        cells
          .map((c, i) => ` ${fmtCell(c, widths[i], cols[i].align || "left")} `)
          .join(dim(BOX.v)) +
        dim(BOX.v),
    );
  }

  console.log(dim(hline(BOX.bl, BOX.bm, BOX.br)));

  if (opts?.footer) {
    console.log(dim(opts.footer));
  }
}

/** Print a bold section heading. */
function heading(text: string): void {
  console.log(ansi("1", text));
}

/** Render key-value pairs in a clean aligned format. */
function kvBlock(pairs: Array<[string, string]>): void {
  if (pairs.length === 0) return;
  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    console.log(`${ansi("1", pad(k, maxKey))}  ${v}`);
  }
}

/**
 * Word-wrap text to fit within a given width.
 * Breaks at spaces; falls back to hard-break for words exceeding width.
 */
function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (word === "") continue;
    if (line.length === 0) {
      // Hard-break words longer than width
      if (visibleLen(word) > width) {
        let remaining = word;
        while (visibleLen(remaining) > width) {
          lines.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        line = remaining;
      } else {
        line = word;
      }
    } else if (visibleLen(line) + 1 + visibleLen(word) <= width) {
      line += " " + word;
    } else {
      lines.push(line);
      if (visibleLen(word) > width) {
        let remaining = word;
        while (visibleLen(remaining) > width) {
          lines.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        line = remaining;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Render a search result card with box-drawing borders.
 */
function card(opts: {
  id: string;
  badge: string;
  title: string;
  subtitle?: string;
  body: string[];
  width?: number;
  maxBodyLines?: number;
}): void {
  const w = opts.width || 80;
  const inner = w - 4; // "│ " + content + " │"
  const maxLines = opts.maxBodyLines || 6;
  const dim = (s: string) => ansi("2", s);

  // Top border: ┌─ id ──...── badge ─┐
  const idStr = ` ${opts.id} `;
  const badgeStr = ` ${opts.badge} `;
  const fill = w - 2 - idStr.length - badgeStr.length; // -2 for ┌ and ┐
  const topLine =
    dim(BOX.tl + BOX.h) +
    ansi("1;36", idStr) +
    dim(BOX.h.repeat(Math.max(1, fill))) +
    dim(badgeStr) +
    dim(BOX.h + BOX.tr);
  console.log(topLine);

  // Body line renderer
  const printLine = (text: string) => {
    const padded = pad(text, inner);
    // Truncate if pad somehow exceeds inner width
    const display = visibleLen(padded) > inner ? trunc(padded, inner) : padded;
    console.log(`${dim(BOX.v)} ${display} ${dim(BOX.v)}`);
  };

  // Title (bold)
  printLine(ansi("1", trunc(opts.title, inner)));

  // Subtitle (dimmed)
  if (opts.subtitle) {
    printLine(ansi("2", trunc(opts.subtitle, inner)));
  }

  // Blank separator before body
  if (opts.body.length > 0) {
    printLine("");
    let printed = 0;
    for (const line of opts.body) {
      if (printed >= maxLines) {
        printLine(ansi("2", "…"));
        break;
      }
      printLine(line);
      printed++;
    }
  }

  // Bottom border
  console.log(dim(BOX.bl + BOX.h.repeat(w - 2) + BOX.br));
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ansi(code: string, text: string): string {
  return tty ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function highlight(text: string, query: string): string {
  if (!query || !tty) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let result = "";
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, idx);
    result += ansi("1;33", text.slice(idx, idx + query.length));
    i = idx + query.length;
  }
  return result;
}

function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function partPreview(raw: string): string {
  try {
    const d = JSON.parse(raw);
    if (d.type === "text" && (d.content || d.text))
      return (d.content || d.text).replace(/\n/g, " ");
    if (d.type === "tool") {
      const title = d.state?.title || d.tool || "tool";
      const out = d.state?.output
        ? `: ${d.state.output}`
        : d.state?.input
          ? `: ${d.state.input}`
          : "";
      return `[tool:${title}]${out}`.replace(/\n/g, " ");
    }
    if (d.type === "reasoning" && (d.content || d.text))
      return `[reasoning] ${(d.content || d.text).replace(/\n/g, " ")}`;
    if (d.type === "snapshot") return "[snapshot]";
    if (d.type === "subtask") return `[subtask] ${d.title || ""}`.trim();
    if (d.type === "file") return `[file] ${d.path || ""}`.trim();
    return `[${d.type || "unknown"}]`;
  } catch {
    return raw.slice(0, 80);
  }
}

/** Extract a top-level field from a JSON string, returning fallback on failure. */
function jsonField(raw: string, field: string, fallback = "?"): string {
  try {
    const v = JSON.parse(raw)[field];
    return v != null && v !== "" ? String(v) : fallback;
  } catch {
    return fallback;
  }
}

function msgPreview(parts: Array<{ data: string }>): string {
  for (const p of parts) {
    const pv = partPreview(p.data);
    if (pv && !pv.startsWith("[")) return pv;
  }
  for (const p of parts) {
    const pv = partPreview(p.data);
    if (pv) return pv;
  }
  return "";
}

/** Print data as formatted JSON. Used with `return void jsonOut(...)` for early return. */
function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Fetch parts for a message, ordered by id.
 */
function fetchParts(
  db: Database,
  messageId: string,
): Array<{ id: string; data: string; time_created: number }> {
  return db
    .query(
      `SELECT id, data, time_created FROM part WHERE message_id = ? ORDER BY id ASC`,
    )
    .all(messageId) as any[];
}

/**
 * Look up a session by exact ID. If not found, prints suggestions for
 * prefix matches and returns null, or dies if no matches at all.
 */
function findSession(db: Database, id: string): any {
  const row = db
    .query(
      `SELECT s.*, p.worktree, p.vcs, p.name as project_name
       FROM session s
       LEFT JOIN project p ON s.project_id = p.id
       WHERE s.id = ?`,
    )
    .get(id);
  if (row) return row;

  // Suggest prefix matches
  const similar = db
    .query(`SELECT id, title FROM session WHERE id LIKE ? ESCAPE '\\' LIMIT 5`)
    .all(`${escapeLike(id)}%`) as any[];
  if (similar.length > 0) {
    console.log(`Session "${id}" not found. Similar IDs:`);
    for (const s of similar) console.log(`  ${s.id}  ${s.title}`);
    return null;
  }
  die(`Session not found: ${id}`);
}

// ─── Query Building ───────────────────────────────────────────────────────────

class WhereBuilder {
  private conditions: string[] = [];
  private values: any[] = [];

  add(condition: string, ...params: any[]): this {
    this.conditions.push(condition);
    this.values.push(...params);
    return this;
  }

  toSql(): string {
    return this.conditions.length > 0
      ? `WHERE ${this.conditions.join(" AND ")}`
      : "";
  }

  get params(): any[] {
    return this.values;
  }
}

const VALID_SQL_ALIAS = /^[a-z_][a-z0-9_]*$/i;

function sortOrder(
  sort: string,
  opts?: { alias?: string; extraClauses?: Record<string, string> },
): string {
  const alias = opts?.alias || "";
  if (alias && !VALID_SQL_ALIAS.test(alias)) die(`Invalid SQL alias: ${alias}`);
  const a = alias ? `${alias}.` : "";
  const extra = opts?.extraClauses || {};
  // Only allow known sort keys — unknown values fall through to default
  if (sort in extra) return extra[sort];
  if (sort === "created") return `${a}time_created DESC`;
  return `${a}time_updated DESC`; // default for "updated" or any unknown value
}

// ─── Row Types ────────────────────────────────────────────────────────────────

/** Minimal session row returned by list/search queries. */
interface SessionRow {
  id: string;
  title: string;
  directory: string;
  project_id: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  version: string;
  [key: string]: unknown; // allow extra columns from JOINs
}

/** Row from COUNT/GROUP BY aggregations. */
interface CountRow {
  count: number;
  [key: string]: unknown;
}

// ─── DB Resolution ────────────────────────────────────────────────────────────

function dataDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "opencode",
  );
}

function listDbs(): Array<{
  name: string;
  path: string;
  size: number;
  mtime: number;
}> {
  const dir = dataDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("opencode") && f.endsWith(".db"))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function channelFromName(name: string): string {
  if (name === "opencode.db") return "latest/beta/prod";
  const m = name.match(/^opencode-(.+)\.db$/);
  return m ? m[1] : "unknown";
}

function resolveDb(dbFlag?: string, channelFlag?: string): string {
  if (dbFlag) {
    if (!fs.existsSync(dbFlag)) die(`DB file not found: ${dbFlag}`);
    return dbFlag;
  }
  const explicit = process.env.OPENCODE_DB;
  if (explicit) {
    if (explicit === ":memory:") return explicit;
    const resolved = path.isAbsolute(explicit)
      ? explicit
      : path.join(dataDir(), explicit);
    if (!fs.existsSync(resolved)) die(`OPENCODE_DB not found: ${resolved}`);
    return resolved;
  }
  if (channelFlag) {
    const safe = channelFlag.replace(/[^a-zA-Z0-9._-]/g, "-");
    const name = ["latest", "beta", "prod"].includes(channelFlag)
      ? "opencode.db"
      : `opencode-${safe}.db`;
    const full = path.join(dataDir(), name);
    if (!fs.existsSync(full)) die(`Channel DB not found: ${full}`);
    return full;
  }
  const dbs = listDbs(); // already sorted by mtime desc
  if (dbs.length === 0) die(`No opencode DB found in ${dataDir()}`);
  return dbs[0].path;
}

/** Open the DB using --db / --channel flags or auto-detect. */
function openDb(): Database {
  const p = resolveDb(flag("db"), flag("channel"));
  console.error(`DB: ${p}`);
  return new Database(p, { readonly: true });
}

// ─── Project ID Inference ─────────────────────────────────────────────────────

function inferProject(): string | null {
  try {
    // Check cached project ID first (matches opencode's project.ts:159-227)
    const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"]);
    if (gitDir.exitCode === 0) {
      const dir = gitDir.stdout.toString().trim();
      // Handle worktrees: resolve common dir
      const common = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"]);
      const root =
        common.exitCode === 0 ? common.stdout.toString().trim() : dir;
      const cached = path.join(root, "opencode");
      if (fs.existsSync(cached)) {
        const id = fs.readFileSync(cached, "utf-8").trim();
        if (id) return id;
      }
    }
    // Fall back to root commit hash
    const result = Bun.spawnSync([
      "git",
      "rev-list",
      "--max-parents=0",
      "HEAD",
    ]);
    if (result.exitCode !== 0) return null;
    const commits = result.stdout.toString().trim().split("\n").sort();
    return commits[0] || null;
  } catch {
    return null;
  }
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

/** Flags that never consume a following positional as their value. */
const BOOLEAN_FLAGS = new Set([
  "all",
  "archived",
  "forks",
  "parts",
  "json",
  "fork",
  "dry-run",
  "help",
]);

function parseArgs(argv: string[]): {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
} {
  const cmd = argv[0] || "help";
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { cmd, pos, flags };
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

function cmdDbs() {
  const dir = dataDir();
  const dbs = listDbs();
  if (dbs.length === 0) {
    console.log(`No opencode DBs found in ${dir}`);
    return;
  }
  if (bool("json"))
    return void jsonOut(
      dbs.map((d) => ({ ...d, channel: channelFromName(d.name) })),
    );
  console.log(`Data dir: ${dir}\n`);
  table(
    [
      { key: "file", label: "File" },
      { key: "size", label: "Size", align: "right" },
      { key: "modified", label: "Modified" },
      { key: "channel", label: "Channel" },
    ],
    dbs.map((d) => ({
      file: d.name,
      size: size(d.size),
      modified: ts(d.mtime),
      channel: channelFromName(d.name),
    })),
  );
}

function cmdProjects(db: Database) {
  const rows = db
    .query(
      `SELECT p.*, 
              (SELECT COUNT(*) FROM session s WHERE s.project_id = p.id) as session_count,
              (SELECT MAX(s.time_updated) FROM session s WHERE s.project_id = p.id) as last_session
       FROM project p
       ORDER BY last_session DESC NULLS LAST`,
    )
    .all() as any[];

  if (bool("json")) return void jsonOut(rows);
  table(
    [
      { key: "id", label: "ID", max: 42 },
      { key: "worktree", label: "Worktree", flex: true, min: 12 },
      { key: "vcs", label: "VCS", max: 5 },
      { key: "sessions", label: "Sessions", align: "right", max: 10 },
      { key: "updated", label: "Updated", max: 12 },
    ],
    rows.map((r: any) => ({
      id: r.id,
      worktree: r.worktree || "(none)",
      vcs: r.vcs || "—",
      sessions: String(r.session_count),
      updated: ago(r.last_session),
    })),
    { footer: `${rows.length} project(s)`, emptyMsg: "No projects found." },
  );
}

function cmdSessions(db: Database) {
  const all = bool("all");
  const archived = bool("archived");
  const forks = bool("forks");
  const limit = num("limit", 100);
  const sort = flag("sort") || "updated";
  const dir = flag("directory");
  const proj = flag("project");
  const since = flag("since");
  const before = flag("before");

  const w = new WhereBuilder();

  if (!all) {
    w.add("s.project_id = ?", proj || inferProject() || "global");
  } else if (proj) {
    w.add("s.project_id = ?", proj);
  }

  if (!archived) w.add("s.time_archived IS NULL");
  if (!forks) w.add("s.parent_id IS NULL");
  if (dir) w.add("s.directory LIKE ? ESCAPE '\\'", `${escapeLike(dir)}%`);
  if (since) {
    const ms = new Date(since).getTime();
    if (isNaN(ms)) die(`Invalid date for --since: ${since}`);
    w.add("s.time_updated >= ?", ms);
  }
  if (before) {
    const ms = new Date(before).getTime();
    if (isNaN(ms)) die(`Invalid date for --before: ${before}`);
    w.add("s.time_updated <= ?", ms);
  }

  const order = sortOrder(sort, {
    alias: "s",
    extraClauses: { title: "s.title ASC" },
  });

  const rows = db
    .query(
      `SELECT s.id, s.title, s.directory, s.project_id, s.parent_id,
              s.time_created, s.time_updated, s.time_archived, s.version,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as msg_count,
              p.worktree
       FROM session s
       LEFT JOIN project p ON s.project_id = p.id
       ${w.toSql()}
       ORDER BY ${order}
       LIMIT ?`,
    )
    .all(...w.params, limit) as any[];

  if (bool("json")) return void jsonOut(rows);
  table(
    [
      { key: "id", label: "ID", max: 32 },
      { key: "title", label: "Title", flex: true, min: 10 },
      { key: "directory", label: "Directory", flex: true, min: 10 },
      { key: "updated", label: "Updated", max: 12 },
      { key: "msgs", label: "Msgs", align: "right", max: 6 },
    ],
    rows.map((r: any) => ({
      id: r.id,
      title: r.title || "(untitled)",
      directory: r.directory || "",
      updated: ago(r.time_updated),
      msgs: String(r.msg_count),
    })),
    { footer: `${rows.length} session(s)`, emptyMsg: "No sessions found." },
  );
}

function cmdMessages(db: Database) {
  const sid = parsed.pos[0];
  if (!sid) die(`Usage: ${BIN} messages <sessionID> [options]`);

  const limit = num("limit", 20);
  const offset = num("offset", 0);
  const role = flag("role");
  const showParts = bool("parts");

  const w = new WhereBuilder();
  w.add("m.session_id = ?", sid);
  if (role) w.add("json_extract(m.data, '$.role') = ?", role);

  const rows = db
    .query(
      `SELECT m.id, m.data, m.time_created
       FROM message m
       ${w.toSql()}
       ORDER BY m.time_created ASC, m.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...w.params, limit, offset) as any[];

  if (bool("json")) {
    const data = showParts
      ? rows.map((r: any) => ({ ...r, parts: fetchParts(db, r.id) }))
      : rows;
    return void jsonOut(data);
  }

  // Prepare rows with parts for display
  const prepared = rows.map((r: any) => {
    const parts = fetchParts(db, r.id);
    return {
      ...r,
      parts,
      role: jsonField(r.data, "role"),
      preview: msgPreview(parts),
    };
  });

  table(
    [
      { key: "id", label: "ID", max: 32 },
      { key: "role", label: "Role", max: 10 },
      { key: "time", label: "Time", max: 20 },
      { key: "preview", label: "Preview", flex: true, min: 16 },
    ],
    prepared.map((r: any) => ({
      id: r.id,
      role: r.role,
      time: ts(r.time_created),
      preview: r.preview,
    })),
    { footer: `${rows.length} message(s)`, emptyMsg: "No messages found." },
  );

  if (showParts) {
    console.log();
    for (const r of prepared) {
      if (r.parts.length === 0) continue;
      console.log(ansi("1", `${r.id}`) + ansi("2", ` (${r.role})`));
      for (const p of r.parts) {
        console.log(
          `  ${ansi("36", pad(`[${jsonField(p.data, "type")}]`, 14))} ${trunc(partPreview(p.data), termWidth() - 18)}`,
        );
      }
      console.log();
    }
  }
}

function cmdParts(db: Database) {
  const sid = parsed.pos[0];
  const mid = flag("message");
  if (!sid && !mid)
    die(`Usage: ${BIN} parts <sessionID> [--message <messageID>] [options]`);

  const limit = num("limit", 50);
  const typeFilter = flag("type");

  const w = new WhereBuilder();
  if (sid) w.add("p.session_id = ?", sid);
  if (mid) w.add("p.message_id = ?", mid);
  if (typeFilter) w.add("json_extract(p.data, '$.type') = ?", typeFilter);

  const rows = db
    .query(
      `SELECT p.id, p.message_id, p.session_id, p.data, p.time_created
       FROM part p
       ${w.toSql()}
       ORDER BY p.time_created ASC, p.id ASC
       LIMIT ?`,
    )
    .all(...w.params, limit) as any[];

  if (bool("json")) return void jsonOut(rows);
  table(
    [
      { key: "id", label: "ID", max: 32 },
      { key: "type", label: "Type", max: 14 },
      { key: "message", label: "Message", max: 32 },
      { key: "preview", label: "Preview", flex: true, min: 16 },
    ],
    rows.map((r: any) => ({
      id: r.id,
      type: jsonField(r.data, "type"),
      message: r.message_id,
      preview: partPreview(r.data),
    })),
    { footer: `${rows.length} part(s)`, emptyMsg: "No parts found." },
  );
}

function cmdSearch(db: Database) {
  const query = parsed.pos[0];
  if (!query) die(`Usage: ${BIN} search <query> [options]`);

  const scope = flag("scope") || "all";
  const proj = flag("project");
  const sid = flag("session");
  const limit = num("limit", 20);
  const sort = flag("sort") || "updated";
  const width = num("width", 80);

  const order = sortOrder(sort, { alias: "s" });
  const pattern = `%${escapeLike(query)}%`;

  interface SearchResult {
    session: string;
    title: string;
    directory: string;
    match: string;
    preview: string;
    updated: number;
    created: number;
  }
  const results: SearchResult[] = [];

  /** Apply common project/session filters to a WhereBuilder. */
  function addScopeFilters(w: WhereBuilder): void {
    if (proj) w.add("s.project_id = ?", proj);
    if (sid) w.add("s.id = ?", sid);
  }

  // Title search
  if (scope === "all" || scope === "title") {
    const w = new WhereBuilder();
    w.add("s.title LIKE ? ESCAPE '\\'", pattern);
    addScopeFilters(w);

    const rows = db
      .query(
        `SELECT s.id, s.title, s.directory, s.time_updated, s.time_created
         FROM session s
         ${w.toSql()}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...w.params, limit) as any[];

    for (const r of rows) {
      results.push({
        session: r.id,
        title: r.title,
        directory: r.directory,
        match: "title",
        preview: r.title,
        updated: r.time_updated,
        created: r.time_created,
      });
    }
  }

  // Content search
  if (scope === "all" || scope === "content") {
    const w = new WhereBuilder();
    w.add("json_extract(p.data, '$.type') IN ('text', 'tool', 'reasoning')");
    w.add(
      `(json_extract(p.data, '$.content') LIKE ? ESCAPE '\\'
        OR json_extract(p.data, '$.text') LIKE ? ESCAPE '\\'
        OR json_extract(p.data, '$.state.output') LIKE ? ESCAPE '\\'
        OR json_extract(p.data, '$.state.input') LIKE ? ESCAPE '\\'
        OR json_extract(p.data, '$.state.title') LIKE ? ESCAPE '\\')`,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
    );
    addScopeFilters(w);

    const rows = db
      .query(
        `SELECT p.id as part_id, p.session_id, p.data as part_data, s.title, s.directory, s.time_updated, s.time_created
         FROM part p
         JOIN session s ON p.session_id = s.id
         ${w.toSql()}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...w.params, limit) as any[];

    const radius = 250;
    for (const r of rows) {
      const pv = partPreview(r.part_data);
      const idx = pv.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - radius);
      const end = Math.min(pv.length, idx + query.length + radius);
      const ctx =
        (start > 0 ? "…" : "") +
        pv.slice(start, end) +
        (end < pv.length ? "…" : "");
      results.push({
        session: r.session_id,
        title: r.title,
        directory: r.directory,
        match: "part",
        preview: ctx || pv.slice(0, 500),
        updated: r.time_updated,
        created: r.time_created,
      });
    }
  }

  // Sort merged results
  results.sort((a, b) =>
    sort === "created" ? b.created - a.created : b.updated - a.updated,
  );
  const final = results.slice(0, limit);

  if (bool("json")) return void jsonOut(final);
  if (final.length === 0) {
    console.log(`No results for "${query}".`);
    return;
  }

  const cardWidth = Math.min(width, termWidth());
  const cardInner = cardWidth - 4;
  for (const r of final) {
    // For title matches, the title is already shown — skip redundant preview
    const body =
      r.match === "title"
        ? []
        : wordWrap(r.preview, cardInner).map((line) => highlight(line, query));
    card({
      id: r.session,
      badge: r.match,
      title:
        r.match === "title"
          ? highlight(r.title || "(untitled)", query)
          : r.title || "(untitled)",
      subtitle: r.directory || undefined,
      body,
      width: cardWidth,
    });
    console.log();
  }
  console.log(`${final.length} result(s)`);
}

function cmdInspect(db: Database) {
  const sid = parsed.pos[0];
  if (!sid) die(`Usage: ${BIN} inspect <sessionID>`);

  const row = findSession(db, sid);
  if (!row) return;

  const msgStats = db
    .query(
      `SELECT json_extract(data, '$.role') as role, COUNT(*) as count
       FROM message WHERE session_id = ?
       GROUP BY role`,
    )
    .all(sid) as any[];

  const partStats = db
    .query(
      `SELECT json_extract(data, '$.type') as type, COUNT(*) as count
       FROM part WHERE session_id = ?
       GROUP BY type`,
    )
    .all(sid) as any[];

  const todos = db
    .query(
      `SELECT content, status, priority FROM todo
       WHERE session_id = ?
       ORDER BY position ASC`,
    )
    .all(sid) as any[];

  const children = db
    .query(
      `SELECT id, title, time_updated FROM session WHERE parent_id = ? ORDER BY time_created ASC`,
    )
    .all(sid) as any[];

  // Token/cost aggregation from message data
  let totalInput = 0;
  let totalOutput = 0;
  let totalCache = 0;
  let totalCost = 0;
  const msgs = db
    .query(`SELECT data FROM message WHERE session_id = ?`)
    .all(sid) as any[];
  for (const m of msgs) {
    try {
      const d = JSON.parse(m.data);
      if (d.tokens) {
        totalInput += d.tokens.input || 0;
        totalOutput += d.tokens.output || 0;
        totalCache += d.tokens.cache?.read || 0;
      }
      if (d.cost) totalCost += d.cost;
    } catch {}
  }

  if (bool("json"))
    return void jsonOut({
      session: row,
      messages: msgStats,
      parts: partStats,
      todos,
      children,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cache_read: totalCache,
      },
      cost: totalCost,
    });

  const totalMsgs = msgStats.reduce((s: number, r: any) => s + r.count, 0);
  const totalParts = partStats.reduce((s: number, r: any) => s + r.count, 0);
  const msgBreakdown = msgStats
    .map((r: any) => `${r.count} ${r.role}`)
    .join(", ");
  const partBreakdown = partStats
    .map((r: any) => `${r.count} ${r.type}`)
    .join(", ");

  heading("Session");
  kvBlock([
    ["ID", row.id],
    ["Title", row.title],
    ["Project", `${row.project_id}`],
    ["Worktree", row.worktree || "—"],
    ["Directory", row.directory],
    ["Created", ts(row.time_created)],
    ["Updated", ts(row.time_updated)],
    ["Archived", row.time_archived ? ts(row.time_archived) : "no"],
    ["Parent", row.parent_id || "—"],
    ["Version", row.version],
  ]);

  console.log();
  heading("Stats");
  const statPairs: Array<[string, string]> = [
    ["Messages", `${totalMsgs} (${msgBreakdown})`],
    ["Parts", `${totalParts} (${partBreakdown})`],
  ];
  if (totalInput || totalOutput) {
    statPairs.push([
      "Tokens",
      `${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out / ${totalCache.toLocaleString()} cache`,
    ]);
  }
  if (totalCost > 0) {
    statPairs.push(["Cost", `$${totalCost.toFixed(4)}`]);
  }
  kvBlock(statPairs);

  if (todos.length > 0) {
    console.log();
    heading(`Todos (${todos.length})`);
    const statusIcon = (s: string) =>
      s === "completed"
        ? ansi("32", "✓")
        : s === "in_progress"
          ? ansi("33", "●")
          : s === "cancelled"
            ? ansi("2", "✗")
            : "○";
    for (const t of todos) {
      console.log(
        `  ${statusIcon(t.status)} ${t.content}${t.priority === "high" ? ansi("31", " !") : ""}`,
      );
    }
  }

  if (children.length > 0) {
    console.log();
    heading(`Children (${children.length})`);
    table(
      [
        { key: "id", label: "ID", max: 32 },
        { key: "title", label: "Title", flex: true, min: 10 },
        { key: "updated", label: "Updated", max: 12 },
      ],
      children.map((c: any) => ({
        id: c.id,
        title: c.title || "(untitled)",
        updated: ago(c.time_updated),
      })),
    );
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function latestRootSession(
  db: Database,
  projectId: string,
  since?: number,
): any {
  const timeClause = since != null ? "AND time_updated >= ?" : "";
  const params = since != null ? [projectId, since] : [projectId];
  return db
    .query(
      `SELECT id, title, directory, time_updated
       FROM session
       WHERE project_id = ? AND parent_id IS NULL ${timeClause}
       ORDER BY time_updated DESC LIMIT 1`,
    )
    .get(...params);
}

function cmdLatest(db: Database) {
  const projFlag = flag("project");
  const inferred = inferProject();
  const proj = projFlag || inferred || "global";
  const projSource = projFlag
    ? "--project flag"
    : inferred
      ? "inferred from cwd"
      : "global (not in a git repo)";
  const cutoff = Date.now() - THIRTY_DAYS_MS;

  const tui = latestRootSession(db, proj, cutoff);
  const headless = latestRootSession(db, proj);

  const totalRoots = db
    .query(
      `SELECT COUNT(*) as count FROM session WHERE project_id = ? AND parent_id IS NULL`,
    )
    .get(proj) as CountRow;

  const excluded = db
    .query(
      `SELECT COUNT(*) as count FROM session
       WHERE project_id = ? AND parent_id IS NULL AND time_updated < ?`,
    )
    .get(proj, cutoff) as CountRow;

  if (bool("json"))
    return void jsonOut({
      project: proj,
      tui,
      headless,
      totalRoots: totalRoots.count,
      excludedBy30d: excluded.count,
    });

  heading("Project");
  kvBlock([
    ["ID", proj],
    ["Source", projSource],
  ]);

  console.log();
  heading("TUI mode (-c)");
  if (tui) {
    kvBlock([
      ["Session", tui.id],
      ["Title", tui.title],
      ["Updated", ts(tui.time_updated)],
      ["Directory", tui.directory],
    ]);
  } else {
    console.log(ansi("2", "  No session found (none updated in last 30 days)"));
  }

  console.log();
  heading("Headless mode (run -c)");
  if (headless) {
    const same = tui && headless.id === tui.id;
    if (same) {
      console.log(ansi("2", "  Same as TUI mode"));
    } else {
      kvBlock([
        ["Session", headless.id],
        ["Title", headless.title],
        ["Updated", ts(headless.time_updated)],
        ["Directory", headless.directory],
      ]);
    }
  } else {
    console.log(ansi("2", "  No session found"));
  }

  console.log();
  kvBlock([
    ["Root sessions", String(totalRoots.count)],
    ["Outside 30d window", String(excluded.count)],
  ]);
}

async function cmdLoad(db: Database) {
  const sid = parsed.pos[0];
  if (!sid) die(`Usage: ${BIN} load <sessionID> [--fork] [--dry-run]`);

  const row = findSession(db, sid);
  if (!row) return;

  const fork = bool("fork");
  const dry = bool("dry-run");

  const args = ["opencode", "--session", sid];
  if (fork) args.push("--fork");

  // Propagate DB path if non-default
  const dbPath = db.filename;
  const env: Record<string, string> = {};
  const defaultDb = path.join(dataDir(), "opencode.db");
  if (dbPath !== defaultDb) {
    env.OPENCODE_DB = dbPath;
  }

  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const cmdStr = `${envPrefix ? envPrefix + " " : ""}${args.join(" ")}`;

  if (dry) {
    kvBlock([
      ["Directory", row.directory],
      ["Command", cmdStr],
    ]);
    return;
  }

  console.log(`Opening session ${sid} in ${row.directory}...`);
  const proc = Bun.spawn(args, {
    cwd: row.directory,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}

function cmdHelp() {
  console.log(`${ansi("1", BIN)} — search and inspect the opencode database

${ansi("1", "Usage:")} ${BIN} <command> [options]

${ansi("1", "Commands:")}
  dbs                       List available DB files
  projects                  List all projects
  sessions                  List sessions
  messages <sessionID>      Show messages for a session
  parts <sessionID>         Show parts for a session
  search <query>            Search titles and content
  inspect <sessionID>       Detailed session info
  latest                    Show what -c would pick
  load <sessionID>          Open session in opencode

${ansi("1", "Global options:")}
  --db <path>               Path to SQLite DB
  --channel <name>          Channel for DB filename (local, latest, etc.)
  --json                    Output as JSON

Use --json with any command for machine-readable output.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv.slice(2));

// Flag accessors — close over the singleton parsed.flags
function flag(key: string): string | undefined {
  const v = parsed.flags[key];
  return typeof v === "string" ? v : undefined;
}
function bool(key: string): boolean {
  const v = parsed.flags[key];
  return v === true || v === "true";
}
function num(key: string, def: number): number {
  const v = flag(key);
  if (!v) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

async function main() {
  switch (parsed.cmd) {
    case "dbs":
      cmdDbs();
      break;
    case "projects":
      cmdProjects(openDb());
      break;
    case "sessions":
      cmdSessions(openDb());
      break;
    case "messages":
      cmdMessages(openDb());
      break;
    case "parts":
      cmdParts(openDb());
      break;
    case "search":
      cmdSearch(openDb());
      break;
    case "inspect":
      cmdInspect(openDb());
      break;
    case "latest":
      cmdLatest(openDb());
      break;
    case "load":
      await cmdLoad(openDb());
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      die(`Unknown command: ${parsed.cmd}\nRun with --help for usage.`);
  }
}

main().catch((e: any) => {
  if (e.message?.includes("database is locked")) {
    die("Database is locked. Close opencode first or use a different --db.");
  }
  if (e.code === "SQLITE_CANTOPEN") {
    die(`Cannot open database. Check path and permissions.`);
  }
  throw e;
});
