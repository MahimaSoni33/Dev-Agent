// Run scorecard: tokens, estimated cost and delivery quality of one run, from files the agent already writes.
//   node scorecard.mjs --run-dir RUN [--transcript s.jsonl ...] [--prices file] [--write]
//   node scorecard.mjs --table RUN1 RUN2 ...        one row per run, for comparing runs
// Reads RUN/usage.json (token hook) and RUN/state.json (units, history, follow-ups). Optional transcripts add LLM
// calls, tool calls, human stops and active time. Cost is an estimate from config/prices.json (USD per million
// tokens, matched by model-name substring); a model without a price is listed, never guessed.
// Kiro sessions are measured in credits, not tokens: they are reported apart and never priced or added to tokens.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transcriptMetrics } from "./metrics.mjs";
import { addTotals, creditTotals, sessionUnit } from "../providers/usage.mjs";
import { loadState, parseArgs } from "./runstate.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

export function loadPrices(file) {
  const p = readJson(file ?? path.join(PLUGIN_ROOT, "config", "prices.json"));
  return p && typeof p === "object" ? p : {};
}

export function tokensByModel(usage) {
  const models = {};
  for (const s of Object.values(usage?.sessions ?? {})) {
    for (const [m, t] of Object.entries(s.models ?? {})) models[m] = addTotals(models[m] ?? zero(), { ...zero(), ...t });
  }
  return models;
}

// prices: { "<model substring>": { input, output, cacheRead, cacheWrite } } in USD per 1M tokens
export function estimateCost(models, prices) {
  let usd = 0;
  const unpriced = [];
  const keys = Object.keys(prices).filter((k) => !k.startsWith("_"));
  for (const [model, t] of Object.entries(models)) {
    const key = keys.find((k) => model.includes(k));
    if (!key) {
      unpriced.push(model);
      continue;
    }
    const p = prices[key];
    usd += (t.input * (p.input ?? 0) + t.output * (p.output ?? 0) + t.cacheRead * (p.cacheRead ?? 0) + t.cacheWrite * (p.cacheWrite ?? 0)) / 1e6;
  }
  return { usd: keys.length ? Math.round(usd * 10000) / 10000 : null, unpriced: keys.length ? unpriced : [] };
}

// A unit that goes back to building after it was verifying, done, failed or blocked is rework: the agent
// correcting itself
export function reworkCount(state) {
  return (state?.history ?? []).filter((h) => /(verifying|done|failed|blocked) -> building$/.test(h.event)).length;
}

export function scorecard(runDir, { transcripts = [], prices = loadPrices() } = {}) {
  const usage = readJson(path.join(runDir, "usage.json"));
  const state = loadState(runDir);
  const models = tokensByModel(usage);
  const tokens = Object.values(models).reduce(addTotals, zero());
  const cacheBase = tokens.cacheRead + tokens.input + tokens.cacheWrite;
  const cost = estimateCost(models, prices);
  const units = Object.values(state?.units ?? {});
  const count = (s) => units.filter((u) => u.status === s).length;
  const done = count("done");
  const rework = reworkCount(state);
  const stamps = (state?.history ?? []).map((h) => Date.parse(h.at)).filter(Number.isFinite);
  const run = transcripts.length ? transcripts.map(transcriptMetrics) : null;
  const sum = (f) => run.reduce((a, r) => a + f(r), 0);
  const card = {
    key: state?.key ?? usage?.ticket ?? path.basename(runDir),
    tier: state?.tier ?? null,
    phase: state?.phase ?? null,
    tokens,
    cacheHitRatio: cacheBase ? Math.round((tokens.cacheRead / cacheBase) * 1000) / 1000 : null,
    models,
    sessions: Object.entries(usage?.sessions ?? {}).map(([id, s]) => ({
      id,
      repo: s.repo ?? null,
      source: s.source ?? null,
      unit: sessionUnit(s),
      surface: s.surface ?? null,
      requests: s.requests ?? null,
      credits: sessionUnit(s) === "credits" ? (s.credits ?? { used: null, source: "unavailable" }) : null,
      tokens: Object.values(s.models ?? {}).reduce((a, t) => addTotals(a, { ...zero(), ...t }), zero()),
    })),
    credits: creditTotals(usage),
    costUsd: cost.usd,
    unpricedModels: cost.unpriced,
    units: { total: units.length, done, failed: count("failed"), blocked: count("blocked") },
    reworkCycles: rework,
    followUps: state?.feedback ?? 0,
    shipped: Boolean(state?.shipped),
    // Clean = every unit done, no rework, no follow-up after release. Provisional until the run is shipped.
    firstPass: units.length > 0 && done === units.length && rework === 0 && (state?.feedback ?? 0) === 0,
    perUnit: done
      ? {
          outputTokens: Math.round(tokens.output / done),
          newInputTokens: Math.round((tokens.input + tokens.cacheWrite) / done),
          costUsd: cost.usd === null ? null : Math.round((cost.usd / done) * 10000) / 10000,
        }
      : null,
    runSeconds: stamps.length > 1 ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000) : null,
    transcript: run && {
      activeSeconds: sum((r) => r.activeSeconds),
      llmCalls: sum((r) => r.llmCalls),
      toolCalls: sum((r) => r.toolCalls),
      humanStops: sum((r) => r.humanStops),
    },
    notes: [],
  };
  if (!usage) card.notes.push("no usage.json: the usage hook has not recorded this run, so tokens and cost are empty");
  if (!state) card.notes.push("no state.json: delivery quality cannot be scored");
  if (cost.unpriced.length) card.notes.push(`no price for: ${cost.unpriced.join(", ")}; add it to config/prices.json`);
  if (card.costUsd === null && usage) card.notes.push("no prices configured: copy config/prices.example.json to config/prices.json for a cost estimate");
  if (card.units.failed || card.units.blocked) card.notes.push(`${card.units.failed} failed and ${card.units.blocked} blocked unit(s)`);
  if (card.credits.sessions) {
    card.notes.push("Kiro sessions are measured in credits, not tokens: they are not in the token totals or the cost estimate");
    if (card.credits.unavailableSessions) card.notes.push(`credits are unavailable for ${card.credits.unavailableSessions} Kiro session(s): Kiro did not expose them, so the credit total is incomplete`);
  }
  if (state && !state.shipped) card.notes.push("not shipped yet: first pass is provisional until the run is closed");
  return card;
}

const t0 = (s) => s.tokens;
const creditText = (c) => (typeof c?.used === "number" ? `credits ${c.used} (${c.source})` : "credits unavailable");
const n = (x) => (x === null || x === undefined ? "n/a" : x.toLocaleString("en-US"));
const pct = (r) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);

export function scorecardMarkdown(c) {
  const t = c.tokens;
  const rows = [
    `# Scorecard: ${c.key}`,
    "",
    `Tier: ${c.tier ?? "n/a"} · phase: ${c.phase ?? "n/a"} · shipped: ${c.shipped ? "yes" : "no"}`,
    "",
    "## Tokens and cost",
    `- Output: ${n(t.output)} · new input: ${n(t.input + t.cacheWrite)} · cache read: ${n(t.cacheRead)}`,
    `- Cache hit ratio: ${pct(c.cacheHitRatio)}`,
    `- Estimated cost: ${c.costUsd === null ? "n/a" : `$${c.costUsd}`} (estimate from config/prices.json)`,
    ...Object.entries(c.models).map(([m, x]) => `- ${m}: out ${n(x.output)}, new in ${n(x.input + x.cacheWrite)}, cache read ${n(x.cacheRead)}`),
    "",
    "## Per session",
    ...(c.sessions.length
      ? c.sessions.map((s) =>
          s.unit === "credits"
            ? `- ${s.id} (${s.repo ?? "?"}, kiro ${s.surface ?? "?"}): ${n(s.requests)} request(s), ${creditText(s.credits)}`
            : `- ${s.id} (${s.repo ?? "?"}, ${s.source ?? "?"}): out ${n(t0(s).output)}, new in ${n(t0(s).input + t0(s).cacheWrite)}, cache read ${n(t0(s).cacheRead)}`,
        )
      : ["- none recorded"]),
    ...(c.credits.sessions
      ? [
          "",
          "## Credits (Kiro)",
          `- Measured: ${n(c.credits.measured)} · user-reported: ${n(c.credits.userReported)} · sessions with no credit figure: ${c.credits.unavailableSessions} of ${c.credits.sessions}`,
          "- Credits are not tokens and not money; they are never converted into either",
        ]
      : []),
    "",
    "## Delivery quality",
    `- Units: ${c.units.done}/${c.units.total} done, ${c.units.failed} failed, ${c.units.blocked} blocked`,
    `- Rework cycles (unit sent back to building): ${c.reworkCycles}`,
    `- Follow-up tasks after release: ${c.followUps}`,
    `- First pass: ${c.firstPass ? "yes" : "no"}`,
    "",
    "## Efficiency",
    c.perUnit
      ? `- Per done unit: ${n(c.perUnit.outputTokens)} output tok, ${n(c.perUnit.newInputTokens)} new input tok, cost ${c.perUnit.costUsd === null ? "n/a" : `$${c.perUnit.costUsd}`}`
      : "- Per unit: n/a (no unit done)",
    `- Run duration (first to last recorded event): ${n(c.runSeconds)} s`,
  ];
  if (c.transcript) {
    rows.push(`- Transcript: ${n(c.transcript.activeSeconds)} s active, ${n(c.transcript.llmCalls)} LLM calls, ${n(c.transcript.toolCalls)} tool calls, ${n(c.transcript.humanStops)} human stops`);
  }
  if (c.notes.length) rows.push("", "## Notes", ...c.notes.map((x) => `- ${x}`));
  return `${rows.join("\n")}\n`;
}

export function scorecardTable(cards) {
  const cols = [
    ["run", (c) => c.key],
    ["tier", (c) => c.tier ?? "-"],
    ["output tok", (c) => n(c.tokens.output)],
    ["new input tok", (c) => n(c.tokens.input + c.tokens.cacheWrite)],
    ["cache hit", (c) => (c.cacheHitRatio === null ? "-" : pct(c.cacheHitRatio))],
    ["cost $", (c) => (c.costUsd === null ? "-" : String(c.costUsd))],
    ["kiro credits", (c) => (!c.credits.sessions ? "-" : c.credits.unavailableSessions === c.credits.sessions ? "n/a" : `${n(c.credits.measured + c.credits.userReported)}${c.credits.unavailableSessions ? "+" : ""}`)],
    ["units done", (c) => `${c.units.done}/${c.units.total}`],
    ["rework", (c) => String(c.reworkCycles)],
    ["follow-ups", (c) => String(c.followUps)],
    ["first pass", (c) => (c.firstPass ? "yes" : "no")],
  ];
  const lines = [cols.map(([h]) => h), ...cards.map((c) => cols.map(([, f]) => f(c)))];
  const widths = cols.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((x, i) => x.padStart(widths[i])).join("  ")).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "--table") {
      if (argv.length < 2) throw new Error("Usage: scorecard.mjs --table <run-dir> ...");
      console.log(scorecardTable(argv.slice(1).map((d) => scorecard(path.resolve(d)))));
    } else {
      const o = parseArgs(argv);
      if (!o["run-dir"] || o["run-dir"] === true) throw new Error("Usage: scorecard.mjs --run-dir <dir> [--transcript f.jsonl] [--prices file] [--write]");
      const runDir = path.resolve(o["run-dir"]);
      const card = scorecard(runDir, {
        transcripts: [].concat(o.transcript ?? []).filter((x) => typeof x === "string"),
        prices: loadPrices(typeof o.prices === "string" ? o.prices : undefined),
      });
      if (o.write) fs.writeFileSync(path.join(runDir, "scorecard.md"), scorecardMarkdown(card));
      console.log(o.write ? scorecardMarkdown(card) : JSON.stringify(card, null, 2));
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
