import assert from "node:assert/strict";
import { test } from "node:test";
import { coverage, parseAcceptance, parseCoverage, parseUnits, validate } from "./artifacts.mjs";

const AC = `# Criteria
- AC1 [clear] given a user, when they save, then it persists
- AC2 [proposed] given bad input, then an error shows
`;
const UNITS = `- U1 | repo=api | layer=0 | depends=- | covers=AC1 | files=a.js,b.js
- U2 | repo=web | layer=1 | depends=U1 | covers=AC1,AC2 | files=c.js
`;

test("acceptance and units parse into records", () => {
  const ac = parseAcceptance(AC);
  assert.deepEqual(ac.map((a) => [a.id, a.mark]), [["AC1", "clear"], ["AC2", "proposed"]]);
  const units = parseUnits(UNITS);
  assert.deepEqual(units[1], { id: "U2", repo: "web", layer: 1, depends: ["U1"], covers: ["AC1", "AC2"], files: ["c.js"] });
});

test("a consistent set validates", () => {
  const r = validate({ acceptance: parseAcceptance(AC), units: parseUnits(UNITS), repos: ["api", "web"] });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("vague criteria, uncovered criteria and unknown references are errors", () => {
  const ac = parseAcceptance(`${AC}- AC3 [vague] should feel fast\n`);
  const r = validate({ acceptance: ac, units: parseUnits(UNITS), repos: ["api"] });
  assert.equal(r.ok, false);
  const text = r.errors.join("\n");
  assert.match(text, /AC3 is vague/);
  assert.match(text, /AC3 is covered by no unit/);
  assert.match(text, /unknown repo "web"/);
});

test("a dependency cycle and a dependency on a later layer are caught", () => {
  const cyc = parseUnits("- U1 | repo=a | layer=0 | depends=U2 | covers=AC1\n- U2 | repo=a | layer=0 | depends=U1 | covers=AC1\n");
  assert.match(validate({ acceptance: parseAcceptance(AC), units: cyc }).errors.join("\n"), /cycle/);
  const later = parseUnits("- U1 | repo=a | layer=0 | depends=U2 | covers=AC1\n- U2 | repo=a | layer=1 | depends=- | covers=AC2\n");
  assert.match(validate({ acceptance: parseAcceptance(AC), units: later }).errors.join("\n"), /later layer/);
});

test("coverage reads the section and stops at the next heading", () => {
  const report = "# R\n## Criteria coverage\n- AC1: covered - test saves.spec\n- AC2: partial - no UI test\n## Other\n- AC9: covered - ignored\n";
  assert.deepEqual(parseCoverage(report).map((r) => [r.id, r.status]), [["AC1", "covered"], ["AC2", "partial"]]);
  assert.equal(parseCoverage("# R\nnothing"), null);
});

test("coverage takes the best claim per criterion and flags open ones and missing sections", () => {
  const acceptance = parseAcceptance(AC);
  const reports = [
    { repo: "api", text: "## Criteria coverage\n- AC1: covered - t\n## Test-first\nred: failed\ngreen: passed\n" },
    { repo: "web", text: "## Criteria coverage\n- AC1: partial - x\n- AC2: not-covered - y\n" },
    { repo: "docs", text: "# no section" },
  ];
  const c = coverage({ acceptance, reports });
  assert.equal(c.ok, false);
  assert.deepEqual(c.open, ["AC2"]);
  assert.deepEqual(c.missingSection, ["docs"]);
  assert.deepEqual(c.noTestFirst, ["web", "docs"]);
  const done = coverage({ acceptance, reports: [{ repo: "api", text: "## Criteria coverage\n- AC1: covered - t\n- AC2: n/a - docs only\n" }] });
  assert.equal(done.ok, true);
});
