// Kiro stop hook (CLI custom agent hook and IDE "agent stop" hook): records one more request for the session
// under runs/<ticket>/usage.json and usage.log.jsonl. Kiro's hook input is not fully documented, so every field
// is optional: the payload may be empty or not JSON (the IDE may send nothing), in which case the working folder
// is used. It never blocks anything: any problem goes to stderr and the exit code stays 0.
//   node kiro-usage.mjs --surface cli|ide
import { creditLine, gitBranch, readSession, recordSession, sessionFromKiroEvent } from "../providers/usage.mjs";

const argv = process.argv.slice(2);
const at = argv.indexOf("--surface");
const surface = at >= 0 && ["cli", "ide"].includes(argv[at + 1]) ? argv[at + 1] : "cli";

let raw = "";
process.stdin.setEncoding("utf8");
if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk;

try {
  let event = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") event = parsed;
  } catch {
    // empty or foreign input
  }
  event.cwd ??= process.cwd();
  const branch = gitBranch(event.cwd);
  const first = sessionFromKiroEvent(event, { surface, branch });
  const previous = readSession("kiro", first.sessionId, first.ticket);
  const session = sessionFromKiroEvent(event, { surface, branch, previous });
  recordSession(session);
  console.error(`dev-agent usage: ${creditLine(session)}`);
} catch (err) {
  console.error(`dev-agent kiro usage: ${err.message}`);
}
process.exit(0);
