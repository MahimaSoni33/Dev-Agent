// Resolves the agent's config for the current workspace and profiles each repo.
//   node config.mjs [--config <file>] [--cwd <dir>] [--change-target in-place|worktree]
//                   [--save-change-target <value>] [--save-base <repoId>=<branch>]
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
    changeTarget: "in-place", // "in-place": edit the developer's own checkout on a new feature branch; "worktree": isolated git worktree
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

const CHANGE_TARGETS = ["in-place", "worktree"];

function checkChangeTarget(value, where) {
  if (!CHANGE_TARGETS.includes(value)) throw new Error(`${where} must be "in-place" or "worktree", not "${value}"`);
  return value;
}

// Order: --change-target flag, DEV_AGENT_CHANGE_TARGET, rules.changeTarget in the config, then the default
function pickChangeTarget({ flag, env, configured }) {
  if (flag) return { value: checkChangeTarget(flag, "--change-target"), source: "flag" };
  if (env) return { value: checkChangeTarget(env, "DEV_AGENT_CHANGE_TARGET"), source: "env" };
  if (configured) return { value: checkChangeTarget(configured, "rules.changeTarget"), source: "config" };
  return { value: DEFAULTS.rules.changeTarget, source: "default" };
}

export function resolveConfig({ cwd = process.cwd(), configPath, changeTarget, env = process.env } = {}) {
  cwd = path.resolve(cwd);
  const file = configPath ? path.resolve(configPath) : findConfig(cwd);
  const raw = file ? readJson(file) : {};
  // The config lives in <root>/.dev-agent/config.json, unless it was passed explicitly
  const root = file ? (path.basename(path.dirname(file)) === ".dev-agent" ? path.dirname(path.dirname(file)) : path.dirname(file)) : cwd;

  const target = pickChangeTarget({ flag: changeTarget, env: env.DEV_AGENT_CHANGE_TARGET, configured: raw.rules?.changeTarget });
  const rules = { ...DEFAULTS.rules, ...raw.rules, changeTarget: target.value, models: { ...DEFAULTS.rules.models, ...raw.rules?.models } };
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
      baseBranch: entry.baseBranch ?? rules.baseBranch ?? null, // the repo's own choice wins over the project-wide rule
    };
  });

  return {
    configFile: file,
    changeTarget: target.value,
    changeTargetSource: target.source, // "default" means nobody chose yet: the first interactive run asks and saves it
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

// Saves the developer's choice so they are not asked again. Creates .dev-agent/config.json when there is none.
function updateConfig({ root, configFile }, change) {
  const file = configFile ?? path.join(root, ".dev-agent", "config.json");
  const raw = fs.existsSync(file) ? readJson(file) : {};
  change(raw);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return file;
}

export function saveChangeTarget(cfg, value) {
  checkChangeTarget(value, "changeTarget");
  return updateConfig(cfg, (raw) => {
    raw.rules = { ...raw.rules, changeTarget: value };
  });
}

// Per repo when the config lists it, else the project-wide rules.baseBranch
export function saveBaseBranch(cfg, repoId, branch) {
  return updateConfig(cfg, (raw) => {
    const entry = raw.repos?.find((r) => r.id === repoId);
    if (entry) entry.baseBranch = branch;
    else raw.rules = { ...raw.rules, baseBranch: branch };
  });
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
    const resolve = () => resolveConfig({ cwd: opts.cwd, configPath: opts.config, changeTarget: opts["change-target"] });
    // --save-change-target <value> and --save-base <repoId>=<branch> remember a choice, then print the new config
    if (opts["save-change-target"] || opts["save-base"]) {
      const before = resolve();
      if (opts["save-change-target"]) console.error(`Saved to ${saveChangeTarget(before, opts["save-change-target"])}`);
      if (opts["save-base"]) {
        const [id, ...rest] = opts["save-base"].split("=");
        console.error(`Saved to ${saveBaseBranch(before, id, rest.join("="))}`);
      }
    }
    console.log(JSON.stringify(resolve(), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
