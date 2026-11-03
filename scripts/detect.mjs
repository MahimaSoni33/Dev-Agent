// Read-only profile of one repo: stack, package manager, verify candidates, instruction files.
//   node detect.mjs <repo path>
// Prints one JSON object. Config values always win over what is detected here (see config.mjs).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const has = (dir, ...parts) => fs.existsSync(path.join(dir, ...parts));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

function nodeProfile(dir) {
  const pm = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : has(dir, "bun.lockb") ? "bun" : "npm";
  let scripts = {};
  try {
    scripts = readJson(path.join(dir, "package.json")).scripts ?? {};
  } catch {
    // An unreadable package.json just means no detected commands
  }
  const verify = ["lint", "typecheck", "build", "test"].filter((n) => scripts[n]).map((n) => `${pm} run ${n}`);
  return { stack: "node", packageManager: pm, verify, run: scripts.dev ? [`${pm} run dev`] : [] };
}

// One entry per marker file; the first matching marker of each stack wins
const STACKS = [
  ["package.json", nodeProfile],
  ["go.mod", () => ({ stack: "go", verify: ["go vet ./...", "go test ./..."] })],
  ["Cargo.toml", () => ({ stack: "rust", verify: ["cargo build", "cargo test"] })],
  ["pom.xml", () => ({ stack: "java", verify: ["mvn -q test"] })],
  ["build.gradle", () => ({ stack: "java", verify: ["gradle test"] })],
  ["build.gradle.kts", () => ({ stack: "java", verify: ["gradle test"] })],
  ["pyproject.toml", () => ({ stack: "python", verify: ["python -m pytest"] })],
  ["requirements.txt", () => ({ stack: "python", verify: ["python -m pytest"] })],
  ["Gemfile", () => ({ stack: "ruby", verify: ["bundle exec rake test"] })],
  ["composer.json", () => ({ stack: "php", verify: ["composer test"] })],
];

function makeTargets(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
    return ["lint", "build", "test"].filter((t) => new RegExp(`^${t}:`, "m").test(text)).map((t) => `make ${t}`);
  } catch {
    return [];
  }
}

function instructionFiles(dir) {
  const found = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "README.md"].filter((f) => has(dir, f));
  const skills = path.join(dir, ".claude", "skills");
  if (fs.existsSync(skills)) {
    for (const name of fs.readdirSync(skills)) {
      const file = `.claude/skills/${name}/SKILL.md`;
      if (/task|pr/i.test(name) && has(dir, file)) found.unshift(file);
    }
  }
  return found;
}

export function detectRepo(repoPath) {
  const dir = path.resolve(repoPath);
  const stacks = [];
  const profile = { stack: [], packageManager: null, verify: [], run: [] };
  for (const [marker, fn] of STACKS) {
    if (!has(dir, marker)) continue;
    const found = fn(dir);
    if (stacks.includes(found.stack)) continue;
    stacks.push(found.stack);
    profile.packageManager ??= found.packageManager ?? null;
    profile.verify.push(...found.verify);
    profile.run.push(...(found.run ?? []));
  }
  profile.stack = stacks;
  if (!profile.verify.length) profile.verify = makeTargets(dir);
  profile.instructions = instructionFiles(dir);
  // Hints for the manual-checks list: checks that need secrets or running services
  profile.needsEnv = [".env.example", ".env.sample", ".env.template"].some((f) => has(dir, f));
  profile.usesCompose = fs.readdirSync(dir).some((f) => /^(docker-)?compose.*\.ya?ml$/i.test(f));
  return profile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(detectRepo(process.argv[2] ?? "."), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
