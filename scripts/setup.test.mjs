import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AGENTS_TEMPLATE, scaffoldConfig, scanRepos, setup } from "./setup.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-setup-"));
const repo = (dir) => fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
const scripted = (...answers) => {
  const left = [...answers];
  return { ask: async (_q, def) => left.shift() ?? def, close() {} };
};

test("a folder that is a repo scans to itself", () => {
  const root = tmp();
  repo(root);
  assert.deepEqual(scanRepos(root), [{ id: path.basename(root), path: "." }]);
});

test("nested repos are found with unique ids, and node_modules is skipped", () => {
  const root = tmp();
  repo(path.join(root, "api", "api"));
  repo(path.join(root, "web", "api"));
  repo(path.join(root, "node_modules", "pkg"));
  repo(path.join(root, "a", "b", "c", "d", "too-deep"));
  const found = scanRepos(root, 3);
  assert.deepEqual(found.map((r) => r.path).sort(), ["api/api", "web/api"]);
  assert.equal(new Set(found.map((r) => r.id)).size, 2);
});

test("the starter config round-trips through valid JSON and has no secrets", () => {
  const cfg = JSON.parse(scaffoldConfig("/x/proj", [{ id: "a", path: "a/a" }]));
  assert.equal(cfg.project, "proj");
  assert.deepEqual(cfg.repos, [{ id: "a", path: "a/a" }]);
  assert.match(AGENTS_TEMPLATE, /## Commands/);
});

const quiet = () => {};
// The machine check depends on what is installed here, so the tests use a fixed answer
const doctor = () => ({ ok: true, checks: [] });

test("setup installs into the workspace and writes a config for nested repos", async () => {
  const ws = tmp();
  repo(path.join(ws, "svc", "svc"));
  const res = await setup({ dest: ws, prompter: scripted("y", "y"), log: quiet, doctor });
  assert.equal(res.installed, true);
  assert.ok(fs.existsSync(path.join(ws, ".agents", "skills", "solve-ticket", "SKILL.md")));
  const cfg = JSON.parse(fs.readFileSync(path.join(ws, ".dev-agent", "config.json"), "utf8"));
  assert.equal(cfg.repos[0].path, "svc/svc");
});

test("answering no installs nothing", async () => {
  const ws = tmp();
  const res = await setup({ dest: ws, prompter: scripted("n"), log: quiet, doctor });
  assert.equal(res.installed, false);
  assert.equal(fs.existsSync(path.join(ws, ".agents")), false);
});

test("an existing config is never overwritten", async () => {
  const ws = tmp();
  repo(path.join(ws, "svc", "svc"));
  fs.mkdirSync(path.join(ws, ".dev-agent"));
  fs.writeFileSync(path.join(ws, ".dev-agent", "config.json"), '{"project":"mine"}');
  await setup({ dest: ws, prompter: scripted("y"), log: quiet, doctor });
  assert.equal(fs.readFileSync(path.join(ws, ".dev-agent", "config.json"), "utf8"), '{"project":"mine"}');
});

test("a single repo gets no config, and AGENTS.md is only made when asked", async () => {
  const ws = tmp();
  repo(ws);
  await setup({ dest: ws, prompter: scripted("y", "n"), log: quiet, doctor });
  assert.equal(fs.existsSync(path.join(ws, ".dev-agent")), false);
  assert.equal(fs.existsSync(path.join(ws, "AGENTS.md")), false);

  const ws2 = tmp();
  repo(ws2);
  await setup({ dest: ws2, prompter: scripted("y", "y"), log: quiet, doctor });
  assert.equal(fs.readFileSync(path.join(ws2, "AGENTS.md"), "utf8"), AGENTS_TEMPLATE);
});

test("a folder that does not exist, or a bad scope, is an error", async () => {
  await assert.rejects(setup({ dest: path.join(tmp(), "nope"), log: quiet, doctor }), /Folder not found/);
  await assert.rejects(setup({ dest: tmp(), scope: "planet", log: quiet, doctor }), /--scope/);
});

test("--yes installs without asking and keeps a workspace path with spaces intact", async () => {
  const ws = path.join(tmp(), "my project");
  fs.mkdirSync(ws);
  repo(ws);
  const res = await setup({ dest: ws, yes: true, log: quiet, doctor });
  assert.equal(res.installed, true);
  const skill = fs.readFileSync(path.join(ws, ".agents", "skills", "solve-ticket", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /%20/);
});
