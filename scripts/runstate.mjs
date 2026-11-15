// Durable run state: the file that lets a run be resumed and tells the conductor what to do next.
//   node runstate.mjs init  --run-dir RUN --key PROJ-1 [--project p --tier simple --mode in-place]
//   node runstate.mjs set   --run-dir RUN [--phase construction] [--tier t] [--gate plan=approved] [--unit U1=done]
//                           [--repo api.branch=feat/x] [--event "text"] [--units-from-artifacts]
//   node runstate.mjs show  --run-dir RUN
//   node runstate.mjs next  --run-dir RUN        prints the next action as JSON (never changes anything)
// Phases follow AI-DLC: inception -> construction -> operations -> done.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseUnits } from "./artifacts.mjs";

export const PHASES = ["inception", "construction", "operations", "done"];
const UNIT_STATUS = ["pending", "building", "verifying", "done", "blocked", "failed"];
const FILE = "state.json";

// `--k v` pairs; a repeated key becomes an array; a flag with no value is true
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`Bad argument: ${argv[i]}`);
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    const v = next === undefined || next.startsWith("--") ? true : (i++, next);
    opts[k] = k in opts ? [].concat(opts[k], v) : v;
  }
  return opts;
}

const statePath = (runDir) => path.join(runDir, FILE);
const now = () => new Date().toISOString();

// A half-written or foreign file reads as "no state": the run then starts over instead of crashing
export function loadState(runDir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(runDir), "utf8"));
    return s && s.version === 1 && s.key ? s : null;
  } catch {
    return null;
  }
}

// Temp file then rename, so a crash never leaves a torn state file
function save(runDir, state) {
  fs.mkdirSync(runDir, { recursive: true });
  state.updated = now();
  const tmp = `${statePath(runDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, statePath(runDir));
  return state;
}

export function initState(runDir, { key, project = "", tier = null, mode = "in-place" }) {
  if (!key) throw new Error("init needs --key");
  const old = loadState(runDir);
  if (old) return { ...old, resumed: true };
  return save(runDir, {
    version: 1, key, project, tier, mode, phase: "inception",
    gates: { plan: null, commit: null }, units: {}, repos: {}, shipped: false, feedback: 0,
    history: [{ at: now(), event: "run started" }],
  });
}

// patch: { phase, tier, gates: {plan}, units: {id: {status,...}}, repos: {id: {...}}, event, shipped }
export function patchState(runDir, patch) {
  const s = loadState(runDir);
  if (!s) throw new Error(`No run state in ${runDir}; run init first`);
  if (patch.phase !== undefined) {
    if (!PHASES.includes(patch.phase)) throw new Error(`Unknown phase: ${patch.phase}`);
    if (patch.phase !== s.phase) s.history.push({ at: now(), event: `phase ${s.phase} -> ${patch.phase}` });
    s.phase = patch.phase;
  }
  for (const k of ["tier", "mode", "shipped", "feedback"]) if (patch[k] !== undefined) s[k] = patch[k];
  Object.assign(s.gates, patch.gates ?? {});
  for (const [id, u] of Object.entries(patch.units ?? {})) {
    if (u.status && !UNIT_STATUS.includes(u.status)) throw new Error(`Unknown unit status: ${u.status}`);
    const was = s.units[id]?.status;
    s.units[id] = { ...s.units[id], ...u };
    if (u.status && u.status !== was) s.history.push({ at: now(), event: `${id} ${was ?? "new"} -> ${u.status}` });
  }
  for (const [id, r] of Object.entries(patch.repos ?? {})) s.repos[id] = { ...s.repos[id], ...r };
  if (patch.event) s.history.push({ at: now(), event: patch.event });
  s.history = s.history.slice(-100);
  return save(runDir, s);
}

// What the conductor does next. Reads state plus which artifacts exist; changes nothing.
export function nextAction(runDir) {
  const s = loadState(runDir);
  if (!s) return { action: "start", reason: "no run state" };
  const has = (f) => fs.existsSync(path.join(runDir, f));
  const base = { key: s.key, phase: s.phase };
  if (s.phase === "inception") {
    for (const [file, action] of [["intent.md", "write-intent"], ["acceptance.md", "write-acceptance"], ["units.md", "write-units"], ["plan.md", "write-plan"]]) {
      if (!has(file)) return { ...base, action, reason: `${file} is missing` };
    }
    return s.gates.plan ? { ...base, action: "build", reason: `plan gate: ${s.gates.plan}` } : { ...base, action: "plan-gate", reason: "plan not yet approved" };
  }
  if (s.phase === "construction") {
    const units = Object.entries(s.units).map(([id, u]) => ({ id, ...u }));
    if (!units.length) return { ...base, action: "write-units", reason: "no units in state" };
    const bad = units.filter((u) => u.status === "blocked" || u.status === "failed");
    if (bad.length) return { ...base, action: "blocked", units: bad.map((u) => u.id), reason: "a unit is blocked or failed; ask the developer" };
    // A crash can leave a unit mid-way: inspect its folder before building again
    const interrupted = units.filter((u) => u.status === "building" || u.status === "verifying");
    if (interrupted.length) return { ...base, action: "resume-units", units: interrupted.map((u) => u.id), reason: "interrupted mid-unit; check the repo folder, then continue or rebuild" };
    const done = new Set(units.filter((u) => u.status === "done").map((u) => u.id));
    const pending = units.filter((u) => u.status === "pending");
    if (pending.length) {
      const layer = Math.min(...pending.map((u) => u.layer ?? 0));
      // Only the lowest open layer, and only units whose dependencies are done, so layers keep their order
      const ready = pending.filter((u) => (u.layer ?? 0) === layer && (u.depends ?? []).every((d) => done.has(d)));
      if (ready.length) return { ...base, action: "build", units: ready.map((u) => u.id), reason: `layer ${layer}` };
      return { ...base, action: "blocked", units: pending.map((u) => u.id), reason: "no unit has all its dependencies done" };
    }
    if (!s.gates.commit) return { ...base, action: "commit-gate", reason: "all units done" };
    if (!has("summary.md")) return { ...base, action: "write-summary", reason: "summary.md is missing" };
    return { ...base, action: "ship", reason: "construction finished" };
  }
  if (s.phase === "operations") return has("release.md") ? { ...base, action: "close", reason: "release plan written" } : { ...base, action: "ship", reason: "no release plan yet" };
  return { ...base, action: "done", reason: "run is closed", feedback: s.feedback };
}

function applyCli(runDir, o) {
  const kv = (v, label) => [].concat(v ?? []).map((x) => {
    const i = String(x).indexOf("=");
    if (i < 1) throw new Error(`--${label} needs name=value, got: ${x}`);
    return [x.slice(0, i), x.slice(i + 1)];
  });
  const patch = { gates: {}, units: {}, repos: {} };
  for (const k of ["phase", "tier", "mode", "event"]) if (typeof o[k] === "string") patch[k] = o[k];
  for (const [g, v] of kv(o.gate, "gate")) patch.gates[g] = v;
  for (const [id, status] of kv(o.unit, "unit")) patch.units[id] = { status };
  for (const [path_, v] of kv(o.repo, "repo")) {
    const [id, field] = path_.split(".");
    if (!field) throw new Error(`--repo needs id.field=value, got: ${path_}`);
    (patch.repos[id] ??= {})[field] = v;
  }
  if (o["units-from-artifacts"]) {
    const text = fs.readFileSync(path.join(runDir, "units.md"), "utf8");
    for (const u of parseUnits(text)) patch.units[u.id] = { repo: u.repo, layer: u.layer, depends: u.depends, covers: u.covers, status: patch.units[u.id]?.status ?? loadState(runDir)?.units[u.id]?.status ?? "pending" };
  }
  return patchState(runDir, patch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    const o = parseArgs(rest);
    if (!o["run-dir"] || o["run-dir"] === true) throw new Error("Usage: runstate.mjs init|set|show|next --run-dir <dir> ...");
    const runDir = path.resolve(o["run-dir"]);
    const out = {
      init: () => initState(runDir, { key: o.key, project: o.project, tier: o.tier, mode: o.mode }),
      set: () => applyCli(runDir, o),
      show: () => loadState(runDir) ?? { error: "no run state" },
      next: () => nextAction(runDir),
    }[cmd];
    if (!out) throw new Error(`Unknown command: ${cmd}`);
    console.log(JSON.stringify(out(), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
