// PreToolUse hook for Claude Code and Antigravity. The host sends the tool call as JSON on stdin; the event
// shape tells the providers apart (see providers/tools.mjs).
// Claude Code blocks with exit code 2 and stderr; Antigravity blocks with {"decision":"deny"} on stdout.
import { check } from "./rules.mjs";
import { normalizeToolCall, verdict } from "../providers/tools.mjs";

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

const { provider, tool, input } = normalizeToolCall(event);
const { stdout, stderr, code } = verdict(provider, check(tool, input, process.env));
if (stdout) console.log(stdout);
if (stderr) console.error(stderr);
process.exit(code);
