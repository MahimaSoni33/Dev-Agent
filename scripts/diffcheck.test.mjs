// Runs against a throwaway git repo in the temp folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { diffCheck } from "./diffcheck.mjs";

let dir;
const git = (...a) => assert.equal(spawnSync("git", a, { cwd: dir }).status, 0);
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-diff-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("a.js", "function a() {\n  return 1;\n}\n");
  write("b.js", "const b = 2;\n");
  git("add", "a.js", "b.js");
  git("commit", "-q", "-m", "init");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a clean planned change passes", () => {
  write("a.js", "function a() {\n  return 2;\n}\n");
  const r = diffCheck({ dest: dir, planFiles: ["a.js"] });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.files, ["a.js"]);
  git("checkout", "--", "a.js");
});

test("reformatting, leftovers, secrets and unplanned files are caught", () => {
  write("a.js", "function a() {\n    return 1;\n}\n"); // indentation only
  write("b.js", "const b = 2;\nconsole.log(b);\n");
  write(".env", "X=1\n");
  write("new.js", 'const password = "hunter2hunter2";\n');
  const r = diffCheck({ dest: dir, planFiles: ["b.js"] });
  const has = (sev, file, re) => r.findings.some((f) => f.severity === sev && f.file === file && re.test(f.message));
  assert.equal(r.verdict, "changes-needed");
  assert.ok(has("blocking", "a.js", /whitespace-only/));
  assert.ok(has("minor", "b.js", /console\.log/));
  assert.ok(has("blocking", ".env", /secret file/));
  assert.ok(has("blocking", "new.js", /hardcoded secret/));
  assert.ok(has("minor", "a.js", /not in the plan/));
});

test("an empty worktree is not a pass", () => {
  git("checkout", "--", "a.js", "b.js");
  fs.rmSync(path.join(dir, ".env"));
  fs.rmSync(path.join(dir, "new.js"));
  assert.equal(diffCheck({ dest: dir }).verdict, "changes-needed");
});
