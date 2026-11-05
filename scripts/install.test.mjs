import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installAntigravity } from "./install.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-install-"));

test("antigravity install writes skill, agents and hooks", () => {
  const baseDir = tmp();
  installAntigravity({ baseDir, pluginDir: "C:/tools/dev-agent" });

  const skill = fs.readFileSync(path.join(baseDir, "skills/solve-ticket/SKILL.md"), "utf8");
  assert.match(skill, /`C:\/tools\/dev-agent`/);
  assert.doesNotMatch(skill, /<!--plugin-->|argument-hint/);

  const builder = fs.readFileSync(path.join(baseDir, "agents/repo-builder/agent.md"), "utf8");
  assert.match(builder, /^name: repo-builder$/m);
  assert.match(builder, /^ {2}- run_command$/m);
  assert.match(builder, /^ {2}- write_to_file$/m);
  assert.match(builder, /^mainAgent: false$/m);
  const reviewer = fs.readFileSync(path.join(baseDir, "agents/repo-reviewer/agent.md"), "utf8");
  assert.doesNotMatch(reviewer, /write_to_file|replace_file_content/);

  const hooks = JSON.parse(fs.readFileSync(path.join(baseDir, "hooks.json"), "utf8"));
  const entry = hooks["dev-agent"].PreToolUse[0];
  assert.match(entry.matcher, /run_command/);
  assert.match(entry.hooks[0].command, /C:\/tools\/dev-agent\/hooks\/guard\.mjs/);
});

test("installing again keeps other hooks and replaces ours", () => {
  const baseDir = tmp();
  fs.writeFileSync(path.join(baseDir, "hooks.json"), JSON.stringify({ mine: { Stop: [] } }));
  installAntigravity({ baseDir, pluginDir: "/p" });
  installAntigravity({ baseDir, pluginDir: "/q" });
  const hooks = JSON.parse(fs.readFileSync(path.join(baseDir, "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks).sort(), ["dev-agent", "mine"]);
  assert.match(hooks["dev-agent"].PreToolUse[0].hooks[0].command, /\/q\//);
});

test("a hooks file that is not JSON is left alone", () => {
  const baseDir = tmp();
  fs.writeFileSync(path.join(baseDir, "hooks.json"), "{ nope");
  assert.throws(() => installAntigravity({ baseDir, pluginDir: "/p" }), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(baseDir, "hooks.json"), "utf8"), "{ nope");
});

test("probe hook is added on request and removed again without it", () => {
  const baseDir = tmp();
  installAntigravity({ baseDir, pluginDir: "C:/tools/dev-agent", probe: true });
  const file = path.join(baseDir, "hooks.json");
  const probed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(probed["dev-agent-probe"].Stop[0].hooks[0].command, /hooks\/dump\.mjs/);
  assert.ok(probed["dev-agent"].PreToolUse);

  installAntigravity({ baseDir, pluginDir: "C:/tools/dev-agent" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["dev-agent-probe"], undefined);
});
