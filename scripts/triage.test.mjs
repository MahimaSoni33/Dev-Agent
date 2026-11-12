import assert from "node:assert/strict";
import { test } from "node:test";
import { modelsFor, triage } from "./triage.mjs";

const cfg = (rules = {}) => ({
  rules: { planGate: "auto", models: {}, ...rules },
  repos: [
    { id: "agent-panel", areaPrefix: "Web", owns: ["AI Studio"] },
    { id: "api-server", owns: ["REST API"] },
  ],
});

test("a short visual change in one place is simple, skips the gate, and still gets the reviewer", () => {
  const t = triage("AI Studio chatbot profiles: show hidden channels in a tooltip when hovering the +N pill", cfg());
  assert.equal(t.tier, "simple");
  assert.equal(t.strategy.planGate, "auto");
  assert.equal(t.strategy.review, "diffcheck+agent"); // quality: every tier keeps the independent reviewer
  assert.deepEqual(t.strategy.models, { builder: null, reviewer: null }); // quality: every agent uses the host model by default
});

test("structural words make it complex with a plan gate", () => {
  const t = triage("Add a database migration and a new endpoint for invoices", cfg());
  assert.equal(t.tier, "complex");
  assert.equal(t.strategy.planGate, "ask");
  assert.equal(t.strategy.review, "diffcheck+agent");
});

test("security or destructive wording is never fast-pathed and needs a human", () => {
  const t = triage("Fix the tooltip colour when the user deletes a profile", cfg());
  assert.notEqual(t.tier, "simple");
  assert.equal(t.strategy.planGate, "ask");
  assert.match(t.humanRequired[0], /delete/);
});

test("text that names two repos is complex", () => {
  const t = triage("Show the REST API result in AI Studio", cfg());
  assert.equal(t.tier, "complex");
  assert.deepEqual(t.repos.sort(), ["agent-panel", "api-server"]);
});

test("ownership matches whole words only: NOVA-162 is simple, not a two-repo task", () => {
  const config = cfg();
  config.repos[1].owns.push("config");
  const t = triage(
    "AI Studio chatbot profiles: hovering the +N pill should show a tooltip. Displayed channels match the profile's configured channels.",
    config,
  );
  assert.deepEqual(t.repos, ["agent-panel"]);
  assert.equal(t.tier, "simple");
});

test("unclear text lands in medium, and planGate always keeps the old behaviour", () => {
  const t = triage("Improve how the dashboard loads", cfg({ planGate: "always" }));
  assert.equal(t.tier, "medium");
  assert.equal(t.strategy.planGate, "ask");
});

test("a forced tier wins, and models fall back to inherit", () => {
  assert.equal(triage("fix typo in tooltip", cfg(), { tier: "complex" }).tier, "complex");
  const tuned = cfg({ models: { simple: "haiku", reviewer: "sonnet" } });
  assert.deepEqual(modelsFor("medium", tuned), { builder: null, reviewer: "sonnet" });
  assert.deepEqual(modelsFor("simple", tuned), { builder: "haiku", reviewer: "sonnet" });
  assert.deepEqual(modelsFor("simple", {}), { builder: null, reviewer: null });
});
