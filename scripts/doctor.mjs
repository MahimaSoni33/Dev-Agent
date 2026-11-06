// Checks that this machine and workspace are ready to run dev-agent through Antigravity (IDE or CLI).
//   node doctor.mjs [--cwd <workspace dir>] [--json]
// Read-only: it installs nothing and writes nothing. Exit code 1 when a required check fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectAntigravity, defaultRun, globalDir, workspaceDir } from "../providers/antigravity.mjs";
import { resolveConfig } from "./config.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = 18;
const posix = (p) => p.replace(/\\/g, "/");

const CLI_INSTALL = {
  win32: "PowerShell: irm https://antigravity.google/cli/install.ps1 | iex",
  default: "Terminal: curl -fsSL https://antigravity.google/cli/install.sh | bash",
};

const check = (level, title, detail = "", fix = "") => ({ level, title, detail, fix });

function readJson(file, exists, readFile) {
  if (!exists(file)) return null;
  try {
    return JSON.parse(readFile(file).replace(/^﻿/, ""));
  } catch {
    return undefined; // present but unreadable
  }
}

// Is dev-agent installed in one scope (<workspace>/.agents or ~/.gemini/config)?
function installState(baseDir, pluginDir, { exists, readFile }) {
  const files = ["skills/solve-ticket/SKILL.md", "agents/repo-builder/agent.md", "agents/repo-reviewer/agent.md"];
  const missing = files.filter((f) => !exists(path.join(baseDir, f)));
  const hooks = readJson(path.join(baseDir, "hooks.json"), exists, readFile);
  const command = hooks?.["dev-agent"]?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "";
  const guardDir = /node "(.+)\/hooks\/guard\.mjs"/.exec(command)?.[1] ?? null;
  return {
    anyFile: missing.length < files.length,
    missing,
    hooksUnreadable: hooks === undefined,
    hasHook: Boolean(guardDir),
    guardDir,
    guardExists: guardDir ? exists(path.join(guardDir, "hooks", "guard.mjs")) : false,
    samePlugin: guardDir ? posix(path.resolve(guardDir)) === posix(path.resolve(pluginDir)) : false,
  };
}

function installChecks(label, baseDir, pluginDir, fs_, { required }) {
  const s = installState(baseDir, pluginDir, fs_);
  const fix = `node ${posix(pluginDir)}/scripts/install.mjs --provider antigravity${label === "Personal" ? " --scope global" : ` --dest "${posix(path.dirname(baseDir))}"`}`;
  if (!s.anyFile && !s.hasHook) {
    return [check(required ? "fail" : "info", `${label} install: dev-agent is not installed in ${baseDir}`, "", fix)];
  }
  const out = [];
  if (s.missing.length) out.push(check("fail", `${label} install is incomplete`, `missing: ${s.missing.join(", ")}`, fix));
  if (s.hooksUnreadable) out.push(check("fail", `${label} hooks.json is not valid JSON`, path.join(baseDir, "hooks.json"), "Fix or remove that file, then run the installer again"));
  else if (!s.hasHook) out.push(check("fail", `${label} install has no safety hook (hooks.json)`, "", fix));
  else if (!s.guardExists) out.push(check("fail", `${label} safety hook points at a folder that no longer exists`, s.guardDir, fix));
  else if (!s.samePlugin) out.push(check("warn", `${label} install was made from another dev-agent folder`, `${s.guardDir} (this one: ${posix(pluginDir)})`, `Run the installer again from this folder: ${fix}`));
  if (!out.length) out.push(check("ok", `${label} install is in place`, baseDir));
  return out;
}

// Looks only at server names, never at the values (they can hold tokens)
function jiraCheck(workspace, home, fs_) {
  const files = [path.join(workspaceDir(workspace), "mcp_config.json"), path.join(globalDir(home), "mcp_config.json")];
  for (const file of files) {
    const cfg = readJson(file, fs_.exists, fs_.readFile);
    const names = Object.keys(cfg?.mcpServers ?? {});
    const hit = names.find((n) => /atlassian|jira/i.test(n));
    if (hit) return check("ok", `Jira connection found in MCP config: "${hit}"`, file);
  }
  return check("warn", "No Jira / Atlassian MCP server found in the Antigravity MCP config", "Only needed to read tickets by key. Without it, give the task as plain text.", "Add it in Antigravity: IDE MCP Store or CLI /mcp. See the guide");
}

export function runDoctor({
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  run = defaultRun,
  exists = fs.existsSync,
  readFile = (f) => fs.readFileSync(f, "utf8"),
  pluginDir = PLUGIN_DIR,
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [];
  const fs_ = { exists, readFile };
  const workspace = path.resolve(cwd);

  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push(nodeMajor >= MIN_NODE ? check("ok", `Node.js ${nodeVersion}`) : check("fail", `Node.js ${nodeVersion} is too old (need ${MIN_NODE}+)`, "", "Install the current LTS from https://nodejs.org"));

  const git = run("git", ["--version"]);
  checks.push(git ? check("ok", git) : check("fail", "git was not found", "", "Install git from https://git-scm.com"));

  checks.push(
    exists(path.join(pluginDir, "hooks", "guard.mjs"))
      ? check("ok", `dev-agent folder: ${posix(pluginDir)}`)
      : check("fail", "This does not look like a complete dev-agent folder", pluginDir, "Clone the repository again"),
  );

  const ag = detectAntigravity({ platform, home, env, run, exists });
  if (ag.cli.found) {
    checks.push(
      ag.cli.meetsMinimum
        ? check("ok", `Antigravity CLI (agy) ${ag.cli.version}`, ag.cli.onPath ? "on PATH" : ag.cli.path)
        : check("warn", `Antigravity CLI (agy) ${ag.cli.version} is older than ${ag.cli.minimum}`, "", "Re-run the CLI install command (see the guide). Some guides also mention `agy update`: confirm with `agy --help`"),
    );
  } else {
    checks.push(check("info", "Antigravity CLI (agy) not found. Only needed if you want to use the CLI", "", platform === "win32" ? CLI_INSTALL.win32 : CLI_INSTALL.default));
  }
  for (const note of ag.notes) checks.push(check("warn", note));

  if (ag.ide.found) {
    const how = ag.ide.version ? `version ${ag.ide.version}` : "version: open Antigravity > About to read it";
    checks.push(check("ok", `Antigravity IDE found (${how})`, ag.ide.path ?? "launcher on PATH"));
  } else if (ag.ide.usedBefore) {
    checks.push(check("ok", "Antigravity IDE has been used on this machine", "No launcher or install folder was detected (the docs do not list them), so check Antigravity > About for the version"));
  } else {
    checks.push(check("info", "Antigravity IDE not detected. Only needed if you want to use the IDE", "Detection is best effort: the docs list no IDE install folders", "Download it from https://antigravity.google"));
  }
  if (!ag.cli.found && !ag.ide.found && !ag.ide.usedBefore) {
    checks.push(check("fail", "Neither the Antigravity CLI nor the IDE was detected", "", "Install one of them, then run this check again"));
  }

  checks.push(...installChecks("Workspace", workspaceDir(workspace), pluginDir, fs_, { required: false }));
  checks.push(...installChecks("Personal", globalDir(home), pluginDir, fs_, { required: false }));
  const ws = installState(workspaceDir(workspace), pluginDir, fs_);
  const gl = installState(globalDir(home), pluginDir, fs_);
  if (!ws.hasHook && !gl.hasHook) {
    checks.push(check("fail", "dev-agent is not installed for this workspace or for your account", "", `node ${posix(pluginDir)}/scripts/install.mjs --provider antigravity --dest "${posix(workspace)}"`));
  }

  try {
    const cfg = resolveConfig({ cwd: workspace });
    const missing = cfg.repos.filter((r) => !r.exists);
    const how = cfg.configFile ? `config: ${posix(cfg.configFile)}` : "no .dev-agent/config.json: using the folder (or the git repos directly inside it)";
    checks.push(
      missing.length
        ? check("fail", `Repo path not found: ${missing.map((r) => r.id).join(", ")}`, how, "Fix the paths in .dev-agent/config.json")
        : check("ok", `${cfg.repos.length} repo(s): ${cfg.repos.map((r) => `${r.id} [${r.stack.join("+") || "unknown stack"}]`).join(", ")}`, how),
    );
    const noVerify = cfg.repos.filter((r) => r.exists && !r.verify.length);
    if (noVerify.length) checks.push(check("info", `No verify commands detected for: ${noVerify.map((r) => r.id).join(", ")}`, "The builder will say what it could not check", "Add `verify` in .dev-agent/config.json"));
  } catch (err) {
    checks.push(check("fail", "Could not read the dev-agent config", err.message, "Fix .dev-agent/config.json"));
  }

  checks.push(jiraCheck(workspace, home, fs_));

  return { ok: !checks.some((c) => c.level === "fail"), checks, antigravity: ag };
}

const MARK = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]", info: "[info]" };

export function format(report) {
  const lines = [];
  for (const c of report.checks) {
    lines.push(`${MARK[c.level]} ${c.title}`);
    if (c.detail) lines.push(`        ${c.detail}`);
    if (c.fix && c.level !== "ok") lines.push(`        fix: ${c.fix}`);
  }
  lines.push("", report.ok ? "Ready. Open the workspace in Antigravity and start the skill (see docs/GETTING-STARTED.md)." : "Not ready: fix the [FAIL] items above, then run this check again.");
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`Bad argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const report = runDoctor({ cwd: typeof opts.cwd === "string" ? opts.cwd : process.cwd() });
    console.log(opts.json ? JSON.stringify(report, null, 2) : format(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
