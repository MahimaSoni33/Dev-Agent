// Creates and removes the git worktrees the agent builds in. The developer's own checkout is never touched.
//   node worktree.mjs create --repo <path> --branch <name> --dest <path> [--base main] [--no-link-deps]
//   node worktree.mjs remove --repo <path> --dest <path> [--force]
// Prints one JSON object. Exits 1 with a message on stderr when something is wrong.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
}

function mustGit(cwd, args) {
  const res = git(cwd, args);
  if (!res.ok) throw new Error(`git ${args.join(" ")} failed: ${res.err || res.out}`);
  return res.out;
}

export function createWorktree({ repo, branch, dest, base = "main", linkDeps = true }) {
  repo = path.resolve(repo);
  dest = path.resolve(dest);

  mustGit(repo, ["rev-parse", "--is-inside-work-tree"]);
  mustGit(repo, ["check-ref-format", "--branch", branch]);
  if (fs.existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    throw new Error(`Branch already exists: ${branch}`);
  }

  // Always cut from the freshly fetched remote base, never from a stale local one
  mustGit(repo, ["fetch", "origin", base]);
  const baseSha = mustGit(repo, ["rev-parse", `origin/${base}`]);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  mustGit(repo, ["worktree", "add", "--no-track", "-b", branch, dest, `origin/${base}`]);

  // Reuse the installed packages instead of installing again
  let depsLinked = false;
  const modules = path.join(repo, "node_modules");
  if (linkDeps && fs.existsSync(modules)) {
    fs.symlinkSync(modules, path.join(dest, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    depsLinked = true;
  }

  return { repo, branch, base, baseSha, dest, depsLinked };
}

export function removeWorktree({ repo, dest, force = false }) {
  repo = path.resolve(repo);
  dest = path.resolve(dest);

  // Remove the link first so nothing can follow it into the real node_modules
  const link = path.join(dest, "node_modules");
  const target = fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : null;
  if (target) fs.unlinkSync(link);

  try {
    mustGit(repo, ["worktree", "remove", ...(force ? ["--force"] : []), dest]);
  } catch (err) {
    // A refused removal (for example uncommitted work) must leave the worktree usable
    if (target) fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    throw err;
  }
  mustGit(repo, ["worktree", "prune"]);
  return { removed: dest, branchKept: true };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) throw new Error(`Unexpected argument: ${rest[i]}`);
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else opts[key] = rest[++i];
  }
  return { command, opts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { command, opts } = parseArgs(process.argv.slice(2));
    let result;
    if (command === "create") {
      result = createWorktree({
        repo: opts.repo,
        branch: opts.branch,
        dest: opts.dest,
        base: opts.base ?? "main",
        linkDeps: !opts["no-link-deps"],
      });
    } else if (command === "remove") {
      result = removeWorktree({ repo: opts.repo, dest: opts.dest, force: Boolean(opts.force) });
    } else {
      throw new Error("Usage: worktree.mjs create|remove --repo <path> --dest <path> ...");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
