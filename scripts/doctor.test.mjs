import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installAntigravity, installKiro } from "./install.mjs";
import { format, runDoctor } from "./doctor.mjs";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-doctor-"));
const gitRepo = (dir) => fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
const levels = (r) => Object.fromEntries(r.checks.map((c) => [c.title.slice(0, 30), c.level]));
const find = (r, re) => r.checks.find((c) => re.test(c.title));

// A fake machine: git works, and `agy` answers with the given text (or is missing)
const machine = (agy) => (cmd) => (cmd === "git" ? "git version 2.40.0" : cmd === "agy" ? agy : null);

test("an empty workspace is not ready and says how to install", () => {
  const home = tmp();
  const ws = tmp();
  gitRepo(ws);
  const r = runDoctor({ cwd: ws, home, run: machine("agy version 2.0.0"), pluginDir: PLUGIN });
  assert.equal(r.ok, false);
  const fail = find(r, /not installed for this workspace/);
  assert.equal(fail.level, "fail");
  assert.match(fail.fix, /install\.mjs --provider antigravity --dest/);
});

test("a workspace install makes it ready", () => {
  const home = tmp();
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  const r = runDoctor({ cwd: ws, home, run: machine("agy version 2.0.0"), pluginDir: PLUGIN });
  assert.equal(r.ok, true, format(r));
  assert.equal(find(r, /Workspace install is in place/).level, "ok");
  assert.match(format(r), /^Ready\./m);
});

test("a global install counts for any workspace", () => {
  const home = tmp();
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(home, ".gemini", "config"), pluginDir: PLUGIN });
  const r = runDoctor({ cwd: ws, home, run: machine("agy 2.0.0"), pluginDir: PLUGIN });
  assert.equal(r.ok, true, format(r));
  assert.equal(find(r, /Personal install is in place/).level, "ok");
});

test("a hook that points at a folder that was moved is a failure", () => {
  const home = tmp();
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: path.join(os.tmpdir(), "gone", "dev-agent") });
  const r = runDoctor({ cwd: ws, home, run: machine("agy 2.0.0"), pluginDir: PLUGIN });
  assert.equal(r.ok, false);
  assert.equal(find(r, /no longer exists/).level, "fail");
});

test("an install made from another folder that still exists is only a warning", () => {
  const home = tmp();
  const ws = tmp();
  const other = tmp();
  fs.mkdirSync(path.join(other, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(other, "hooks", "guard.mjs"), "");
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: other });
  const r = runDoctor({ cwd: ws, home, run: machine("agy 2.0.0"), pluginDir: PLUGIN });
  assert.equal(find(r, /another dev-agent folder/).level, "warn");
  assert.equal(r.ok, true);
});

test("no Antigravity at all fails, and an old CLI only warns", () => {
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  // env points LOCALAPPDATA at an empty folder so a real Antigravity on this machine is not seen
  const env = { LOCALAPPDATA: tmp() };
  const none = runDoctor({ cwd: ws, home: tmp(), env, run: machine(null), pluginDir: PLUGIN });
  assert.equal(find(none, /Neither the Antigravity CLI nor the IDE/).level, "fail");

  const old = runDoctor({ cwd: ws, home: tmp(), env, run: machine("agy 1.0.0"), pluginDir: PLUGIN });
  assert.equal(find(old, /older than/).level, "warn");
  assert.match(find(old, /older than/).fix, /install command/);
});

test("a too old Node.js or a missing git is a failure", () => {
  const ws = tmp();
  gitRepo(ws);
  const r = runDoctor({ cwd: ws, home: tmp(), run: () => null, pluginDir: PLUGIN, nodeVersion: "16.20.0" });
  assert.equal(find(r, /Node\.js 16/).level, "fail");
  assert.equal(find(r, /git was not found/).level, "fail");
});

test("a config pointing at a missing repo is reported by name", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, ".dev-agent"));
  fs.writeFileSync(path.join(ws, ".dev-agent", "config.json"), JSON.stringify({ repos: [{ id: "api", path: "nope" }] }));
  const r = runDoctor({ cwd: ws, home: tmp(), run: machine("agy 2.0.0"), pluginDir: PLUGIN });
  assert.match(find(r, /Repo path not found/).title, /api/);
});

test("a Jira MCP server is recognised by name, and token values are never printed", () => {
  const home = tmp();
  const ws = tmp();
  gitRepo(ws);
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { atlassian: { serverUrl: "https://x", headers: { Authorization: "Bearer SECRET-TOKEN" } } } }));
  const r = runDoctor({ cwd: ws, home, run: machine("agy 2.0.0"), pluginDir: PLUGIN });
  assert.equal(find(r, /Jira connection found/).level, "ok");
  assert.doesNotMatch(JSON.stringify(r) + format(r), /SECRET-TOKEN/);
});

test("the report is stable on a different platform", () => {
  const ws = tmp();
  gitRepo(ws);
  const r = runDoctor({ cwd: ws, home: tmp(), platform: "darwin", run: machine(null), exists: (p) => fs.existsSync(p), pluginDir: PLUGIN });
  assert.match(find(r, /Antigravity CLI/).fix, /curl -fsSL .*install\.sh/);
  assert.ok(Object.keys(levels(r)).length > 5);
});

// ---- Kiro: optional checks, never a reason for "not ready" ----
const kiroMachine = (answers) => (cmd, args) => (cmd === "git" ? "git version 2.40.0" : cmd === "agy" ? "agy 2.0.0" : (answers[`${cmd} ${args[0]}`] ?? null));
const noLocal = () => ({ LOCALAPPDATA: tmp() }); // keeps a real Kiro on this machine out of the picture

test("without Kiro the report only gains an info line and stays ready", () => {
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  const r = runDoctor({ cwd: ws, home: tmp(), env: noLocal(), run: kiroMachine({}), pluginDir: PLUGIN, exists: (p) => fs.existsSync(p) });
  assert.equal(r.ok, true, format(r));
  assert.equal(find(r, /Kiro not detected/).level, "info");
});

test("Kiro CLI signed in with an install in place is ok", () => {
  const ws = tmp();
  const home = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  installKiro({ baseDir: path.join(ws, ".kiro"), pluginDir: PLUGIN });
  const run = kiroMachine({ "kiro-cli --version": "kiro-cli 2.1.0", "kiro-cli whoami": "Logged in as someone" });
  const r = runDoctor({ cwd: ws, home, env: noLocal(), run, pluginDir: PLUGIN });
  assert.equal(find(r, /Kiro CLI 2\.1\.0/).level, "ok");
  assert.equal(find(r, /Kiro CLI is signed in/).level, "ok");
  assert.equal(find(r, /Kiro workspace install is in place/).level, "ok");
});

test("Kiro CLI that is not signed in is a warning with the fix, and an API key is never printed", () => {
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  const run = kiroMachine({ "kiro-cli --version": "kiro-cli 2.0.0" });
  const noAuth = runDoctor({ cwd: ws, home: tmp(), env: noLocal(), run, pluginDir: PLUGIN });
  assert.equal(find(noAuth, /not signed in/).level, "warn");
  assert.match(find(noAuth, /not signed in/).fix, /kiro-cli login/);
  assert.equal(noAuth.ok, true);

  const withKey = runDoctor({ cwd: ws, home: tmp(), env: { ...noLocal(), KIRO_API_KEY: "ksk_TOPSECRET" }, run, pluginDir: PLUGIN });
  assert.match(find(withKey, /KIRO_API_KEY is set/).title, /value not shown/);
  assert.doesNotMatch(JSON.stringify(withKey) + format(withKey), /TOPSECRET/);
});

test("a partial or stale Kiro install warns without failing the report", () => {
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  installKiro({ baseDir: path.join(ws, ".kiro"), pluginDir: PLUGIN });
  fs.rmSync(path.join(ws, ".kiro", "agents", "repo-reviewer.json"));
  const run = kiroMachine({ "kiro-cli --version": "kiro-cli 2.0.0", "kiro-cli whoami": "ok" });
  const r = runDoctor({ cwd: ws, home: tmp(), env: noLocal(), run, pluginDir: PLUGIN });
  assert.equal(find(r, /Kiro workspace install is incomplete/).level, "warn");
  assert.equal(r.ok, true);
});

test("a Kiro CLI older than 2.0 is a warning", () => {
  const ws = tmp();
  gitRepo(ws);
  installAntigravity({ baseDir: path.join(ws, ".agents"), pluginDir: PLUGIN });
  const r = runDoctor({ cwd: ws, home: tmp(), env: noLocal(), run: kiroMachine({ "kiro-cli --version": "kiro-cli 1.9.0" }), pluginDir: PLUGIN });
  assert.equal(find(r, /Kiro CLI 1\.9\.0 is older/).level, "warn");
});
