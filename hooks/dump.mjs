// Probe, not part of the agent: appends every hook event it receives to a file so the shape of a provider's
// events can be read. Set DEV_AGENT_DUMP to the output file (default: dump.jsonl in the OS temp folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const file = process.env.DEV_AGENT_DUMP ?? path.join(os.tmpdir(), "dev-agent-dump.jsonl");
const entry = { at: new Date().toISOString(), argv: process.argv.slice(2), env: process.env.CLAUDE_PLUGIN_ROOT ? "claude" : "other", event: raw };
fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
process.exit(0);
