import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initState, loadState, nextAction, parseArgs, patchState } from "./runstate.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "devagent-state-"));
const put = (dir, name, text = "x") => fs.writeFileSync(path.join(dir, name), text);

test("init creates state once; a second init resumes it", () => {
  const dir = tmp();
  assert.equal(initState(dir, { key: "P-1" }).resumed, undefined);
  patchState(dir, { tier: "medium" });
  const again = initState(dir, { key: "P-1" });
  assert.equal(again.resumed, true);
  assert.equal(again.tier, "medium");
});

test("a damaged state file reads as no state instead of crashing", () => {
  const dir = tmp();
  put(dir, "state.json", "{ not json");
  assert.equal(loadState(dir), null);
  assert.equal(nextAction(dir).action, "start");
});

test("inception asks for each artifact in order, then the plan gate", () => {
  const dir = tmp();
  initState(dir, { key: "P-1" });
  const order = [];
  for (const file of ["intent.md", "acceptance.md", "units.md", "plan.md"]) {
    order.push(nextAction(dir).action);
    put(dir, file);
  }
  assert.deepEqual(order, ["write-intent", "write-acceptance", "write-units", "write-plan"]);
  assert.equal(nextAction(dir).action, "plan-gate");
  patchState(dir, { gates: { plan: "approved" } });
  assert.equal(nextAction(dir).action, "build");
});

test("construction builds the lowest open layer, in dependency order", () => {
  const dir = tmp();
  initState(dir, { key: "P-1" });
  patchState(dir, { phase: "construction", units: { U1: { layer: 0, status: "pending", depends: [] }, U2: { layer: 1, status: "pending", depends: ["U1"] }, U3: { layer: 0, status: "pending", depends: [] } } });
  const first = nextAction(dir);
  assert.deepEqual(first.units, ["U1", "U3"]);
  patchState(dir, { units: { U1: { status: "done" }, U3: { status: "done" } } });
  assert.deepEqual(nextAction(dir).units, ["U2"]);
});

test("a unit left mid-way after a crash is flagged for inspection, not rebuilt blindly", () => {
  const dir = tmp();
  initState(dir, { key: "P-1" });
  patchState(dir, { phase: "construction", units: { U1: { layer: 0, status: "building" } } });
  const next = nextAction(dir);
  assert.equal(next.action, "resume-units");
  assert.deepEqual(next.units, ["U1"]);
});

test("blocked units stop the run; finished units lead to commit gate, summary, ship", () => {
  const dir = tmp();
  initState(dir, { key: "P-1" });
  patchState(dir, { phase: "construction", units: { U1: { layer: 0, status: "blocked" } } });
  assert.equal(nextAction(dir).action, "blocked");
  patchState(dir, { units: { U1: { status: "done" } } });
  assert.equal(nextAction(dir).action, "commit-gate");
  patchState(dir, { gates: { commit: "all" } });
  assert.equal(nextAction(dir).action, "write-summary");
  put(dir, "summary.md");
  assert.equal(nextAction(dir).action, "ship");
});

test("a dependency that is not done blocks instead of looping", () => {
  const dir = tmp();
  initState(dir, { key: "P-1" });
  patchState(dir, { phase: "construction", units: { U2: { layer: 0, status: "pending", depends: ["U9"] } } });
  assert.equal(nextAction(dir).action, "blocked");
});

test("bad phase or status is rejected; history keeps the transitions", () => {
  const dir = tmp();
  initState(dir, { key: "P-1" });
  assert.throws(() => patchState(dir, { phase: "later" }), /Unknown phase/);
  assert.throws(() => patchState(dir, { units: { U1: { status: "weird" } } }), /Unknown unit status/);
  patchState(dir, { phase: "construction" });
  assert.match(loadState(dir).history.at(-1).event, /inception -> construction/);
});

test("parseArgs handles repeated and bare flags", () => {
  assert.deepEqual(parseArgs(["--unit", "U1=done", "--unit", "U2=done", "--units-from-artifacts"]), { unit: ["U1=done", "U2=done"], "units-from-artifacts": true });
});
