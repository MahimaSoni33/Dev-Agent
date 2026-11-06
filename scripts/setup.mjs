// Guided setup for running dev-agent through Antigravity (IDE or CLI), on Windows, macOS and Linux.
//   node setup.mjs [--dest <workspace dir>] [--scope workspace|global] [--yes]
// Steps: check the machine, install the skill, subagents and safety hook, optionally write a starter
// config for repos nested deeper than one level, then re-check and print what to type next.
// It never overwrites a file without keeping a .bak copy, never writes secrets, and asks before each change.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globalDir, workspaceDir } from "../providers/antigravity.mjs";
import { format, runDoctor } from "./doctor.mjs";
import { installAntigravity } from "./install.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", ".agents", ".dev-agent", "dist", "build", ".venv", "venv", "__pycache__"]);
const posix = (p) => p.replace(/\\/g, "/");
const isRepo = (dir) => fs.existsSync(path.join(dir, ".git"));

// Git repos under root, up to maxDepth folders down. A repo is not searched inside.
export function scanRepos(root, maxDepth = 3) {
  root = path.resolve(root);
  if (isRepo(root)) return [{ id: path.basename(root), path: "." }];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (isRepo(abs)) found.push(posix(path.relative(root, abs)));
      else walk(abs, depth + 1);
    }
  };
  walk(root, 1);
  const seen = new Set();
  return found.map((p) => {
    let id = path.basename(p);
    for (let i = 2; seen.has(id); i++) id = `${path.basename(p)}-${i}`;
    seen.add(id);
    return { id, path: p };
  });
}

// What zero-config would pick: the folder itself, or the git repos directly inside it
const directRepos = (root) => scanRepos(root, 1);

export function scaffoldConfig(root, repos) {
  return `${JSON.stringify({ project: path.basename(path.resolve(root)), tracker: { type: "jira", projectKey: null }, repos }, null, 2)}\n`;
}

export const AGENTS_TEMPLATE = `# Project guide for coding agents

Fill in what an agent needs to change this project safely. Delete what does not apply.

## Commands
- Install:
- Run:
- Test:
- Lint / build:

## Conventions
- Folder layout:
- Naming:
- Things not to touch:
`;

// The terminal is only opened on the first question, so a run that asks nothing never holds stdin
function makePrompter({ yes }) {
  if (yes) return { ask: async (_q, def) => def, close() {} };
  let rl = null;
  return {
    ask: async (q, def) => {
      rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`${q} `)).trim().toLowerCase();
      return answer === "" ? def : answer;
    },
    close: () => rl?.close(),
  };
}

const yesNo = (answer) => ["y", "yes"].includes(answer);

export async function setup({ dest = process.cwd(), scope = "workspace", yes = false, prompter = makePrompter({ yes }), log = console.log, doctor = runDoctor } = {}) {
  const workspace = path.resolve(dest);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`Folder not found: ${workspace}`);
  if (!["workspace", "global"].includes(scope)) throw new Error(`--scope must be workspace or global, not "${scope}"`);

  log("Step 1 of 4: checking this machine");
  const before = doctor({ cwd: workspace });
  const blocking = before.checks.filter((c) => c.level === "fail" && /Node\.js|git was not found|dev-agent folder|Neither the Antigravity/.test(c.title));
  for (const c of blocking) log(`  [FAIL] ${c.title}${c.fix ? `\n         fix: ${c.fix}` : ""}`);
  if (blocking.length) throw new Error("Fix the items above first, then run setup again.");
  log("  Node, git and Antigravity are in place.");

  log(`\nStep 2 of 4: install dev-agent into Antigravity (${scope === "global" ? "all your workspaces" : workspace})`);
  const baseDir = scope === "global" ? globalDir() : workspaceDir(workspace);
  log(`  It writes the solve-ticket skill, the repo-builder and repo-reviewer agents and a safety hook into:\n  ${baseDir}`);
  log("  Your other hooks are kept. A file that dev-agent did not write is saved as .bak before it is replaced.");
  if (!yesNo(await prompter.ask("  Install now? [Y/n]", "y"))) {
    log("  Skipped. Nothing was changed.");
    return { installed: false };
  }
  for (const file of installAntigravity({ baseDir, pluginDir: PLUGIN_DIR })) log(`  wrote ${file}`);

  log("\nStep 3 of 4: workspace");
  const configFile = path.join(workspace, ".dev-agent", "config.json");
  if (fs.existsSync(configFile)) {
    log(`  Found ${posix(configFile)}. Left as it is.`);
  } else {
    const deep = scanRepos(workspace, 3);
    const direct = directRepos(workspace);
    if (!deep.length) {
      log("  No git repository found here or up to 3 folders down.");
      if (yesNo(await prompter.ask("  Run `git init` in this folder? [y/N]", "n"))) {
        const res = spawnSync("git", ["init"], { cwd: workspace, encoding: "utf8" });
        log(res.status === 0 ? "  git initialised." : `  git init failed: ${res.stderr.trim()}`);
      }
    } else if (deep.length !== direct.length) {
      log(`  Found ${deep.length} repos, some deeper than one folder down (dev-agent only looks one level down without a config):`);
      for (const r of deep) log(`    ${r.id}  ->  ${r.path}`);
      if (yesNo(await prompter.ask("  Write a starter .dev-agent/config.json for them? [Y/n]", "y"))) {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, scaffoldConfig(workspace, deep), { flag: "wx" });
        log(`  wrote ${posix(configFile)}. Add buildOrder, owns and verify later if you need them.`);
      }
    } else {
      log(`  ${deep.length} repo(s) found. dev-agent finds them without a config file.`);
    }
    const root = path.join(workspace, "AGENTS.md");
    if (isRepo(workspace) && !["AGENTS.md", "CLAUDE.md", "GEMINI.md"].some((f) => fs.existsSync(path.join(workspace, f)))) {
      log("  This repo has no AGENTS.md. It tells the agent your commands and conventions, and is optional.");
      if (yesNo(await prompter.ask("  Create a blank AGENTS.md template? [y/N]", "n"))) {
        fs.writeFileSync(root, AGENTS_TEMPLATE, { flag: "wx" });
        log(`  wrote ${posix(root)}`);
      }
    }
  }

  log("\nStep 4 of 4: final check");
  const after = doctor({ cwd: workspace });
  log(format(after));

  log(`
Next, in the Antigravity IDE: open ${posix(workspace)}, then in the agent chat type:
    Use the solve-ticket skill for PROJ-123          (or describe the task in plain words)
In the Antigravity CLI, from that folder:
    agy
    /solve-ticket PROJ-123
Credentials: dev-agent needs no API key. Sign in to Antigravity itself (IDE: first launch; CLI: run \`agy\` once
interactively). To read Jira tickets by key, connect the Atlassian MCP server inside Antigravity (see the guide).`);
  return { installed: true, ok: after.ok };
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
  const opts = parseArgs(process.argv.slice(2));
  const yes = opts.yes === true || opts.yes === "on";
  if (!yes && !process.stdin.isTTY) {
    console.error("Not running in a terminal. Run it in one, or pass --yes to accept the defaults.");
    process.exit(1);
  }
  const prompter = makePrompter({ yes });
  try {
    const res = await setup({ dest: typeof opts.dest === "string" ? opts.dest : process.cwd(), scope: opts.scope ?? "workspace", yes, prompter });
    prompter.close();
    process.exit(res.installed === false || res.ok ? 0 : 1);
  } catch (err) {
    prompter.close();
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}
