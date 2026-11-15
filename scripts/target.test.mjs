// Runs against throwaway git repos in the temp folder. It never touches a real project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatSummary, inspectRepo, prepareTarget, summarize } from "./target.mjs";

const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...author } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
};
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);

// A bare origin with a main branch, and a clone of it that is the developer's checkout
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-target-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  write(repo, "a.txt", "one\n");
  write(repo, "b.txt", "two\n");
  git(repo, "add", "a.txt", "b.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "-q", "origin", "main");
  return { root, origin, repo };
}

// Pushes one more commit to origin from a second clone, so the developer's main is behind
function remoteMoves({ root, origin }) {
  const other = path.join(root, "other");
  git(root, "clone", "-q", origin, other);
  write(other, "remote.txt", "from remote\n");
  git(other, "add", "remote.txt");
  git(other, "commit", "-q", "-m", "remote work");
  git(other, "push", "-q", "origin", "main");
}

const run = (repo, extra = {}) => prepareTarget("in-place", { repo, branch: "Web/PROJ-1/Fix", base: "main", key: "PROJ-1", ...extra });

test("inspect reports a clean repo, the branch and the base candidates", () => {
  const { repo } = makeRepo();
  const info = inspectRepo(repo);
  assert.equal(info.branch, "main");
  assert.deepEqual(info.dirty, []);
  assert.equal(info.state, null);
  assert.deepEqual(info.candidates, ["main"]);
  assert.equal(info.hasOrigin, true);
});

test("in-place cuts an untracked feature branch from the up-to-date base and commits nothing", () => {
  const { repo } = makeRepo();
  const head = git(repo, "rev-parse", "HEAD");
  const res = run(repo, { runDir: path.join(repo, "..", "run") });
  assert.equal(res.status, "ready");
  assert.equal(res.pull, "up-to-date");
  assert.equal(res.dest, inspectRepo(repo).top);
  assert.equal(git(repo, "branch", "--show-current"), "Web/PROJ-1/Fix");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(res.baseSha, head);
  assert.equal(spawnSync("git", ["config", "--get", "branch.Web/PROJ-1/Fix.remote"], { cwd: repo }).status, 1); // no upstream
  assert.ok(fs.existsSync(path.join(repo, "..", "run", "restore.json")));
  assert.ok(res.rollback.some((c) => c.startsWith("git switch main")));
});

test("a base that moved on origin is fast-forwarded before the branch is cut", () => {
  const ctx = makeRepo();
  remoteMoves(ctx);
  const res = run(ctx.repo);
  assert.equal(res.pull, "fast-forwarded");
  assert.ok(fs.existsSync(path.join(ctx.repo, "remote.txt")));
});

test("it asks which branch is the latest when none was given", () => {
  const { repo } = makeRepo();
  const res = run(repo, { base: undefined });
  assert.equal(res.status, "needs-input");
  assert.equal(res.need, "base");
  assert.deepEqual(res.candidates, ["main"]);
  assert.equal(git(repo, "branch", "--show-current"), "main"); // nothing changed
});

test("working from another branch pulls the chosen base, not the current branch", () => {
  const ctx = makeRepo();
  git(ctx.repo, "switch", "-q", "-c", "side");
  remoteMoves(ctx);
  const res = run(ctx.repo);
  assert.equal(res.status, "ready");
  assert.equal(res.restore.originalBranch, "side");
  assert.ok(fs.existsSync(path.join(ctx.repo, "remote.txt")));
  assert.equal(git(ctx.repo, "rev-parse", "side"), res.restore.originalHead); // the old branch is untouched
});

test("uncommitted work: ask, then continue, stash or cancel", () => {
  const { repo } = makeRepo();
  write(repo, "a.txt", "one\nmy edit\n");
  write(repo, "new.txt", "mine\n");

  const ask = run(repo);
  assert.equal(ask.status, "needs-input");
  assert.equal(ask.need, "dirty");
  assert.deepEqual(ask.files.sort(), ["a.txt", "new.txt"]);
  assert.equal(git(repo, "branch", "--show-current"), "main");

  assert.equal(run(repo, { dirty: "cancel" }).status, "stopped");
  assert.equal(run(repo, { yes: true }).status, "stopped"); // an unattended run never decides for the developer
  assert.equal(git(repo, "branch", "--show-current"), "main");

  const kept = run(repo, { dirty: "continue" });
  assert.equal(kept.status, "ready");
  assert.deepEqual(Object.keys(kept.restore.preexisting).sort(), ["a.txt", "new.txt"]);
  assert.match(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), /my edit/);
});

test("stash first leaves a clean tree and names the stash", () => {
  const { repo } = makeRepo();
  write(repo, "a.txt", "one\nmy edit\n");
  const res = run(repo, { dirty: "stash" });
  assert.equal(res.status, "ready");
  assert.equal(inspectRepo(repo).dirty.length, 0);
  assert.match(git(repo, "stash", "list"), /dev-agent: before PROJ-1/);
  assert.ok(res.restore.stashRef);
  assert.ok(res.rollback.some((c) => c.includes("dev-agent: before PROJ-1")));
});

test("a merge in progress or a detached HEAD stops everything", () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(git(repo, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), `${git(repo, "rev-parse", "HEAD")}\n`);
  const merging = run(repo);
  assert.equal(merging.status, "stopped");
  assert.match(merging.reason, /merge/);
  fs.rmSync(path.join(git(repo, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"));

  git(repo, "switch", "-q", "--detach");
  assert.match(run(repo).reason, /detached/);
});

test("a base that cannot fast-forward stops and puts the checkout back", () => {
  const ctx = makeRepo();
  remoteMoves(ctx);
  write(ctx.repo, "local.txt", "local only\n");
  git(ctx.repo, "add", "local.txt");
  git(ctx.repo, "commit", "-q", "-m", "local work"); // main has diverged from origin/main
  git(ctx.repo, "switch", "-q", "-c", "side");
  const res = run(ctx.repo);
  assert.equal(res.status, "stopped");
  assert.match(res.reason, /fast-forward/);
  assert.equal(git(ctx.repo, "branch", "--show-current"), "side");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/Web/PROJ-1/Fix"], { cwd: ctx.repo }).status, 1);
});

test("offline: ask first, then continue from the local base when told to", () => {
  const ctx = makeRepo();
  git(ctx.repo, "remote", "set-url", "origin", path.join(ctx.root, "gone.git"));
  const ask = run(ctx.repo);
  assert.equal(ask.status, "needs-input");
  assert.equal(ask.need, "offline");
  assert.equal(git(ctx.repo, "branch", "--show-current"), "main");

  const res = run(ctx.repo, { offline: "skip" });
  assert.equal(res.status, "ready");
  assert.match(res.pull, /offline/);
});

test("a branch name that is taken gets a suggestion instead of a clash", () => {
  const { repo } = makeRepo();
  git(repo, "branch", "Web/PROJ-1/Fix");
  const res = run(repo);
  assert.equal(res.status, "needs-input");
  assert.equal(res.need, "branch-name");
  assert.equal(res.suggestion, "Web/PROJ-1/Fix-2");
});

test("an unknown base is refused", () => {
  const { repo } = makeRepo();
  assert.match(run(repo, { base: "nope" }).reason, /not found/);
});

test("the printed rollback commands bring the developer back", () => {
  const { repo } = makeRepo();
  const res = run(repo);
  write(repo, "agent.txt", "agent work\n");
  for (const cmd of res.rollback.filter((c) => !c.startsWith("git stash list"))) {
    const [, ...args] = cmd.split("   #")[0].match(/"[^"]*"|\S+/g).map((t) => t.replace(/^"|"$/g, ""));
    git(repo, ...args);
  }
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/Web/PROJ-1/Fix"], { cwd: repo }).status, 1);
  assert.match(git(repo, "stash", "list"), /dev-agent changes: PROJ-1/); // the agent's work was kept, not deleted
});

test("worktree mode still creates an isolated worktree", () => {
  const ctx = makeRepo();
  const dest = path.join(ctx.root, "wt");
  const res = prepareTarget("worktree", { repo: ctx.repo, branch: "Web/PROJ-2/Other", dest, base: "main" });
  assert.equal(res.status, "ready");
  assert.equal(res.mode, "worktree");
  assert.ok(fs.existsSync(path.join(dest, "a.txt")));
  assert.equal(git(ctx.repo, "branch", "--show-current"), "main"); // the developer's checkout is untouched
});

test("an unknown mode is an error", () => {
  assert.throws(() => prepareTarget("sideways", {}), /Unknown change target/);
});

test("the summary lists changed, added and deleted files and where they live", () => {
  const { repo } = makeRepo();
  const res = run(repo);
  write(repo, "a.txt", "one\nchanged\n");
  fs.rmSync(path.join(repo, "b.txt"));
  write(repo, "c.txt", "brand new\n");
  const s = summarize({ dest: repo, baseSha: res.baseSha, branch: res.branch });
  assert.deepEqual(s.files, { modified: ["a.txt"], added: ["c.txt"], deleted: ["b.txt"] });
  assert.match(s.diffStat, /a\.txt/);
  assert.match(s.location, /your working folder/);
  assert.match(formatSummary(s), /Web\/PROJ-1\/Fix/);
});

test("the summary keeps the developer's own dirty files apart from the agent's", () => {
  const { repo } = makeRepo();
  write(repo, "a.txt", "one\nmine\n");
  write(repo, "b.txt", "two\nmine too\n");
  const res = run(repo, { dirty: "continue" });
  write(repo, "b.txt", "two\nmine too\nagent line\n"); // the agent edits on top of the developer's edit
  write(repo, "c.txt", "agent file\n");
  const s = summarize({ dest: repo, baseSha: res.baseSha, restore: res.restore, reported: ["b.txt", "c.txt"] });
  assert.deepEqual(s.yours, ["a.txt"]);
  assert.deepEqual(s.onTopOfYours, ["b.txt"]);
  assert.deepEqual(s.files.added, ["c.txt"]);
  assert.deepEqual(s.unreported, []);
});

test("files changed during the run that the builder did not report are flagged", () => {
  const { repo } = makeRepo();
  const res = run(repo);
  write(repo, "a.txt", "one\nagent\n");
  write(repo, "b.txt", "two\nthe developer typed this\n");
  const s = summarize({ dest: repo, baseSha: res.baseSha, reported: ["a.txt"] });
  assert.deepEqual(s.unreported, ["b.txt"]);
});
