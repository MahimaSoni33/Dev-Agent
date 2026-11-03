// Maps each provider's tool calls onto the tool names and input fields that hooks/rules.mjs understands
// (Claude Code's: Bash, Read, Edit, Write, Grep, Glob). Unknown tools pass through and are allowed.

const first = (...values) => values.find((v) => typeof v === "string" && v);

// Antigravity tool name -> [canonical name, input mapper]
const ANTIGRAVITY = {
  run_command: ["Bash", (a) => ({ command: a.CommandLine })],
  view_file: ["Read", (a) => ({ file_path: a.AbsolutePath })],
  write_to_file: ["Write", (a) => ({ file_path: a.TargetFile })],
  replace_file_content: ["Edit", (a) => ({ file_path: a.TargetFile })],
  multi_replace_file_content: ["MultiEdit", (a) => ({ file_path: a.TargetFile })],
  // Only the location is passed on: Query is search text, not a file name
  grep_search: ["Grep", (a) => ({ path: a.SearchPath })],
  list_dir: ["Glob", (a) => ({ path: a.DirectoryPath })],
  find_by_name: ["Glob", (a) => ({ path: first(a.SearchDirectory, a.SearchPath), glob: first(a.Pattern) })],
};

// Canonical agent tool -> Antigravity tools, used when generating agent files
export const ANTIGRAVITY_AGENT_TOOLS = {
  Read: ["view_file"],
  Edit: ["replace_file_content", "multi_replace_file_content"],
  Write: ["write_to_file"],
  Grep: ["grep_search"],
  Glob: ["find_by_name", "list_dir"],
  Bash: ["run_command"],
  PowerShell: ["run_command"],
};

// Hook event in, { provider, tool, input } out
export function normalizeToolCall(event) {
  if (event.toolCall) {
    const { name, args = {} } = event.toolCall;
    const [tool, map] = ANTIGRAVITY[name] ?? [name, () => args];
    return { provider: "antigravity", tool, input: map(args) };
  }
  return { provider: "claude", tool: event.tool_name, input: event.tool_input ?? {} };
}

// How a provider wants a blocked (or allowed) call reported back
export function verdict(provider, reason) {
  if (provider === "antigravity") {
    const body = reason ? { decision: "deny", reason: `Blocked by dev-agent: ${reason}` } : { decision: "allow" };
    return { stdout: JSON.stringify(body), stderr: "", code: 0 };
  }
  return reason ? { stdout: "", stderr: `Blocked by dev-agent: ${reason}`, code: 2 } : { stdout: "", stderr: "", code: 0 };
}
