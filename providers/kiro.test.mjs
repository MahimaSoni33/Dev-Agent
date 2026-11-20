import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { authState, detectKiro, globalDir, workspaceDir } from "./kiro.mjs";

const none = () => false;
// A fake machine: answers by command name
const machine = (answers) => (cmd, args) => answers[`${cmd} ${args[0]}`] ?? null;

test("folders follow the documented .kiro layout", () => {
  assert.equal(workspaceDir("/w/app"), path.join(path.resolve("/w/app"), ".kiro"));
  assert.equal(globalDir("/home/me"), path.join("/home/me", ".kiro"));
});

test("nothing installed: both surfaces report not found and auth is not asked", () => {
  const k = detectKiro({ run: machine({}), exists: none, home: "/h", env: {} });
  assert.equal(k.cli.found, false);
  assert.equal(k.ide.found, false);
  assert.equal(k.auth, null);
});

test("CLI on PATH: version, minimum and auth are read", () => {
  const run = machine({ "kiro-cli --version": "kiro-cli 2.1.0", "kiro-cli whoami": "Logged in with Builder ID\nmore" });
  const k = detectKiro({ run, exists: none, home: "/h", env: {} });
  assert.equal(k.cli.found, true);
  assert.equal(k.cli.version, "2.1.0");
  assert.equal(k.cli.meetsMinimum, true);
  assert.equal(k.auth.signedIn, true);
  assert.equal(k.auth.whoami, "Logged in with Builder ID");
});

test("a CLI older than 2.0 is flagged", () => {
  const k = detectKiro({ run: machine({ "kiro-cli --version": "kiro-cli 1.9.4" }), exists: none, home: "/h", env: {} });
  assert.equal(k.cli.found, true);
  assert.equal(k.cli.meetsMinimum, false);
});

test("the API key is reported as set or not set and its value never appears", () => {
  const env = { KIRO_API_KEY: "ksk_SECRET_VALUE" };
  const a = authState({ env, run: () => null });
  assert.deepEqual(a, { signedIn: false, whoami: null, apiKeySet: true });
  assert.doesNotMatch(JSON.stringify(detectKiro({ run: machine({ "kiro-cli --version": "kiro-cli 2.0.0" }), exists: none, home: "/h", env })), /SECRET_VALUE/);
  assert.equal(authState({ env: {}, run: () => null }).apiKeySet, false);
});

test("a CLI found only in its default folder gets a PATH note", () => {
  const file = path.join("/h", ".local", "bin", "kiro-cli");
  const run = (cmd) => (cmd === file ? "kiro-cli 2.0.1" : null);
  const k = detectKiro({ run, exists: (p) => p === file, home: "/h", platform: "linux", env: {} });
  assert.equal(k.cli.found, true);
  assert.equal(k.cli.onPath, false);
  assert.match(k.notes[0], /not on your PATH/);
});

test("the IDE is recognised by launcher or install folder, and marked best effort", () => {
  const viaLauncher = detectKiro({ run: machine({ "kiro --version": "1.4.2\nabc" }), exists: none, home: "/h", env: {} });
  assert.equal(viaLauncher.ide.found, true);
  assert.equal(viaLauncher.ide.version, "1.4.2");
  const viaFolder = detectKiro({ run: machine({}), exists: (p) => p === "/Applications/Kiro.app", platform: "darwin", home: "/h", env: {} });
  assert.equal(viaFolder.ide.found, true);
  assert.equal(viaFolder.ide.bestEffort, true);
});

// ---- the stop hook, end to end ----
const hook = fileURLToPath(new URL("../hooks/kiro-usage.mjs", import.meta.url));
const runHook = (input, runs, args = ["--surface", "cli"]) =>
  spawnSync(process.execPath, [hook, ...args], { input, encoding: "utf8", env: { ...process.env, DEV_AGENT_RUNS_DIR: runs } });

test("the Kiro stop hook records requests per session and never fails the run", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-kiro-hook-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "NOVA-5-"));
  const a = JSON.stringify({ hook_event_name: "stop", session_id: "s1", cwd });
  assert.equal(runHook(a, runs).status, 0);
  const second = runHook(a, runs);
  assert.equal(second.status, 0);
  assert.match(second.stderr, /session s1: 2 request\(s\), credits unavailable/);
  assert.equal(runHook(JSON.stringify({ session_id: "s2", cwd }), runs).status, 0);

  const doc = JSON.parse(fs.readFileSync(path.join(runs, "NOVA-5", "usage.json"), "utf8"));
  assert.equal(doc.sessions["kiro:s1"].requests, 2);
  assert.equal(doc.sessions["kiro:s2"].requests, 1);
  assert.equal(doc.sessions["kiro:s1"].credits.used, null);
});

test("the Kiro stop hook survives empty or broken input and takes the surface from its argument", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-kiro-hook-"));
  assert.equal(runHook("", runs, ["--surface", "ide"]).status, 0);
  assert.equal(runHook("{broken", runs).status, 0);
  const files = fs.readdirSync(runs);
  assert.ok(files.length >= 1);
  const doc = JSON.parse(fs.readFileSync(path.join(runs, files[0], "usage.json"), "utf8"));
  const surfaces = Object.values(doc.sessions).map((s) => s.surface);
  assert.ok(surfaces.includes("ide") || surfaces.includes("cli"));
  assert.ok(Object.values(doc.sessions).every((s) => s.sessionIdSource === "derived"));
});
