import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { add, forget, load, recall, render } from "./memory.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "devagent-mem-"));

test("a lesson is stored and recalled by matching words", () => {
  const r = root();
  add(r, { kind: "convention", text: "API handlers return errors through the shared problem-details helper", repo: "api" });
  add(r, { kind: "finding", text: "Date filters must use UTC boundaries in the reports query", repo: "web" });
  const out = recall(r, { query: "add a date filter to reports", repo: "web" });
  assert.match(render(out), /UTC boundaries/);
});

test("the same lesson twice strengthens one entry instead of duplicating it", () => {
  const r = root();
  add(r, { kind: "finding", text: "Always null-check the optional manager field" });
  const second = add(r, { kind: "finding", text: "always null-check the optional manager field!" });
  assert.equal(second.reinforced, true);
  assert.equal(load(r).length, 1);
  assert.equal(load(r)[0].seen, 2);
});

test("secrets, tokens and oversize text are refused", () => {
  const r = root();
  assert.throws(() => add(r, { kind: "finding", text: "the api_key = sk_live_abcdef123456 works here" }), /secret/);
  assert.throws(() => add(r, { kind: "finding", text: "x".repeat(300) }), /at most/);
  assert.throws(() => add(r, { kind: "bogus", text: "a proper sentence here" }), /kind must/);
  assert.equal(load(r).length, 0);
});

test("another repo's lessons are not recalled; conventions apply everywhere", () => {
  const r = root();
  add(r, { kind: "finding", text: "Migration files need a down step before merging", repo: "api" });
  add(r, { kind: "convention", text: "Tests sit next to the source file" });
  const out = recall(r, { query: "migration down step", repo: "web" });
  assert.deepEqual(out.map((e) => e.kind), ["convention"]);
});

test("a damaged line is skipped and forget removes by id", () => {
  const r = root();
  const { id } = add(r, { kind: "decision", text: "Use the existing toast component for errors" });
  fs.appendFileSync(path.join(r, ".dev-agent", "memory.jsonl"), "{broken\n");
  assert.equal(load(r).length, 1);
  forget(r, id);
  assert.equal(load(r).length, 0);
  assert.throws(() => forget(r, "nope"), /No lesson/);
});

test("recall returns nothing for an empty memory and respects the limit", () => {
  const r = root();
  assert.equal(render(recall(r, { query: "anything" })), "");
  for (let i = 0; i < 5; i++) add(r, { kind: "convention", text: `Convention number ${i} about naming things` });
  assert.equal(recall(r, { query: "naming", limit: 3 }).length, 3);
});
