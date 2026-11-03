import assert from "node:assert/strict";
import { test } from "node:test";
import { check, checkCommand, isSecretFile } from "./rules.mjs";

const blocked = (cmd, env) => assert.ok(checkCommand(cmd, env), `should block: ${cmd}`);
const allowed = (cmd, env) => assert.equal(checkCommand(cmd, env), null, `should allow: ${cmd}`);

test("push, merge and PR commands are blocked, even inside a chain", () => {
  blocked("git push");
  blocked("git push origin main");
  blocked("cd repo && git push -u origin x");
  blocked("git -C api-server/api-server push");
  blocked("FOO=1 git push");
  blocked("git merge main");
  blocked("gh pr create --fill");
  blocked("gh pr merge 12");
  blocked("gh api repos/x/y/pulls -X POST");
});

test("read-only git and gh commands are allowed", () => {
  allowed("git status --short");
  allowed("git log --oneline -5");
  allowed("git diff");
  allowed("git fetch origin main");
  allowed("git pull origin main");
  allowed("git checkout main");
  allowed("git branch --show-current");
  allowed("git branch -vv");
  allowed("gh pr view 12");
  allowed("gh api repos/x/y/pulls");
});

test("destructive git commands are blocked", () => {
  blocked("git stash");
  blocked("git stash pop");
  blocked("git reset --hard origin/main");
  blocked("git clean -fd");
  blocked("git checkout -- .");
  blocked("git restore src/a.ts");
  allowed("git restore --staged src/a.ts");
  allowed("git reset -q -- file.js");
});

test("commits are blocked until approved", () => {
  blocked('git commit -m "x"');
  allowed('git commit -m "x"', { DEV_AGENT_ALLOW_COMMIT: "1" });
  blocked('git commit -m "x" --no-verify', { DEV_AGENT_ALLOW_COMMIT: "1" });
});

test("a commit is allowed only with the approval marker", () => {
  allowed('DEV_AGENT_COMMIT_OK=1 git commit -m "NOVA-1: x"');
  allowed('cd repo && DEV_AGENT_COMMIT_OK=1 git -C wt commit -m "x"');
  blocked('DEV_AGENT_COMMIT_OK=0 git commit -m "x"');
  blocked('git commit -m "DEV_AGENT_COMMIT_OK=1"');
  blocked('DEV_AGENT_COMMIT_OK=1 git commit -m "x" --no-verify');
});

test("the old NOVA_* approval names still work", () => {
  allowed('NOVA_COMMIT_OK=1 git commit -m "x"');
  allowed('git commit -m "x"', { NOVA_DEV_ALLOW_COMMIT: "1" });
});

test("files must be staged by name", () => {
  blocked("git add -A");
  blocked("git add .");
  blocked("git add --all");
  blocked("git add -u");
  allowed("git add src/a.ts src/b.ts");
  allowed("git -C wt add services/TagService.js");
});

test("worktrees: create needs --no-track, removal is script-only", () => {
  blocked("git worktree add -b Backend/NOVA-1/X ../wt origin/main");
  allowed("git worktree add --no-track -b Backend/NOVA-1/X ../wt origin/main");
  allowed("git worktree list");
  blocked("git worktree remove ../wt");
  blocked("git worktree prune");
});

test("branches need --no-track", () => {
  blocked("git checkout -b Backend/ABC-1/Thing");
  blocked("git switch -c Backend/ABC-1/Thing");
  blocked("git branch Backend/ABC-1/Thing");
  allowed("git checkout --no-track -b Backend/ABC-1/Thing");
  allowed("git checkout --no-track -b Backend/ABC-1/Thing origin/main");
  allowed("git branch -D Backend/ABC-1/Thing");
});

test("secret env files are blocked in commands", () => {
  blocked("cat .env");
  blocked("cat api-server/.env.production");
  blocked("type .env.local");
  blocked("Get-Content .env");
  blocked("cp .env.example .env");
  blocked("node --env-file=.env server.js");
  blocked("git add .env");
  allowed("cat .env.example");
  allowed("npm run dev");
  allowed("ls -a");
});

test("secret env files are blocked in file tools", () => {
  assert.ok(check("Read", { file_path: "C:/x/api-server/.env" }));
  assert.ok(check("Edit", { file_path: "C:\\x\\.env.staging" }));
  assert.ok(check("Grep", { pattern: "KEY", path: "C:/x/.env" }));
  assert.ok(check("Glob", { pattern: "**/.env*" }));
  assert.equal(check("Read", { file_path: "C:/x/.env.example" }), null);
  assert.equal(check("Read", { file_path: "C:/x/src/environment.ts" }), null);
});

test("node_modules and .git are not editable", () => {
  assert.ok(check("Write", { file_path: "C:/x/node_modules/a/index.js" }));
  assert.ok(check("Edit", { file_path: "C:/x/.git/config" }));
  assert.equal(check("Read", { file_path: "C:/x/node_modules/a/index.js" }), null);
  assert.equal(check("Write", { file_path: "C:/x/src/a.ts" }), null);
});

test("other tools are ignored", () => {
  assert.equal(check("WebFetch", { url: "https://x" }), null);
});

test("isSecretFile", () => {
  assert.equal(isSecretFile(".env"), true);
  assert.equal(isSecretFile("a/b/.env.local"), true);
  assert.equal(isSecretFile(".env.example"), false);
  assert.equal(isSecretFile("env.ts"), false);
});
