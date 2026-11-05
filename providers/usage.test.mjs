import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseClaudeTranscript, recordSession, sessionFromClaudeEvent, ticketFrom } from "./usage.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-usage-"));
const jsonl = (rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
const assistant = (id, model, u) => ({
  type: "assistant",
  sessionId: "s1",
  cwd: "C:\work\api",
  gitBranch: "Area/NOVA-162/Thing",
  message: { id, model, usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } },
});

function fixture() {
  const dir = tmp();
  const log = path.join(dir, "s1.jsonl");
  fs.writeFileSync(
    log,
    jsonl([
      { type: "user" },
      assistant("m1", "claude-a", [1, 5, 10, 100]), // streamed twice: only the last counts
      assistant("m1", "claude-a", [1, 50, 10, 100]),
      "{not json",
      assistant("m2", "claude-a", [2, 7, 20, 0]),
      assistant("m3", "<synthetic>", [0, 0, 0, 0]),
    ]),
  );
  fs.mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "s1", "subagents", "agent-x.jsonl"), jsonl([assistant("sub1", "claude-b", [3, 9, 0, 40])]));
  return log;
}

test("sums usage per model, once per message id, subagents included", () => {
  const { models, branch, sessionId } = parseClaudeTranscript(fixture());
  assert.deepEqual(models["claude-a"], { input: 3, output: 57, cacheRead: 30, cacheWrite: 100 });
  assert.deepEqual(models["claude-b"], { input: 3, output: 9, cacheRead: 0, cacheWrite: 40 });
  assert.equal(models["<synthetic>"], undefined);
  assert.equal(branch, "Area/NOVA-162/Thing");
  assert.equal(sessionId, "s1");
});

test("a missing transcript gives empty usage", () => {
  assert.deepEqual(parseClaudeTranscript(path.join(tmp(), "nope.jsonl")).models, {});
});

test("ticket comes from the branch, then the folder, else null", () => {
  assert.equal(ticketFrom("Area/PROJ-145/x"), "PROJ-145");
  assert.equal(ticketFrom(null, "C:/w/NOVA-9/repo"), "NOVA-9");
  assert.equal(ticketFrom("main", null), null);
});

test("recording a session twice replaces it and keeps other sessions", () => {
  const dir = tmp();
  const base = { provider: "claude", ticket: "NOVA-1", source: "measured", models: {} };
  recordSession({ ...base, sessionId: "a", models: { m: { input: 1 } } }, { dir });
  recordSession({ ...base, sessionId: "a", models: { m: { input: 5 } } }, { dir });
  const file = recordSession({ ...base, sessionId: "b" }, { dir });
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(doc.sessions).length, 2);
  assert.equal(doc.sessions["claude:a"].models.m.input, 5);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["usage.json"]);
});

test("sessions without a ticket land in _unassigned", () => {
  const dir = tmp();
  const file = recordSession({ provider: "claude", sessionId: "z", ticket: null, models: {} }, { dir });
  assert.match(file, /_unassigned/);
});

test("a hook event without a transcript is ignored", () => {
  assert.equal(sessionFromClaudeEvent({ session_id: "x" }), null);
});
