// Token usage per session: parses a provider's session log and merges the result into runs/<ticket>/usage.json.
// Shape of one session: { provider, sessionId, repo, ticket, branch, cwd, source, models, updatedAt }
//   source: "measured" (read from the provider's own log) or "estimated"
//   models: { <model>: { input, output, cacheRead, cacheWrite } }
// Kiro sessions add unit: "credits", surface, requests and credits (see "Units" below); their `models` stays empty.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TICKET = /[A-Z][A-Z0-9]+-\d+/;

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addTotals(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

// Every transcript line that is valid JSON; a half-written last line or a foreign line is skipped
function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return lines;
}

// Claude Code keeps subagent logs next to the session log: <session>.jsonl and <session>/subagents/agent-*.jsonl
export function claudeLogFiles(transcriptPath) {
  const files = [transcriptPath];
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) if (/\.jsonl$/.test(name)) files.push(path.join(dir, name));
  }
  return files;
}

// A response is streamed into several lines that share a message id; the last one carries the final usage
export function parseClaudeTranscript(transcriptPath) {
  const byId = new Map();
  let branch = null;
  let cwd = null;
  let sessionId = null;
  for (const file of claudeLogFiles(transcriptPath)) {
    for (const line of readJsonl(file)) {
      if (file === transcriptPath) {
        branch = line.gitBranch ?? branch;
        cwd = line.cwd ?? cwd;
        sessionId = line.sessionId ?? sessionId;
      }
      const msg = line.type === "assistant" ? line.message : null;
      if (!msg?.usage) continue;
      byId.set(msg.id ?? `${file}:${byId.size}`, msg);
    }
  }
  const models = {};
  for (const msg of byId.values()) {
    const u = msg.usage;
    const model = msg.model ?? "unknown";
    if (model === "<synthetic>") continue;
    models[model] = addTotals(models[model] ?? emptyTotals(), {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }
  return { sessionId, branch, cwd, models };
}

export function ticketFrom(...candidates) {
  for (const c of candidates) {
    const m = typeof c === "string" ? c.match(TICKET) : null;
    if (m) return m[0];
  }
  return null;
}

// The main repo's folder name, also from inside one of its worktrees
export function repoName(cwd) {
  if (!cwd) return "unknown";
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (res.status !== 0) return path.basename(cwd);
  return path.basename(path.dirname(res.stdout.trim()));
}

export function runsDir(env = process.env) {
  return env.DEV_AGENT_RUNS_DIR ?? path.join(PLUGIN_ROOT, "runs");
}

// One file per ticket holding every session that worked on it. A session is replaced, never added to, because
// its totals are cumulative.
export function recordSession(session, { dir = runsDir() } = {}) {
  const folder = ticketFolder(session.ticket, { dir });
  const file = path.join(folder, "usage.json");
  let doc = { ticket: session.ticket ?? null, sessions: {} };
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // first write, or an unreadable file that is replaced
  }
  doc.sessions[`${session.provider}:${session.sessionId}`] = { ...session, updatedAt: new Date().toISOString() };
  fs.mkdirSync(folder, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
  appendUsageLog(session, { dir });
  return file;
}

// ---- Units. Tokens, credits and money are different things and are never converted into each other. ----
// A session without `unit` is a token session (every record written before Kiro support). A Kiro session has
// unit "credits": { used: number | null, source: "measured" | "user-reported" | "unavailable", note }.
//   measured:      read from an official Kiro output
//   user-reported: typed in by the developer from Kiro's own display (scripts/usage.mjs credits ...)
//   unavailable:   Kiro did not expose it; used is null, never 0
export const sessionUnit = (s) => s?.unit ?? "tokens";

export const UNAVAILABLE_NOTE = "Kiro does not expose credits to hooks; read them in the Kiro IDE chat panel, `/usage` or the Kiro portal";

export function ticketFolder(ticket, { dir = runsDir() } = {}) {
  return path.join(dir, ticket ?? "_unassigned");
}

export function readSession(provider, sessionId, ticket, { dir = runsDir() } = {}) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ticketFolder(ticket, { dir }), "usage.json"), "utf8"));
    return doc.sessions?.[`${provider}:${sessionId}`] ?? null;
  } catch {
    return null;
  }
}

// Append-only audit trail next to usage.json: one JSON line per recorded update. Never throws.
export function appendUsageLog(session, { dir = runsDir(), event = "update" } = {}) {
  try {
    const folder = ticketFolder(session.ticket, { dir });
    fs.mkdirSync(folder, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      event,
      provider: session.provider,
      surface: session.surface ?? null,
      sessionId: session.sessionId,
      ticket: session.ticket ?? null,
      unit: sessionUnit(session),
      source: session.source ?? null,
      model: session.model ?? null,
      requests: session.requests ?? null,
      credits: session.credits ?? null,
      models: session.models ?? {},
    };
    fs.appendFileSync(path.join(folder, "usage.log.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    // the log is a debugging aid; it must never break a run
  }
}

// Credit totals for one usage.json document. Measured, user-reported and unavailable stay apart.
export function creditTotals(usage) {
  const t = { measured: 0, userReported: 0, unavailableSessions: 0, sessions: 0 };
  for (const s of Object.values(usage?.sessions ?? {})) {
    if (sessionUnit(s) !== "credits") continue;
    t.sessions++;
    const c = s.credits;
    if (typeof c?.used !== "number") t.unavailableSessions++;
    else if (c.source === "user-reported") t.userReported += c.used;
    else t.measured += c.used;
  }
  t.measured = Math.round(t.measured * 100) / 100;
  t.userReported = Math.round(t.userReported * 100) / 100;
  return t;
}

// One line for a credit session, e.g. "kiro ide, session k1: 3 request(s), credits unavailable (...)". Wording
// follows `source`: only measured credits are plain, the others say where the number came from.
export function creditLine(s) {
  const head = `${s.provider}${s.surface ? ` ${s.surface}` : ""}, session ${s.sessionId}${s.sessionIdSource === "derived" ? " (derived id)" : ""}: ${s.requests ?? 0} request(s)`;
  const c = s.credits;
  if (typeof c?.used !== "number") return `${head}, credits unavailable (not exposed by Kiro; tokens are not reported either)`;
  return `${head}, credits ${c.used}${c.source === "measured" ? " (measured)" : ` (${c.source})`}`;
}

export function gitBranch(cwd) {
  if (!cwd) return null;
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() || null : null;
}

// Kiro hook event in, session record out. `surface` ("cli" | "ide") comes from the hook command, not the payload.
// `previous` is the stored record of the same session: its request count, start time and any credits are kept.
// A payload without a session id gets a derived one (surface, folder, day), flagged so reports can say so.
export function sessionFromKiroEvent(event, { surface = "cli", branch = null, previous = null, now = new Date() } = {}) {
  const cwd = event.cwd ?? previous?.cwd ?? null;
  const given = event.session_id ?? event.sessionId ?? null;
  const day = now.toISOString().slice(0, 10);
  const sessionId = given ?? previous?.sessionId ?? `${surface}-${path.basename(cwd ?? "unknown")}-${day}`;
  const prevCredits = previous?.credits;
  const keep = typeof prevCredits?.used === "number";
  return {
    provider: "kiro",
    surface,
    sessionId,
    sessionIdSource: given ? "kiro" : "derived",
    repo: repoName(cwd),
    ticket: ticketFrom(branch, cwd),
    branch,
    cwd,
    unit: "credits",
    source: keep ? prevCredits.source : "unavailable",
    model: typeof event.model === "string" ? event.model : (previous?.model ?? null),
    requests: (previous?.requests ?? 0) + 1,
    startedAt: previous?.startedAt ?? now.toISOString(),
    credits: keep ? prevCredits : { used: null, source: "unavailable", note: UNAVAILABLE_NOTE },
    models: {},
  };
}

// Hook event in, session record out. Returns null when the event has nothing to read.
export function sessionFromClaudeEvent(event) {
  if (!event.transcript_path) return null;
  const parsed = parseClaudeTranscript(event.transcript_path);
  const cwd = event.cwd ?? parsed.cwd;
  return {
    provider: "claude",
    sessionId: event.session_id ?? parsed.sessionId,
    repo: repoName(cwd),
    ticket: ticketFrom(parsed.branch, cwd),
    branch: parsed.branch,
    cwd,
    source: "measured",
    models: parsed.models,
  };
}
