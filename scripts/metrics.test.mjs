import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { metricsTable, transcriptMetrics } from "./metrics.mjs";

const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const asst = (id, s, blocks) => ({
  type: "assistant",
  timestamp: at(s),
  message: { id, model: "m", content: blocks, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
});
const use = (name) => ({ type: "tool_use", id: `t-${name}`, name, input: {} });

test("counts responses once, tools, questions and idle gaps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-metrics-"));
  const file = path.join(dir, "s.jsonl");
  const lines = [
    { type: "user", timestamp: at(0), message: { content: "solve 1" } },
    asst("r1", 5, [use("Read")]),
    asst("r1", 6, [use("Read")]), // streamed duplicate of r1
    asst("r2", 10, [use("AskUserQuestion")]),
    { type: "user", timestamp: at(500), message: { content: "yes" } }, // developer thinking for 490 s
    asst("r3", 505, [use("Edit")]),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  const m = transcriptMetrics(file);
  assert.equal(m.llmCalls, 3);
  assert.equal(m.toolCalls, 4);
  assert.equal(m.humanStops, 2); // one question + one extra typed message
  assert.equal(m.wallSeconds, 505);
  assert.equal(m.activeSeconds, 15); // the 490 s wait is excluded
  assert.equal(m.tokens.output, 15);
  assert.match(metricsTable([m]), /LLM calls/);
  fs.rmSync(dir, { recursive: true, force: true });
});
