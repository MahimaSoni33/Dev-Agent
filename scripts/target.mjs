// Decides where the agent's code changes go: the developer's own checkout ("in-place") or a separate git
// worktree ("worktree"). One strategy per mode behind prepareTarget(), so no other file branches on the mode.
//   node target.mjs inspect   --repo <path>
//   node target.mjs prepare   --mode in-place|worktree --repo <path> --branch <name> [--key <KEY>] [--base <branch>]
//                             [--dirty continue|stash|cancel] [--offline skip] [--yes] [--run-dir <dir>]
//                             [--dest <path>] [--link-dirs a,b | --no-link-deps]   (worktree mode only)
//   node target.mjs summarize --repo <path> [--base-sha <sha>] [--restore <restore.json>] [--reported a,b] [--branch <name>] [--mode ...]
// Prints one JSON object. `prepare` answers { status: "ready" | "needs-input" | "stopped", ... }: needs-input means
// "ask the developer, then run it again with the answer"; nothing has been changed when it says so.
// In-place mode never commits or pushes. It switches branches only after the developer chose in-place and the base.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWorktree, git, mustGit } from "./worktree.mjs";

const IN_PROGRESS = {
  MERGE_HEAD: "a merge",
  CHERRY_PICK_HEAD: "a cherry-pick",
  REVERT_HEAD: "a revert",
  BISECT_LOG: "a bisect",
  "rebase-merge": "a rebase",
  "rebase-apply": "a rebase",
};
const NETWORK = /Could not resolve host|unable to access|Could not read from remote|Connection (timed out|refused)|Network is unreachable|Failed to connect/i;
const norm = (p) => p.replace(/\\/g, "/");

// Uncommitted paths, untracked ones included. Read raw: git() trims, which would eat the first line's status column.
function dirtyFiles(top) {
  const res = spawnSync("git", ["status", "--porcelain", "-z", "-uall"], { cwd: top, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parts = (res.stdout ?? "").split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    files.push(norm(parts[i].slice(3)));
    if (/[RC]/.test(parts[i].slice(0, 2))) i++; // a rename lists the old name next
  }
  return files;
}

// Content hash of a file in the working tree, null when it does not exist (deleted)
function fileHash(top, rel) {
  if (!fs.existsSync(path.join(top, rel))) return null;
  const res = git(top, ["hash-object", "--", rel]);
  return res.ok ? res.out : null;
}

const refExists = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--quiet", ref]).ok;

function baseCandidates(top) {
  const names = [];
  const head = git(top, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok) names.push(head.out.replace(/^origin\//, ""));
  for (const n of ["main", "develop", "master"]) {
    if (refExists(top, `refs/heads/${n}`) || refExists(top, `refs/remotes/origin/${n}`)) names.push(n);
  }
  return [...new Set(names)];
}

export function inspectRepo(repo) {
  repo = path.resolve(repo);
  mustGit(repo, ["rev-parse", "--is-inside-work-tree"]);
  const top = mustGit(repo, ["rev-parse", "--show-toplevel"]);
  const gitDir = mustGit(repo, ["rev-parse", "--absolute-git-dir"]);
  const marker = Object.keys(IN_PROGRESS).find((n) => fs.existsSync(path.join(gitDir, n)));
  return {
    top,
    branch: git(top, ["branch", "--show-current"]).out, // empty when HEAD is detached
    head: git(top, ["rev-parse", "HEAD"]).out,
    state: marker ? IN_PROGRESS[marker] : null,
    dirty: dirtyFiles(top),
    candidates: baseCandidates(top),
    hasOrigin: git(top, ["remote"]).out.split(/\s+/).includes("origin"),
  };
}

// Commands that put the developer back where they started. The agent's work is stashed, never deleted.
function rollbackCommands({ key, branch, originalBranch, stashName }) {
  return [
    `git stash push -u -m "dev-agent changes: ${key}"   # keeps the agent's uncommitted work safe`,
    `git switch ${originalBranch}`,
    `git branch -D ${branch}   # optional: removes the feature branch (unpushed commits on it are lost)`,
    ...(stashName ? [`git stash list   # then: git stash pop <the entry named "${stashName}"> to get your own work back`] : []),
  ];
}

function prepareInPlace({ repo, branch, base, dirty, offline, yes = false, key = "task", runDir }) {
  const info = inspectRepo(repo);
  const { top } = info;
  const stop = (reason) => ({ status: "stopped", reason });

  if (info.state) return stop(`The repo is in the middle of ${info.state}. Finish or abort it first.`);
  if (!info.branch) return stop("HEAD is detached. Switch to a branch first, then run again.");
  if (!info.head) return stop("The repo has no commits yet.");
  mustGit(top, ["check-ref-format", "--branch", branch]);

  if (info.dirty.length) {
    const choice = dirty ?? (yes ? "cancel" : null); // an unattended run never decides for the developer
    if (!choice) return { status: "needs-input", need: "dirty", files: info.dirty, options: ["continue", "stash", "cancel"] };
    if (choice === "cancel") return stop("Cancelled: the working tree has uncommitted changes.");
    if (!["continue", "stash"].includes(choice)) throw new Error(`--dirty must be continue, stash or cancel, not "${choice}"`);
  }
  if (!base) return { status: "needs-input", need: "base", current: info.branch, candidates: info.candidates };
  const localBase = refExists(top, `refs/heads/${base}`);
  if (!localBase && !refExists(top, `refs/remotes/origin/${base}`)) return stop(`Base branch "${base}" was not found locally or on origin.`);
  if (refExists(top, `refs/heads/${branch}`)) {
    let n = 2;
    while (refExists(top, `refs/heads/${branch}-${n}`)) n++;
    return { status: "needs-input", need: "branch-name", taken: branch, suggestion: `${branch}-${n}` };
  }

  // Everything is decided. From here on the checkout changes, and a failure puts it back as it was.
  const restore = { originalBranch: info.branch, originalHead: info.head, stashName: null, stashRef: null, preexisting: {} };
  if (dirty === "stash" && info.dirty.length) {
    restore.stashName = `dev-agent: before ${key}`;
    mustGit(top, ["stash", "push", "-u", "-m", restore.stashName]);
    restore.stashRef = mustGit(top, ["rev-parse", "stash@{0}"]);
  } else {
    for (const f of info.dirty) restore.preexisting[f] = fileHash(top, f); // told apart from the agent's edits later
  }
  const undo = () => {
    if (git(top, ["branch", "--show-current"]).out !== info.branch) git(top, ["switch", info.branch]);
    if (restore.stashRef) git(top, ["stash", "pop"]);
  };
  const fail = (reason) => {
    undo();
    return stop(`${reason} Nothing was changed.`);
  };

  if (info.branch !== base) {
    const sw = git(top, localBase ? ["switch", base] : ["switch", "--no-track", "-c", base, `origin/${base}`]);
    if (!sw.ok) return fail(`Could not switch to ${base}: ${sw.err}.`);
  }

  let pull = "skipped (no origin remote)";
  if (info.hasOrigin && offline !== "skip") {
    const res = git(top, ["pull", "--ff-only", "origin", base]);
    if (res.ok) pull = /Already up to date/i.test(`${res.out}\n${res.err}`) ? "up-to-date" : "fast-forwarded";
    else if (NETWORK.test(res.err)) {
      undo();
      return { status: "needs-input", need: "offline", error: res.err, options: ["skip", "cancel"] };
    } else return fail(`git pull --ff-only origin ${base} failed (the branch cannot fast-forward, or local changes are in the way): ${res.err}.`);
  } else if (info.hasOrigin) pull = "skipped (offline: the local base was used)";

  const created = git(top, ["switch", "--no-track", "-c", branch]);
  if (!created.ok) return fail(`Could not create branch ${branch}: ${created.err}.`);

  const baseSha = mustGit(top, ["rev-parse", "HEAD"]);
  if (runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "restore.json"), JSON.stringify({ ...restore, branch, base, baseSha }, null, 2));
  }
  return {
    status: "ready",
    mode: "in-place",
    dest: top,
    branch,
    base,
    baseSha,
    pull,
    restore,
    rollback: rollbackCommands({ key, branch, originalBranch: info.branch, stashName: restore.stashName }),
  };
}

function prepareWorktree({ repo, branch, dest, base, linkDirs }) {
  if (!dest) throw new Error("--dest is required in worktree mode");
  const made = createWorktree({ repo, branch, dest, base, linkDirs });
  return {
    status: "ready",
    mode: "worktree",
    dest: made.dest,
    branch,
    base: made.base,
    baseSha: made.baseSha,
    pull: made.fromRemote ? "fetched" : "skipped (no origin remote)",
    restore: null,
    rollback: [`node scripts/worktree.mjs remove --repo "${made.repo}" --dest "${made.dest}"   # the branch is kept`],
  };
}

export const strategies = {
  "in-place": { prepare: prepareInPlace },
  worktree: { prepare: prepareWorktree },
};

export function prepareTarget(mode, opts) {
  const strategy = strategies[mode];
  if (!strategy) throw new Error(`Unknown change target "${mode}". Use in-place or worktree.`);
  return strategy.prepare(opts);
}

// What the agent changed since baseSha, and where it lives. The same for both modes.
export function summarize({ dest, baseSha, mode = "in-place", branch, restore, reported }) {
  const top = mustGit(path.resolve(dest), ["rev-parse", "--show-toplevel"]);
  const ref = baseSha ?? "HEAD";
  const preexisting = restore?.preexisting ?? {};
  const kind = new Map();
  const nameStatus = spawnSync("git", ["diff", "--name-status", "--no-renames", ref], { cwd: top, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [code, file] = line.split("\t");
    kind.set(norm(file), code === "A" ? "added" : code === "D" ? "deleted" : "modified");
  }
  const untracked = git(top, ["ls-files", "--others", "--exclude-standard"]).out.split("\n").filter(Boolean);
  for (const file of untracked) kind.set(norm(file), "added");

  const yours = []; // dirty before the run and untouched by the agent
  const onTopOfYours = []; // dirty before the run and edited again by the agent
  const files = { modified: [], added: [], deleted: [] };
  for (const [file, k] of kind) {
    if (file in preexisting) {
      if (fileHash(top, file) === preexisting[file]) {
        yours.push(file);
        continue;
      }
      onTopOfYours.push(file);
    }
    files[k].push(file);
  }
  const mine = Object.values(files).flat();
  const unreported = reported ? mine.filter((f) => !reported.map(norm).includes(f)) : [];

  const tracked = mine.filter((f) => !untracked.map(norm).includes(f));
  const diffStat = tracked.length ? (spawnSync("git", ["diff", "--stat", ref, "--", ...tracked], { cwd: top, encoding: "utf8" }).stdout ?? "").trimEnd() : "";
  const location = mode === "worktree" ? `the worktree ${top}` : `your working folder ${top}`;
  return { mode, location, branch: branch ?? git(top, ["branch", "--show-current"]).out, files, diffStat, yours, onTopOfYours, unreported };
}

export function formatSummary(s) {
  const list = (title, arr) => (arr.length ? [`${title} (${arr.length}):`, ...arr.map((f) => `  ${f}`)] : []);
  return [
    `Changes are in ${s.location}, on branch ${s.branch}.`,
    ...list("Modified", s.files.modified),
    ...list("Added", s.files.added),
    ...list("Deleted", s.files.deleted),
    ...(s.diffStat ? ["", s.diffStat] : []),
    ...(s.onTopOfYours.length ? ["", "The agent also edited files you had already changed (review these closely):", ...s.onTopOfYours.map((f) => `  ${f}`)] : []),
    ...(s.yours.length ? ["", `Your own uncommitted files, untouched by the agent (${s.yours.length}): ${s.yours.join(", ")}`] : []),
    ...(s.unreported.length ? ["", "Changed but not in the builder's report (edited by you during the run?):", ...s.unreported.map((f) => `  ${f}`)] : []),
  ].join("\n");
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
    if (command === "inspect") {
      result = inspectRepo(opts.repo);
    } else if (command === "prepare") {
      result = prepareTarget(opts.mode ?? "in-place", {
        repo: opts.repo,
        branch: opts.branch,
        base: opts.base,
        dest: opts.dest,
        linkDirs: opts["no-link-deps"] ? [] : typeof opts["link-dirs"] === "string" ? opts["link-dirs"].split(",") : undefined,
        key: opts.key,
        dirty: opts.dirty,
        offline: opts.offline,
        yes: opts.yes === true,
        runDir: opts["run-dir"],
      });
    } else if (command === "summarize") {
      const restore = opts.restore ? JSON.parse(fs.readFileSync(opts.restore, "utf8")) : undefined;
      result = summarize({
        dest: opts.repo,
        baseSha: opts["base-sha"] ?? restore?.baseSha,
        mode: opts.mode,
        branch: opts.branch ?? restore?.branch,
        restore,
        reported: opts.reported ? opts.reported.split(",") : undefined,
      });
      result.text = formatSummary(result);
    } else {
      throw new Error("Usage: target.mjs inspect|prepare|summarize --repo <path> ...");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
