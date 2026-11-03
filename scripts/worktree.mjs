// Creates and removes the git worktrees the agent builds in. The developer's own checkout is never touched.
//   node worktree.mjs create --repo <path> --branch <name> --dest <path> [--base <branch>] [--link-dirs a,b | --no-link-deps]
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

const linkType = process.platform === "win32" ? "junction" : "dir";

// The repo's default branch: origin/HEAD, else a local main or master, else the checked-out branch
function defaultBase(repo) {
  const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok) return head.out.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok) return name;
  }
  return mustGit(repo, ["branch", "--show-current"]);
}

export function createWorktree({ repo, branch, dest, base, linkDirs = ["node_modules"] }) {
  repo = path.resolve(repo);
  dest = path.resolve(dest);

  mustGit(repo, ["rev-parse", "--is-inside-work-tree"]);
  mustGit(repo, ["check-ref-format", "--branch", branch]);
  if (fs.existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    throw new Error(`Branch already exists: ${branch}`);
  }

  base ??= defaultBase(repo);
  // Cut from the freshly fetched remote base when there is a remote, never from a stale local one
  const hasOrigin = git(repo, ["remote"]).out.split(/\s+/).includes("origin");
  if (hasOrigin) mustGit(repo, ["fetch", "origin", base]);
  const startPoint = hasOrigin ? `origin/${base}` : base;
  const baseSha = mustGit(repo, ["rev-parse", startPoint]);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  mustGit(repo, ["worktree", "add", "--no-track", "-b", branch, dest, startPoint]);

  // Reuse the installed packages instead of installing again
  const linked = [];
  for (const dir of linkDirs) {
    const source = path.join(repo, dir);
    if (!fs.existsSync(source)) continue;
    fs.symlinkSync(source, path.join(dest, dir), linkType);
    linked.push(dir);
  }

  return { repo, branch, base, baseSha, dest, depsLinked: linked.length > 0, linked, fromRemote: hasOrigin };
}

export function removeWorktree({ repo, dest, force = false, linkDirs = ["node_modules"] }) {
  repo = path.resolve(repo);
  dest = path.resolve(dest);

  // Remove the links first so nothing can follow them into the real folders
  const links = [];
  for (const dir of linkDirs) {
    const link = path.join(dest, dir);
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
      links.push([link, fs.readlinkSync(link)]);
      fs.unlinkSync(link);
    }
  }

  try {
    mustGit(repo, ["worktree", "remove", ...(force ? ["--force"] : []), dest]);
  } catch (err) {
    // A refused removal (for example uncommitted work) must leave the worktree usable
    for (const [link, target] of links) fs.symlinkSync(target, link, linkType);
    throw err;
  }
  mustGit(repo, ["worktree", "prune"]);
  return { removed: dest, branchKept: true };
}

// --no-link-deps links nothing; --link-dirs a,b replaces the default list
function linkDirs(opts) {
  if (opts["no-link-deps"]) return [];
  return typeof opts["link-dirs"] === "string" ? opts["link-dirs"].split(",") : undefined;
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
        base: opts.base,
        linkDirs: linkDirs(opts),
      });
    } else if (command === "remove") {
      result = removeWorktree({ repo: opts.repo, dest: opts.dest, force: Boolean(opts.force), linkDirs: linkDirs(opts) });
    } else {
      throw new Error("Usage: worktree.mjs create|remove --repo <path> --dest <path> ...");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
