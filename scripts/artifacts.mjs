// Inception artifacts (acceptance.md, units.md) and the Construction proof (criteria coverage in each report).
//   node artifacts.mjs validate --run-dir RUN [--repos api,web]   checks acceptance.md and units.md agree
//   node artifacts.mjs coverage --run-dir RUN                      checks every criterion is covered by a report
//
// acceptance.md line:  - AC1 [clear|vague|missing|proposed] given X, when Y, then Z
// units.md line:       - U1 | repo=api | layer=0 | depends=- | covers=AC1,AC2 | files=a.js,b.js
// report.md section:   ## Criteria coverage     - AC1: covered|partial|not-covered|n/a - how (test or file)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const list = (v) => (!v || v === "-" ? [] : v.split(",").map((x) => x.trim()).filter(Boolean));

export function parseAcceptance(text) {
  return [...text.matchAll(/^[-*]\s*(AC\d+)\s*\[(clear|vague|missing|proposed)\]\s*(.+)$/gim)].map((m) => ({ id: m[1].toUpperCase(), mark: m[2].toLowerCase(), text: m[3].trim() }));
}

export function parseUnits(text) {
  const units = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[-*]\s*(U\d+)\s*\|(.*)$/i);
    if (!m) continue;
    const f = Object.fromEntries(m[2].split("|").map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")).trim().toLowerCase(), p.slice(p.indexOf("=") + 1).trim()]));
    units.push({ id: m[1].toUpperCase(), repo: f.repo ?? "", layer: Number.parseInt(f.layer ?? "0", 10) || 0, depends: list(f.depends).map((d) => d.toUpperCase()), covers: list(f.covers).map((c) => c.toUpperCase()), files: list(f.files) });
  }
  return units;
}

export function validate({ acceptance, units, repos = [] }) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  for (const a of acceptance) {
    if (ids.has(a.id)) errors.push(`Duplicate criterion ${a.id}`);
    ids.add(a.id);
    if (a.mark === "vague" || a.mark === "missing") errors.push(`${a.id} is ${a.mark}: ask the developer before planning or building`);
  }
  if (!acceptance.length) errors.push("acceptance.md has no criteria in the form `- AC1 [clear] ...`");
  if (!units.length) errors.push("units.md has no units in the form `- U1 | repo=... | covers=AC1`");
  const byId = new Map();
  for (const u of units) {
    if (byId.has(u.id)) errors.push(`Duplicate unit ${u.id}`);
    byId.set(u.id, u);
    if (!u.repo) errors.push(`${u.id} has no repo`);
    else if (repos.length && !repos.includes(u.repo)) errors.push(`${u.id} names unknown repo "${u.repo}"`);
    if (!u.covers.length) warnings.push(`${u.id} covers no criterion: does the ticket need it?`);
  }
  const covered = new Set();
  for (const u of units) {
    for (const c of u.covers) {
      if (!ids.has(c)) errors.push(`${u.id} covers unknown criterion ${c}`);
      covered.add(c);
    }
    for (const d of u.depends) {
      const dep = byId.get(d);
      if (!dep) errors.push(`${u.id} depends on unknown unit ${d}`);
      else if (dep.layer > u.layer) errors.push(`${u.id} (layer ${u.layer}) depends on ${d} in a later layer ${dep.layer}`);
    }
  }
  for (const a of acceptance) if (!covered.has(a.id)) errors.push(`${a.id} is covered by no unit`);
  // Cycle check: walk dependencies depth-first
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 2 || !byId.has(id)) return;
    if (state.get(id) === 1) return errors.push(`Dependency cycle: ${[...trail, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of byId.get(id).depends) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  return { ok: !errors.length, errors, warnings };
}

export function parseCoverage(report) {
  const start = report.search(/^##\s+Criteria coverage\s*$/im);
  if (start < 0) return null;
  const body = report.slice(start).split(/\r?\n/).slice(1);
  const end = body.findIndex((l) => /^##\s/.test(l));
  const rows = [...(end < 0 ? body : body.slice(0, end)).join("\n").matchAll(/^[-*]\s*(AC\d+)\s*:\s*(covered|partial|not-covered|n\/a)\b\s*[-–—:]?\s*(.*)$/gim)];
  return rows.map((m) => ({ id: m[1].toUpperCase(), status: m[2].toLowerCase(), how: m[3].trim() }));
}

// Best status per criterion across all repo reports. `covered` and `n/a` close a criterion; `partial` does not.
export function coverage({ acceptance, reports }) {
  const rank = { "not-covered": 0, partial: 1, "n/a": 2, covered: 3 };
  const best = new Map(acceptance.map((a) => [a.id, { id: a.id, status: "not-covered", how: "no report claims it", repo: null }]));
  const missingSection = [];
  for (const { repo, text } of reports) {
    const rows = parseCoverage(text);
    if (!rows) {
      missingSection.push(repo);
      continue;
    }
    for (const r of rows) {
      const cur = best.get(r.id);
      if (cur && rank[r.status] > rank[cur.status]) best.set(r.id, { ...r, repo });
    }
  }
  const rows = [...best.values()];
  const open = rows.filter((r) => r.status === "not-covered" || r.status === "partial");
  // Test-first evidence is a warning, not a blocker: some changes (docs, config) have no test to write first
  const noTestFirst = reports.filter((r) => !/^##\s+Test-first/im.test(r.text)).map((r) => r.repo);
  return { ok: !open.length && !missingSection.length, rows, open: open.map((r) => r.id), missingSection, noTestFirst };
}

const read = (f) => fs.readFileSync(f, "utf8");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    const o = {};
    for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, "")] = rest[i + 1];
    if (!o["run-dir"]) throw new Error("Usage: artifacts.mjs validate|coverage --run-dir <dir> [--repos a,b]");
    const dir = path.resolve(o["run-dir"]);
    const acceptance = parseAcceptance(read(path.join(dir, "acceptance.md")));
    let out;
    if (cmd === "validate") out = { ...validate({ acceptance, units: parseUnits(read(path.join(dir, "units.md"))), repos: list(o.repos) }), criteria: acceptance.length };
    else if (cmd === "coverage") {
      const reports = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "report.md"))).map((d) => ({ repo: d.name, text: read(path.join(dir, d.name, "report.md")) }));
      out = coverage({ acceptance, reports });
    } else throw new Error(`Unknown command: ${cmd}`);
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 2);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
