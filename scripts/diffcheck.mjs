// Deterministic review of one worktree's uncommitted change: the reviewer for simple tasks, no LLM call.
//   node diffcheck.mjs --dest <worktree> [--plan-files a,b] [--max-files 5] [--max-lines 200]
// Prints { verdict: "pass"|"changes-needed", files, added, removed, findings: [{severity, file, message}] }.
// Checks what a script can know: planned files, secrets, build output, leftovers, reformat-only edits, size.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isSecretFile } from "../hooks/rules.mjs";

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
  return res.stdout;
}

const norm = (p) => p.replace(/\\/g, "/");
const GENERATED = /(^|\/)(node_modules|dist|build|coverage|\.next|__pycache__|vendor|\.venv|target)\//;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|go\.sum)$/;
const LEFTOVERS = [
  [/^\+.*\bconsole\.(log|debug)\(/, "console.log added"],
  [/^\+\s*debugger\b/, "debugger statement added"],
  [/^\+.*\b(it|test|describe)\.only\(/, "focused test (.only) added"],
  [/^\+.*\b(TODO|FIXME|XXX)\b/, "TODO or FIXME added"],
  [/^\+.*(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"']{8,}["'])/i, "possible hardcoded secret"],
];

export function diffCheck({ dest, planFiles = [], maxFiles = 5, maxLines = 200 }) {
  dest = path.resolve(dest);
  const findings = [];
  const add = (severity, file, message) => findings.push({ severity, file, message });

  // New files count too: they show up as untracked, not in `git diff`
  const status = git(dest, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean);
  const files = status.map((l) => norm(l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")));
  const untracked = new Set(status.filter((l) => l.startsWith("??")).map((l) => norm(l.slice(3))));

  const stat = git(dest, ["diff", "HEAD", "--numstat"]).split("\n").filter(Boolean).map((l) => l.split("\t"));
  const loose = new Set(git(dest, ["diff", "HEAD", "--numstat", "-w", "--ignore-blank-lines"]).split("\n").filter(Boolean).map((l) => l.split("\t")[2]));
  let added = 0;
  let removed = 0;
  for (const [a, r, file] of stat) {
    added += Number(a) || 0;
    removed += Number(r) || 0;
    // The file changed, but not once whitespace is ignored: a reformat, not a change
    if (Number(a) + Number(r) > 0 && !loose.has(file)) add("blocking", norm(file), "whitespace-only change (reformatting the task did not ask for)");
  }

  const patch = git(dest, ["diff", "HEAD", "-U0"]);
  let current = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) current = norm(line.slice(6));
    for (const [re, message] of LEFTOVERS) if (re.test(line)) add(/secret/.test(message) ? "blocking" : "minor", current, message);
  }

  // New files are not in the patch: scan their content the same way
  for (const file of untracked) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dest, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      for (const [re, message] of LEFTOVERS) if (re.test(`+${line}`)) add(/secret/.test(message) ? "blocking" : "minor", file, message);
    }
  }

  const planned = new Set(planFiles.map(norm));
  for (const file of files) {
    if (isSecretFile(file)) add("blocking", file, "secret file in the change");
    if (GENERATED.test(file)) add("blocking", file, "build output or installed dependencies in the change");
    if (LOCKFILE.test(file)) add("minor", file, "lockfile changed: confirm the task needed a dependency change");
    if (planned.size && !planned.has(file) && !untracked.has(file)) add("minor", file, "file is not in the plan");
    if (planned.size && !planned.has(file) && untracked.has(file)) add("minor", file, "new file is not in the plan");
  }
  if (files.length > maxFiles) add("minor", "-", `${files.length} files changed (limit ${maxFiles} for a simple task): re-triage as medium`);
  if (added + removed > maxLines) add("minor", "-", `${added + removed} lines changed (limit ${maxLines} for a simple task): re-triage as medium`);
  if (!files.length) add("blocking", "-", "no changes in the worktree");

  const blocking = findings.some((f) => f.severity === "blocking");
  return { verdict: blocking ? "changes-needed" : "pass", files, added, removed, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const o = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`Bad argument: ${argv[i]}`);
      o[argv[i].slice(2)] = argv[i + 1];
    }
    if (!o.dest) throw new Error("Usage: diffcheck.mjs --dest <worktree> [--plan-files a,b] [--max-files n] [--max-lines n]");
    console.log(
      JSON.stringify(
        diffCheck({
          dest: o.dest,
          planFiles: o["plan-files"] ? o["plan-files"].split(",") : [],
          maxFiles: o["max-files"] ? Number(o["max-files"]) : undefined,
          maxLines: o["max-lines"] ? Number(o["max-lines"]) : undefined,
        }),
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
