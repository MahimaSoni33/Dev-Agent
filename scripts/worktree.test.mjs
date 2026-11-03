// Runs against throwaway git repos in the temp folder. It never touches a real project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWorktree, removeWorktree } from "./worktree.mjs";

const author = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd, ...args) => {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...author } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
};

let root, origin, repo;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-wt-"));
  origin = path.join(root, "origin.git");
  repo = path.join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".gitignore", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "-q", "origin", "main");
  // A "real" node_modules in the main checkout, ignored by git
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  // The developer has unrelated uncommitted work that must stay untouched
  fs.writeFileSync(path.join(repo, "a.txt"), "one\nlocal edit\n");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("creates a worktree on a new, untracked branch cut from the remote base", () => {
  // The remote moves ahead of the local main
  const other = path.join(root, "other");
  git(root, "clone", "-q", origin, other);
  fs.writeFileSync(path.join(other, "b.txt"), "from remote\n");
  git(other, "add", "b.txt");
  git(other, "commit", "-q", "-m", "remote work");
  git(other, "push", "-q", "origin", "main");

  const dest = path.join(root, "wt", "repo");
  const info = createWorktree({ repo, branch: "Backend/NOVA-1/Thing", dest });

  assert.equal(info.branch, "Backend/NOVA-1/Thing");
  assert.equal(git(dest, "branch", "--show-current"), "Backend/NOVA-1/Thing");
  // Cut from the fresh remote base, not the stale local main
  assert.ok(fs.existsSync(path.join(dest, "b.txt")));
  assert.equal(git(dest, "rev-parse", "HEAD"), info.baseSha);
  // No upstream, so it can never push to main by accident
  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: dest, encoding: "utf8" });
  assert.notEqual(upstream.status, 0);
  // Packages are reused through a link
  assert.equal(info.depsLinked, true);
  assert.ok(fs.existsSync(path.join(dest, "node_modules", "pkg", "index.js")));
  // The developer's own checkout is untouched
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\nlocal edit\n");
});

test("refuses an existing branch or destination", () => {
  assert.throws(
    () => createWorktree({ repo, branch: "Backend/NOVA-1/Thing", dest: path.join(root, "wt", "other") }),
    /Branch already exists/,
  );
  assert.throws(
    () => createWorktree({ repo, branch: "Backend/NOVA-2/Other", dest: path.join(root, "wt", "repo") }),
    /Destination already exists/,
  );
  assert.throws(() => createWorktree({ repo, branch: "bad name", dest: path.join(root, "wt", "x") }));
});

test("fails clearly when the base does not exist", () => {
  assert.throws(
    () => createWorktree({ repo, branch: "Backend/NOVA-3/X", dest: path.join(root, "wt", "y"), base: "nope" }),
    /fetch origin nope failed/,
  );
});

test("removal keeps the branch and never deletes the real node_modules", () => {
  const dest = path.join(root, "wt", "repo");
  const res = removeWorktree({ repo, dest });
  assert.equal(res.branchKept, true);
  assert.equal(fs.existsSync(dest), false);
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "pkg", "index.js")), "real node_modules must survive");
  assert.match(git(repo, "branch", "--list", "Backend/NOVA-1/Thing"), /Backend\/NOVA-1\/Thing/);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});

test("removal refuses a worktree with uncommitted work unless forced", () => {
  const dest = path.join(root, "wt", "dirty");
  createWorktree({ repo, branch: "Backend/NOVA-4/Dirty", dest, linkDirs: [] });
  fs.writeFileSync(path.join(dest, "new.txt"), "uncommitted\n");
  assert.throws(() => removeWorktree({ repo, dest }));
  assert.ok(fs.existsSync(dest));
  removeWorktree({ repo, dest, force: true });
  assert.equal(fs.existsSync(dest), false);
});

test("a refused removal keeps the node_modules link", () => {
  const dest = path.join(root, "wt", "linked");
  createWorktree({ repo, branch: "Backend/NOVA-5/Linked", dest });
  fs.writeFileSync(path.join(dest, "new.txt"), "uncommitted\n");
  assert.throws(() => removeWorktree({ repo, dest }));
  assert.ok(fs.existsSync(path.join(dest, "node_modules", "pkg", "index.js")));
  removeWorktree({ repo, dest, force: true });
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "pkg", "index.js")));
});

test("a repo without a remote is cut from its local default branch", () => {
  const solo = path.join(root, "solo");
  git(root, "init", "-q", "-b", "trunk", solo);
  fs.writeFileSync(path.join(solo, "s.txt"), "s\n");
  git(solo, "add", "s.txt");
  git(solo, "commit", "-q", "-m", "init");
  const dest = path.join(root, "wt", "solo");
  const info = createWorktree({ repo: solo, branch: "KEY-1/Solo", dest });
  assert.equal(info.base, "trunk");
  assert.equal(info.fromRemote, false);
  assert.ok(fs.existsSync(path.join(dest, "s.txt")));
});

test("extra dependency folders can be linked", () => {
  fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(repo, "vendor", "v.txt"), "v\n");
  const dest = path.join(root, "wt", "vendored");
  const info = createWorktree({ repo, branch: "KEY-2/Vendored", dest, linkDirs: ["node_modules", "vendor"] });
  assert.deepEqual(info.linked, ["node_modules", "vendor"]);
  removeWorktree({ repo, dest, linkDirs: ["node_modules", "vendor"] });
  assert.ok(fs.existsSync(path.join(repo, "vendor", "v.txt")), "real vendor folder must survive");
});
