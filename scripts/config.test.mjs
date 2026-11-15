// Runs against throwaway folders in the temp folder. It never touches a real project.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveConfig, saveBaseBranch, saveChangeTarget } from "./config.mjs";
import { detectRepo } from "./detect.mjs";

let root;
const write = (rel, text = "") => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-cfg-"));
  write("web/.git/HEAD");
  write("web/pnpm-lock.yaml");
  write("web/package.json", JSON.stringify({ scripts: { lint: "x", build: "x", test: "x", dev: "x" } }));
  write("web/CLAUDE.md");
  write("web/.env.example");
  write("svc/.git/HEAD");
  write("svc/go.mod");
  write("py/.git/HEAD");
  write("py/pyproject.toml");
  write("mk/Makefile", "lint:\n\techo\ntest:\n\techo\n");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("detects node scripts, package manager and instruction files", () => {
  const p = detectRepo(path.join(root, "web"));
  assert.deepEqual(p.stack, ["node"]);
  assert.equal(p.packageManager, "pnpm");
  assert.deepEqual(p.verify, ["pnpm run lint", "pnpm run build", "pnpm run test"]);
  assert.deepEqual(p.run, ["pnpm run dev"]);
  assert.deepEqual(p.instructions, ["CLAUDE.md"]);
  assert.equal(p.needsEnv, true);
});

test("detects other stacks and Makefile targets", () => {
  assert.deepEqual(detectRepo(path.join(root, "svc")).verify, ["go vet ./...", "go test ./..."]);
  assert.deepEqual(detectRepo(path.join(root, "py")).stack, ["python"]);
  assert.deepEqual(detectRepo(path.join(root, "mk")).verify, ["make lint", "make test"]);
});

test("zero-config finds the git repos inside the folder", () => {
  const cfg = resolveConfig({ cwd: root });
  assert.equal(cfg.configFile, null);
  assert.deepEqual(cfg.repos.map((r) => r.id).sort(), ["py", "svc", "web"]);
  assert.deepEqual(cfg.buildOrder, [cfg.repos.map((r) => r.id)]);
  assert.equal(cfg.repos[0].branchTemplate, "<KEY>/<ShortFeatureName>");
  assert.equal(cfg.rules.pushAllowed, false);
});

test("a single repo with no config is its own workspace", () => {
  const cfg = resolveConfig({ cwd: path.join(root, "web") });
  assert.equal(cfg.repos.length, 1);
  assert.equal(cfg.repos[0].path, ".");
  assert.equal(cfg.repos[0].verify.length, 3);
});

test("config is found in a parent folder and wins over detection", () => {
  write(
    ".dev-agent/config.json",
    JSON.stringify({
      project: "demo",
      tracker: { projectKey: "DEMO" },
      repos: [{ id: "web", path: "web", verify: ["custom check"], areaPrefix: "Web" }, { id: "svc", path: "svc" }],
      buildOrder: [["svc"], ["web"]],
      runsDir: "runs-here",
    }),
  );
  const cfg = resolveConfig({ cwd: path.join(root, "web") });
  assert.equal(cfg.project, "demo");
  assert.equal(cfg.tracker.projectKey, "DEMO");
  assert.equal(cfg.tracker.type, "jira");
  const web = cfg.repos.find((r) => r.id === "web");
  assert.deepEqual(web.verify, ["custom check"]);
  assert.equal(web.branchTemplate, "Web/<KEY>/<ShortFeatureName>");
  assert.deepEqual(cfg.repos.find((r) => r.id === "svc").verify, ["go vet ./...", "go test ./..."]);
  assert.deepEqual(cfg.buildOrder, [["svc"], ["web"]]);
  assert.equal(cfg.runsBase, path.join(root, "runs-here", "demo"));
});

test("the shipped example configs resolve", () => {
  const nova = resolveConfig({ cwd: root, configPath: new URL("../config/examples/nova-aid/config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  assert.equal(nova.repos.length, 5);
  assert.equal(nova.tracker.projectKey, "NOVA");
  assert.equal(nova.repos[0].branchTemplate, "Backend/<KEY>/<ShortFeatureName>");
  assert.equal(nova.repos[0].verify[1], "npm test");
  assert.deepEqual(nova.repos[4].instructions, []);
});

test("changeTarget defaults to in-place, and who set it is reported", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-cfg-empty-"));
  const cfg = resolveConfig({ cwd: empty, env: {} });
  assert.equal(cfg.changeTarget, "in-place");
  assert.equal(cfg.changeTargetSource, "default");
  assert.equal(cfg.rules.changeTarget, "in-place");
});

test("changeTarget order: flag, then env, then config, then default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-cfg-order-"));
  fs.mkdirSync(path.join(dir, ".git"));
  saveChangeTarget({ root: dir, configFile: null }, "worktree");
  const fromConfig = resolveConfig({ cwd: dir, env: {} });
  assert.deepEqual([fromConfig.changeTarget, fromConfig.changeTargetSource], ["worktree", "config"]);
  const fromEnv = resolveConfig({ cwd: dir, env: { DEV_AGENT_CHANGE_TARGET: "in-place" } });
  assert.deepEqual([fromEnv.changeTarget, fromEnv.changeTargetSource], ["in-place", "env"]);
  const fromFlag = resolveConfig({ cwd: dir, env: { DEV_AGENT_CHANGE_TARGET: "in-place" }, changeTarget: "worktree" });
  assert.deepEqual([fromFlag.changeTarget, fromFlag.changeTargetSource], ["worktree", "flag"]);
});

test("a bad changeTarget is an error, wherever it comes from", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-cfg-bad-"));
  assert.throws(() => resolveConfig({ cwd: dir, env: {}, changeTarget: "sideways" }), /--change-target/);
  assert.throws(() => resolveConfig({ cwd: dir, env: { DEV_AGENT_CHANGE_TARGET: "x" } }), /DEV_AGENT_CHANGE_TARGET/);
  assert.throws(() => saveChangeTarget({ root: dir }, "x"), /changeTarget/);
});

test("saving a choice keeps the rest of the config, and the base branch is saved per repo", () => {
  const cfgFile = path.join(root, ".dev-agent", "config.json");
  const before = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  const cfg = resolveConfig({ cwd: root, env: {} });
  saveChangeTarget(cfg, "worktree");
  saveBaseBranch(cfg, "web", "develop");
  saveBaseBranch(cfg, "not-listed", "main");
  const after = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  assert.equal(after.project, before.project);
  assert.equal(after.rules.changeTarget, "worktree");
  assert.equal(after.repos.find((r) => r.id === "web").baseBranch, "develop");
  assert.equal(after.rules.baseBranch, "main");
  const resolved = resolveConfig({ cwd: root, env: {} });
  assert.equal(resolved.repos.find((r) => r.id === "web").baseBranch, "develop");
  assert.equal(resolved.repos.find((r) => r.id === "svc").baseBranch, "main"); // falls back to rules.baseBranch
});
