// Token usage per session: parses a provider's session log and merges the result into runs/<ticket>/usage.json.
// Shape of one session: { provider, sessionId, repo, ticket, branch, cwd, source, models, updatedAt }
//   source: "measured" (read from the provider's own log) or "estimated"
//   models: { <model>: { input, output, cacheRead, cacheWrite } }
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
  const folder = path.join(dir, session.ticket ?? "_unassigned");
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
  return file;
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
