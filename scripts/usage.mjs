// Session usage report: what each provider session of a ticket used, read from runs/<ticket>/usage.json.
//   node usage.mjs show [--ticket KEY | --run-dir RUN]     sessions and totals of one ticket (default: _unassigned)
//   node usage.mjs history                                 one line per ticket that has usage
//   node usage.mjs credits --ticket KEY --session ID --credits 4.2 [--provider kiro]
//        records credits you read from Kiro's own display (IDE chat panel, `/usage`, the portal) for that session.
//        They are stored as "user-reported", never as measured.
// Tokens, credits and money are different units. They are listed apart and never converted or added together.
// Kiro does not report tokens, and Dev Agent has no remaining-credit figure to show, so it shows none.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addTotals, creditTotals, recordSession, runsDir, sessionUnit, ticketFolder } from "../providers/usage.mjs";
import { parseArgs } from "./runstate.mjs";

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const n = (x) => (typeof x === "number" ? x.toLocaleString("en-US") : "n/a");

export function loadUsage(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, "usage.json"), "utf8"));
  } catch {
    return null;
  }
}

const sessionTokens = (s) => Object.values(s.models ?? {}).reduce((a, t) => addTotals(a, { ...zero(), ...t }), zero());

export function creditText(c) {
  if (typeof c?.used !== "number") return "credits unavailable (Kiro did not expose them)";
  return `credits ${c.used} (${c.source === "measured" ? "measured" : c.source})`;
}

export function report(usage, label = usage?.ticket ?? "_unassigned") {
  const lines = [`Usage for ${label}`, "Tokens, credits and cost are different units and are never added together.", ""];
  const entries = Object.entries(usage?.sessions ?? {});
  if (!entries.length) return `${lines.join("\n")}No sessions recorded.\n`;
  const tokenSessions = entries.filter(([, s]) => sessionUnit(s) === "tokens");
  const creditSessions = entries.filter(([, s]) => sessionUnit(s) === "credits");

  if (tokenSessions.length) {
    lines.push("Tokens");
    let total = zero();
    for (const [id, s] of tokenSessions) {
      const t = sessionTokens(s);
      total = addTotals(total, t);
      const models = Object.keys(s.models ?? {}).join(", ") || "no model";
      lines.push(`  ${id}  ${s.repo ?? "?"}  ${s.source ?? "?"}  ${models}`);
      lines.push(`      output ${n(t.output)} · new input ${n(t.input + t.cacheWrite)} · cache read ${n(t.cacheRead)}`);
    }
    lines.push(`  total: output ${n(total.output)} · new input ${n(total.input + total.cacheWrite)} · cache read ${n(total.cacheRead)}`, "");
  }

  if (creditSessions.length) {
    lines.push("Credits (Kiro)");
    for (const [id, s] of creditSessions) {
      const derived = s.sessionIdSource === "derived" ? "  (session id derived: Kiro sent none)" : "";
      lines.push(`  ${id}  ${s.surface ?? "?"}  model ${s.model ?? "not reported"}  ${n(s.requests)} request(s)${derived}`);
      lines.push(`      ${creditText(s.credits)}`);
    }
    const t = creditTotals(usage);
    lines.push(`  total: measured ${n(t.measured)} · user-reported ${n(t.userReported)} · no figure for ${t.unavailableSessions} of ${t.sessions} session(s)`);
    if (t.unavailableSessions) lines.push("  The credit total is incomplete: read the missing sessions in Kiro and record them with `usage.mjs credits`.");
    lines.push("  Remaining credits: not shown (Dev Agent has no official source for it; see the Kiro portal or `/usage`)", "");
  }
  return `${lines.join("\n")}`;
}

// One line per ticket folder under the runs directory
export function history(dir = runsDir()) {
  let tickets = [];
  try {
    tickets = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return "No runs directory yet.\n";
  }
  const rows = [];
  for (const t of tickets) {
    const u = loadUsage(path.join(dir, t));
    if (!u) continue;
    const sessions = Object.values(u.sessions ?? {});
    const tok = sessions.filter((s) => sessionUnit(s) === "tokens").reduce((a, s) => addTotals(a, sessionTokens(s)), zero());
    const c = creditTotals(u);
    rows.push([t, String(sessions.length), n(tok.output), n(tok.input + tok.cacheWrite), c.sessions ? `${n(c.measured)} / ${n(c.userReported)} / ${c.unavailableSessions} n/a` : "-"]);
  }
  if (!rows.length) return "No usage recorded yet.\n";
  const lines = [["ticket", "sessions", "output tok", "new input tok", "kiro credits (measured / user-reported / n/a)"], ...rows];
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return `${lines.map((l) => l.map((x, i) => x.padEnd(widths[i])).join("  ")).join("\n")}\n`;
}

// Records credits a developer read from Kiro for an existing Kiro session
export function setUserCredits({ ticket, session, credits, provider = "kiro", dir = runsDir() }) {
  const value = Number(credits);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--credits must be a number of 0 or more, not "${credits}"`);
  const usage = loadUsage(ticketFolder(ticket, { dir }));
  const key = `${provider}:${session}`;
  const found = usage?.sessions?.[key];
  if (!found) {
    const known = Object.keys(usage?.sessions ?? {}).join(", ") || "none";
    throw new Error(`No session ${key} for ${ticket ?? "_unassigned"}. Sessions recorded: ${known}`);
  }
  if (sessionUnit(found) !== "credits") throw new Error(`${key} is measured in tokens, not credits`);
  const updated = {
    ...found,
    source: "user-reported",
    credits: { used: Math.round(value * 100) / 100, source: "user-reported", note: "typed in by the developer from Kiro's own display" },
  };
  return recordSession(updated, { dir });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd = "show", ...rest] = process.argv.slice(2);
    const o = parseArgs(rest);
    const str = (v) => (typeof v === "string" ? v : undefined);
    if (cmd === "show") {
      const folder = str(o["run-dir"]) ? path.resolve(o["run-dir"]) : ticketFolder(str(o.ticket));
      console.log(report(loadUsage(folder), str(o.ticket) ?? path.basename(folder)));
    } else if (cmd === "history") {
      console.log(history());
    } else if (cmd === "credits") {
      if (!str(o.session) || o.credits === undefined) throw new Error("Usage: usage.mjs credits --ticket KEY --session ID --credits 4.2 [--provider kiro]");
      const file = setUserCredits({ ticket: str(o.ticket), session: o.session, credits: o.credits, provider: str(o.provider) });
      console.log(`recorded as user-reported in ${file}`);
    } else {
      throw new Error("Usage: usage.mjs show|history|credits ...");
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
