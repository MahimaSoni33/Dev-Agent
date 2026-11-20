import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { estimateCost, scorecard, scorecardMarkdown, scorecardTable } from "./scorecard.mjs";
import { initState, patchState } from "./runstate.mjs";

const T = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });

function makeRun({ rework = false, feedback = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-score-"));
  initState(dir, { key: "T-1", tier: "simple" });
  patchState(dir, { units: { U1: { status: "building" } } });
  patchState(dir, { units: { U1: { status: "verifying" } } });
  if (rework) patchState(dir, { units: { U1: { status: "building" } } });
  patchState(dir, { units: { U1: { status: "done" } }, shipped: true, feedback });
  fs.writeFileSync(
    path.join(dir, "usage.json"),
    JSON.stringify({
      ticket: "T-1",
      sessions: {
        a: { models: { "claude-sonnet-x": T(100, 1000, 8000, 900) } },
        b: { models: { "claude-sonnet-x": T(50, 500, 1000, 100), "mystery-1": T(1, 1, 1, 1) } },
      },
    }),
  );
  return dir;
}

test("sums sessions, cache ratio and per-unit numbers", () => {
  const dir = makeRun();
  const c = scorecard(dir, { prices: {} });
  assert.equal(c.tokens.output, 1501);
  assert.equal(c.tokens.cacheRead, 9001);
  assert.equal(c.units.done, 1);
  assert.equal(c.firstPass, true);
  assert.equal(c.costUsd, null);
  assert.ok(c.notes.some((x) => /no prices/.test(x)));
  assert.equal(c.perUnit.outputTokens, 1501);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rework and follow-ups break first pass", () => {
  const a = makeRun({ rework: true });
  const b = makeRun({ feedback: 1 });
  assert.equal(scorecard(a, { prices: {} }).reworkCycles, 1);
  assert.equal(scorecard(a, { prices: {} }).firstPass, false);
  assert.equal(scorecard(b, { prices: {} }).firstPass, false);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("cost uses substring prices and lists unpriced models", () => {
  const { usd, unpriced } = estimateCost(
    { "claude-sonnet-x": T(1e6, 1e6, 0, 0), "mystery-1": T(5, 5, 5, 5) },
    { sonnet: { input: 3, output: 15 } },
  );
  assert.equal(usd, 18);
  assert.deepEqual(unpriced, ["mystery-1"]);
});

test("a run with no files still scores without crashing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-score-"));
  const c = scorecard(dir, { prices: {} });
  assert.equal(c.firstPass, false);
  assert.ok(c.notes.length >= 2);
  assert.match(scorecardMarkdown(c), /Scorecard/);
  assert.match(scorecardTable([c]), /first pass/);
  fs.rmSync(dir, { recursive: true, force: true });
});
