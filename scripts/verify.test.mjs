// Runs against a throwaway git repo in the temp folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { check, failureLines } from "./verify.mjs";

let root, repo, sha;
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
const node = (code) => `node -e "${code}"`;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-verify-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  sha = git(repo, "rev-parse", "HEAD").stdout.trim();
});
after(() => {
  git(repo, "worktree", "prune");
  fs.rmSync(root, { recursive: true, force: true });
});

test("failure signatures ignore numbers and summary counters", () => {
  const a = failureLines("src/x.ts:10:5 error no-unused\n166 problems (3 errors)\n");
  const b = failureLines("src/x.ts:99:7 error no-unused\n170 problems (4 errors)\n");
  assert.deepEqual([...a], [...b]);
});

test("passes, pre-existing failures and new failures are told apart; the baseline is cached", async () => {
  const wt = path.join(root, "wt");
  assert.equal(git(repo, "worktree", "add", "--no-track", "-b", "feature", wt, sha).status, 0);
  fs.writeFileSync(path.join(wt, "marker"), "x"); // only the worktree has it
  const cacheFile = path.join(root, "cache.json");
  const cmds = [
    node("process.exit(0)"),
    node("console.error('error: already broken'); process.exit(1)"),
    node("process.exit(require('fs').existsSync('marker') ? 1 : 0)"),
  ];
  const first = await check({ repo, dest: wt, baseSha: sha, cmds, cacheFile, tmpRoot: root });
  assert.deepEqual(first.results.map((r) => r.status), ["pass", "preexisting-fail", "new-fail"]);
  assert.equal(first.baselineRuns, 2);
  assert.equal(first.cacheHits, 0);

  const second = await check({ repo, dest: wt, baseSha: sha, cmds, cacheFile, tmpRoot: root });
  assert.deepEqual(second.results.map((r) => r.status), ["pass", "preexisting-fail", "new-fail"]);
  assert.equal(second.baselineRuns, 0);
  assert.equal(second.cacheHits, 2);
  assert.equal(git(repo, "worktree", "list").stdout.trim().split("\n").length, 2); // main + wt: temp baselines are gone
});

test("when everything passes no baseline is run at all", async () => {
  const r = await check({ repo, dest: repo, baseSha: sha, cmds: [node("process.exit(0)")], tmpRoot: root });
  assert.equal(r.baselineRuns, 0);
  assert.equal(r.results[0].status, "pass");
});
