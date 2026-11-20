// Kiro locations and install detection. Kiro has two surfaces that share one account: the CLI (`kiro-cli`) and
// the IDE. Documented (kiro.dev/docs/cli): `kiro-cli --version`, `kiro-cli whoami`, headless mode with the
// KIRO_API_KEY environment variable (CLI 2.0 and later), project files under .kiro/ and personal ones under ~/.kiro/.
// Everything the docs do not cover (where the IDE and the CLI install to) is labelled best effort.
// This file never reads the value of KIRO_API_KEY: it only reports whether the variable is set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRun, meetsMinimum, parseVersion } from "./antigravity.mjs";

// Headless mode and API-key sign-in arrived with CLI 2.0
export const MIN_CLI_VERSION = "2.0";

export const workspaceDir = (workspace) => path.join(path.resolve(workspace), ".kiro");
export const globalDir = (home = os.homedir()) => path.join(home, ".kiro");

// Best effort: the docs do not list install folders. The first match wins.
export function cliCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Programs", "Kiro CLI", "kiro-cli.exe"), path.join(home, ".local", "bin", "kiro-cli.exe")];
  }
  return [path.join(home, ".local", "bin", "kiro-cli")];
}

// Best effort, as above
export function ideCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Programs", "Kiro", "Kiro.exe")];
  }
  if (platform === "darwin") return ["/Applications/Kiro.app", path.join(home, "Applications", "Kiro.app")];
  return ["/usr/share/kiro", "/opt/Kiro", "/opt/kiro"];
}

// Is the CLI signed in? `kiro-cli whoami` is the documented way to ask; its wording is not documented, so only
// "it answered" is trusted and the first line is passed on as text. A browser sign-in wins over the API key.
export function authState({ env = process.env, run = defaultRun } = {}) {
  const apiKeySet = typeof env.KIRO_API_KEY === "string" && env.KIRO_API_KEY.length > 0;
  const out = run("kiro-cli", ["whoami"]);
  return {
    signedIn: Boolean(out),
    whoami: out ? out.split("\n")[0].slice(0, 200) : null,
    apiKeySet,
  };
}

// Returns what is installed, never throws. `run` and `exists` can be replaced in tests.
export function detectKiro({ platform = process.platform, home = os.homedir(), env = process.env, run = defaultRun, exists = fs.existsSync } = {}) {
  const notes = [];

  const onPath = run("kiro-cli", ["--version"]);
  const cliFile = cliCandidates({ platform, home, env }).find((p) => exists(p));
  let cliOut = onPath;
  if (!cliOut && cliFile) {
    cliOut = run(cliFile, ["--version"]);
    if (cliOut) notes.push(`kiro-cli is installed at ${cliFile} but is not on your PATH. Open a new terminal, or add that folder to PATH.`);
  }
  const v = parseVersion(cliOut);
  const cli = {
    found: Boolean(cliOut),
    onPath: Boolean(onPath),
    path: cliFile ?? null,
    version: v?.text ?? null,
    meetsMinimum: v ? meetsMinimum(v, MIN_CLI_VERSION) : false,
    minimum: MIN_CLI_VERSION,
  };

  // IDE: its launcher is `kiro`; a PATH hit and an install folder are both only evidence
  const launcherOut = run("kiro", ["--version"]);
  const ideFile = ideCandidates({ platform, home, env }).find((p) => exists(p));
  const ide = {
    found: Boolean(launcherOut || ideFile),
    launcherOnPath: Boolean(launcherOut),
    path: ideFile ?? null,
    version: launcherOut ? (parseVersion(launcherOut)?.text ?? launcherOut.split("\n")[0]) : null,
    usedBefore: exists(globalDir(home)),
    bestEffort: true,
  };

  return {
    platform,
    cli,
    ide,
    auth: cli.found ? authState({ env, run }) : null,
    folders: { global: globalDir(home), globalExists: exists(globalDir(home)) },
    notes,
  };
}
