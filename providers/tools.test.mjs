import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { check } from "../hooks/rules.mjs";
import { expandToolCalls, normalizeToolCall, verdict } from "./tools.mjs";

const guard = (event) =>
  spawnSync("node", [new URL("../hooks/guard.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], {
    input: JSON.stringify(event),
    encoding: "utf8",
  });
const ag = (name, args) => ({ toolCall: { name, args }, stepIdx: 1 });

test("Antigravity tool calls are normalised to the names the rules know", () => {
  assert.deepEqual(normalizeToolCall(ag("run_command", { CommandLine: "git push" })), {
    provider: "antigravity",
    tool: "Bash",
    input: { command: "git push" },
  });
  assert.equal(normalizeToolCall(ag("view_file", { AbsolutePath: "/a/.env" })).tool, "Read");
  assert.equal(normalizeToolCall({ tool_name: "Bash", tool_input: { command: "ls" } }).provider, "claude");
});

test("the same rules block the same actions on both providers", () => {
  const blockedCalls = [
    ag("run_command", { CommandLine: "cd x && git push origin main" }),
    ag("view_file", { AbsolutePath: "C:/repo/.env.local" }),
    ag("write_to_file", { TargetFile: "/repo/node_modules/a/index.js" }),
  ];
  for (const event of blockedCalls) {
    const { tool, input } = normalizeToolCall(event);
    assert.ok(check(tool, input, {}), `should block ${event.toolCall.name}`);
  }
  const ok = normalizeToolCall(ag("run_command", { CommandLine: "git status --short" }));
  assert.equal(check(ok.tool, ok.input, {}), null);
  const example = normalizeToolCall(ag("view_file", { AbsolutePath: "/repo/.env.example" }));
  assert.equal(check(example.tool, example.input, {}), null);
});

test("a search for the text .env is not treated as reading a secret file", () => {
  const call = normalizeToolCall(ag("grep_search", { SearchPath: "/repo/src", Query: ".env" }));
  assert.equal(check(call.tool, call.input, {}), null);
});

test("verdicts follow each provider's contract", () => {
  assert.deepEqual(verdict("claude", "no"), { stdout: "", stderr: "Blocked by dev-agent: no", code: 2 });
  assert.equal(verdict("claude", null).code, 0);
  const deny = verdict("antigravity", "no");
  assert.equal(deny.code, 0);
  assert.deepEqual(JSON.parse(deny.stdout), { decision: "deny", reason: "Blocked by dev-agent: no" });
  assert.deepEqual(JSON.parse(verdict("antigravity", null).stdout), { decision: "allow" });
});

test("guard.mjs end to end", () => {
  const claude = guard({ tool_name: "Bash", tool_input: { command: "git push" } });
  assert.equal(claude.status, 2);
  const blocked = guard(ag("run_command", { CommandLine: "git push" }));
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, "deny");
  assert.equal(JSON.parse(guard(ag("run_command", { CommandLine: "git status" })).stdout).decision, "allow");
});

const kiro = (tool_name, tool_input) => ({ hook_event_name: "preToolUse", cwd: "/repo", tool_name, tool_input });

test("Kiro tool calls are normalised and judged by the same rules", () => {
  const push = normalizeToolCall(kiro("execute_bash", { command: "git push origin main" }));
  assert.deepEqual(push, { provider: "kiro", tool: "Bash", input: { command: "git push origin main" } });
  assert.ok(check(push.tool, push.input, {}));
  assert.equal(normalizeToolCall(kiro("fs_write", { command: "create", path: "/r/a.js" })).tool, "Write");
  assert.equal(normalizeToolCall(kiro("fs_write", { command: "str_replace", path: "/r/a.js" })).tool, "Edit");
  const env = normalizeToolCall(kiro("fs_read", { operations: [{ mode: "Line", path: "/repo/.env.local" }] }));
  assert.ok(check(env.tool, env.input, {}));
  const ok = normalizeToolCall(kiro("execute_bash", { command: "git status" }));
  assert.equal(check(ok.tool, ok.input, {}), null);
});

test("a Kiro read of several files is judged file by file", () => {
  const calls = expandToolCalls(kiro("fs_read", { operations: [{ path: "/repo/a.js" }, { path: "/repo/.env" }] }));
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((c) => check(c.tool, c.input, {})).length, 1);
});

test("Claude tool names are not mistaken for Kiro ones", () => {
  assert.equal(normalizeToolCall({ tool_name: "Bash", tool_input: { command: "ls" } }).provider, "claude");
  assert.equal(normalizeToolCall({ tool_name: "toString", tool_input: {} }).provider, "claude");
});

test("Kiro blocks with exit code 2 and the reason on stderr", () => {
  assert.deepEqual(verdict("kiro", "no"), { stdout: "", stderr: "Blocked by dev-agent: no", code: 2 });
  assert.equal(verdict("kiro", null).code, 0);
});

test("guard.mjs end to end for Kiro", () => {
  assert.equal(guard(kiro("execute_bash", { command: "git push" })).status, 2);
  assert.equal(guard(kiro("fs_read", { operations: [{ path: "/a.js" }, { path: "/x/.env" }] })).status, 2);
  assert.equal(guard(kiro("execute_bash", { command: "git status" })).status, 0);
});
