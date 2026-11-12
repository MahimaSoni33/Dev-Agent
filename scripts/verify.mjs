// Runs a repo's verify commands in parallel and judges failures against a cached baseline.
//   node verify.mjs check --repo <path> --dest <worktree> --base-sha <sha> --cmd "<command>" [--cmd ...]
//        [--cache <file>] [--log-dir <dir>] [--serial] [--timeout-ms 600000]
// Why: the old flow ran every command twice, one after the other (baseline, then after the change). Here the commands
// run together on the changed worktree, and only the ones that FAIL are run again on the untouched base commit
// (in a throwaway detached worktree). That result is cached by base sha + command, so it is paid at most once.
// Prints { results: [{ cmd, exitCode, ms, status, newFailures, tail }], baselineRuns, cacheHits, totalMs }.
//   status: pass | preexisting-fail (the base fails the same way) | new-fail (yours to fix)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWorktree } from "./worktree.mjs";

function run(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    const take = (d) => {
      out += d;
      if (out.length > 4_000_000) out = out.slice(-2_000_000); // keep the tail of runaway output
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ cmd, exitCode: code ?? 1, ms: Date.now() - started, output: out });
    });
  });
}

// Lines that describe a failure, without numbers, so a moved line or a new duration is not a "new" failure
export function failureLines(output) {
  const set = new Set();
  for (const raw of output.split("\n")) {
    if (!/\b(error|fail(ed|ure|ing)?|✖|×|not ok)\b/i.test(raw)) continue;
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    // summary counters ("166 problems", "Tests failed: 2") change without a new failure
    if (line && !/^(#+\s)?(problems?|tests?|test files?|errors?|failed|duration)\b/i.test(line)) set.add(line);
  }
  return set;
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
}

// Runs the given commands on a clean checkout of `sha`, then removes that checkout again
async function baselineRun({ repo, sha, cmds, timeoutMs, tmpRoot }) {
  const dest = fs.mkdtempSync(path.join(tmpRoot, "devagent-base-"));
  fs.rmdirSync(dest); // git wants to create it
  const add = spawnSync("git", ["worktree", "add", "--detach", dest, sha], { cwd: repo, encoding: "utf8" });
  if (add.status !== 0) throw new Error(`baseline checkout failed: ${add.stderr.trim()}`);
  try {
    const source = path.join(repo, "node_modules");
    if (fs.existsSync(source)) fs.symlinkSync(source, path.join(dest, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    return await Promise.all(cmds.map((c) => run(c, dest, timeoutMs)));
  } finally {
    removeWorktree({ repo, dest, force: true });
  }
}

const tail = (output, n = 30) => output.split("\n").filter((l) => l.trim()).slice(-n).join("\n");

export async function check({ repo, dest, baseSha, cmds, cacheFile, logDir, serial = false, timeoutMs = 600_000, tmpRoot = path.dirname(path.resolve(dest)) }) {
  const started = Date.now();
  repo = path.resolve(repo);
  dest = path.resolve(dest);

  const after = serial ? [] : await Promise.all(cmds.map((c) => run(c, dest, timeoutMs)));
  if (serial) for (const c of cmds) after.push(await run(c, dest, timeoutMs));

  const cache = cacheFile ? readCache(cacheFile) : {};
  const key = (cmd) => `${baseSha}::${cmd}`;
  const failed = after.filter((r) => r.exitCode !== 0);
  const missing = failed.filter((r) => !cache[key(r.cmd)]).map((r) => r.cmd);
  let baselineRuns = 0;
  if (missing.length && baseSha) {
    const runs = await baselineRun({ repo, sha: baseSha, cmds: missing, timeoutMs, tmpRoot });
    for (const r of runs) {
      cache[key(r.cmd)] = { exitCode: r.exitCode, failures: [...failureLines(r.output)], ms: r.ms, at: new Date().toISOString() };
      baselineRuns++;
    }
    if (cacheFile) writeCache(cacheFile, cache);
  }

  if (logDir) fs.mkdirSync(logDir, { recursive: true });
  const results = after.map((r, i) => {
    if (logDir) fs.writeFileSync(path.join(logDir, `${i + 1}-${r.cmd.replace(/[^\w.-]+/g, "_").slice(0, 40)}.log`), r.output);
    if (r.exitCode === 0) return { cmd: r.cmd, exitCode: 0, ms: r.ms, status: "pass", newFailures: [], tail: "" };
    const base = cache[key(r.cmd)];
    const mine = failureLines(r.output);
    const known = new Set(base?.failures ?? []);
    const fresh = [...mine].filter((l) => !known.has(l));
    // The base failed too and nothing new appears: not caused by this change
    const pre = base && base.exitCode !== 0 && fresh.length === 0;
    return { cmd: r.cmd, exitCode: r.exitCode, ms: r.ms, status: pre ? "preexisting-fail" : "new-fail", newFailures: fresh.slice(0, 10), tail: tail(r.output) };
  });
  return { results, baselineRuns, cacheHits: failed.length - missing.length, totalMs: Date.now() - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const o = { cmd: [] };
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i].replace(/^--/, "");
      if (k === "serial") o.serial = true;
      else if (k === "cmd") o.cmd.push(rest[++i]);
      else o[k] = rest[++i];
    }
    if (command !== "check" || !o.dest || !o.cmd.length) throw new Error("Usage: verify.mjs check --repo <path> --dest <worktree> --base-sha <sha> --cmd <command> [--cmd ...] [--cache f] [--log-dir d] [--serial]");
    const res = await check({
      repo: o.repo ?? o.dest,
      dest: o.dest,
      baseSha: o["base-sha"],
      cmds: o.cmd,
      cacheFile: o.cache,
      logDir: o["log-dir"],
      serial: o.serial,
      timeoutMs: o["timeout-ms"] ? Number(o["timeout-ms"]) : undefined,
    });
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
