// Picks the execution strategy for a task without an LLM call: simple, medium or complex.
//   node triage.mjs [--config <file>] [--cwd <dir>] [--tier auto|simple|medium|complex] --text "<ticket text>"
//   (or pipe the text on stdin). Prints one JSON object: { tier, reasons, humanRequired, repos, strategy }.
// The signals are cheap and conservative: anything unclear moves UP a tier, never down. The conductor may raise the
// tier after reading code, but may not lower it below what a security or destructive signal set.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "./config.mjs";

const word = (list) => new RegExp(`\\b(?:${list.join("|")})\\b`, "i");

// Work that changes contracts, data or structure: always planned in full
const COMPLEX = word([
  "migrat\\w*", "schema", "database", "db", "endpoint", "api contract", "breaking", "refactor\\w*", "architecture",
  "redesign\\w*", "new service", "rewrite", "multi-?tenant", "queue", "websocket", "socket", "webhook", "cron",
]);
// Needs a human decision whatever the size: security, money, destructive operations
const SENSITIVE = word([
  "password", "secret", "token", "credential\\w*", "api key", "encrypt\\w*", "auth\\w*", "permission\\w*", "role\\w*",
  "payment\\w*", "billing", "invoice\\w*", "delet\\w*", "drop(?!down)\\w*", "purg\\w*", "truncat\\w*", "wip\\w*", "remove all", "cors", "csrf",
]);
// Local, visual or textual changes
const SMALL = word([
  "typo", "tooltip", "wording", "colou?r", "padding", "margin", "spacing", "icon", "hover", "placeholder",
  "badge", "pill", "alignment", "font", "label", "copy",
]);

function criteriaCount(text) {
  return (text.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? []).length;
}

// Repos the text points at, by id, area prefix or an `owns` phrase
function matchRepos(text, repos) {
  // Whole words only ("config" must not match "configured"); the area prefix is a branch label, not ownership
  const has = (term) => new RegExp(`(?<![\\w-])${String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text);
  return repos.filter((r) => [r.id, ...(r.owns ?? [])].filter(Boolean).some(has)).map((r) => r.id);
}

const STRATEGIES = {
  simple: {
    ticketReview: "brief", // five lines and the acceptance criteria; no ambiguity essay
    plan: "compact", // repo, files, approach, verify: one screen
    repoTriage: "owner-only", // do not inspect repos the text does not point at
    planGate: "auto", // show the plan and go on, unless something needs a human
    review: "diffcheck+agent", // script first (free), then the reviewer agent, in parallel with verify
    verify: "after-first", // run the checks after the change; baseline only for what fails
    fixRounds: 2,
  },
  medium: {
    ticketReview: "full",
    plan: "full",
    repoTriage: "hinted",
    planGate: "auto",
    review: "diffcheck+agent",
    verify: "cached-baseline",
    fixRounds: 1,
  },
  complex: {
    ticketReview: "full",
    plan: "full",
    repoTriage: "all",
    planGate: "ask",
    review: "diffcheck+agent",
    verify: "cached-baseline",
    fixRounds: 1,
  },
};

export function triage(text, config, { tier: forced = "auto" } = {}) {
  text = String(text ?? "");
  const repos = config?.repos ?? [];
  const reasons = [];
  const humanRequired = [];

  const sensitive = [...new Set((text.match(new RegExp(SENSITIVE.source, "gi")) ?? []).map((s) => s.toLowerCase()))];
  const complexHits = [...new Set((text.match(new RegExp(COMPLEX.source, "gi")) ?? []).map((s) => s.toLowerCase()))];
  const smallHit = SMALL.test(text);
  const named = matchRepos(text, repos);
  const criteria = criteriaCount(text);

  let tier = "medium";
  if (complexHits.length) reasons.push(`structural words: ${complexHits.join(", ")}`);
  if (named.length > 1) reasons.push(`names ${named.length} repos: ${named.join(", ")}`);
  if (text.length > 2500) reasons.push("long description");
  if (criteria > 6) reasons.push(`${criteria} list items / criteria`);

  if (complexHits.length || named.length > 1 || text.length > 2500 || criteria > 6) {
    tier = "complex";
  } else if (smallHit && text.length <= 1200 && criteria <= 5) {
    tier = "simple";
    reasons.push("local visual or textual change, short, few criteria");
  } else {
    reasons.push("no clear small or structural signal");
  }

  if (sensitive.length) {
    humanRequired.push(`security or destructive wording: ${sensitive.join(", ")}`);
    if (tier === "simple") tier = "medium"; // never fast-path a sensitive task
  }

  const mode = String(forced ?? "auto").toLowerCase();
  if (STRATEGIES[mode] && mode !== "auto") {
    reasons.push(`tier forced by config: ${mode}`);
    tier = mode;
  }

  const strategy = { ...STRATEGIES[tier] };
  // `rules.planGate: "always"` keeps the original behaviour for everyone who wants a gate on every ticket
  if (config?.rules?.planGate === "always") strategy.planGate = "ask";
  if (humanRequired.length) strategy.planGate = "ask";
  strategy.models = modelsFor(tier, config);

  return { tier, reasons, humanRequired, repos: named, strategy };
}

// `rules.models` maps roles to model aliases; null or missing means "inherit the host's model"
export function modelsFor(tier, config) {
  const m = config?.rules?.models ?? {};
  return { builder: m[tier] ?? null, reviewer: m.reviewer ?? null };
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`Bad argument: ${argv[i]}`);
      opts[argv[i].slice(2)] = argv[i + 1];
    }
    const config = resolveConfig({ cwd: opts.cwd, configPath: opts.config });
    const text = opts.text ?? readStdin();
    console.log(JSON.stringify(triage(text, config, { tier: opts.tier ?? config.rules.tier }), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
