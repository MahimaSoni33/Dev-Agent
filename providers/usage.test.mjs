import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendUsageLog, creditTotals, parseClaudeTranscript, readSession, recordSession, sessionFromClaudeEvent, sessionFromKiroEvent, sessionUnit, ticketFrom } from "./usage.mjs";

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
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["usage.json", "usage.log.jsonl"]);
});

test("sessions without a ticket land in _unassigned", () => {
  const dir = tmp();
  const file = recordSession({ provider: "claude", sessionId: "z", ticket: null, models: {} }, { dir });
  assert.match(file, /_unassigned/);
});

test("a hook event without a transcript is ignored", () => {
  assert.equal(sessionFromClaudeEvent({ session_id: "x" }), null);
});

// ---- Kiro: credits, never tokens ----
const kiroEvent = (over = {}) => ({ session_id: "k1", cwd: "C:/work/api", hook_event_name: "stop", ...over });
const kiro = (over, opts) => sessionFromKiroEvent(kiroEvent(over), { branch: "Area/NOVA-7/Thing", ...opts });

test("a Kiro session is a credit session with credits unavailable, not zero", () => {
  const s = kiro();
  assert.equal(s.provider, "kiro");
  assert.equal(sessionUnit(s), "credits");
  assert.equal(s.credits.used, null);
  assert.equal(s.credits.source, "unavailable");
  assert.deepEqual(s.models, {});
  assert.equal(s.ticket, "NOVA-7");
  assert.equal(s.sessionIdSource, "kiro");
});

test("records written before Kiro support still count as token sessions", () => {
  assert.equal(sessionUnit({ provider: "claude", models: {} }), "tokens");
});

test("the request count grows across hook calls and the start time is kept", () => {
  const first = kiro({}, { now: new Date("2026-01-01T10:00:00Z") });
  const second = kiro({}, { previous: first, now: new Date("2026-01-01T11:00:00Z") });
  assert.equal(first.requests, 1);
  assert.equal(second.requests, 2);
  assert.equal(second.startedAt, "2026-01-01T10:00:00.000Z");
});

test("credits a developer reported are kept by later hook calls, still labelled user-reported", () => {
  const previous = { ...kiro(), credits: { used: 4.2, source: "user-reported" }, source: "user-reported", requests: 3 };
  const next = kiro({}, { previous });
  assert.deepEqual(next.credits, { used: 4.2, source: "user-reported" });
  assert.equal(next.requests, 4);
});

test("a payload without a session id gets a derived, flagged id", () => {
  const s = sessionFromKiroEvent({ cwd: "C:/work/api" }, { surface: "ide", now: new Date("2026-02-03T00:00:00Z") });
  assert.equal(s.sessionId, "ide-api-2026-02-03");
  assert.equal(s.sessionIdSource, "derived");
  assert.equal(s.surface, "ide");
});

test("credit totals keep measured, user-reported and unavailable apart", () => {
  const usage = {
    sessions: {
      "kiro:a": { unit: "credits", credits: { used: 1.5, source: "measured" } },
      "kiro:b": { unit: "credits", credits: { used: 2.25, source: "user-reported" } },
      "kiro:c": { unit: "credits", credits: { used: null, source: "unavailable" } },
      "claude:d": { models: { m: { input: 999, output: 999 } } },
    },
  };
  assert.deepEqual(creditTotals(usage), { measured: 1.5, userReported: 2.25, unavailableSessions: 1, sessions: 3 });
});

test("two Kiro sessions on one ticket stay separate and every update is logged", () => {
  const dir = tmp();
  const a = kiro({ session_id: "a" });
  const b = kiro({ session_id: "b" });
  recordSession(a, { dir });
  recordSession({ ...a, requests: 2 }, { dir });
  const file = recordSession(b, { dir });
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(doc.sessions["kiro:a"].requests, 2);
  assert.equal(doc.sessions["kiro:b"].requests, 1);
  assert.equal(readSession("kiro", "a", "NOVA-7", { dir }).requests, 2);
  assert.equal(readSession("kiro", "nope", "NOVA-7", { dir }), null);
  const log = fs.readFileSync(path.join(path.dirname(file), "usage.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 3);
  assert.equal(log[0].unit, "credits");
  assert.equal(log[0].credits.used, null);
});

test("the usage log never throws, even into an impossible folder", () => {
  assert.doesNotThrow(() => appendUsageLog({ provider: "kiro", sessionId: "x", ticket: null }, { dir: "\0:/bad" }));
});
