import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initState, loadState, patchState } from "./runstate.mjs";
import { close, feedback, prepare, redact, section } from "./ship.mjs";

function makeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-ship-"));
  initState(dir, { key: "P-7" });
  patchState(dir, { phase: "construction", repos: { api: { branch: "feat/P-7-api" }, web: { branch: "feat/P-7-web" } } });
  const w = (f, t) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  };
  w("intent.md", "# Intent\nAdd CSV export to the reports page\n");
  w("acceptance.md", "- AC1 [clear] given reports, when export is clicked, then a CSV downloads\n- AC2 [clear] given no data, then export is disabled\n");
  w("units.md", "- U1 | repo=api | layer=0 | depends=- | covers=AC1\n- U2 | repo=web | layer=1 | depends=U1 | covers=AC1,AC2\n");
  w("plan.md", "# Plan\n## Risks and open questions\n- Large exports may time out\n## Other\nx\n");
  w("api/report.md", "## Criteria coverage\n- AC1: covered - export.test\n## Manual checks for the developer\n- Call GET /export on staging\n## PR text\nAdds the export endpoint.\n");
  w("web/report.md", "## Criteria coverage\n- AC1: covered - e2e\n- AC2: covered - button.test\n## PR text\nAdds the export button.\n");
  return dir;
}

test("prepare writes a release plan ordered producers first, with checks and rollback", () => {
  const dir = makeRun();
  const r = prepare(dir, { commits: { api: "aaa111", web: "bbb222" } });
  assert.deepEqual(r.order, ["api", "web"]);
  assert.deepEqual(r.warnings, []);
  const text = fs.readFileSync(r.file, "utf8");
  assert.match(text, /- Added: P-7 Add CSV export/);
  assert.match(text, /Adds the export endpoint/);
  assert.match(text, /\(api\) Call GET \/export on staging/);
  assert.match(text, /AC2: given no data/);
  assert.match(text, /Large exports may time out/);
  assert.ok(text.indexOf("git revert bbb222") < text.indexOf("git revert aaa111"), "rollback runs in reverse order");
  assert.equal(loadState(dir).phase, "operations");
});

test("prepare warns about uncommitted repos and uncovered criteria", () => {
  const dir = makeRun();
  fs.writeFileSync(path.join(dir, "web", "report.md"), "## Criteria coverage\n- AC1: covered - e2e\n- AC2: not-covered - no data case\n");
  const r = prepare(dir);
  assert.match(r.warnings.join("\n"), /api has no local commit/);
  assert.match(r.warnings.join("\n"), /AC2/);
  assert.match(fs.readFileSync(r.file, "utf8"), /## Needs attention/);
});

test("feedback writes a self-contained follow-up with secrets removed and the log trimmed", () => {
  const dir = makeRun();
  const log = [...Array.from({ length: 80 }, (_, i) => `line ${i}`), "AWS key AKIAABCDEFGHIJKLMNOP", "password: hunter2hunter2"].join("\n");
  const f = feedback(dir, { source: "ci", text: log });
  const text = fs.readFileSync(f.file, "utf8");
  assert.equal(f.n, 1);
  assert.match(text, /Follow-up 1 to P-7 \(ci\)/);
  assert.match(text, /AC1 given reports/);
  assert.doesNotMatch(text, /AKIAABCDEFGHIJKLMNOP|hunter2/);
  assert.doesNotMatch(text, /line 10\b/);
  assert.match(text, /line 79/);
  assert.equal(feedback(dir, { source: "revert", text: "reverted" }).n, 2);
});

test("feedback rejects an unknown source or empty text; close needs a release plan", () => {
  const dir = makeRun();
  assert.throws(() => feedback(dir, { source: "rumor", text: "x" }), /--source/);
  assert.throws(() => feedback(dir, { source: "ci", text: "  " }), /failure text/);
  assert.throws(() => close(dir), /release plan/);
  prepare(dir);
  close(dir);
  assert.equal(loadState(dir).phase, "done");
});

test("section and redact helpers", () => {
  assert.equal(section("## A\none\n## B\ntwo", "A"), "one");
  assert.equal(section("## A\none", "Z"), "");
  assert.match(redact("token = abc12345"), /token = \[redacted\]/);
});
