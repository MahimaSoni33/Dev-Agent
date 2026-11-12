// Resolves the agent's config for the current workspace and profiles each repo.
//   node config.mjs [--config <file>] [--cwd <dir>]
// Lookup: --config, else .dev-agent/config.json in --cwd or a parent, else zero-config (cwd is the repo,
// or every git repo directly inside cwd). Prints one JSON object. Config values win over detected ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detectRepo } from "./detect.mjs";

const DEFAULTS = {
  tracker: { type: "jira", projectKey: null },
  rules: {
    baseBranch: null, // null: each repo's origin/HEAD
    branchPattern: "<Area>/<KEY>/<ShortFeatureName>",
    planGate: "auto", // "always": ask on every ticket; "auto": ask only when triage says a human is needed
    tier: "auto", // or simple | medium | complex to force one execution strategy
    models: {}, // optional role -> model alias (simple, medium, complex, reviewer); missing: every agent uses the host's model
    commitRequiresApproval: true,
    pushAllowed: false,
    askBeforeTrackerWrite: true,
  },
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
const isGitRepo = (dir) => fs.existsSync(path.join(dir, ".git"));
const expandHome = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function findConfig(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".dev-agent", "config.json");
    if (fs.existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}

// Without a config: the folder itself if it is a repo, else the git repos directly inside it
function discoverRepos(root) {
  if (isGitRepo(root)) return [{ id: path.basename(root), path: "." }];
  const children = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isGitRepo(path.join(root, d.name)))
    .map((d) => ({ id: d.name, path: d.name }));
  return children.length ? children : [{ id: path.basename(root), path: "." }];
}

// "<Area>/" disappears when a repo has no area prefix
const branchTemplate = (pattern, area) => (area ? pattern.replace("<Area>", area) : pattern.replace(/<Area>[/-]?/, ""));

export function resolveConfig({ cwd = process.cwd(), configPath } = {}) {
  cwd = path.resolve(cwd);
  const file = configPath ? path.resolve(configPath) : findConfig(cwd);
  const raw = file ? readJson(file) : {};
  // The config lives in <root>/.dev-agent/config.json, unless it was passed explicitly
  const root = file ? (path.basename(path.dirname(file)) === ".dev-agent" ? path.dirname(path.dirname(file)) : path.dirname(file)) : cwd;

  const rules = { ...DEFAULTS.rules, ...raw.rules, models: { ...DEFAULTS.rules.models, ...raw.rules?.models } };
  const project = raw.project ?? path.basename(root);
  const repoEntries = raw.repos?.length ? raw.repos : discoverRepos(root);

  const repos = repoEntries.map((entry) => {
    const abs = path.resolve(root, entry.path);
    const exists = fs.existsSync(abs);
    const detected = exists ? detectRepo(abs) : null;
    const pick = (key) => (entry[key]?.length ? entry[key] : detected?.[key] ?? []);
    return {
      ...entry,
      absPath: abs,
      exists,
      packageManager: entry.packageManager ?? detected?.packageManager ?? null,
      stack: detected?.stack ?? [],
      verify: pick("verify"),
      run: pick("run"),
      instructions: pick("instructions"),
      needsEnv: detected?.needsEnv ?? false,
      usesCompose: detected?.usesCompose ?? false,
      branchTemplate: branchTemplate(rules.branchPattern, entry.areaPrefix),
    };
  });

  return {
    configFile: file,
    root,
    project,
    tracker: { ...DEFAULTS.tracker, ...raw.tracker },
    rules,
    runsBase: path.resolve(root, expandHome(raw.runsDir ?? "~/.dev-agent/runs"), project),
    contextFiles: (raw.contextFiles ?? []).map((f) => path.resolve(root, f)),
    repos,
    buildOrder: raw.buildOrder?.length ? raw.buildOrder : [repos.map((r) => r.id)],
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`Bad argument: ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(resolveConfig({ cwd: opts.cwd, configPath: opts.config }), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
