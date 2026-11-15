// Run metrics from a Claude Code transcript (plus its subagent logs): the numbers used to compare runs.
//   node metrics.mjs <session.jsonl> [more.jsonl ...]      prints one JSON object per transcript
//   node metrics.mjs --table <a.jsonl> <b.jsonl> ...        prints a comparison table
// llmCalls = distinct assistant responses; toolCalls = tool_use blocks (subagents included);
// humanStops = questions put to the developer (AskUserQuestion) plus user messages typed in the main session.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addTotals, claudeLogFiles } from "../providers/usage.mjs";

function readLines(file) {
  const out = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // half-written or foreign line
    }
  }
  return out;
}

const IDLE_GAP = 120_000;
const blocks = (msg) => (Array.isArray(msg?.content) ? msg.content : []);
// A typed message, not a tool result or a harness reminder
const isTypedPrompt = (line) => {
  if (line.type !== "user" || line.isSidechain || line.isMeta) return false;
  const c = line.message?.content;
  if (typeof c === "string") return !/^<(system-reminder|command-|local-command)/.test(c.trim());
  return Array.isArray(c) && c.some((b) => b.type === "text" && !/^<(system-reminder|command-|local-command)/.test(b.text.trim()));
};

export function transcriptMetrics(transcriptPath) {
  const responses = new Map(); // message id -> final message (streamed lines share an id)
  const tools = {};
  const stamps = [];
  let questions = 0;
  let typed = 0;
  let subagents = 0;
  const files = claudeLogFiles(transcriptPath);
  for (const file of files) {
    for (const line of readLines(file)) {
      if (line.timestamp) stamps.push(Date.parse(line.timestamp));
      if (file === transcriptPath && isTypedPrompt(line)) typed++;
      const msg = line.type === "assistant" ? line.message : null;
      if (!msg) continue;
      if (msg.usage && msg.model !== "<synthetic>") responses.set(msg.id ?? `${file}:${responses.size}`, msg);
      for (const b of blocks(msg)) {
        if (b.type !== "tool_use") continue;
        tools[b.name] = (tools[b.name] ?? 0) + 1;
        if (b.name === "AskUserQuestion") questions++;
        if (b.name === "Agent" || b.name === "Task") subagents++;
      }
    }
  }
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = {};
  for (const m of responses.values()) {
    const u = m.usage;
    tokens = addTotals(tokens, {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
    models[m.model] = (models[m.model] ?? 0) + 1;
  }
  const valid = stamps.filter(Number.isFinite).sort((a, b) => a - b);
  // Active time: gaps over IDLE_GAP are the developer reading or answering, not the agent working
  let active = 0;
  for (let i = 1; i < valid.length; i++) if (valid[i] - valid[i - 1] <= IDLE_GAP) active += valid[i] - valid[i - 1];
  return {
    session: path.basename(transcriptPath, ".jsonl"),
    wallSeconds: valid.length ? Math.round((valid[valid.length - 1] - valid[0]) / 1000) : 0,
    activeSeconds: Math.round(active / 1000),
    llmCalls: responses.size,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
    tools,
    subagents,
    humanStops: questions + Math.max(0, typed - 1), // the first typed message is the task itself
    tokens,
    models,
  };
}

const fmt = (n) => n.toLocaleString("en-US");

export function metricsTable(rows) {
  const cols = [
    ["session", (r) => r.session.slice(0, 8)],
    ["active s", (r) => fmt(r.activeSeconds)],
    ["wall s", (r) => fmt(r.wallSeconds)],
    ["LLM calls", (r) => fmt(r.llmCalls)],
    ["tool calls", (r) => fmt(r.toolCalls)],
    ["subagents", (r) => fmt(r.subagents)],
    ["human stops", (r) => fmt(r.humanStops)],
    ["output tok", (r) => fmt(r.tokens.output)],
    ["new input tok", (r) => fmt(r.tokens.input + r.tokens.cacheWrite)],
    ["cache read tok", (r) => fmt(r.tokens.cacheRead)],
  ];
  const lines = [cols.map(([h]) => h), ...rows.map((r) => cols.map(([, f]) => f(r)))];
  const widths = cols.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => c.padStart(widths[i])).join("  ")).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const table = args[0] === "--table";
  const files = table ? args.slice(1) : args;
  if (!files.length) {
    console.error("Usage: metrics.mjs [--table] <session.jsonl> ...");
    process.exit(1);
  }
  const rows = files.map(transcriptMetrics);
  console.log(table ? metricsTable(rows) : JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2));
}
