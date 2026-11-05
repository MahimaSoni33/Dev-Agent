// Stop / SubagentStop hook: records the session's token usage under runs/<ticket>/usage.json.
// Never blocks the agent: any problem is reported on stderr and the exit code stays 0.
import { recordSession, sessionFromClaudeEvent } from "../providers/usage.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  const session = event.toolCall || event.toolCalls ? null : sessionFromClaudeEvent(event);
  if (session) recordSession(session);
} catch (err) {
  console.error(`dev-agent usage: ${err.message}`);
}
process.exit(0);
