import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordSession, sessionFromKiroEvent } from "../providers/usage.mjs";
import { history, loadUsage, report, setUserCredits } from "./usage.mjs";
import { scorecard, scorecardMarkdown, scorecardTable } from "./scorecard.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-usagecli-"));
const claude = (id) => ({ provider: "claude", sessionId: id, ticket: "NOVA-7", repo: "api", source: "measured", models: { "claude-a": { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } });
const kiro = (id, surface = "ide") => sessionFromKiroEvent({ session_id: id, cwd: "C:/work/api" }, { surface, branch: "Area/NOVA-7/x" });

function fixture() {
  const dir = tmp();
  recordSession(claude("c1"), { dir });
  recordSession(kiro("k1"), { dir });
  recordSession(kiro("k2", "cli"), { dir });
  return dir;
}

test("the report keeps tokens and credits in separate sections and never invents credits", () => {
  const dir = fixture();
  const text = report(loadUsage(path.join(dir, "NOVA-7")), "NOVA-7");
  assert.match(text, /never added together/);
  assert.match(text, /Tokens\n  claude:c1/);
  assert.match(text, /Credits \(Kiro\)\n  kiro:k1/);
  assert.match(text, /credits unavailable \(Kiro did not expose them\)/);
  assert.match(text, /no figure for 2 of 2 session\(s\)/);
  assert.match(text, /Remaining credits: not shown/);
  // the Kiro sessions add nothing to the token total
  assert.match(text, /total: output 20 · new input 50 · cache read 30/);
});

test("user-reported credits are labelled as such and counted apart from measured ones", () => {
  const dir = fixture();
  setUserCredits({ ticket: "NOVA-7", session: "k1", credits: "4.2", dir });
  const text = report(loadUsage(path.join(dir, "NOVA-7")), "NOVA-7");
  assert.match(text, /credits 4\.2 \(user-reported\)/);
  assert.match(text, /measured 0 · user-reported 4\.2 · no figure for 1 of 2/);
  assert.match(text, /The credit total is incomplete/);
});

test("recording credits rejects bad numbers, unknown sessions and token sessions", () => {
  const dir = fixture();
  assert.throws(() => setUserCredits({ ticket: "NOVA-7", session: "k1", credits: "-1", dir }), /0 or more/);
  assert.throws(() => setUserCredits({ ticket: "NOVA-7", session: "k1", credits: "abc", dir }), /0 or more/);
  assert.throws(() => setUserCredits({ ticket: "NOVA-7", session: "nope", credits: "1", dir }), /No session kiro:nope.*kiro:k1/);
  assert.throws(() => setUserCredits({ ticket: "NOVA-7", session: "c1", provider: "claude", credits: "1", dir }), /tokens, not credits/);
});

test("history lists each ticket with tokens and credits apart", () => {
  const dir = fixture();
  recordSession({ ...claude("c2"), ticket: "NOVA-8" }, { dir });
  const text = history(dir);
  assert.match(text, /NOVA-7\s+3\s+20\s+50\s+0 \/ 0 \/ 2 n\/a/);
  assert.match(text, /NOVA-8\s+1\s+20\s+50\s+-/);
  assert.match(history(path.join(dir, "missing")), /No runs directory/);
});

test("an empty ticket reports no sessions instead of crashing", () => {
  assert.match(report(null, "X"), /No sessions recorded/);
});

test("the scorecard counts Kiro credits apart from tokens and cost", () => {
  const dir = fixture();
  setUserCredits({ ticket: "NOVA-7", session: "k1", credits: 2, dir });
  const card = scorecard(path.join(dir, "NOVA-7"), { prices: { "claude-a": { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 } } });
  assert.deepEqual(card.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.deepEqual(card.credits, { measured: 0, userReported: 2, unavailableSessions: 1, sessions: 2 });
  // USD per million tokens: (10 + 20) tokens only; the Kiro credits add nothing to it
  assert.equal(card.costUsd, 30);
  assert.ok(card.notes.some((x) => /measured in credits, not tokens/.test(x)));
  assert.ok(card.notes.some((x) => /unavailable for 1 Kiro session/.test(x)));
  const md = scorecardMarkdown(card);
  assert.match(md, /kiro ide\): 1 request\(s\), credits 2 \(user-reported\)/);
  assert.match(md, /kiro cli\): 1 request\(s\), credits unavailable/);
  assert.match(md, /## Credits \(Kiro\)/);
  assert.match(scorecardTable([card]), /kiro credits/);
});

test("a run with no Kiro sessions has no credits section", () => {
  const dir = tmp();
  recordSession(claude("c1"), { dir });
  const md = scorecardMarkdown(scorecard(path.join(dir, "NOVA-7"), { prices: {} }));
  assert.doesNotMatch(md, /Credits \(Kiro\)/);
});
