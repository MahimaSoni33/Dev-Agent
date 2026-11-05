// Installs the agent into a host that has no Claude-style plugin loader, by generating that host's files
// from the canonical ones (skills/, agents/, hooks/). Claude Code needs no install: use --plugin-dir.
//   node install.mjs --provider antigravity [--scope workspace|global] [--dest <workspace dir>]
// workspace (default): <dest or cwd>/.agents/{skills,agents,hooks.json}; global: ~/.gemini/config/{...}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANTIGRAVITY_AGENT_TOOLS } from "../providers/tools.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const HOOK_TOOLS = "run_command|view_file|write_to_file|replace_file_content|multi_replace_file_content|grep_search|list_dir|find_by_name";

const read = (...p) => fs.readFileSync(path.join(PLUGIN_DIR, ...p), "utf8").replace(/\r\n/g, "\n");
const posix = (p) => p.replace(/\\/g, "/");

function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("Missing frontmatter");
  const fields = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  return { fields, body: m[2] };
}

function write(file, text, written) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  written.push(file);
}

// Antigravity has no skill-directory variable, so the skill gets the plugin folder written in
function skillFor(pluginDir) {
  const { fields, body } = splitFrontmatter(read("skills", "solve-ticket", "SKILL.md"));
  const resolved = body.replace(/<!--plugin-->[\s\S]*?<!--\/plugin-->/, `\`${posix(pluginDir)}\``);
  return `---\nname: ${fields.name}\ndescription: ${fields.description}\n---\n${resolved}`;
}

// Claude tool list -> Antigravity tool names; a misspelt name can hang a subagent, so unknown tools throw
function agentFor(file) {
  const { fields, body } = splitFrontmatter(read("agents", file));
  const tools = [...new Set(fields.tools.split(",").flatMap((t) => {
    const mapped = ANTIGRAVITY_AGENT_TOOLS[t.trim()];
    if (!mapped) throw new Error(`No Antigravity tool for ${t.trim()} in agents/${file}`);
    return mapped;
  }))];
  return [
    "---",
    `name: ${fields.name}`,
    `description: ${fields.description}`,
    "tools:",
    ...tools.map((t) => `  - ${t}`),
    "subagent: true",
    "mainAgent: false",
    "model: inherit",
    "---",
    body,
  ].join("\n");
}

function mergeHooks(file, pluginDir, written, probe = false) {
  let hooks = {};
  try {
    hooks = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    // No hooks file yet, or an unreadable one that is replaced below only when empty
    if (fs.existsSync(file)) throw new Error(`${file} is not valid JSON; fix it or remove it, then run again`);
  }
  hooks["dev-agent"] = {
    PreToolUse: [
      {
        matcher: HOOK_TOOLS,
        hooks: [{ type: "command", command: `node "${posix(pluginDir)}/hooks/guard.mjs"`, timeout: 10 }],
      },
    ],
  };
  // Temporary: logs the raw events so the shape of Antigravity's session data can be read (hooks/dump.mjs)
  if (probe) {
    const dump = [{ hooks: [{ type: "command", command: `node "${posix(pluginDir)}/hooks/dump.mjs"`, timeout: 10 }] }];
    hooks["dev-agent-probe"] = { PostToolUse: dump, Stop: dump };
  } else {
    delete hooks["dev-agent-probe"];
  }
  write(file, `${JSON.stringify(hooks, null, 2)}\n`, written);
}

export function installAntigravity({ baseDir, pluginDir = PLUGIN_DIR, probe = false }) {
  const written = [];
  write(path.join(baseDir, "skills", "solve-ticket", "SKILL.md"), skillFor(pluginDir), written);
  for (const name of ["repo-builder", "repo-reviewer"]) {
    write(path.join(baseDir, "agents", name, "agent.md"), agentFor(`${name}.md`), written);
  }
  mergeHooks(path.join(baseDir, "hooks.json"), pluginDir, written, probe);
  return written;
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
    if (opts.provider !== "antigravity") throw new Error("Usage: install.mjs --provider antigravity [--scope workspace|global] [--dest <dir>] [--probe on]");
    const baseDir =
      opts.scope === "global"
        ? path.join(os.homedir(), ".gemini", "config")
        : path.join(path.resolve(opts.dest ?? process.cwd()), ".agents");
    for (const file of installAntigravity({ baseDir, probe: opts.probe === "on" })) console.log(`wrote ${file}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
