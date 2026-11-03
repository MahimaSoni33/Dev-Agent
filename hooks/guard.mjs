// PreToolUse hook. Claude Code sends the tool call as JSON on stdin.
// Exit code 2 blocks the call and shows stderr to the model.
import { check } from "./rules.mjs";

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

const reason = check(event.tool_name, event.tool_input ?? {}, process.env);
if (reason) {
  console.error(`Blocked by dev-agent: ${reason}`);
  process.exit(2);
}
process.exit(0);
