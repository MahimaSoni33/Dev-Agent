import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { cliCandidates, detectAntigravity, globalDir, ideCandidates, meetsMinimum, parseVersion, workspaceDir } from "./antigravity.mjs";

const home = path.join(path.sep, "home", "dev");
const none = () => null;

test("versions are parsed from the first number group", () => {
  assert.equal(parseVersion("agy version 2.0.0").text, "2.0.0");
  assert.equal(parseVersion("1.2").minor, 2);
  assert.equal(parseVersion("no digits"), null);
  assert.equal(parseVersion(null), null);
});

test("the minimum CLI version compares major then minor", () => {
  assert.equal(meetsMinimum("1.2.0"), true);
  assert.equal(meetsMinimum("1.1.9"), false);
  assert.equal(meetsMinimum("2.0.0"), true);
  assert.equal(meetsMinimum("0.9"), false);
  assert.equal(meetsMinimum(null), false);
});

test("folders follow the documented layout", () => {
  assert.equal(path.basename(workspaceDir("/repo")), ".agents");
  assert.deepEqual(globalDir(home).split(path.sep).slice(-2), [".gemini", "config"]);
});

test("default CLI install folders differ by platform", () => {
  const win = cliCandidates({ platform: "win32", home: "C:\\Users\\a", env: { LOCALAPPDATA: "D:\\Local" } });
  assert.match(win[0], /Local[\\/]agy[\\/]bin[\\/]agy\.exe$/);
  assert.match(cliCandidates({ platform: "linux", home })[0], /\.local[\\/]bin[\\/]agy$/);
  assert.match(ideCandidates({ platform: "darwin", home })[0], /Antigravity\.app$/);
});

test("nothing installed is reported without throwing", () => {
  const r = detectAntigravity({ platform: "linux", home, run: none, exists: () => false });
  assert.equal(r.cli.found, false);
  assert.equal(r.ide.found, false);
  assert.equal(r.ide.usedBefore, false);
});

test("a CLI on PATH is read through agy --version", () => {
  const run = (cmd) => (cmd === "agy" ? "agy version 2.0.0" : null);
  const r = detectAntigravity({ platform: "linux", home, run, exists: () => false });
  assert.deepEqual([r.cli.found, r.cli.onPath, r.cli.version, r.cli.meetsMinimum], [true, true, "2.0.0", true]);
});

test("an old CLI is found but does not meet the minimum", () => {
  const run = (cmd) => (cmd === "agy" ? "agy 1.0.3" : null);
  const r = detectAntigravity({ platform: "linux", home, run, exists: () => false });
  assert.equal(r.cli.found, true);
  assert.equal(r.cli.meetsMinimum, false);
});

test("a CLI in its default folder but off PATH is found with a note", () => {
  const file = cliCandidates({ platform: "linux", home })[0];
  const run = (cmd) => (cmd === file ? "agy version 1.5.0" : null);
  const r = detectAntigravity({ platform: "linux", home, run, exists: (p) => p === file });
  assert.equal(r.cli.found, true);
  assert.equal(r.cli.onPath, false);
  assert.match(r.notes[0], /not on your PATH/);
});

test("the IDE is detected by install folder, by launcher, or by its data folder", () => {
  const folder = ideCandidates({ platform: "linux", home })[0];
  assert.equal(detectAntigravity({ platform: "linux", home, run: none, exists: (p) => p === folder }).ide.found, true);

  const viaLauncher = detectAntigravity({ platform: "linux", home, run: (c) => (c === "antigravity" ? "1.107.0\nabc\nx64" : null), exists: () => false });
  assert.equal(viaLauncher.ide.found, true);
  assert.equal(viaLauncher.ide.version, "1.107.0");

  const usedOnly = detectAntigravity({ platform: "linux", home, run: none, exists: (p) => p.endsWith("antigravity-ide") });
  assert.equal(usedOnly.ide.found, false);
  assert.equal(usedOnly.ide.usedBefore, true);
});
