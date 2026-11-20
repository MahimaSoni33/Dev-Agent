// PreToolUse hook for Claude Code, Antigravity and Kiro. The host sends the tool call as JSON on stdin; the event
// shape tells the providers apart (see providers/tools.mjs).
// Claude Code and Kiro block with exit code 2 and stderr; Antigravity blocks with {"decision":"deny"} on stdout.
import { check } from "./rules.mjs";
import { expandToolCalls, verdict } from "../providers/tools.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let event;
try {
  event = JSON.parse(raw);
} catch {
  // Nothing to judge without a readable event
  console.error("dev-agent guard: could not read the hook input, allowing the call");
  process.exit(0);
}

// The first call the rules object to decides; a Kiro read of several files is judged file by file
const calls = expandToolCalls(event);
const hit = calls.map((c) => ({ provider: c.provider, reason: check(c.tool, c.input, process.env) })).find((r) => r.reason);
const { stdout, stderr, code } = verdict(hit?.provider ?? calls[0].provider, hit?.reason ?? null);
if (stdout) console.log(stdout);
if (stderr) console.error(stderr);
process.exit(code);
