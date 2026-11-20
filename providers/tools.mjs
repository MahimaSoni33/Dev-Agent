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

// Kiro (CLI and IDE) tool name -> [canonical name, input mapper]. Built from Kiro's documented built-in tools
// (execute_bash, fs_read, fs_write, grep, glob) and the shorter names newer CLI versions use. Unverified against a
// live session: confirm the names and fields with the probe (hooks/dump.mjs) before relying on them.
const paths = (i) => [i.path, ...(Array.isArray(i.operations) ? i.operations.map((o) => o?.path) : []), ...(Array.isArray(i.paths) ? i.paths : [])].filter((p) => typeof p === "string" && p);
const KIRO = {
  execute_bash: ["Bash", (i) => [{ command: i.command }]],
  shell: ["Bash", (i) => [{ command: i.command }]],
  bash: ["Bash", (i) => [{ command: i.command }]],
  fs_read: ["Read", (i) => paths(i).map((p) => ({ file_path: p }))],
  read: ["Read", (i) => paths(i).map((p) => ({ file_path: p }))],
  // create is a Write, str_replace / insert / append are Edits
  fs_write: [(i) => (i.command === "create" ? "Write" : "Edit"), (i) => paths(i).map((p) => ({ file_path: p }))],
  write: ["Write", (i) => paths(i).map((p) => ({ file_path: p }))],
  grep: ["Grep", (i) => [{ path: first(i.path, i.root) }]],
  glob: ["Glob", (i) => [{ path: first(i.path, i.root), glob: first(i.pattern) }]],
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

// Canonical agent tool -> Kiro tools, used when generating Kiro custom agents
export const KIRO_AGENT_TOOLS = {
  Read: ["fs_read"],
  Edit: ["fs_write"],
  Write: ["fs_write"],
  Grep: ["grep"],
  Glob: ["glob"],
  Bash: ["execute_bash"],
  PowerShell: ["execute_bash"],
};
// Kiro tools that never change anything; the generated agents pre-approve only these
export const KIRO_READ_ONLY_TOOLS = ["fs_read", "grep", "glob"];

// Hook event in, every call it contains out: [{ provider, tool, input }]. One Kiro file read can name several paths,
// and each one has to be judged.
export function expandToolCalls(event) {
  if (event.toolCall) {
    const { name, args = {} } = event.toolCall;
    const [tool, map] = ANTIGRAVITY[name] ?? [name, () => args];
    return [{ provider: "antigravity", tool, input: map(args) }];
  }
  const kiro = Object.hasOwn(KIRO, event.tool_name) ? KIRO[event.tool_name] : null;
  if (kiro) {
    const input = event.tool_input ?? {};
    const tool = typeof kiro[0] === "function" ? kiro[0](input) : kiro[0];
    const inputs = kiro[1](input);
    return (inputs.length ? inputs : [{}]).map((i) => ({ provider: "kiro", tool, input: i }));
  }
  return [{ provider: "claude", tool: event.tool_name, input: event.tool_input ?? {} }];
}

// Hook event in, { provider, tool, input } out (the first call; see expandToolCalls for all of them)
export const normalizeToolCall = (event) => expandToolCalls(event)[0];

// How a provider wants a blocked (or allowed) call reported back
export function verdict(provider, reason) {
  if (provider === "antigravity") {
    const body = reason ? { decision: "deny", reason: `Blocked by dev-agent: ${reason}` } : { decision: "allow" };
    return { stdout: JSON.stringify(body), stderr: "", code: 0 };
  }
  // Claude Code and Kiro both block with exit code 2 and the reason on stderr
  return reason ? { stdout: "", stderr: `Blocked by dev-agent: ${reason}`, code: 2 } : { stdout: "", stderr: "", code: 0 };
}
