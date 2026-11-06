// Antigravity locations and install detection. Paths and the CLI come from the official docs
// (antigravity.google/docs: getting-started, customization-discovery, hooks, skills, subagents):
//   workspace customizations: <workspace>/.agents/      personal: ~/.gemini/config/
//   CLI binary: agy (`agy --version`); the IDE and App share the two folders above
// Everything the docs do not cover (the IDE launcher and its install folders) is labelled best effort.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MIN_CLI_VERSION = "1.2";

export const workspaceDir = (workspace) => path.join(path.resolve(workspace), ".agents");
export const globalDir = (home = os.homedir()) => path.join(home, ".gemini", "config");

// Per-surface app data folders (documented as <app_data_dir> in the hooks page)
export const appDataDirs = (home = os.homedir()) => ({
  app: path.join(home, ".gemini", "antigravity"),
  cli: path.join(home, ".gemini", "antigravity-cli"),
  ide: path.join(home, ".gemini", "antigravity-ide"),
});

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  return m ? { major: +m[1], minor: +m[2], patch: +(m[3] ?? 0), text: m[0] } : null;
}

export function meetsMinimum(version, min = MIN_CLI_VERSION) {
  const v = typeof version === "string" ? parseVersion(version) : version;
  const need = parseVersion(min);
  if (!v || !need) return false;
  return v.major !== need.major ? v.major > need.major : v.minor >= need.minor;
}

// Default install folders of `agy` from the getting-started page
export function cliCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "agy", "bin", "agy.exe")];
  }
  return [path.join(home, ".local", "bin", "agy")];
}

// Best effort only: the docs do not list IDE install folders. The first match wins.
export function ideCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Programs", "Antigravity", "Antigravity.exe")];
  }
  if (platform === "darwin") return ["/Applications/Antigravity.app", path.join(home, "Applications", "Antigravity.app")];
  return ["/usr/share/antigravity", "/opt/Antigravity", "/opt/antigravity"];
}

export function defaultRun(command, args) {
  try {
    const res = spawnSync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (res.error || res.status !== 0) return null;
    return `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  } catch {
    return null;
  }
}

// Returns what is installed, never throws. `run` and `exists` can be replaced in tests.
export function detectAntigravity({ platform = process.platform, home = os.homedir(), env = process.env, run = defaultRun, exists = fs.existsSync } = {}) {
  const notes = [];

  // CLI: ask the PATH first, then the documented default folder
  const onPath = run("agy", ["--version"]);
  const cliFile = cliCandidates({ platform, home, env }).find((p) => exists(p));
  let cliOut = onPath;
  if (!cliOut && cliFile) {
    cliOut = run(cliFile, ["--version"]);
    if (cliOut) notes.push(`agy is installed at ${cliFile} but is not on your PATH. Open a new terminal, or add that folder to PATH.`);
  }
  const cliVersion = parseVersion(cliOut);
  const cli = {
    found: Boolean(cliOut),
    onPath: Boolean(onPath),
    path: cliFile ?? null,
    version: cliVersion?.text ?? null,
    meetsMinimum: cliVersion ? meetsMinimum(cliVersion) : false,
    minimum: MIN_CLI_VERSION,
  };

  // IDE: the launcher is not documented, so a PATH hit and an install folder are both only evidence
  const launcherOut = run("antigravity", ["--version"]);
  const ideFile = ideCandidates({ platform, home, env }).find((p) => exists(p));
  const dataDir = appDataDirs(home).ide;
  const ide = {
    found: Boolean(launcherOut || ideFile),
    launcherOnPath: Boolean(launcherOut),
    path: ideFile ?? null,
    // First line of `antigravity --version` when the launcher answers; otherwise read it from Antigravity > About
    version: launcherOut ? (parseVersion(launcherOut)?.text ?? launcherOut.split("\n")[0]) : null,
    usedBefore: exists(dataDir),
    bestEffort: true,
  };

  return {
    platform,
    cli,
    ide,
    folders: { global: globalDir(home), globalExists: exists(globalDir(home)) },
    notes,
  };
}
